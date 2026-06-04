<%--
  Same-origin proxy from the App View to the Data Aggregator's REST
  WebServices (/rest/sdn/networkpath/filtered/).

  Why this exists:
    The browser cannot call the DA directly — different host, Basic auth
    credentials would be exposed, and the DA's cert is often self-signed
    in dev. This JSP runs on PC's Jetty/Tomcat (same origin as the App
    View) and forwards the request server-side with Basic auth injected.

    Used specifically to map AppNeta path ids to PC SdnItemIDs, which PC
    OData doesn't expose as a queryable inventory entity. The mapped
    ItemIDs feed the network-path popup's "open in PC" link.

  Deployment:
    Ships inside WeatherMap.zip. Reachable at
    /pc/apps/user/WeatherMap/da-proxy.jsp.

  Configuration:
    All environment-specific values (target URL, credentials, SSL flag)
    live in da-proxy.properties next to this JSP. Edit that file, not
    this one. On first request the JSP base64-encodes the password in
    the file and marks it with an {obfuscated} prefix so it isn't
    sitting in plaintext.

  Security:
    - No path parameter — the target URL is fixed by da.target.url in
      the properties file. Removes SSRF risk entirely.
    - Only POST is forwarded (the only verb this endpoint needs).
    - SSL verification is controlled by da.ssl.verify in the properties
      file. For production, install the DA cert in the container's
      truststore and set da.ssl.verify=true.
--%>
<%@ page import="java.io.*,java.net.*,java.util.*" %>
<%@ page import="javax.net.ssl.*,java.security.cert.X509Certificate" %>
<%!
    private static final String PROPS_FILENAME = "da-proxy.properties";
    private static final String OBFUSCATED_PREFIX = "{obfuscated}";

    // Populated on first request from da-proxy.properties.
    private static final Object CONFIG_LOCK = new Object();
    private static volatile boolean configLoaded = false;
    private static String targetUrl;
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

            targetUrl = require(props, "da.target.url");
            String user = require(props, "da.user");
            String rawPass = require(props, "da.password");
            boolean verifySsl = Boolean.parseBoolean(
                props.getProperty("da.ssl.verify", "true").trim());

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
                    System.err.println("da-proxy: could not obfuscate password in "
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
     * Rewrite the da.password= line, preserving all other lines
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
                if (trimmed.startsWith("da.password=")
                        || trimmed.startsWith("da.password ")) {
                    lines.add("da.password=" + newValue);
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
        // Log to server too — load balancers in front of PC often replace
        // error response bodies with their own generic 5xx page, so the
        // browser can't see this message. Server logs are the source of truth.
        application.log("da-proxy: config load failed", e);
        response.setStatus(HttpServletResponse.SC_INTERNAL_SERVER_ERROR);
        response.setContentType("text/plain");
        response.getWriter().write("Proxy misconfigured: " + e.getMessage());
        return;
    }

    if (!"POST".equals(request.getMethod())) {
        response.setStatus(HttpServletResponse.SC_METHOD_NOT_ALLOWED);
        return;
    }

    HttpURLConnection conn = null;
    try {
        URL url = new URL(targetUrl);
        conn = (HttpURLConnection) url.openConnection();
        if (conn instanceof HttpsURLConnection && permissiveSocketFactory != null) {
            HttpsURLConnection https = (HttpsURLConnection) conn;
            https.setSSLSocketFactory(permissiveSocketFactory);
            https.setHostnameVerifier(permissiveHostnameVerifier);
        }
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Authorization", authHeader);

        String contentType = request.getContentType();
        conn.setRequestProperty("Content-Type",
            contentType != null ? contentType : "application/xml");
        String accept = request.getHeader("Accept");
        conn.setRequestProperty("Accept",
            accept != null ? accept : "application/xml");

        conn.setDoOutput(true);
        try (InputStream in = request.getInputStream();
             OutputStream upstreamOut = conn.getOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) upstreamOut.write(buf, 0, n);
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
