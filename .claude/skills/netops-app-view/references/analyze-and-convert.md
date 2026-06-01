# Analyze and Convert

This file is the playbook for Workflows 2 and 3 (analyzing an existing App View and converting plain HTML/JS to React+Vite). Read alongside `app-anatomy.md` and `odata-query-guide.md`.

## Part 1: How to read an existing App View

### Step 1 — Inventory the folder

```bash
ls -la <app-folder>/
```

Expect at minimum `appConfig.properties` + `index.html`. JS and CSS are typically under `assets/`, but may be alongside `index.html` in simpler apps. Note whether the JS is:

- **Source** — hand-written, readable, possibly multiple files. Easy to analyze.
- **Bundled and minified** — single large file with mangled variable names. You'll rely on grep patterns more than reading.
- **Bundled but not minified** — readable but with module boilerplate. Skim for the OData URL pattern; ignore framework internals.

Tell the user which case you're in before you start — it sets expectations for the depth of the analysis.

### Step 2 — Read appConfig.properties

This file is small, plain-text, and the most informative single source of context. Extract:

- **appName** and **description** — what the app calls itself
- **height** — visual scale (small widget vs. full-page)
- **url** — every `{Placeholder}` tells you what runtime context the app consumes. Resolve each against `url-parameters.md`. Fixed query params (like `&metric=im_UtilizationIn`) tell you what is hardcoded.
- **supportedContext** — what NetOps Portal pages this app appears on

Write this up first; it frames everything else.

### Step 3 — Find the OData query

Search the JS for OData fingerprints:

```bash
grep -oE '/pc/odata[0-9]?/api/[a-zA-Z_]+' <js-file>
grep -oE '\$(select|filter|expand|apply|top|skip|orderby|count)=[^"`&)]{1,200}' <js-file>
grep -oE '(resolution|period|duration|starttime|endtime|bh|timeout|threshold|prjoffset)=[^"`&)]{1,80}' <js-file>
```

You're looking for:
- The entity-set path: `/pc/odata4/api/devices`, `/pc/odata/api/portmfs`, etc. The `/pc/odata/` path means **OData 2.0** (older); `/pc/odata4/` means **OData 4.0**.
- The query tokens: `$select`, `$filter`, `$expand`, `$apply`, etc.
- Time controls: `resolution`, `period`, `starttime`, `endtime`.

In a minified bundle, the URL may be assembled from several string literals concatenated at runtime. Pull each piece, then mentally splice them in the order the code uses them. The variable that holds the final URL is often passed to `fetch()` or `XMLHttpRequest.open()`. Searching for those call sites narrows the assembly logic.

### Step 4 — Decode the query

Use `odata-query-guide.md` to translate each token to plain English, and `odata-query-examples.md` to spot the closest matching pattern. The summary you give the user should answer:

1. **What entity set** is it querying? (devices, interfaces, portmfs, etc.)
2. **What columns** does it select? (`$select`)
3. **What does it filter to?** (`$filter`) — translate each predicate.
4. **What does it expand?** (`$expand`) — what related entities, with what nested limits.
5. **Does it aggregate?** (`$apply`) — group-by keys and aggregate functions.
6. **What time range and granularity?** (`period`/`resolution`/`starttime`/`endtime`)
7. **Where do the appConfig URL parameters feed in?** Map `{ItemIdDA}` → which OData parameter, `{TimeStartUTC}` → `starttime`, etc.

### Step 5 — Infer rendering

Look at `index.html` for the structure scaffold, then scan the JS for:
- `document.createElement` / `innerHTML` / framework render calls — what DOM does it build?
- Chart library mentions (`Chart`, `d3`, `Plotly`, `Highcharts`) — what kind of visualization?
- Table-building code (`<tr>`, `<td>` in strings) — likely a tabular view
- CSS class names — often descriptive of the rendered widgets

Combine this with the query analysis to describe what the user sees on screen.

### Step 6 — Note debug/test mode (if present)

Most well-built apps have a debug switch. Search for:

```bash
grep -E "(debug|getParameterByName|sample[._-]?data|test[._-]?data|\\.json)" <js-file>
```

If found, the app loads a static JSON file when `?debug=1` (or similar) is in the URL. Note the file path; that JSON file is also a goldmine — it tells you the exact response shape the app expects.

## Part 2: Conversion to React+Vite

### Prerequisite

Workflow 2 must be done first. Don't start converting until the analysis is complete and the user has confirmed what the app does.

### The contract to preserve

The converted app must be a drop-in replacement:
- **`appConfig.properties`** — carry over `appName`, `description`, `url` (especially the placeholders), `height`, `supportedContext` unchanged
- **Deployable folder shape** — Vite's build output must produce `index.html` + `assets/*`. Copy `appConfig.properties` and `sample-data.json` into `dist/` post-build (the starter's `vite.config.js` does this via a small plugin).

### What changes (when source is OData 2.0)

If the original app uses OData 2.0, the query itself must change — the system no longer supports 2.0, so a verbatim port would produce a broken app. The conversion is done by the external `convertToOdata4_patched.py` script (URL in, URL out). Steps:

1. Extract the OData 2.0 URL template from the original JS.
2. Reconstruct it with placeholder values where the original injected runtime variables. (E.g., if the original built `'/pc/odata/api/devices(' + idFromUrl + ')'` at runtime, reconstruct as `/pc/odata/api/devices(123)?...` for the script.)
3. Apply the `/pc/` prefix workaround (see `odata-2-to-4.md`).
4. Surface the URL to the user with shell-safe formatting.
5. Wait for the user to paste back the 4.0 result.
6. Wire the 4.0 URL into the new app's `src/api/odata.js`, restoring the runtime variable injection points.

The contract preserved here is the *behavior* — what data the app fetches and renders — not the query string itself. The response shape may differ slightly (4.0 returns aggregates under your chosen aliases instead of the generic `Value` column from 2.0), so the rendering code needs to be adjusted to read from the new field names.

### Mapping table

| Plain HTML/JS pattern | React+Vite equivalent |
|---|---|
| Inline `<script>` in `index.html` doing setup | `src/main.jsx` mounts `<App />` to `#root` |
| `document.getElementById(...).innerHTML = ...` | JSX returned from a component, driven by `useState` |
| `addEventListener('load', ...)` | `useEffect(() => {...}, [])` |
| jQuery `$(selector).text(x)` etc. | Render text in JSX directly |
| `XMLHttpRequest` / raw `fetch` | `fetch` inside an async function in `useEffect`, results stored in state via `useState` |
| Manual URL parameter parsing | `useUrlParams` hook from the starter |
| Inline `<style>` or `style.css` | Co-located CSS modules or a single `App.css` imported into `App.jsx` |
| Bundled libraries via `<script>` tags | `npm install <lib>` + `import` in the component that uses it |
| `setTimeout` polling loop | `useEffect` with an interval, with cleanup |
| Global `var debugMode = ...` | `const isDebug = useUrlParams().get('debug') === '1'` |
| Static JSON loaded via `fetch('sample.json')` in debug | Same fetch path; place `sample-data.json` in `public/` so Vite copies it as-is |
| jQuery DataTables / sortable HTML tables | Either keep DataTables as an npm dep (works fine), or migrate to a React table lib like `@tanstack/react-table` |
| D3 visualizations | Either wrap D3 in a React component (D3 owns the DOM inside one ref), or replace with `recharts` for simpler cases |
| Chart.js | `chart.js` npm package, wrapped in a component that re-creates the chart on prop changes |

### Library migration notes

- **jQuery** — usually removable. Direct DOM manipulation becomes JSX + state. If the codebase uses jQuery heavily for non-trivial things (animations, plugins), keep it as an npm dep and call it inside `useEffect`.
- **D3** — the React-friendly pattern is to let React manage the SVG container and let D3 select and mutate inside it via a `useRef`. Don't try to map every D3 selection to JSX; the resulting code is worse than the original.
- **Chart.js** — install `chart.js` + optionally `react-chartjs-2`. The wrapper makes Chart.js feel native.
- **DataTables** — install `datatables.net` + `datatables.net-dt` for styling. Initialize on a ref'd `<table>` in `useEffect`, destroy on cleanup.

### File-by-file conversion order

0. **If the original uses OData 2.0**, do the script handoff first. The 4.0 URL it returns is what feeds every later step. See `odata-2-to-4.md`.
1. **`appConfig.properties`** — copy verbatim, change nothing.
2. **`public/sample-data.json`** — if the original used 2.0, the response shape may have changed (aggregate aliases, function name prefixes, lambda result keys). Capture a fresh response from the 4.0 URL, or regenerate from the schema. If the original used 4.0 already, copy verbatim.
3. **`src/api/odata.js`** — the OData 4.0 URL goes here. Wire in URL parameters via function arguments.
4. **`src/App.jsx`** — port the rendering. Start with the simplest case (one item rendered correctly), then loop. When source was 2.0, watch for hardcoded references to the `Value` column — these become aggregate aliases (`sumBytes`, `avgUtil`, etc.) post-conversion.
5. **Styles** — port last. Get function right first, then prettiness.
6. **Verify build output**: `npm run build && ls dist/`. Should contain `index.html`, `assets/`, `appConfig.properties`, `sample-data.json`.

### Things to flag to the user during conversion

- **OData 2.0 was found.** The system no longer supports 2.0, so this isn't a "preserve as-is" situation — the query must be run through `convertToOdata4_patched.py` before the app can work. Surface this early and don't let it slip to the end.
- **Response-shape changes after 2→4 conversion.** Aggregate aliases replace the generic `Value` column; function calls gain the `f.` prefix; navigation property results may key differently. Rendering code that hardcoded `Value` will need updates.
- **Behavior tied to `setTimeout` polling intervals** needs cleanup logic in `useEffect` returns, or the converted app will leak timers and double-fetch on dashboard updates.
- **Global state** in the original (variables at the top of the IIFE) needs to become React state or refs. Two App View instances on the same dashboard each get their own React tree, which is actually a multi-instance safety improvement.
- **iframe quirks** the original might handle (e.g., resize handling, parent-frame messages) usually carry over unchanged; React just renders into the iframe's document like any other code.
