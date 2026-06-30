# WeatherMap — Build Guide

How to build `WeatherMap.zip` from source. See the main
[README](../README.md) for downloading, installing, configuring, and
running a pre-built release — this doc is for producing that release
in the first place.

---

## Prerequisites

- **Node.js 18 or 20** — Vite 5 (this project's build tool) requires
  one of these.
- **npm** — ships with Node.
- **git** — to clone the repository.
- **zip** — standard on macOS and Linux. On Windows, use WSL or Git
  Bash.
- *(Optional)* SSH access to a NetOps Portal host, if you want
  `build.sh` to copy the built zip there for you.

---

## Clone and install

```bash
git clone <repository-url> WeatherMap
cd WeatherMap
npm install
```

**If `npm install` fails with 403/404 on a package** — your npm
registry configuration is blocking a public package. Check for a
corporate proxy/registry override (`.npmrc`) and confirm it can reach
whatever registry your packages come from.

---

## Build

The wrapper script builds, packages, and (optionally) copies the
result to a portal host:

```bash
SCP_TARGET=<user>@<portal-host>:~/. ./build.sh   # build + scp
SCP_TARGET=none ./build.sh                       # build only, no scp
```

`SCP_TARGET` is required — the script exits with an error and a usage
hint if it's unset.

Or build manually:

```bash
npm install
npm run build
rm -rf WeatherMap WeatherMap.zip
mv dist WeatherMap
zip -r WeatherMap.zip WeatherMap
```

Either way produces `WeatherMap.zip` in the project root, ready to
install via either method in the main README's
[Install](../README.md#install) section.

### Why the rename-then-zip step

The portal expects the zip's **top-level entry to be the app folder
itself** (`WeatherMap/index.html`, …), not the bare `dist/` contents.
`vite build` outputs to `dist/`, so the build step renames it to
`WeatherMap/` before zipping — zipping `dist/` directly would produce
the wrong shape and the app wouldn't appear in the portal's App View
dropdown.

### Why `vite.config.js` sets `base: './'`

```js
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
  },
})
```

The portal serves the app from a path it controls
(`/pc/apps/user/WeatherMap/`), not one this project controls. Without
`base: './'`, Vite would emit absolute asset paths (`/assets/...`)
that 404 once deployed. This setting is load-bearing — don't remove it
when touching the Vite config.

---

## Local development (without building)

```bash
npm install
npm run dev
```

Vite serves the app at `http://localhost:8888`. Append `?debug=1` to
bypass the OData / Spectrum / AppNeta calls and render sample devices
across the US — useful for visual checks without portal access or any
backend configured.

---

## Project layout

```
WeatherMap/
├── README.md
├── package.json
├── vite.config.js                      ← base: './' is critical
├── index.html
├── build.sh                            ← build + zip + optional scp
├── docs/
│   ├── BUILD.md                        ← this file
│   ├── BACKEND_CONFIGURATION.md
│   └── weathermap-screenshot.png
├── public/                             ← copied verbatim into the zip
│   ├── appConfig.properties
│   ├── runtime-config.json
│   ├── spectrum-proxy.jsp              ← Spectrum same-origin proxy
│   ├── spectrum-proxy.properties.example
│   ├── appneta-proxy.jsp               ← AppNeta same-origin proxy
│   ├── appneta-proxy.properties.example
│   ├── da-proxy.jsp                    ← Data Aggregator WebServices proxy
│   ├── da-proxy.properties.example
│   ├── topo-icon.png                   ← Triage View deep-link icon
│   ├── appneta-mp-icon.png             ← AppNeta MP bullseye icon
│   ├── appneta-target-icon.png         ← AppNeta target globe icon
│   └── sample-devices.csv              ← used by ?debug=1
└── src/
    ├── main.jsx                        ← loads runtime-config, mounts React
    ├── App.jsx                         ← map + overlays + data fetches
    ├── App.css
    ├── api/
    │   ├── odata.js                    ← PC devices + metrics
    │   ├── spectrum.js                 ← alarms via proxy
    │   ├── tunnels.js                  ← SD-WAN tunnels via PC OData
    │   ├── appneta.js                  ← AppNeta MPs + paths via proxy
    │   ├── networkpath.js              ← AppNeta-pathId → PC-LocalID via DA proxy
    │   └── odin.js                     ← power outages from ODIN
    ├── hooks/
    │   └── useUrlParams.js             ← parses id, startTime, endTime, debug
    ├── lib/
    │   ├── config.js                   ← runtime-config.json loader
    │   └── leaflet.rainviewer.js       ← vendored Rainviewer plugin
    └── components/
        ├── DeviceMarker.jsx            ← color-by-severity device pin
        ├── TabbedPopup.jsx             ← Site Info / Weather / Metrics / Alarms
        ├── TunnelLayer.jsx             ← SD-WAN tunnel lines
        ├── TunnelLegend.jsx            ← SD-WAN sites legend + filter
        ├── AppNetaLayer.jsx            ← AppNeta MPs + targets + paths
        ├── AppNetaLegend.jsx           ← AppNeta MPs legend + filter
        ├── PowerOutageLayer.jsx        ← ODIN outages as polygons
        ├── RainviewerControl.jsx       ← animated radar bottom-left
        └── Legend.jsx                  ← severity legend (bottom-right)
```
