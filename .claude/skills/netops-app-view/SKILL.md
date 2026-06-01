---
name: netops-app-view
description: Create, analyze, or convert OpenAPI App Views for DX NetOps Performance Management. Use this skill when the user explicitly mentions an "App View", "OpenAPI app", "NetOps app", or "App View for NetOps Portal" — whether scaffolding a new one in React+Vite, explaining what an existing App View (often plain HTML/JS) does, or converting an existing plain HTML/JS App View to React+Vite. Covers appConfig.properties, URL parameter handling, OData query construction and reading, and the deployment-shape constraints (relative paths, iframe-safe, multi-instance).
---

# NetOps App View

OpenAPI App Views are visualizations that embed in the DX NetOps Performance Management Portal via iframe. Each App View is a folder containing `appConfig.properties` plus HTML/JS/CSS, zipped and deployed through Administration → Configuration Settings → App Deployment in the portal.

This skill handles three workflows:
1. **Create new** — scaffold a React+Vite App View with OData query wiring
2. **Analyze existing** — explain what an existing App View does, especially its OData query
3. **Convert** — migrate a plain HTML/JS App View to React+Vite

## Routing

Pick the workflow based on user intent:
- "Create / build / scaffold a new App View for X" → **Create new**
- "Explain / what does this App View do / review this app" + an existing folder → **Analyze existing**
- "Convert / migrate / port this App View to React" + an existing folder → **Convert**

If a user gives an existing folder without saying which they want, ask once: analyze, convert, or use as a reference for something new.

## Required reading

Always read `references/app-anatomy.md` first — it covers the folder layout, the `appConfig.properties` schema, deployment, and the cross-cutting constraints (relative paths, iframe isolation, no portal JS/CSS, multi-instance, debug mode).

For any workflow involving an OData query (almost always):
- `references/url-parameters.md` — the `{ItemIdDA}`, `{TimeStartUTC}`, `{TimeEndUTC}`, `{itemName}` substitution system the portal performs on the URL in `appConfig.properties`, plus `supportedContext` codes.
- `references/odata-query-guide.md` — OData 4.0 tokens (`for`/`$select`/`$filter`/`$expand`/`$apply`/`$top`/`$orderby`) and request paths. Includes the OData 2.0 endpoint pattern (`/pc/odata/api/`) for reading older apps.
- `references/odata-query-examples.md` — catalog of example queries by use case (inventory, time-series, top-N, aggregations, business hours, flow data, alarms, baselines, counts, projections). Read this when constructing or interpreting a query.

For workflows 2 and 3:
- `references/analyze-and-convert.md` — checklist for reading an existing app and the mapping from plain HTML/JS patterns to React+Vite equivalents.
- `references/odata-2-to-4.md` — the handoff protocol for the external OData 2.0 → 4.0 conversion script. Required reading whenever a 2.0 query is detected.

## Workflow 1: Create new App View

1. Clarify with the user before coding:
   - **App name** → becomes `appName` in `appConfig.properties`
   - **Context** — what page does it appear on? Device, Interface, Server, Router, Group, or all? Maps to `supportedContext` (`d`/`i`/`s`/`r`/`g`/`nc`). Multiple values comma-separated.
   - **Data to display** — what does the user want to visualize? Drives the OData query.
   - **URL parameters needed** — usually some combination of `{ItemIdDA}`, `{TimeStartUTC}`, `{TimeEndUTC}`, `{itemName}`. Add a fixed metric param if the app is dedicated to one metric.
   - **Height** — iframe pixel height (default 250; rich views typically 600–900).

2. Construct the OData query. Default to OData 4.0 (`/pc/odata4/api/...`) for new builds. Use `odata-query-examples.md` for the closest matching pattern and adapt it. Always use a relative path.

3. Copy `assets/starter-react-vite/` to `/mnt/user-data/outputs/<app-name>/` and customize:
   - `appConfig.properties` — `appName`, `description`, `url`, `height`, `supportedContext`
   - `src/api/odata.js` — relative endpoint, query construction from URL params, and the debug-mode static-data fallback
   - `src/App.jsx` — render the data; put labels in one localizable spot; give every rendered element a stable CSS class
   - `public/sample-data.json` — small realistic sample of the OData response, used when `?debug=1` is in the URL
   - `vite.config.js` — already configured to produce the deployable shape

4. Build verification: after `npm install && npm run build`, the `dist/` folder should contain `index.html` + `assets/*` + `appConfig.properties` + `sample-data.json`. That's the deployable shape; zip `dist/` and upload via App Deployment.

5. Present the folder with `present_files`. Tell the user the deploy steps: `npm install && npm run build` → zip `dist/` → upload via Administration → Configuration Settings → App Deployment.

## Workflow 2: Analyze existing App View

1. List the folder. Confirm the shape: at minimum `appConfig.properties` + `index.html`, plus some JS/CSS. If the JS is a single bundled minified file (a built artifact rather than source), say so up front — analysis will rely on grep patterns more than reading source.

2. Read `appConfig.properties` first. Report:
   - **appName** and **description**
   - **height**
   - **URL parameters used** — every `{...}` placeholder in the `url` field. Each tells you what context data the portal injects. Use `url-parameters.md` to explain each.
   - **supportedContext** — what NetOps pages this app can appear on.

3. Find the OData query in the code. Search the JS for:
   - Strings containing `/pc/odata/api/` (OData 2.0) or `/pc/odata4/api/` (OData 4.0)
   - `$select=`, `$filter=`, `$expand=`, `$apply=`, `$top=`, `$orderby=`
   - Entity-set names like `devices`, `interfaces`, `cpumfs`, `portmfs`, `groups`, `flowdevices`, `flowconversationmfs`
   
   Reconstruct the full query URL. If the JS is minified, you may need to splice tokens from several locations.

4. Decode the query using `odata-query-guide.md` and `odata-query-examples.md`. Summarize for the user:
   - Which entity set is queried (and which OData version)
   - What it filters on
   - What it expands and why
   - What it aggregates (if anything)
   - How URL parameters from `appConfig.properties` feed into the query
   - What it renders (best inference from HTML structure, CSS classes, and any string literals)

5. **If the query is OData 2.0** (path is `/pc/odata/api/...`, you see `substringof(...)` calls, function calls without parens like `/getSchemaVersion`, navigation filters without lambda syntax like `groups/Name eq 'X'`), call this out explicitly: the system no longer supports 2.0, so this query will need conversion before any further work. Offer to walk the user through the script handoff — see `references/odata-2-to-4.md`. Even if the user only asked for analysis, the conversion need is information they'll want.

## Workflow 3: Convert plain HTML/JS App View to React+Vite

1. **Do Workflow 2 first.** A clean analysis is the prerequisite for a clean conversion — without it, you'll port quirks blindly.

2. **If the existing app uses OData 2.0, do the script handoff before anything else.** Extract the query template from the JS, reconstruct it with placeholder values for any runtime-injected variables, present the result to the user in a shell-safe form, and wait for them to paste back the OData 4.0 URL produced by `convertToOdata4_patched.py`. The 4.0 URL is what gets wired into the converted app — don't proceed with the React+Vite work until you have it. See `references/odata-2-to-4.md` for the full handoff protocol, including the `/pc/` prefix workaround.

3. Identify the substantive pieces to port:
   - The OData query (and any sample/static data used in debug mode)
   - The DOM rendering logic (tables, charts, lists, summary tiles)
   - Third-party libraries — jQuery, D3, Chart.js, etc. become npm deps (or get replaced with React-native equivalents like Recharts)
   - Styling (CSS files or inline)
   - URL parameter parsing

4. Scaffold from `assets/starter-react-vite/` using the `appName`, `description`, `height`, and `supportedContext` from the existing `appConfig.properties`. **Preserve the URL parameter contract exactly** — the converted app should drop into the same portal slots without reconfiguration.

5. Port piece by piece. See `references/analyze-and-convert.md` for the detailed mapping. High-level:
   - `document.getElementById` / jQuery selectors → React refs or state-driven JSX
   - Imperative DOM updates → declarative `useState` / `useEffect`
   - `new XMLHttpRequest()` or raw `fetch` calls → the `odata.js` wrapper in the starter
   - Inline HTML strings → JSX components
   - `getParameterByName` helpers → the `useUrlParams` hook in the starter

6. Wire the OData query into `src/api/odata.js`. If the original was 2.0, use the **4.0 URL produced by the script** in step 2 (not the original 2.0 URL). Preserve the relative path (`/pc/odata4/api/...`). Map the original's runtime variables (item ID, time range, etc.) to the same positions in the converted URL.

7. Build, verify the deployable shape, and present.

## Cross-cutting rules (apply in all workflows)

- **Relative paths only.** `/pc/odata4/api/...` — never include hostname or scheme. The PDF docs flag full URLs as a top breakage source behind firewalls and on DNS changes.
- **No NetOps Portal JS/CSS dependencies.** Apps are isolated in iframes and the portal may change its assets; depending on them breaks the app.
- **Internally-sourced libraries only.** Bundle libraries into the app; don't load from CDNs. Vite does this naturally with `npm` deps.
- **Multi-instance safe.** Two copies of the app on the same dashboard must coexist. Avoid hardcoded DOM IDs and global `window` pollution. React mounts to a `#root` div by default, which is fine because each iframe has its own document.
- **Debug mode.** Always support `?debug=1` — bypass the network call and use static sample data. Critical for development and for whoever maintains the app later.
- **iframe-aware.** The app runs in an iframe. Avoid `window.top`, `_top` navigation, and anything that assumes top-level window context.
- **Auth.** When using relative `/pc/odata*/api/...` paths, the app inherits NetOps Portal session auth automatically. Never put credentials or tokens in code.
- **OData version.** All new and converted App Views use OData 4.0 (`/pc/odata4/api/`). DX NetOps Performance Management no longer supports OData 2.0 (`/pc/odata/api/`), so when you find a 2.0 query in an existing app, **conversion is required, not optional.** The user has an external Python script (`convertToOdata4_patched.py`) that does the transformation. Claude's job is to (a) extract the 2.0 query cleanly from the existing code, (b) hand it to the user for conversion, and (c) integrate the resulting 4.0 query into the new app. See `references/odata-2-to-4.md` for the handoff protocol.
- **Content Security Policy.** The portal sets a strict CSP on App View responses that blocks external `<img>` sources and external `fetch()` calls by default. **Any App View that uses external map tile servers, CDN-hosted images, third-party APIs, or remote fonts will fail in deployment unless the portal's CSP is relaxed for that origin.** When scaffolding an app with external dependencies, list those origins explicitly in the README so the admin knows what to whitelist. See the CSP section in `references/app-anatomy.md` for details on which directives matter and how to extend them at the nginx (reverse proxy) layer.
- **LayersControl with dynamic-count overlay names will reorder on refresh.** If an `<Overlay name={`Devices (${count})`}>` includes live data in the name, react-leaflet sees a new `name` prop on every refresh, runs the cleanup (`removeOverlay`) and re-runs the effect (`addOverlay`), which **appends the layer to the end of Leaflet's `_layers` array**. Result: the layer whose count updated most recently sinks to the bottom of the panel, and panel order changes every minute. Fix: pass `sortLayers` + a `sortFunction` that compares by stable name prefix:
  ```jsx
  function makeSortByPrefix(order) {
    return (a, b, nameA, nameB) => {
      const ai = order.findIndex((p) => nameA.startsWith(p))
      const bi = order.findIndex((p) => nameB.startsWith(p))
      return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi)
    }
  }
  <LayersControl sortLayers sortFunction={makeSortByPrefix(['Devices', 'SD-WAN Tunnels', 'AppNeta MPs'])}>
  ```
  Same trap applies whether you have one LayersControl or multiple stacked.
- **Multiple LayersControls at the same corner need visual + label disambiguation.** Leaflet renders each LayersControl as the same stack-of-papers icon — two of them stacked at top-right are indistinguishable. Pattern that works:
  - Wrap each control in a stable CSS class (apply via a small post-mount `useEffect` that finds the controls by corner + index).
  - Tint the `.leaflet-control-layers-toggle` background (NOT the outer container — the toggle covers it). Add a small badge via `::after { content: attr(data-badge); }` in the corner, driven by a `data-badge` attribute set in JS.
  - For a styled hover tooltip (larger, bolder than the browser default), use `:hover::before { content: attr(data-tooltip); }` and remove the native `title` attribute so the two don't double up.
  - **Disable Leaflet's hover-to-expand** when you want the custom tooltip to be visible: hover normally opens the menu immediately and the tooltip never gets a chance to render. Strip with `L.DomEvent.off(ctrl, 'mouseenter mouseleave')` + `L.DomEvent.off(toggle, 'click focus')`, then bind your own click-to-toggle handler.
- **Preserve user view state across auto-refresh.** Any App View with both (a) a `useEffect` that calls a view-mutating Leaflet API like `map.fitBounds`, `map.setView`, `map.flyTo`, etc. AND (b) periodic data refresh (e.g. `setInterval` re-fetch) **must** gate the view-mutating call on a stable composition key, not just the data array's reference. React re-memos produce a new array reference even when the underlying data is identical, so a naive `useEffect(() => map.fitBounds(...), [devices, map])` will yank the user's manually-set zoom/pan back to "fit all" every refresh cycle (60s in WeatherMap's case — felt like a haunted map). Pattern:
  ```jsx
  const lastKeyRef = useRef('')
  useEffect(() => {
    if (devices.length === 0) return
    const key = devices.map((d) => d.id).sort().join(',')
    if (key === lastKeyRef.current) return    // same set, skip the fitBounds
    lastKeyRef.current = key
    map.fitBounds(L.latLngBounds(devices.map((d) => [d.latitude, d.longitude])),
                  { padding: [40, 40], maxZoom: 12 })
  }, [devices, map])
  ```
  Re-fits only when the device set actually changes (first non-empty load, or group context switch). Refreshes that don't change set composition (alarm updates, tunnel polls, AppNeta metric polls) leave the user's view alone.

## Output

All deliverables go to `/mnt/user-data/outputs/<app-name>/`. After producing files, call `present_files` to surface them.
