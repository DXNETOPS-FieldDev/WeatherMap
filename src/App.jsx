import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, LayersControl, LayerGroup, useMap } from 'react-leaflet'
import MarkerClusterGroup from 'react-leaflet-cluster'
import L from 'leaflet'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import { useUrlParams } from './hooks/useUrlParams.js'
import { fetchDevices } from './api/odata.js'
import { fetchSpectrumAlarmsForDevices } from './api/spectrum.js'
import { fetchActiveOutages, correlateOutagesToDevices, bannerOutageCount } from './api/odin.js'
import { fetchTunnels, getTunnelMetricsStatus } from './api/tunnels.js'
import { fetchAppNetaPaths, fetchAppNetaMpDevices } from './api/appneta.js'
import { fetchNetworkPathDetails } from './api/networkpath.js'
import { fetchRadarFrames } from './api/rainviewer.js'
import { fetchNcmCompliance, ncmConfig } from './api/ncm.js'
import { ncmInfoForDevice, nonCompliantDevices } from './lib/ncm-compliance.js'
import { getConfig } from './lib/config.js'
import DeviceMarker from './components/DeviceMarker.jsx'
import RainviewerLayer from './components/RainviewerLayer.jsx'
import Legend from './components/Legend.jsx'
import PowerOutageLayer from './components/PowerOutageLayer.jsx'
import TunnelLayer from './components/TunnelLayer.jsx'
import TunnelLegend from './components/TunnelLegend.jsx'
import AppNetaLayer from './components/AppNetaLayer.jsx'
import AppNetaLegend from './components/AppNetaLegend.jsx'

// Cluster bubble takes the color of the highest-severity device inside it.
// data-severity is embedded in each marker's icon HTML by DeviceMarker.
const CLUSTER_COLOR = {
  Critical: '#d32f2f',
  Major: '#f57c00',
  Minor: '#fbc02d',
  Initial: '#1976d2',
  Normal: '#388e3c',
}
const CLUSTER_RANK = { Critical: 4, Major: 3, Minor: 2, Initial: 1, Normal: 0 }

function createClusterIcon(cluster) {
  const markers = cluster.getAllChildMarkers()
  let topRank = -1
  let topSev = 'Normal'
  for (const m of markers) {
    const html = m.options.icon?.options?.html || ''
    const match = html.match(/data-severity="([^"]+)"/)
    const sev = match ? match[1] : 'Normal'
    const rank = CLUSTER_RANK[sev] ?? 0
    if (rank > topRank) {
      topRank = rank
      topSev = sev
    }
  }
  const color = CLUSTER_COLOR[topSev] || CLUSTER_COLOR.Normal
  return L.divIcon({
    html: `<div class="device-cluster-bubble" style="background:${color}">${markers.length}</div>`,
    className: 'device-cluster',
    iconSize: [32, 32],
  })
}

const { Overlay } = LayersControl

/**
 * Returns a LayersControl.sortFunction that sorts overlays by a known
 * name-prefix order, ignoring trailing dynamic suffixes like "(125)".
 * Used to keep panel order stable when overlay names carry live counts
 * — counts changing every 60s would otherwise cause react-leaflet to
 * re-add the layer at the end of Leaflet's list, scrambling the order.
 */
/**
 * Keep "(count)" suffixes on LayersControl overlay labels current.
 *
 * react-leaflet passes an Overlay's `name` to Leaflet once, when the layer
 * first registers, and ignores later changes — so a label rendered before
 * its data arrived stays at "Devices" / "(0)" forever. This re-registers the
 * layer with the control under the new label (public removeLayer +
 * addOverlay). The layer stays on the map, so checkbox state is preserved
 * and no overlayadd/overlayremove events fire.
 *
 * `labels` maps a stable label prefix to the full label. Finding the
 * registered layer reads the control's `_layers` list; if a future Leaflet
 * renames it, labels simply stop updating rather than breaking the map.
 */
function useOverlayLabels(controlRef, labels) {
  useEffect(() => {
    const control = controlRef.current
    if (!control || !Array.isArray(control._layers)) return
    for (const [prefix, label] of Object.entries(labels)) {
      const entry = control._layers.find(
        (e) => e.overlay && typeof e.name === 'string' && e.name.startsWith(prefix),
      )
      if (entry && entry.name !== label) {
        control.removeLayer(entry.layer)
        control.addOverlay(entry.layer, label)
      }
    }
  })
}

function makeSortByPrefix(order) {
  return (layerA, layerB, nameA, nameB) => {
    const a = order.findIndex((p) => nameA.startsWith(p))
    const b = order.findIndex((p) => nameB.startsWith(p))
    // Unknown names land at the bottom (preserved relative order)
    return (a === -1 ? Infinity : a) - (b === -1 ? Infinity : b)
  }
}

export default function App() {
  const params = useUrlParams()
  const config = getConfig()
  const owmApiKey = config.owmApiKey
  const { center: defaultCenter, zoom: defaultZoom } = config.mapDefaults
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [outages, setOutages] = useState([])
  const [tunnels, setTunnels] = useState([])
  const [tunnelMetricsUnavailable, setTunnelMetricsUnavailable] = useState(false)
  const [missingTunnelMetric, setMissingTunnelMetric] = useState(null)
  const [appnetaPaths, setAppnetaPaths] = useState([])
  const [appnetaMps, setAppnetaMps] = useState([])
  const [radarFrames, setRadarFrames] = useState({ host: '', frames: [] })
  // null until the first NCM load completes; then a fetchNcmCompliance() result.
  const [ncm, setNcm] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fetchDevices(params)
      .then(async (data) => {
        if (cancelled) return
        // Fetch alarms for all devices in one batched POST; merge onto
        // each device so markers can color by severity without per-tab fetches.
        const names = data.map((d) => d.name).filter(Boolean)
        let alarmsByName = new Map()
        try {
          alarmsByName = await fetchSpectrumAlarmsForDevices(names)
        } catch (e) {
          // Non-fatal: render devices without alarms; alarms tab will show empty.
          console.warn('Alarm fetch failed:', e.message)
        }
        if (cancelled) return
        const merged = data.map((d) => ({
          ...d,
          alarms: alarmsByName.get(d.name) || [],
        }))
        setDevices(merged)
      })
      .catch((e) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [params])

  // Power outages — independent of devices/alarms. Non-fatal on failure:
  // the layer toggle just shows nothing rather than blocking the map.
  // Refreshes on an interval since the ODIN feed updates every ~10 min.
  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetchActiveOutages()
        .then((data) => { if (!cancelled) setOutages(data) })
        .catch((e) => console.warn('Power outage fetch failed:', e.message))
    }
    load()
    const timer = setInterval(load, config.powerOutages.refreshIntervalMs)
    return () => { cancelled = true; clearInterval(timer) }
  }, [config.powerOutages.refreshIntervalMs])

  // NCM configuration compliance — optional and independent of devices.
  // When NCM isn't configured on this Portal the proxy answers 404 and the
  // feature stays invisible. Compliance changes on audit cadence, so this
  // refreshes slowly (default 15 min).
  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetchNcmCompliance()
        .then((result) => { if (!cancelled) setNcm(result) })
        .catch((e) => { if (!cancelled) setNcm({ enabled: true, error: e.message }) })
    }
    load()
    const timer = setInterval(load, ncmConfig().refreshIntervalMs)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  // RainViewer radar frames — independent of devices/alarms. Non-fatal on
  // failure: the overlay just shows nothing rather than blocking the map.
  // Refreshes on an interval since RainViewer's frames update every ~10 min.
  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetchRadarFrames()
        .then((data) => { if (!cancelled) setRadarFrames(data) })
        .catch((e) => console.warn('RainViewer fetch failed:', e.message))
    }
    load()
    const timer = setInterval(load, config.rainviewer.refreshIntervalMs)
    return () => { cancelled = true; clearInterval(timer) }
  }, [config.rainviewer.refreshIntervalMs])

  // Collapse PC duplicate device records (same Name + PrimaryIPAddress,
  // different GlobalIDs — happens when a re-discovered device's stale entry
  // wasn't decommissioned). Heuristic, in priority order:
  //   1. Prefer the duplicate whose ID appears in a tunnel — that's the
  //      one PC's tunnel polling is actually using for the physical device.
  //   2. If neither is in tunnels yet (initial load, before tunnels arrive),
  //      prefer the one with non-null cpu/memory/disk metrics.
  //   3. Otherwise keep the first encountered.
  // The right long-term fix is for the PC admin to delete the stale record.
  const dedupedDevices = useMemo(() => {
    if (devices.length === 0) return devices
    const tunnelIds = new Set()
    for (const t of tunnels) {
      if (t.sourceId != null) tunnelIds.add(t.sourceId)
      if (t.destId != null) tunnelIds.add(t.destId)
    }
    const byKey = new Map()
    for (const d of devices) {
      if (!d.name || !d.ip) {
        byKey.set(`__nokey:${d.id}`, d)
        continue
      }
      const key = `${d.name}|${d.ip}`
      const prev = byKey.get(key)
      if (!prev) {
        byKey.set(key, d)
        continue
      }
      const prevInTunnels = tunnelIds.has(prev.id)
      const candInTunnels = tunnelIds.has(d.id)
      if (candInTunnels !== prevInTunnels) {
        if (candInTunnels) byKey.set(key, d)
        continue
      }
      const prevHasMetrics = prev.cpu != null || prev.memory != null || prev.disk != null
      const candHasMetrics = d.cpu != null || d.memory != null || d.disk != null
      if (candHasMetrics && !prevHasMetrics) byKey.set(key, d)
    }
    return [...byKey.values()]
  }, [devices, tunnels])

  // Merge the most-severe containing outage onto each device, so the
  // popup's Site Info tab can warn "possible power outage in this area".
  const devicesWithOutages = useMemo(() => {
    if (outages.length === 0) return dedupedDevices
    const map = correlateOutagesToDevices(dedupedDevices, outages)
    return dedupedDevices.map((d) => ({ ...d, outage: map.get(d.id) || null }))
  }, [dedupedDevices, outages])

  // Attach NCM compliance to each device for the marker ring and the popup's
  // Compliance tab. Absent entirely (no `ncm` field) when NCM isn't configured.
  const devicesWithNcm = useMemo(() => {
    if (!ncm || !ncm.enabled) return devicesWithOutages
    if (ncm.error) {
      return devicesWithOutages.map((d) => ({ ...d, ncm: { status: 'unavailable', error: ncm.error } }))
    }
    const { uiBaseUrl } = ncmConfig()
    return devicesWithOutages.map((d) => ({
      ...d,
      ncm: ncmInfoForDevice(ncm.index, ncm.latestEvents, d, uiBaseUrl),
    }))
  }, [devicesWithOutages, ncm])

  // SD-WAN tunnels — fetched after devices land so we can constrain the
  // query to tunnels whose endpoints are both on the map. Refreshes on an
  // interval (lookbackSeconds is short, so we need to re-poll to keep the
  // sample window current and catch metric spikes as they happen).
  useEffect(() => {
    if (devices.length === 0) return
    let cancelled = false
    const ids = devices.map((d) => d.id).filter(Boolean)
    const load = () => {
      fetchTunnels(ids, { debug: params.debug })
        .then((data) => {
          if (cancelled) return
          setTunnels(data)
          const status = getTunnelMetricsStatus()
          setTunnelMetricsUnavailable(status.unavailable)
          setMissingTunnelMetric(status.missingProperty)
        })
        .catch((e) => console.warn('Tunnel fetch failed:', e.message))
    }
    load()
    const timer = setInterval(load, config.tunnels.refreshIntervalMs)
    return () => { cancelled = true; clearInterval(timer) }
  }, [devices, params.debug, config.tunnels.refreshIntervalMs])

  // AppNeta MP devices — fetched once on app load, regardless of overlay
  // state. Cheap (~25 records) and the data is stable; no need to gate on
  // overlay since the user may toggle the layer on at any time and we want
  // it responsive. Non-fatal: if the customer's PC has no AppNeta-tagged
  // devices the response is just empty and the layer renders nothing.
  useEffect(() => {
    if (!config.showAppNetaPaths) return
    let cancelled = false
    fetchAppNetaMpDevices(params)
      .then((data) => { if (!cancelled) setAppnetaMps(data) })
      .catch((e) => console.warn('AppNeta MP fetch failed:', e.message))
    return () => { cancelled = true }
  }, [config.showAppNetaPaths, params])

  // AppNeta paths + 5-min metric window. Fetched after both PC devices
  // and AppNeta MPs land, since the path filter needs the union of both
  // pools to join `sourceAppliance` to a PC device id. Refreshes on the
  // configured interval (default 60s) so metric spikes show up promptly.
  useEffect(() => {
    if (!config.showAppNetaPaths) return
    if (devices.length === 0 && appnetaMps.length === 0) return
    let cancelled = false
    const byName = new Map()
    for (const d of devices) if (d.name) byName.set(d.name, d)
    for (const m of appnetaMps) if (m.name) byName.set(m.name, m)
    const load = () => {
      fetchAppNetaPaths(byName, { debug: params.debug })
        .then(async (data) => {
          if (cancelled) return
          // Enrich each path with PC metadata (LocalID for the popup
          // redirector link, plus PC's Description and CreateTime for
          // display). PC OData doesn't expose path inventory, so we
          // get this from the Data Aggregator. Best-effort: if DA is
          // unreachable, paths still render without the deep-link or
          // extra metadata.
          try {
            const details = await fetchNetworkPathDetails(data, {
              debug: params.debug,
            })
            if (cancelled) return
            setAppnetaPaths(
              data.map((p) => {
                const d = details.get(Number(p.id))
                return {
                  ...p,
                  localId: d?.localId ?? null,
                  pcDescription: d?.description ?? null,
                  pcCreatedAt: d?.createTime ?? null,
                }
              }),
            )
          } catch (e) {
            console.warn('DA networkpath mapping failed:', e.message)
            if (!cancelled) setAppnetaPaths(data)
          }
        })
        .catch((e) => console.warn('AppNeta path fetch failed:', e.message))
    }
    load()
    const timer = setInterval(load, config.appnetaPaths.refreshIntervalMs)
    return () => { cancelled = true; clearInterval(timer) }
  }, [
    devices,
    appnetaMps,
    params.debug,
    config.showAppNetaPaths,
    config.appnetaPaths.refreshIntervalMs,
  ])

  const devicesById = useMemo(
    () => new Map(dedupedDevices.map((d) => [d.id, d])),
    [dedupedDevices],
  )

  // Per-device visibility toggle for tunnel rendering. Tracked as the
  // negative set ("hidden") so an empty set means "all checked" — no need
  // to repopulate when devices first load. Tunnel renders only when BOTH
  // endpoints are checked, letting the user isolate a specific A↔B view.
  const [hiddenDeviceIds, setHiddenDeviceIds] = useState(() => new Set())
  const toggleDeviceVisibility = useCallback((id) => {
    setHiddenDeviceIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const visibleTunnels = useMemo(
    () => tunnels.filter(
      (t) => !hiddenDeviceIds.has(t.sourceId) && !hiddenDeviceIds.has(t.destId),
    ),
    [tunnels, hiddenDeviceIds],
  )
  // Devices that appear as either endpoint in any tunnel — the universe
  // covered by the tunnel legend's per-site rows. Used by the legend's
  // header "select all" checkbox.
  const tunnelDeviceIds = useMemo(
    () => new Set(
      tunnels.flatMap((t) => [t.sourceId, t.destId]).filter((id) => id != null),
    ),
    [tunnels],
  )
  const setAllTunnelDevicesVisible = useCallback((visible) => {
    setHiddenDeviceIds(visible ? new Set() : new Set(tunnelDeviceIds))
  }, [tunnelDeviceIds])

  // Mirrors the SD-WAN Tunnels overlay's on/off state. The legend mounts
  // when this is true and unmounts when false — so unchecking the overlay
  // hides the legend, and re-checking it brings the legend back fresh
  // (its internal `hidden` resets), even if the user had × -closed it.
  // Starts off — only the Devices layer is on by default; users opt in
  // to the SD-WAN tunnels view (and AppNeta layer below) explicitly.
  const [tunnelLayerOn, setTunnelLayerOn] = useState(false)

  // Devices ↔ SD-WAN Tunnels are coupled both ways to enforce the
  // invariant "Tunnels can only be on when Devices is on" (SDWan tunnel
  // lines without endpoint markers are confusing):
  //   - tunnelLayerOn becomes true → auto-check Devices
  //   - devicesLayerOn becomes false → auto-uncheck Tunnels
  // Both overlays are controlled (`checked={state}` rather than just
  // initial `checked`) so the props re-flow into the layer control UI.
  const [devicesLayerOn, setDevicesLayerOn] = useState(true)
  useEffect(() => {
    if (tunnelLayerOn) setDevicesLayerOn(true)
  }, [tunnelLayerOn])
  useEffect(() => {
    if (!devicesLayerOn) setTunnelLayerOn(false)
  }, [devicesLayerOn])

  // "Non-Compliant Devices" filter in the Network menu. It narrows the
  // Devices layer rather than drawing its own markers, so it's coupled to
  // Devices the same way Tunnels is: turning the filter on turns Devices on,
  // and turning Devices off clears the filter.
  const [ncmFilterOn, setNcmFilterOn] = useState(false)
  useEffect(() => {
    if (ncmFilterOn) setDevicesLayerOn(true)
  }, [ncmFilterOn])
  useEffect(() => {
    if (!devicesLayerOn) setNcmFilterOn(false)
  }, [devicesLayerOn])
  // Only offered when NCM is configured and answering — and only applied
  // then, so an NCM outage can't leave the map silently filtered.
  const ncmAvailable = Boolean(ncm && ncm.enabled && !ncm.error)

  const envControlRef = useRef(null)
  const networkControlRef = useRef(null)

  // Per-MP visibility for the AppNeta path layer. Same negative-set pattern
  // as `hiddenDeviceIds` above (empty = all checked, no need to repopulate
  // when MPs first load). A path renders only when its source MP is checked.
  const [hiddenAppnetaMpIds, setHiddenAppnetaMpIds] = useState(() => new Set())
  const toggleAppnetaMpVisibility = useCallback((id) => {
    setHiddenAppnetaMpIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const visibleAppnetaPaths = useMemo(
    () => appnetaPaths.filter((p) => !hiddenAppnetaMpIds.has(p.sourceDeviceId)),
    [appnetaPaths, hiddenAppnetaMpIds],
  )
  // MPs that are SOURCES of at least one path. These appear as legend
  // rows AND as bullseye markers in the AppNeta layer. Hiding from the
  // legend (per-row checkbox or select-all) only affects this set.
  const renderableAppnetaMps = useMemo(() => {
    const sourceIds = new Set(appnetaPaths.map((p) => p.sourceDeviceId))
    return appnetaMps.filter((m) => sourceIds.has(m.id))
  }, [appnetaMps, appnetaPaths])
  // Orphan MPs — picked up by the name-pattern fetcher but not actually
  // generating paths. Off by default (they fall through to the regular
  // device cluster). Customer can opt in via showOrphanAppnetaMps:true
  // to also render them as bullseyes; they get no legend row, so the
  // legend's select-all doesn't affect them — they stay visible until
  // the user toggles the flag back off or unchecks the AppNeta overlay.
  const orphanAppnetaMps = useMemo(() => {
    if (!config.showOrphanAppnetaMps) return []
    const sourceIds = new Set(appnetaPaths.map((p) => p.sourceDeviceId))
    return appnetaMps.filter((m) => !sourceIds.has(m.id))
  }, [appnetaMps, appnetaPaths, config.showOrphanAppnetaMps])
  // What the AppNeta layer renders: legend-controlled renderable MPs +
  // unconditional orphan MPs (when the flag is on).
  const visibleAppnetaMps = useMemo(
    () => [
      ...renderableAppnetaMps.filter((m) => !hiddenAppnetaMpIds.has(m.id)),
      ...orphanAppnetaMps,
    ],
    [renderableAppnetaMps, hiddenAppnetaMpIds, orphanAppnetaMps],
  )
  // Toggle-all callback for the legend's header checkbox. Orphans aren't
  // in renderableAppnetaMps, so they're untouched by select-all — exactly
  // what we want: a flag-enabled "always show" lane.
  const setAllAppnetaMpsVisible = useCallback((visible) => {
    setHiddenAppnetaMpIds(visible
      ? new Set()
      : new Set(renderableAppnetaMps.map((m) => m.id)))
  }, [renderableAppnetaMps])
  // Mirrors the AppNeta MPs overlay's on/off state — same pattern as
  // tunnelLayerOn. Starts off so customers without AppNeta see no change.
  const [appnetaLayerOn, setAppnetaLayerOn] = useState(false)

  // When the AppNeta layer is on, exclude every MP it claims from the
  // device cluster so each MP gets exactly one marker (the AppNeta layer
  // takes over). Includes orphans when the flag is on — they then render
  // as AppNeta bullseyes instead of cluster bubbles. When the flag is
  // off, orphans aren't in this set, so they stay in the cluster (their
  // only representation).
  const appnetaMpIdSet = useMemo(
    () => new Set([
      ...renderableAppnetaMps.map((m) => m.id),
      ...orphanAppnetaMps.map((m) => m.id),
    ]),
    [renderableAppnetaMps, orphanAppnetaMps],
  )
  const clusterDevices = useMemo(
    () => (appnetaLayerOn
      ? devicesWithNcm.filter((d) => !appnetaMpIdSet.has(d.id))
      : devicesWithNcm),
    [devicesWithNcm, appnetaLayerOn, appnetaMpIdSet],
  )
  const nonCompliantClusterDevices = useMemo(() => nonCompliantDevices(clusterDevices), [clusterDevices])
  const ncmFilterActive = ncmFilterOn && ncmAvailable
  const displayedDevices = ncmFilterActive ? nonCompliantClusterDevices : clusterDevices

  // Overlay labels, defined once so the initial registration and later
  // updates (useOverlayLabels) always agree.
  const devicesLabel = `Devices${clusterDevices.length ? ` (${clusterDevices.length})` : ''}`
  const tunnelsLabel = `SD-WAN Tunnels${tunnels.length ? ` (${tunnels.length})` : ''}`
  const appnetaLabel = `AppNeta MPs${appnetaPaths.length ? ` (${appnetaPaths.length})` : ''}`
  const nonCompliantLabel = `Non-Compliant Devices (${nonCompliantClusterDevices.length})`
  // Counts the distinct outages shown in the banners of the devices currently
  // on the map (so it follows the Non-Compliant filter); the layer itself
  // still draws every outage.
  const affectedOutageCount = useMemo(() => bannerOutageCount(displayedDevices), [displayedDevices])
  const outagesLabel = `Power Outages${affectedOutageCount ? ` (${affectedOutageCount})` : ''}`
  useOverlayLabels(networkControlRef, {
    'Devices': devicesLabel,
    'SD-WAN Tunnels': tunnelsLabel,
    'AppNeta MPs': appnetaLabel,
    'Non-Compliant Devices': nonCompliantLabel,
  })
  useOverlayLabels(envControlRef, { 'Power Outages': outagesLabel })

  return (
    <div className="app">
      <StatusBanner
        loading={loading}
        error={error}
        count={dedupedDevices.length}
        shown={ncmFilterActive ? displayedDevices.length : null}
        debug={params.debug}
      />
      {tunnelLayerOn && tunnelMetricsUnavailable && (
        <div className="status-banner status-empty tunnel-metrics-note">
          SD-WAN tunnel metrics unavailable — this Performance Center doesn't
          expose <code>{missingTunnelMetric}</code>. Tunnels render without
          jitter/latency/loss coloring.
        </div>
      )}
      <MapContainer
        center={defaultCenter}
        zoom={defaultZoom}
        minZoom={2}
        maxZoom={18}
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Secondary control: environmental context (weather + outages).
            Declared first so it stacks ABOVE the network control at
            top-right. Toggled less often than network layers.
            sortFunction keeps the panel order stable when useOverlayLabels
            re-registers an overlay under its updated "(count)" label —
            react-leaflet itself never updates a label after registration. */}
        <LayersControl
          ref={envControlRef}
          position="topright"
          sortLayers
          sortFunction={makeSortByPrefix(['Precipitation', 'Temperature', 'Wind', 'Clouds', 'Weather Radar', 'Power Outages'])}
        >
          <Overlay checked name="Precipitation">
            <TileLayer
              attribution='&copy; <a href="https://openweathermap.org">OpenWeatherMap</a>'
              url={`https://tile.openweathermap.org/map/precipitation_new/{z}/{x}/{y}.png?appid=${owmApiKey}`}
              opacity={0.6}
            />
          </Overlay>
          <Overlay name="Temperature">
            <TileLayer
              attribution='&copy; <a href="https://openweathermap.org">OpenWeatherMap</a>'
              url={`https://tile.openweathermap.org/map/temp_new/{z}/{x}/{y}.png?appid=${owmApiKey}`}
              opacity={0.6}
            />
          </Overlay>
          <Overlay name="Wind">
            <TileLayer
              attribution='&copy; <a href="https://openweathermap.org">OpenWeatherMap</a>'
              url={`https://tile.openweathermap.org/map/wind_new/{z}/{x}/{y}.png?appid=${owmApiKey}`}
              opacity={0.6}
            />
          </Overlay>
          <Overlay name="Clouds">
            <TileLayer
              attribution='&copy; <a href="https://openweathermap.org">OpenWeatherMap</a>'
              url={`https://tile.openweathermap.org/map/clouds_new/{z}/{x}/{y}.png?appid=${owmApiKey}`}
              opacity={0.6}
            />
          </Overlay>
          <Overlay name="Weather Radar">
            <RainviewerLayer host={radarFrames.host} frames={radarFrames.frames} />
          </Overlay>
          <Overlay name={outagesLabel}>
            <PowerOutageLayer outages={outages} />
          </Overlay>
        </LayersControl>

        {/* Primary control: network layers (what the operator actively
            works with). Stacked below the climate control at top-right. */}
        <LayersControl
          ref={networkControlRef}
          position="topright"
          sortLayers
          sortFunction={makeSortByPrefix(['Devices', 'SD-WAN Tunnels', 'AppNeta MPs', 'Non-Compliant Devices'])}
        >
          <Overlay checked={devicesLayerOn} name={devicesLabel}>
            <MarkerClusterGroup
              iconCreateFunction={createClusterIcon}
              showCoverageOnHover={false}
              zoomToBoundsOnClick={false}
              spiderfyOnMaxZoom={true}
              maxClusterRadius={config.clusterRadius}
              eventHandlers={{
                clusterclick: (e) => e.layer.spiderfy(),
              }}
            >
              {displayedDevices.map((d) => (
                <DeviceMarker key={d.id} device={d} weatherApiKey={owmApiKey} />
              ))}
            </MarkerClusterGroup>
          </Overlay>
          <Overlay checked={tunnelLayerOn} name={tunnelsLabel}>
            <TunnelLayer tunnels={visibleTunnels} devicesById={devicesById} />
          </Overlay>
          {config.showAppNetaPaths && (
            <Overlay name={appnetaLabel}>
              <AppNetaLayer
                paths={visibleAppnetaPaths}
                appnetaMps={visibleAppnetaMps}
              />
            </Overlay>
          )}
          {ncmAvailable && (
            // A filter, not a layer: the empty LayerGroup only exists so the
            // checkbox registers — an Overlay with no Leaflet layer inside
            // never appears in the control (see TunnelLayer).
            <Overlay checked={ncmFilterOn} name={nonCompliantLabel}>
              <LayerGroup />
            </Overlay>
          )}
        </LayersControl>


        <FitBoundsToDevices devices={dedupedDevices} />

        <LayersControlLabeler />
        <DevicesOverlayWatcher onChange={setDevicesLayerOn} />
        <TunnelOverlayWatcher onChange={setTunnelLayerOn} />
        {config.showAppNetaPaths && <AppNetaOverlayWatcher onChange={setAppnetaLayerOn} />}
        {ncmAvailable && <NcmFilterOverlayWatcher onChange={setNcmFilterOn} />}
        {config.showAlarmLegend && <Legend />}
        {config.showTunnelLegend && tunnelLayerOn && (
          <TunnelLegend
            tunnels={tunnels}
            devicesById={devicesById}
            hiddenDeviceIds={hiddenDeviceIds}
            onToggleDevice={toggleDeviceVisibility}
            onToggleAll={setAllTunnelDevicesVisible}
          />
        )}
        {config.showAppNetaLegend && appnetaLayerOn && (
          <AppNetaLegend
            paths={appnetaPaths}
            hiddenDeviceIds={hiddenAppnetaMpIds}
            onToggleDevice={toggleAppnetaMpVisibility}
            onToggleAll={setAllAppnetaMpsVisible}
          />
        )}
      </MapContainer>
    </div>
  )
}

/**
 * Watches Leaflet's overlayadd / overlayremove events and reports the
 * SD-WAN Tunnels overlay's on/off state up to App. Matches on the overlay
 * name prefix so the dynamic `(count)` suffix on the label doesn't break it.
 */
function TunnelOverlayWatcher({ onChange }) {
  const map = useMap()
  useEffect(() => {
    const matches = (e) =>
      typeof e?.name === 'string' && e.name.startsWith('SD-WAN Tunnels')
    const onAdd = (e) => { if (matches(e)) onChange(true) }
    const onRemove = (e) => { if (matches(e)) onChange(false) }
    map.on('overlayadd', onAdd)
    map.on('overlayremove', onRemove)
    return () => {
      map.off('overlayadd', onAdd)
      map.off('overlayremove', onRemove)
    }
  }, [map, onChange])
  return null
}

/**
 * Tags the two stacked LayersControl widgets at top-right with class
 * names, hover-tooltip text, and badge text so users can tell the
 * stack-of-papers icons apart at a glance AND get a styled tooltip on
 * hover. Also disables Leaflet's default hover-to-expand: users must
 * CLICK the icon to open the panel. Runs once after mount.
 *
 * Order at top-right (top → bottom): Climate, Network. Determined by
 * the order the two LayersControl components appear in the JSX above.
 */
function LayersControlLabeler() {
  const map = useMap()
  useEffect(() => {
    const corner = map.getContainer().querySelector('.leaflet-top.leaflet-right')
    if (!corner) return
    const controls = corner.querySelectorAll('.leaflet-control-layers')
    const meta = [
      { cls: 'layers-control-env',     badge: 'Env',     tooltip: 'Environment' },
      { cls: 'layers-control-network', badge: 'Network', tooltip: 'Network' },
    ]
    controls.forEach((ctrl, i) => {
      if (meta[i]) configureLayersControl(ctrl, meta[i].cls, meta[i].badge, meta[i].tooltip)
    })
  }, [map])
  return null
}

function configureLayersControl(ctrl, cls, badge, tooltip) {
  if (!ctrl) return
  ctrl.classList.add(cls)
  const toggle = ctrl.querySelector('.leaflet-control-layers-toggle')
  if (!toggle) return

  // Strip Leaflet's hover- and focus-driven expanders so the panel only
  // opens on an explicit click. Hover stays free for the styled tooltip
  // (:hover::before in App.css) — otherwise mousing in immediately
  // expands the menu and the tooltip never gets a chance to render.
  L.DomEvent.off(ctrl, 'mouseenter mouseleave')
  L.DomEvent.off(toggle, 'click focus')
  L.DomEvent.on(toggle, 'click', (e) => {
    L.DomEvent.stop(e)
    if (ctrl.classList.contains('leaflet-control-layers-expanded')) {
      ctrl.classList.remove('leaflet-control-layers-expanded')
      ctrl.classList.add('leaflet-control-layers-collapsed')
    } else {
      ctrl.classList.remove('leaflet-control-layers-collapsed')
      ctrl.classList.add('leaflet-control-layers-expanded')
    }
  })

  // Drive badge + tooltip from data-* attributes (App.css reads them via
  // attr() into ::after and :hover::before pseudo-elements). Remove the
  // native title so the browser tooltip doesn't double up with our
  // styled one. aria-label preserves the name for screen readers.
  const apply = () => {
    toggle.setAttribute('data-badge', badge)
    toggle.setAttribute('data-tooltip', tooltip)
    toggle.setAttribute('aria-label', tooltip)
    toggle.removeAttribute('title')
  }
  apply()
  setTimeout(apply, 0)
}

/** Same pattern as TunnelOverlayWatcher but for the Devices overlay. */
function DevicesOverlayWatcher({ onChange }) {
  const map = useMap()
  useEffect(() => {
    const matches = (e) =>
      typeof e?.name === 'string' && e.name.startsWith('Devices')
    const onAdd = (e) => { if (matches(e)) onChange(true) }
    const onRemove = (e) => { if (matches(e)) onChange(false) }
    map.on('overlayadd', onAdd)
    map.on('overlayremove', onRemove)
    return () => {
      map.off('overlayadd', onAdd)
      map.off('overlayremove', onRemove)
    }
  }, [map, onChange])
  return null
}

/** Same pattern as TunnelOverlayWatcher but for the Non-Compliant Devices filter. */
function NcmFilterOverlayWatcher({ onChange }) {
  const map = useMap()
  useEffect(() => {
    const matches = (e) =>
      typeof e?.name === 'string' && e.name.startsWith('Non-Compliant Devices')
    const onAdd = (e) => { if (matches(e)) onChange(true) }
    const onRemove = (e) => { if (matches(e)) onChange(false) }
    map.on('overlayadd', onAdd)
    map.on('overlayremove', onRemove)
    return () => {
      map.off('overlayadd', onAdd)
      map.off('overlayremove', onRemove)
    }
  }, [map, onChange])
  return null
}

/** Same pattern as TunnelOverlayWatcher but for the AppNeta MPs overlay. */
function AppNetaOverlayWatcher({ onChange }) {
  const map = useMap()
  useEffect(() => {
    const matches = (e) =>
      typeof e?.name === 'string' && e.name.startsWith('AppNeta MPs')
    const onAdd = (e) => { if (matches(e)) onChange(true) }
    const onRemove = (e) => { if (matches(e)) onChange(false) }
    map.on('overlayadd', onAdd)
    map.on('overlayremove', onRemove)
    return () => {
      map.off('overlayadd', onAdd)
      map.off('overlayremove', onRemove)
    }
  }, [map, onChange])
  return null
}

/**
 * After devices load, fit the map view to include all of them.
 * useMap() gives us access to the Leaflet map instance from inside the
 * MapContainer's React tree.
 *
 * Re-fits ONLY when the device set composition actually changes (different
 * IDs, or first non-empty load) — not on every `devices` reference change.
 * The auto-refresh effects (tunnels every 60s, AppNeta paths every 60s)
 * cause `dedupedDevices` to re-memo with a fresh array reference even
 * when the underlying devices are identical; without a stable-key guard
 * the map would snap back to fit-all every minute, undoing the user's
 * manual zoom.
 */
function FitBoundsToDevices({ devices }) {
  const map = useMap()
  const lastKeyRef = useRef('')
  useEffect(() => {
    if (devices.length === 0) return
    const key = devices.map((d) => d.id).sort().join(',')
    if (key === lastKeyRef.current) return
    lastKeyRef.current = key
    const bounds = L.latLngBounds(devices.map((d) => [d.latitude, d.longitude]))
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 })
  }, [devices, map])
  return null
}

function StatusBanner({ loading, error, count, shown, debug }) {
  if (error) {
    return (
      <div className="status-banner status-error">
        Failed to load devices: {error}
      </div>
    )
  }
  if (loading) {
    return <div className="status-banner status-loading">Loading devices…</div>
  }
  if (count === 0) {
    return (
      <div className="status-banner status-empty">
        No geo-located devices found for this group context.
      </div>
    )
  }
  if (shown != null) {
    return (
      <div className="status-banner status-ok">
        {shown} of {count} device{count === 1 ? '' : 's'} · non-compliant only
      </div>
    )
  }
  return (
    <div className="status-banner status-ok">
      {count} device{count === 1 ? '' : 's'}
      {debug && ' (debug mode — using sample data)'}
    </div>
  )
}
