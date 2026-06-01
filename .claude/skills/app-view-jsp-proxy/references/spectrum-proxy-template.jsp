<%--
  TEMPLATE — Same-origin proxy from an App View to an upstream REST API.

  This template is the WeatherMap spectrum-proxy.jsp, verified working on
  PC + Jetty 12 + Jakarta Servlet 6 + Java 17 as of 2026-05.

  To adapt:
    1. Rename this file (e.g. myservice-proxy.jsp) and rename the sibling
       .properties file to match.
    2. Change UPSTREAM_PROPERTY_PREFIX, PROPS_FILENAME, ALLOWED_PATH regex
       to match your upstream API.
    3. Update Allowed methods if your API needs PUT/DELETE.
    4. Keep the diag mode during development; strip before final ship.

  Pitfall fixes baked in:
    - No javax.servlet.* types in the declaration block (Jakarta Servlet 6
      breaks them); takes a plain File instead.
    - Local writer named `w`, not `out` (JSP has implicit `out` JspWriter).
    - application.log() in catch blocks (GCP LB hides 5xx response bodies).
    - ?diag=1 mode returns 200 plaintext for browser-side debugging.
    - Path lookup uses requestURI - contextPath (portable across containers).

  Sibling .properties file format:
    upstream.base.url=https://hostname:port/api/
    upstream.user=username
    upstream.password=password    (auto-rewritten to {obfuscated}<base64> on
                                   first request, if writable)
    upstream.ssl.verify=false     (true for prod with valid certs)
--%>
<%@ page import="java.io.*,java.net.*,java.util.*,java.util.regex.*" %>
<%@ page import="javax.net.ssl.*,java.security.cert.X509Certificate" %>
<%!
    private static final String PROPS_FILENAME = "spectrum-proxy.properties";
    private static final String OBFUSCATED_PREFIX = "{obfuscated}";

    // SSRF guard — only allow paths matching this regex under the upstream base.
    private static final Pattern ALLOWED_PATH =
        Pattern.compile("^restful/[A-Za-z0-9/_.\\-]+$");
    private static final Set<String> ALLOWED_METHODS =
        new HashSet<>(Arrays.asList("GET", "POST"));

    // Populated on first request from the sibling .properties file.
    private static final Object CONFIG_LOCK = new Object();
    private static volatile boolean configLoaded = false;
    private static String upstreamBase;
    private static String authHeader;
    private static SSLSocketFactory permissiveSocketFactory;
    private static HostnameVerifier permissiveHostnameVerifier;

    // Takes a File (not ServletContext) so the declaration block has zero
    // dependency on the servlet API namespace — works under both javax.servlet
    // (older Tomcat) and jakarta.servlet (Jetty 12 / Jakarta EE 10).
    private static void loadConfigIfNeeded(File propsFile) throws IOException {
        if (configLoaded) return;
        synchronized (CONFIG_LOCK) {
            if (configLoaded) return;

            Properties props = new Properties();
            try (InputStream in = new FileInputStream(propsFile)) {
                props.load(in);
            }

            upstreamBase = require(props, "upstream.base.url");
            String user = require(props, "upstream.user");
            String rawPass = require(props, "upstream.password");
            boolean verifySsl = Boolean.parseBoolean(
                props.getProperty("upstream.ssl.verify", "true").trim());

            String password;
            boolean needsRewrite;
            if (rawPass.startsWith(OBFUSCATED_PREFIX)) {
                password = new String(Base64.getDecoder().decode(
                    rawPass.substring(OBFUSCATED_PREFIX.length())), "UTF-8");
                needsRewrite = false;
            } else {
                password = rawPass;
                needsRewrite = true;
            }

            authHeader = "Basic " + Base64.getEncoder().encodeToString(
                (user + ":" + password).getBytes("UTF-8"));

            if (!verifySsl) buildPermissiveSsl();

            if (needsRewrite) {
                String encoded = Base64.getEncoder().encodeToString(
                    password.getBytes("UTF-8"));
                try {
                    rewritePasswordLine(propsFile, OBFUSCATED_PREFIX + encoded);
                } catch (Exception e) {
                    // Obfuscation is best-effort. If write fails (read-only
                    // deploy, locked perms), keep going with in-memory value.
                    System.err.println("proxy: could not obfuscate password in "
                        + propsFile + " (" + e.getMessage() + ")");
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

    // Atomic line-level rewrite. Preserves all other lines (comments, blanks,
    // other properties) verbatim — Properties.store() would lose them.
    private static void rewritePasswordLine(File propsFile, String newValue) throws IOException {
        File tmp = new File(propsFile.getParentFile(), propsFile.getName() + ".tmp");
        List<String> lines = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream(propsFile), "UTF-8"))) {
            String line;
            while ((line = r.readLine()) != null) {
                String trimmed = line.trim();
                if (trimmed.startsWith("upstream.password=")
                        || trimmed.startsWith("upstream.password ")) {
                    lines.add("upstream.password=" + newValue);
                } else {
                    lines.add(line);
                }
            }
        }
        try (BufferedWriter wr = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(tmp), "UTF-8"))) {
            for (String line : lines) {
                wr.write(line);
                wr.newLine();
            }
        }
        java.nio.file.Files.move(tmp.toPath(), propsFile.toPath(),
            java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    }
%>
<%
    response.setHeader("Cache-Control", "no-store");

    // Portable JSP-directory lookup: requestURI minus contextPath survives
    // custom servlet mappings that might mangle getServletPath().
    String ctxPath = request.getContextPath();
    String reqUri = request.getRequestURI();
    String relPath = reqUri.startsWith(ctxPath) ? reqUri.substring(ctxPath.length()) : reqUri;

    // ?diag=1 — returns 200 plaintext with everything you'd need to debug.
    // Strip before final ship.
    if ("1".equals(request.getParameter("diag"))) {
        response.setStatus(HttpServletResponse.SC_OK);
        response.setContentType("text/plain");
        // CRITICAL: can't bind a local named `out` — JSP already has an
        // implicit `out` (JspWriter) at this method scope.
        java.io.PrintWriter w = response.getWriter();
        w.println("=== proxy JSP diagnostics ===");
        w.println("java.version=" + System.getProperty("java.version"));
        w.println("server=" + application.getServerInfo());
        w.println("servletPath=" + request.getServletPath());
        w.println("requestURI=" + reqUri);
        w.println("contextPath=" + ctxPath);
        w.println("relPath=" + relPath);
        String realPath = application.getRealPath(relPath);
        w.println("getRealPath(relPath)=" + realPath);
        if (realPath != null) {
            File jspDir = new File(realPath).getParentFile();
            w.println("jspDir=" + jspDir);
            if (jspDir != null && jspDir.exists()) {
                File props = new File(jspDir, PROPS_FILENAME);
                w.println("propsFile=" + props);
                w.println("propsFile.exists=" + props.exists());
                if (props.exists()) {
                    w.println("propsFile.canRead=" + props.canRead());
                    w.println("propsFile.canWrite=" + props.canWrite());
                    w.println("propsFile.length=" + props.length());
                }
            }
        }
        w.println("configLoaded=" + configLoaded);
        if (configLoaded) {
            w.println("upstreamBase=" + upstreamBase);
            w.println("authHeader=Basic <" + (authHeader != null
                ? (authHeader.length() - "Basic ".length()) : 0) + " encoded chars>");
        }
        return;
    }

    // ===== Real request handling =====
    try {
        String jspRealPath = application.getRealPath(relPath);
        if (jspRealPath == null) {
            throw new IOException("Cannot resolve real path for " + relPath);
        }
        File propsFile = new File(new File(jspRealPath).getParentFile(), PROPS_FILENAME);
        loadConfigIfNeeded(propsFile);
    } catch (Exception e) {
        // Log to server too — load balancers often replace error bodies.
        application.log("proxy: config load failed", e);
        response.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
        response.setContentType("text/plain");
        response.getWriter().write("Proxy misconfigured: " + e.getMessage());
        return;
    }

    String method = request.getMethod();
    if (!ALLOWED_METHODS.contains(method)) {
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

    // Rebuild any other query params (drop our 'path' control parameter).
    StringBuilder qs = new StringBuilder();
    Enumeration<String> paramNames = request.getParameterNames();
    while (paramNames.hasMoreElements()) {
        String p = paramNames.nextElement();
        if ("path".equals(p)) continue;
        for (String v : request.getParameterValues(p)) {
            if (qs.length() > 0) qs.append('&');
            qs.append(URLEncoder.encode(p, "UTF-8")).append('=')
              .append(URLEncoder.encode(v, "UTF-8"));
        }
    }

    String targetUrl = upstreamBase + path;
    if (qs.length() > 0) targetUrl += "?" + qs;

    HttpURLConnection conn = null;
    try {
        URL url = new URL(targetUrl);
        conn = (HttpURLConnection) url.openConnection();
        if (conn instanceof HttpsURLConnection && permissiveSocketFactory != null) {
            HttpsURLConnection https = (HttpsURLConnection) conn;
            https.setSSLSocketFactory(permissiveSocketFactory);
            https.setHostnameVerifier(permissiveHostnameVerifier);
        }
        conn.setRequestMethod(method);
        conn.setRequestProperty("Authorization", authHeader);

        String contentType = request.getContentType();
        if (contentType != null) conn.setRequestProperty("Content-Type", contentType);
        String accept = request.getHeader("Accept");
        if (accept != null) conn.setRequestProperty("Accept", accept);

        if ("POST".equals(method)) {
            conn.setDoOutput(true);
            try (InputStream in = request.getInputStream();
                 OutputStream upstreamOut = conn.getOutputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) upstreamOut.write(buf, 0, n);
            }
        }

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
        application.log("proxy: upstream call failed", e);
        response.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
        response.setContentType("text/plain");
        response.getWriter().write("Proxy error: " + e.getMessage());
    } finally {
        if (conn != null) conn.disconnect();
    }
%>
