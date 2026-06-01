<%--
  Same-origin proxy from the App View to Spectrum REST API.

  Why this exists:
    The browser cannot call Spectrum directly — different origin, Basic auth
    credentials would be exposed, and Spectrum's cert is often self-signed.
    This JSP runs on PC's Tomcat (same origin as the App View) and forwards
    the request server-side with Basic auth injected.

  Deployment:
    Ships inside WeatherMap.zip. Unzipping the App View under
    /pc/apps/user/WeatherMap/ makes this reachable at
    /pc/apps/user/WeatherMap/spectrum-proxy.jsp.

  Alternative (legacy):
    Customers who have an nginx in front of PC can use a nginx location
    instead of this JSP — see README. App View picks the right path via
    a ?proxy=jsp|nginx URL param (default jsp).

  Configuration:
    All environment-specific values (host, credentials, SSL flag) live in
    spectrum-proxy.properties next to this JSP. Edit that file, not this one.
    On first request, the JSP base64-encodes the password in the file and
    marks it with an {obfuscated} prefix so it isn't sitting in plaintext.

  Security:
    - Only the 'path' parameter is honored; the target host is fixed by
      spectrum.base.url in the properties file. This prevents SSRF.
    - 'path' must match ALLOWED_PATH regex (alphanum + a few safe chars).
    - Only GET and POST are forwarded.
    - SSL verification is controlled by spectrum.ssl.verify in the
      properties file. For production, install the Spectrum cert in PC's
      truststore and set spectrum.ssl.verify=true.
--%>
<%@ page import="java.io.*,java.net.*,java.util.*,java.util.regex.*" %>
<%@ page import="javax.net.ssl.*,java.security.cert.X509Certificate" %>
<%!
    private static final String PROPS_FILENAME = "spectrum-proxy.properties";
    private static final String OBFUSCATED_PREFIX = "{obfuscated}";

    // Whitelist of paths under /spectrum/ that are allowed to be proxied.
    private static final Pattern ALLOWED_PATH =
        Pattern.compile("^restful/[A-Za-z0-9/_.\\-]+$");
    private static final Set<String> ALLOWED_METHODS =
        new HashSet<>(Arrays.asList("GET", "POST"));

    // Populated on first request from spectrum-proxy.properties.
    private static final Object CONFIG_LOCK = new Object();
    private static volatile boolean configLoaded = false;
    private static String spectrumBase;
    private static String authHeader;
    private static SSLSocketFactory permissiveSocketFactory;
    private static HostnameVerifier permissiveHostnameVerifier;

    // Takes a plain File rather than a ServletContext so the declaration
    // block has zero dependency on the servlet API namespace — this JSP
    // ships into containers that may be either javax.servlet (Tomcat-style)
    // or jakarta.servlet (Jetty 12 / Jakarta EE 10). The scriptlet resolves
    // the file path using the implicit `application` object, whose type is
    // provided by whichever container is in play.
    private static void loadConfigIfNeeded(File propsFile) throws IOException {
        if (configLoaded) return;
        synchronized (CONFIG_LOCK) {
            if (configLoaded) return;

            Properties props = new Properties();
            try (InputStream in = new FileInputStream(propsFile)) {
                props.load(in);
            }

            spectrumBase = require(props, "spectrum.base.url");
            String user = require(props, "spectrum.user");
            String rawPass = require(props, "spectrum.password");
            boolean verifySsl = Boolean.parseBoolean(
                props.getProperty("spectrum.ssl.verify", "true").trim());

            String password;
            boolean needsRewrite;
            if (rawPass.startsWith(OBFUSCATED_PREFIX)) {
                String encoded = rawPass.substring(OBFUSCATED_PREFIX.length());
                password = new String(Base64.getDecoder().decode(encoded), "UTF-8");
                needsRewrite = false;
            } else {
                password = rawPass;
                needsRewrite = true;
            }

            authHeader = "Basic " + Base64.getEncoder().encodeToString(
                (user + ":" + password).getBytes("UTF-8"));

            if (!verifySsl) {
                buildPermissiveSsl();
            }

            if (needsRewrite) {
                String encoded = Base64.getEncoder().encodeToString(
                    password.getBytes("UTF-8"));
                try {
                    rewritePasswordLine(propsFile, OBFUSCATED_PREFIX + encoded);
                } catch (Exception e) {
                    System.err.println("spectrum-proxy: could not obfuscate password in "
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

    /**
     * Rewrite the spectrum.password= line, preserving all other lines
     * (comments, blanks, other properties) verbatim. Atomic via temp+rename.
     */
    private static void rewritePasswordLine(File propsFile, String newValue) throws IOException {
        File tmp = new File(propsFile.getParentFile(), propsFile.getName() + ".tmp");
        List<String> lines = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream(propsFile), "UTF-8"))) {
            String line;
            while ((line = r.readLine()) != null) {
                String trimmed = line.trim();
                if (trimmed.startsWith("spectrum.password=")
                        || trimmed.startsWith("spectrum.password ")) {
                    lines.add("spectrum.password=" + newValue);
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
        // Log to Tomcat too — load balancers in front of PC often replace
        // error response bodies with their own generic 5xx page, so the
        // browser can't see this message. Server logs are the source of truth.
        application.log("spectrum-proxy: config load failed", e);
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

    String targetUrl = spectrumBase + path;
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
        response.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
        response.setContentType("text/plain");
        response.getWriter().write("Proxy error: " + e.getMessage());
    } finally {
        if (conn != null) conn.disconnect();
    }
%>
