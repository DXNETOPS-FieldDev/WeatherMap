---
name: app-view-jsp-proxy
description: Build or debug a JSP-based same-origin proxy shipped inside a DX NetOps Performance Center App View. Use this skill when a NetOps App View needs to call a backend service (Spectrum, an upstream REST API, etc.) from the browser without exposing credentials or hitting CORS — the typical pattern is to ship a .jsp that PC's web container processes server-side. Also use when an App View JSP returns 500 in the portal, or when planning whether to use a JSP vs an nginx reverse proxy for an App View. Companion to [[netops-app-view]].
---

# App View JSP Proxy

When an App View needs to call a backend (Spectrum REST, internal APIs) from the browser, the typical pattern is a `.jsp` shipped inside the App View zip. The portal's web container processes it server-side, so it can inject Basic auth and bypass CORS without exposing credentials to the browser.

This skill captures **everything that broke in the WeatherMap session** so the next App View JSP ships without the same debugging cycle.

## The PC runtime (verified on dev-netops.forwardinc.biz, May 2026)

Confirmed via diagnostic JSP:

| Aspect | Value |
|---|---|
| Web container | **Jetty 12.1.7** (not Tomcat, despite some legacy docs) |
| Java | **17.0.14** |
| Servlet API | **Jakarta Servlet 6** (`jakarta.servlet.*`, NOT `javax.servlet.*`) |
| Webapp context path | `/pc` |
| App View deploy path | `/opt/CA/PerformanceCenter/PC/webapps/pc/apps/user/<AppName>/` |
| Permissions | Jetty user has read+write on the App View dir |
| `application.getRealPath()` | Works correctly |
| Static asset serving | Works for any file (e.g. `.properties`, `.json`) |
| Load balancer in front | GCP LB — **replaces 5xx response bodies** with a generic "500. That's an error." page |

## Decide first: JSP or nginx?

Two backend proxy options exist. Pick before writing code:

| Option | When | Trade-off |
|---|---|---|
| **JSP inside the App View** | Self-contained ship; customer just uploads the zip and it works. No env-side config required from a separate team. | Constrained by what JSPs can do in this container; must follow all the pitfalls below. |
| **nginx reverse proxy** | Customer already runs nginx in front of PC and is willing to add a `location` block. | Cleanest code (no JSP at all in the App View) but requires coordination with whoever owns nginx. |

The WeatherMap app supports both via a `?proxy=jsp|nginx` URL param and lets the customer choose by editing `appConfig.properties`. That's a good pattern to copy when uncertainty about the deployment environment is high.

## Pitfalls that cost real debug time

### 1. Don't reference `javax.servlet.*` types in `<%! %>` declaration blocks

Jakarta Servlet 6 dropped `javax.servlet.*` entirely. Any explicit reference like:

```java
private static void loadConfig(javax.servlet.ServletContext ctx, String path)
```

…**fails to compile** because `javax.servlet.ServletContext` no longer exists. The JSP returns 500 (and the GCP LB hides the actual compile error — see pitfall 3).

**Fixes, in order of preference:**

1. **Keep declaration blocks servlet-API-agnostic.** Take plain types (`File`, `String`), resolve servlet objects in the scriptlet using implicit `application`/`request`/`response` (whose type the container provides). This is portable across javax/jakarta containers.
2. **If you must reference the type explicitly, use `jakarta.servlet.*`.** Hard-bound to current PC; will break if a customer runs an older javax-based container.

Method calls on implicit objects (`application.log(msg, throwable)`, `request.getRequestURI()`, etc.) work fine in both APIs — only **type names in declarations** are the problem.

### 2. Don't redeclare `out` as a local in scriptlets

JSP's `_jspService` already declares `JspWriter out` at method scope. A scriptlet that does:

```java
java.io.PrintWriter out = response.getWriter();  // duplicate local variable
```

…is a Java compile error. Two safe alternatives:

```java
// Option A: use a different name
java.io.PrintWriter w = response.getWriter();
w.println("hello");

// Option B: chain without binding
response.getWriter().println("hello");
```

### 3. GCP load balancer hides 5xx response bodies

The PC environment sits behind a Google Cloud load balancer. When the JSP returns any 5xx, **the LB replaces your response body with a generic HTML page** that says "500. That's an error." — your "Proxy misconfigured: ..." text never reaches the browser.

Practical consequences:

- **Don't rely on browser response body to debug 5xx.** It's gone.
- **Always include a 200-returning diagnostic mode** in any non-trivial JSP. See the diagnostic-mode pattern below.
- **Always `application.log(msg, throwable)` on the server side.** Even if the body is eaten, the trace lands in Jetty logs (`/opt/CA/PerformanceCenter/PC/logs/`).
- **For first-time deployments, ship a `hello.jsp`** that does the absolute minimum (see template). If it returns 500, JSPs aren't working in this directory at all — pivot to nginx.

### 4. Don't assume the deployment environment without testing

The WeatherMap session burned several deploy cycles on hypotheses (path resolution, servlet mapping wrappers) before confirming actual behavior with a `hello.jsp`. The right first deploy contains a hello-world JSP that dumps:

- `java.version`
- `application.getServerInfo()`
- `request.getContextPath()`, `getServletPath()`, `getRequestURI()`
- `application.getRealPath(...)` results

If any of those surprise you, your real JSP probably has assumptions that won't hold.

## Patterns that worked

### Self-diagnostic mode in your JSP

Add a `?diag=1` query parameter that returns **200 plaintext** with everything you'd need to debug. Place it before any code that can fail (config loading, file I/O). See [references/spectrum-proxy-template.jsp](references/spectrum-proxy-template.jsp) for a full example.

Keep diag mode in until the App View is verified working, then strip it before final ship.

### Robust JSP-directory lookup

To find the directory containing the running JSP (e.g. to read a sibling `.properties` file), prefer `request.getRequestURI()` minus `request.getContextPath()` over `request.getServletPath()`. The former is the literal path the client requested and survives custom servlet mappings; the latter can return a dispatcher's URL pattern in some containers.

```java
String ctxPath = request.getContextPath();
String reqUri = request.getRequestURI();
String relPath = reqUri.startsWith(ctxPath) ? reqUri.substring(ctxPath.length()) : reqUri;
String realPath = application.getRealPath(relPath);  // returns abs path on disk
File jspDir = new File(realPath).getParentFile();
```

In PC's Jetty 12, `getServletPath()` also works correctly — but the above is portable.

### Sibling `.properties` file for env config

Don't hardcode hosts/credentials in the JSP. Ship a `<jspname>.properties` next to the JSP, load it once on first request, cache via a `volatile boolean configLoaded` + `synchronized` block.

This means the customer edits one file in the unzipped App View instead of editing Java source. See [references/spectrum-proxy-template.jsp](references/spectrum-proxy-template.jsp).

### Password obfuscation (optional)

If you ship a default credential, the JSP can rewrite the properties file on first request to base64-encode the password with a marker prefix (e.g. `{obfuscated}`). On subsequent loads, the marker tells the JSP to decode rather than treat as plaintext. **It's obfuscation, not encryption** — protects against casual greps, not against anyone with file access. The Jetty user needs write permission on the App View directory (confirmed working on dev-netops).

Make the rewrite best-effort: catch failures, log via `System.err`, continue with the in-memory value. Don't fail the request if obfuscation can't happen.

## Reference template

[references/spectrum-proxy-template.jsp](references/spectrum-proxy-template.jsp) — a complete, working JSP that proxies an upstream REST API with Basic auth. Includes:

- Sibling `.properties` config loading
- Optional `{obfuscated}` password rewrite
- Configurable SSL verification (for self-signed dev certs)
- `?diag=1` diagnostic mode
- SSRF-safe path whitelist
- GET/POST forwarding only
- All the pitfall fixes baked in

Copy, rename, change the path whitelist, change the property names, ship.

## Quick checklist for a new App View JSP

- [ ] Pick JSP vs nginx (see decision table above). If unsure, support both via `?proxy=` param.
- [ ] Start from the reference template — don't hand-roll.
- [ ] No `javax.servlet.*` types in `<%! %>` blocks.
- [ ] No local variable named `out` in scriptlets.
- [ ] Include `?diag=1` mode during development.
- [ ] Ship a `hello.jsp` in the first deploy too — confirms JSP processing works in the target environment before debugging the real JSP.
- [ ] All env-specific values in a sibling `.properties` file (host, creds, SSL flag).
- [ ] `application.log(msg, throwable)` in every catch block — only reliable diagnostic when the LB swallows your response body.
- [ ] Path whitelist the upstream — `path` query param should match a regex, not be appended raw, to prevent SSRF.
- [ ] Only forward GET/POST; reject other methods.
- [ ] Strip diag mode and any `hello.jsp` before final ship.
