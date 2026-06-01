<%--
  Same-origin proxy from the App View to the AppNeta REST API.

  Why this exists:
    The browser cannot call AppNeta directly — different origin, and the API
    token must never ship to the browser. This JSP runs on PC's servlet
    container (same origin as the App View) and forwards the request
    server-side with `Authorization: Token <key>` injected.

  Deployment:
    Ships inside WeatherMap.zip. Unzipping the App View under
    /pc/apps/user/WeatherMap/ makes this reachable at
    /pc/apps/user/WeatherMap/appneta-proxy.jsp.

  Configuration:
    All environment-specific values (host, token, org id, SSL flag) live in
    appneta-proxy.properties next to this JSP. Edit that file, not this one.
    On first request the JSP base64-encodes the token in the file and marks
    it with an {obfuscated} prefix so it isn't sitting in plaintext.

  URL shape:
    /pc/apps/user/WeatherMap/appneta-proxy.jsp?path=v3/path
    /pc/apps/user/WeatherMap/appneta-proxy.jsp?path=v3/path/data&from=...&to=...
    /pc/apps/user/WeatherMap/appneta-proxy.jsp?path=v4/networkPath
    /pc/apps/user/WeatherMap/appneta-proxy.jsp?path=v4/monitoringPoint

  The `path` parameter is whitelisted; everything else is forwarded as a
  query parameter. The proxy injects `orgId=<configured>` on every request
  so callers never see the org id, and any caller-supplied orgId is dropped.

  Security:
    - Only the 'path' parameter selects the upstream resource; the target
      host is fixed by appneta.base.url in the properties file. Prevents SSRF.
    - 'path' must match ALLOWED_PATH (alphanum + a few safe chars, scoped
      to the AppNeta endpoints this App View actually uses).
    - Only GET is forwarded. AppNeta path/MP reads are the only thing the
      App View ever needs.
    - SSL verification is on by default; flip appneta.ssl.verify=false in
      properties only for a self-signed on-prem deployment.
--%>
<%@ page import="java.io.*,java.net.*,java.util.*,java.util.regex.*" %>
<%@ page import="javax.net.ssl.*,java.security.cert.X509Certificate" %>
<%!
    private static final String PROPS_FILENAME = "appneta-proxy.properties";
    private static final String OBFUSCATED_PREFIX = "{obfuscated}";

    // Whitelist scoped to the endpoints the App View actually consumes.
    // v3 path inventory + bulk metrics, plus per-path lookups. v4 inventory.
    private static final Pattern ALLOWED_PATH = Pattern.compile(
        "^(v3/path(/data)?|v3/path/\\d+(/data)?|v4/networkPath(/\\d+)?|v4/monitoringPoint(/\\d+)?)$");
    private static final Set<String> ALLOWED_METHODS =
        new HashSet<>(Arrays.asList("GET"));

    private static final Object CONFIG_LOCK = new Object();
    private static volatile boolean configLoaded = false;
    private static String appnetaBase;
    private static String authHeader;
    private static String orgId;
    private static SSLSocketFactory permissiveSocketFactory;
    private static HostnameVerifier permissiveHostnameVerifier;

    // Same javax/jakarta-agnostic loader signature as spectrum-proxy.jsp:
    // takes a plain File so this declaration block has zero dependency on
    // the servlet API namespace.
    private static void loadConfigIfNeeded(File propsFile) throws IOException {
        if (configLoaded) return;
        synchronized (CONFIG_LOCK) {
            if (configLoaded) return;

            Properties props = new Properties();
            try (InputStream in = new FileInputStream(propsFile)) {
                props.load(in);
            }

            appnetaBase = require(props, "appneta.base.url");
            orgId = require(props, "appneta.org.id");
            String rawToken = require(props, "appneta.token");
            boolean verifySsl = Boolean.parseBoolean(
                props.getProperty("appneta.ssl.verify", "true").trim());

            String token;
            boolean needsRewrite;
            if (rawToken.startsWith(OBFUSCATED_PREFIX)) {
                String encoded = rawToken.substring(OBFUSCATED_PREFIX.length());
                token = new String(Base64.getDecoder().decode(encoded), "UTF-8");
                needsRewrite = false;
            } else {
                token = rawToken;
                needsRewrite = true;
            }

            authHeader = "Token " + token;

            if (!verifySsl) {
                buildPermissiveSsl();
            }

            if (needsRewrite) {
                String encoded = Base64.getEncoder().encodeToString(
                    token.getBytes("UTF-8"));
                try {
                    rewriteTokenLine(propsFile, OBFUSCATED_PREFIX + encoded);
                } catch (Exception e) {
                    System.err.println("appneta-proxy: could not obfuscate token in "
                        + propsFile + " (" + e.getMessage()
                        + "); continuing with in-memory value");
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

    private static void rewriteTokenLine(File propsFile, String newValue) throws IOException {
        File tmp = new File(propsFile.getParentFile(), propsFile.getName() + ".tmp");
        List<String> lines = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream(propsFile), "UTF-8"))) {
            String line;
            while ((line = r.readLine()) != null) {
                String trimmed = line.trim();
                if (trimmed.startsWith("appneta.token=")
                        || trimmed.startsWith("appneta.token ")) {
                    lines.add("appneta.token=" + newValue);
                } else {
                    lines.add(line);
                }
            }
        }
        try (BufferedWriter w = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(tmp), "UTF-8"))) {
            for (String line : lines) {
                w.write(line);
                w.newLine();
            }
        }
        java.nio.file.Files.move(tmp.toPath(), propsFile.toPath(),
            java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    }
%>
<%
    response.setHeader("Cache-Control", "no-store");

    String ctxPath = request.getContextPath();
    String reqUri = request.getRequestURI();
    String relPath = reqUri.startsWith(ctxPath) ? reqUri.substring(ctxPath.length()) : reqUri;

    try {
        String jspRealPath = application.getRealPath(relPath);
        if (jspRealPath == null) {
            throw new IOException("Cannot resolve real path for " + relPath);
        }
        File propsFile = new File(new File(jspRealPath).getParentFile(), PROPS_FILENAME);
        loadConfigIfNeeded(propsFile);
    } catch (Exception e) {
        // GCP LB in front of PC replaces 5xx bodies with its own page, so
        // log to the container too — server logs are the source of truth.
        application.log("appneta-proxy: config load failed", e);
        response.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
        response.setContentType("text/plain");
        response.getWriter().write("Proxy misconfigured: " + e.getMessage());
        return;
    }

    if (!ALLOWED_METHODS.contains(request.getMethod())) {
        response.setStatus(HttpServletResponse.SC_METHOD_NOT_ALLOWED);
        return;
    }

    String path = request.getParameter("path");
    if (path == null || !ALLOWED_PATH.matcher(path).matches()) {
        response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
        response.setContentType("text/plain");
        response.getWriter().write("Invalid or missing 'path' parameter");
        return;
    }

    // Rebuild query string: drop our 'path' control param, drop any
    // caller-supplied 'orgId' (we inject the configured one), keep the rest.
    StringBuilder qs = new StringBuilder();
    Enumeration<String> paramNames = request.getParameterNames();
    while (paramNames.hasMoreElements()) {
        String p = paramNames.nextElement();
        if ("path".equals(p) || "orgId".equals(p)) continue;
        for (String v : request.getParameterValues(p)) {
            if (qs.length() > 0) qs.append('&');
            qs.append(URLEncoder.encode(p, "UTF-8")).append('=')
              .append(URLEncoder.encode(v, "UTF-8"));
        }
    }
    if (qs.length() > 0) qs.append('&');
    qs.append("orgId=").append(URLEncoder.encode(orgId, "UTF-8"));

    String targetUrl = appnetaBase + path + "?" + qs;

    HttpURLConnection conn = null;
    try {
        URL url = new URL(targetUrl);
        conn = (HttpURLConnection) url.openConnection();
        if (conn instanceof HttpsURLConnection && permissiveSocketFactory != null) {
            HttpsURLConnection https = (HttpsURLConnection) conn;
            https.setSSLSocketFactory(permissiveSocketFactory);
            https.setHostnameVerifier(permissiveHostnameVerifier);
        }
        conn.setRequestMethod("GET");
        conn.setRequestProperty("Authorization", authHeader);

        String accept = request.getHeader("Accept");
        conn.setRequestProperty("Accept", accept != null ? accept : "application/json");

        int status = conn.getResponseCode();
        response.setStatus(status);
        String respCT = conn.getHeaderField("Content-Type");
        if (respCT != null) response.setContentType(respCT);

        InputStream src = (status >= 200 && status < 400)
            ? conn.getInputStream() : conn.getErrorStream();
        if (src != null) {
            try (OutputStream clientOut = response.getOutputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = src.read(buf)) != -1) clientOut.write(buf, 0, n);
            } finally {
                src.close();
            }
        }
    } catch (Exception e) {
        response.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
        response.setContentType("text/plain");
        response.getWriter().write("Proxy error: " + e.getMessage());
    } finally {
        if (conn != null) conn.disconnect();
    }
%>
