<%--
  Same-origin, read-only proxy from the App View to NCM's (Network
  Configuration Manager) REST API, for device configuration compliance.

  Why this exists:
    The browser can't call NCM directly — different origin, NCM credentials
    would be exposed, and NCM's certificate is often self-signed. This JSP
    runs in the Portal's servlet container (same origin as the App View) and
    calls NCM server-side.

  A fixed menu, not a pass-through:
    The browser picks one of two operations; this JSP builds every NCM
    request body itself. Nothing the browser sends is forwarded, so a Portal
    user can't use it to read the rest of NCM's audit log (logins, security
    events) or to call any other NCM endpoint.

      GET ncm-proxy.jsp?op=devices
          -> POST {ncm.base.url}rest/api/v1/network/null/devices/info
             Every device NCM manages, with `devicePolicyCompliance`.

      GET ncm-proxy.jsp?op=events[&since=<epoch ms>]
          -> POST {ncm.base.url}rest/api/v1/event
             Only "Device Compliant" / "Device NonCompliant" audit events,
             newest first, since `since` (default: 365 days ago; never more
             than 730 days, never in the future).

  Responses:
    200  NCM's JSON, unchanged.
    400  Unknown op or malformed `since`.
    404  "NCM not configured" — ncm-proxy.properties is absent. The App View
         treats this as "feature off" and shows nothing.
    405  Any method other than GET.
    500  ncm-proxy.properties exists but is invalid.
    502  NCM unreachable, rejected the credentials, or returned an error.

  Authentication:
    NCM issues short-lived Bearer tokens (expires_in 900s). The proxy logs in
    with ncm.user / ncm.password, caches the token until 60s before expiry,
    and logs in again on a 401 (once per request). The browser never sees
    the credentials or the token.

  Configuration:
    ncm-proxy.properties next to this JSP (copy ncm-proxy.properties.example).
    Read once per servlet-container lifetime: correcting a value needs a
    Performance Center restart. On first load the password is rewritten with
    an {obfuscated} prefix so it isn't in plain text on disk.

  Container compatibility:
    The declaration block uses only JDK types, so this compiles under both
    javax.servlet and jakarta.servlet containers (Jetty 12 / Jakarta EE 10).
--%>
<%@ page import="java.io.*,java.net.*,java.util.*,java.util.regex.*" %>
<%@ page import="javax.net.ssl.*,java.security.cert.X509Certificate" %>
<%!
    private static final String PROPS_FILENAME = "ncm-proxy.properties";
    private static final String OBFUSCATED_PREFIX = "{obfuscated}";

    private static final long DAY_MS = 24L * 60 * 60 * 1000;
    private static final long DEFAULT_LOOKBACK_MS = 365 * DAY_MS;
    private static final long MAX_LOOKBACK_MS = 730 * DAY_MS;
    private static final int RECORD_LIMIT = 10000;

    // Log in again this long before the token's stated expiry, to absorb clock
    // drift and the time the login and the forwarded call themselves take.
    private static final long TOKEN_REFRESH_BUFFER_MS = 60_000L;
    private static final long DEFAULT_EXPIRES_IN_SEC = 900L;

    private static final Pattern ACCESS_TOKEN_RE =
        Pattern.compile("\"access_token\"\\s*:\\s*\"([^\"]*)\"");
    private static final Pattern EXPIRES_IN_RE =
        Pattern.compile("\"expires_in\"\\s*:\\s*(\\d+)");
    private static final Pattern EPOCH_MS_RE = Pattern.compile("^\\d{1,15}$");

    // devices/info rejects a missing or empty filter list (HTTP 500), so ask
    // for every device with a match-all condition.
    private static final String DEVICES_BODY =
        "{\"limit\":" + RECORD_LIMIT + ",\"offset\":0,"
        + "\"filterComponents\":[{\"attributeName\":\"deviceName\",\"operator\":\"regex\",\"value\":\".*\"}]}";

    private static final Object CONFIG_LOCK = new Object();
    private static volatile boolean configLoaded = false;
    private static String ncmBase;
    private static String ncmUser;
    private static String ncmPassword;
    private static SSLSocketFactory permissiveSocketFactory;
    private static HostnameVerifier permissiveHostnameVerifier;

    private static final Object TOKEN_LOCK = new Object();
    private static String cachedToken;
    private static long tokenExpiresAtMs;

    /** Thrown for problems the caller should see as a specific HTTP status. */
    private static final class ProxyException extends Exception {
        final int status;
        ProxyException(int status, String message) { super(message); this.status = status; }
    }

    private static void loadConfigIfNeeded(File propsFile) throws IOException {
        if (configLoaded) return;
        synchronized (CONFIG_LOCK) {
            if (configLoaded) return;

            Properties props = new Properties();
            try (InputStream in = new FileInputStream(propsFile)) {
                props.load(in);
            }

            String base = require(props, "ncm.base.url");
            ncmBase = base.endsWith("/") ? base : base + "/";
            ncmUser = require(props, "ncm.user");
            String rawPass = require(props, "ncm.password");
            boolean verifySsl = Boolean.parseBoolean(
                props.getProperty("ncm.ssl.verify", "true").trim());

            boolean needsRewrite = !rawPass.startsWith(OBFUSCATED_PREFIX);
            ncmPassword = needsRewrite
                ? rawPass
                : new String(Base64.getDecoder().decode(
                      rawPass.substring(OBFUSCATED_PREFIX.length())), "UTF-8");

            if (!verifySsl) buildPermissiveSsl();

            if (needsRewrite) {
                try {
                    rewritePasswordLine(propsFile, OBFUSCATED_PREFIX
                        + Base64.getEncoder().encodeToString(ncmPassword.getBytes("UTF-8")));
                } catch (Exception e) {
                    System.err.println("ncm-proxy: could not obfuscate password in "
                        + propsFile + " (" + e.getMessage() + "); continuing with in-memory value");
                }
            }
            configLoaded = true;
        }
    }

    private static String require(Properties props, String key) {
        String v = props.getProperty(key);
        if (v == null || v.trim().isEmpty()) {
            throw new IllegalStateException("Missing required property: " + key);
        }
        return v.trim();
    }

    private static void buildPermissiveSsl() {
        try {
            TrustManager[] trustAll = new TrustManager[] {
                new X509TrustManager() {
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                    public void checkClientTrusted(X509Certificate[] c, String t) {}
                    public void checkServerTrusted(X509Certificate[] c, String t) {}
                }
            };
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, trustAll, new java.security.SecureRandom());
            permissiveSocketFactory = ctx.getSocketFactory();
            permissiveHostnameVerifier = (h, s) -> true;
        } catch (Exception e) {
            permissiveSocketFactory = null;
            permissiveHostnameVerifier = null;
        }
    }

    /**
     * Rewrite the ncm.password= line, keeping every other line. Atomic via
     * temp + rename. The temp file takes the original's permissions before
     * any content is written: a plain new file gets the default umask
     * (typically 644), and renaming it over a 600 file would leave the
     * credentials world-readable.
     */
    private static void rewritePasswordLine(File propsFile, String newValue) throws IOException {
        File tmp = new File(propsFile.getParentFile(), propsFile.getName() + ".tmp");
        java.nio.file.Files.deleteIfExists(tmp.toPath());
        java.nio.file.Files.createFile(tmp.toPath());
        try {
            java.nio.file.Files.setPosixFilePermissions(tmp.toPath(),
                java.nio.file.Files.getPosixFilePermissions(propsFile.toPath()));
        } catch (UnsupportedOperationException e) {
            // Non-POSIX filesystem (Windows): permissions are inherited from the folder's ACL.
        }
        List<String> lines = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream(propsFile), "UTF-8"))) {
            String line;
            while ((line = r.readLine()) != null) {
                String t = line.trim();
                lines.add(t.startsWith("ncm.password=") || t.startsWith("ncm.password ")
                    ? "ncm.password=" + newValue : line);
            }
        }
        try (BufferedWriter w = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(tmp), "UTF-8"))) {
            for (String line : lines) { w.write(line); w.newLine(); }
        }
        java.nio.file.Files.move(tmp.toPath(), propsFile.toPath(),
            java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    }

    private static void applySsl(HttpURLConnection conn) {
        if (conn instanceof HttpsURLConnection && permissiveSocketFactory != null) {
            HttpsURLConnection https = (HttpsURLConnection) conn;
            https.setSSLSocketFactory(permissiveSocketFactory);
            https.setHostnameVerifier(permissiveHostnameVerifier);
        }
    }

    private static String readAll(InputStream in) throws IOException {
        if (in == null) return "";
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) != -1) buf.write(chunk, 0, n);
        return buf.toString("UTF-8");
    }

    private static String snippet(String body) {
        String s = body == null ? "" : body.replaceAll("\\s+", " ").trim();
        return s.length() > 300 ? s.substring(0, 300) + "..." : s;
    }

    /** A fresh Bearer token: the cached one unless it's near expiry or forceRefresh. */
    private static String getNcmToken(boolean forceRefresh) throws IOException, ProxyException {
        synchronized (TOKEN_LOCK) {
            if (!forceRefresh && cachedToken != null && System.currentTimeMillis() < tokenExpiresAtMs) {
                return cachedToken;
            }
            String body = "username=" + URLEncoder.encode(ncmUser, "UTF-8")
                + "&password=" + URLEncoder.encode(ncmPassword, "UTF-8");

            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(ncmBase + "rest/api/v1/auth/token").openConnection();
                applySsl(conn);
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout(30_000);
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                conn.setRequestProperty("Accept", "application/json");
                conn.setDoOutput(true);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(body.getBytes("UTF-8"));
                }
                int status = conn.getResponseCode();
                String resp = readAll(status >= 200 && status < 300 ? conn.getInputStream() : conn.getErrorStream());
                // NCM 25.4 answers a wrong username or password with HTTP 500
                // {"code":"REST-Generic","message":"Failed to authenticate user "},
                // not 401/403 — match the message so the admin is told what to fix.
                if (status == 401 || status == 403 || resp.contains("Failed to authenticate")) {
                    throw new ProxyException(502, "NCM rejected the configured credentials (HTTP " + status
                        + ") - check ncm.user / ncm.password in " + PROPS_FILENAME);
                }
                if (status < 200 || status >= 300) {
                    throw new ProxyException(502, "NCM login failed: HTTP " + status + " " + snippet(resp));
                }
                Matcher tm = ACCESS_TOKEN_RE.matcher(resp);
                if (!tm.find()) throw new ProxyException(502, "NCM login response had no access_token");
                long expiresInSec = DEFAULT_EXPIRES_IN_SEC;
                Matcher em = EXPIRES_IN_RE.matcher(resp);
                if (em.find()) expiresInSec = Long.parseLong(em.group(1));

                cachedToken = tm.group(1);
                tokenExpiresAtMs = System.currentTimeMillis() + expiresInSec * 1000L - TOKEN_REFRESH_BUFFER_MS;
                return cachedToken;
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
    }

    /** NCM's "Device Compliant" / "Device NonCompliant" events at or after sinceMs, newest first. */
    private static String eventsBody(long sinceMs) {
        String since = java.time.Instant.ofEpochMilli(sinceMs).toString();
        // `==` on ACTION_TYPE is exact and case-insensitive; `regex` is
        // case-sensitive against NCM's upper-case stored values, so avoid it.
        return "{\"filter\":{\"filterComponents\":[{\"operator\":\"&&\",\"filterComponents\":["
            + "{\"operator\":\"||\",\"filterComponents\":["
            + "{\"attributeName\":\"ACTION_TYPE\",\"operator\":\"==\",\"value\":\"Device Compliant\"},"
            + "{\"attributeName\":\"ACTION_TYPE\",\"operator\":\"==\",\"value\":\"Device NonCompliant\"}]},"
            + "{\"attributeName\":\"EVENT_TIME\",\"operator\":\">=\",\"value\":\"" + since + "\"}]}]},"
            + "\"orderByInfo\":[{\"columnType\":\"EVENT_TIME\",\"orderDirection\":\"DESC\"}],"
            + "\"limit\":" + RECORD_LIMIT + ",\"offset\":0}";
    }

    /** POST a fixed JSON body to an NCM path; retry once with a fresh token on 401. */
    private static String callNcm(String path, String jsonBody) throws IOException, ProxyException {
        boolean forceRefresh = false;
        for (int attempt = 0; attempt < 2; attempt++) {
            String token = getNcmToken(forceRefresh);
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(ncmBase + "rest/api/v1/" + path).openConnection();
                applySsl(conn);
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout(60_000);
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Authorization", "Bearer " + token);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setRequestProperty("Accept", "application/json");
                conn.setDoOutput(true);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(jsonBody.getBytes("UTF-8"));
                }
                int status = conn.getResponseCode();
                if (status == 401 && attempt == 0) {   // token revoked or expired early
                    forceRefresh = true;
                    continue;
                }
                String resp = readAll(status >= 200 && status < 300 ? conn.getInputStream() : conn.getErrorStream());
                if (status < 200 || status >= 300) {
                    throw new ProxyException(502, "NCM " + path + " returned HTTP " + status + ": " + snippet(resp));
                }
                return resp;
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        throw new ProxyException(502, "NCM rejected a freshly issued token for " + path);
    }
%>
<%
    response.setHeader("Cache-Control", "no-store");

    if (!"GET".equals(request.getMethod())) {
        response.setStatus(HttpServletResponse.SC_METHOD_NOT_ALLOWED);
        response.setHeader("Allow", "GET");
        return;
    }

    // Resolve the properties file next to this JSP. Absent means the site
    // hasn't configured NCM, which is a normal state, not an error.
    File propsFile;
    try {
        String ctxPath = request.getContextPath();
        String reqUri = request.getRequestURI();
        String relPath = reqUri.startsWith(ctxPath) ? reqUri.substring(ctxPath.length()) : reqUri;
        String jspRealPath = application.getRealPath(relPath);
        if (jspRealPath == null) throw new IOException("Cannot resolve real path for " + relPath);
        propsFile = new File(new File(jspRealPath).getParentFile(), PROPS_FILENAME);
    } catch (Exception e) {
        application.log("ncm-proxy: cannot locate " + PROPS_FILENAME, e);
        response.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
        response.setContentType("text/plain");
        response.getWriter().write("Proxy misconfigured: " + e.getMessage());
        return;
    }
    if (!configLoaded && !propsFile.isFile()) {
        response.setStatus(HttpServletResponse.SC_NOT_FOUND);
        response.setContentType("text/plain");
        response.getWriter().write("NCM not configured");
        return;
    }
    try {
        loadConfigIfNeeded(propsFile);
    } catch (Exception e) {
        // Logged as well as returned: a load balancer in front of the Portal
        // may replace this body with its own error page.
        application.log("ncm-proxy: config load failed", e);
        response.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
        response.setContentType("text/plain");
        response.getWriter().write("Proxy misconfigured: " + e.getMessage());
        return;
    }

    String op = request.getParameter("op");
    String path;
    String body;
    if ("devices".equals(op)) {
        path = "network/null/devices/info";
        body = DEVICES_BODY;
    } else if ("events".equals(op)) {
        long now = System.currentTimeMillis();
        long since = now - DEFAULT_LOOKBACK_MS;
        String sinceParam = request.getParameter("since");
        if (sinceParam != null && !sinceParam.isEmpty()) {
            if (!EPOCH_MS_RE.matcher(sinceParam).matches()) {
                response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
                response.setContentType("text/plain");
                response.getWriter().write("since must be epoch milliseconds");
                return;
            }
            since = Math.min(now, Math.max(now - MAX_LOOKBACK_MS, Long.parseLong(sinceParam)));
        }
        path = "event";
        body = eventsBody(since);
    } else {
        response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
        response.setContentType("text/plain");
        response.getWriter().write("op must be 'devices' or 'events'");
        return;
    }

    try {
        String json = callNcm(path, body);
        response.setStatus(HttpServletResponse.SC_OK);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write(json);
    } catch (ProxyException e) {
        application.log("ncm-proxy: " + e.getMessage());
        response.setStatus(e.status);
        response.setContentType("text/plain");
        response.getWriter().write(e.getMessage());
    } catch (Exception e) {
        application.log("ncm-proxy: NCM call failed", e);
        response.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
        response.setContentType("text/plain");
        response.getWriter().write("NCM unreachable: " + e.getMessage());
    }
%>
