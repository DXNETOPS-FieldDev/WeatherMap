import { useState, useEffect, useRef } from 'react'
import { Popup } from 'react-leaflet'
import { topSeverity } from '../api/spectrum.js'
import { getConfig } from '../lib/config.js'
import { SEVERITIES, worstSelectedSeverity, partitionBySeverity } from '../lib/threshold-alarms.js'

const SEVERITY_COLOR = {
  Critical: '#d32f2f',
  Major: '#f57c00',
  Minor: '#fbc02d',
  Normal: '#388e3c',
  Maintenance: '#616161',
  Suppressed: '#9e9e9e',
  Initial: '#1976d2',
}

function severityLabel(sev) {
  if (typeof sev === 'number') {
    return ['Normal', 'Minor', 'Major', 'Critical', 'Maintenance', 'Suppressed', 'Initial'][sev] || String(sev)
  }
  return sev == null ? 'Unknown' : String(sev)
}

/**
 * Four-tab Leaflet popup. Alarms come pre-fetched on the `device` prop —
 * the parent (App.jsx) batches a single Spectrum query for all devices.
 */
export default function TabbedPopup({ device, apiKey, selectedSeverities }) {
  const [activeTab, setActiveTab] = useState('site')
  const [weather, setWeather] = useState(null)
  const [weatherError, setWeatherError] = useState(null)
  const [weatherLoading, setWeatherLoading] = useState(false)

  const alarms = device.alarms || []
  // Thresholds variant: selectedSeverities is given and the Alarms tab lists
  // the device's threshold alarms (device.thresholdAlarms) instead.
  const thresholdMode = Array.isArray(selectedSeverities)
  const popupSeverity = thresholdMode
    ? worstSelectedSeverity(device.thresholdAlarms || [], selectedSeverities)
    : topSeverity(alarms)
  const severityClass = `popup-severity-${(popupSeverity || 'normal').toLowerCase()}`
  // Leaflet reads className only when it first builds the popup, so a severity
  // that changes later (threshold alarms arriving after the markers, a refresh,
  // a ticked box) must be applied to the options and the live element here.
  const popupRef = useRef(null)
  useEffect(() => {
    const popup = popupRef.current
    if (!popup) return
    popup.options.className = severityClass
    const el = popup.getElement?.()
    if (!el) return
    for (const c of [...el.classList]) if (c.startsWith('popup-severity-')) el.classList.remove(c)
    el.classList.add(severityClass)
  }, [severityClass])
  const triagePageId = getConfig().triageViewPageId
  const triageHref =
    triagePageId && device.globalId != null
      ? `/pc/desktop/page?pg=${triagePageId}&DeviceID=${device.globalId}&IsTriageView=true`
      : null

  useEffect(() => {
    if (activeTab !== 'weather' || weather || weatherLoading) return
    setWeatherLoading(true)
    const url =
      `https://api.openweathermap.org/data/2.5/weather` +
      `?lat=${device.latitude}&lon=${device.longitude}&units=imperial&appid=${apiKey}`
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        setWeather(data)
        setWeatherError(null)
      })
      .catch((e) => setWeatherError(e.message))
      .finally(() => setWeatherLoading(false))
  }, [activeTab, weather, weatherLoading, device.latitude, device.longitude, apiKey])

  return (
    <Popup ref={popupRef} minWidth={280} maxWidth={340} className={severityClass}>
      <div className="tabbed-popup">
        <div className="tabs">
          <button
            className={`tab ${activeTab === 'site' ? 'active' : ''}`}
            onClick={() => setActiveTab('site')}
          >
            Site Info
          </button>
          <button
            className={`tab ${activeTab === 'weather' ? 'active' : ''}`}
            onClick={() => setActiveTab('weather')}
          >
            Weather
          </button>
          <button
            className={`tab ${activeTab === 'metrics' ? 'active' : ''}`}
            onClick={() => setActiveTab('metrics')}
          >
            Metrics
          </button>
          {device.ncm && (
            <button
              className={`tab ${activeTab === 'compliance' ? 'active' : ''}`}
              onClick={() => setActiveTab('compliance')}
            >
              Compliance
            </button>
          )}
          <button
            className={`tab ${activeTab === 'alarms' ? 'active' : ''}`}
            onClick={() => setActiveTab('alarms')}
          >
            Alarms
          </button>
        </div>

        {activeTab === 'site' && (
          <div className="tab-content">
            {device.outage && <OutageWarning outage={device.outage} />}
            {device.ncm?.status === 'noncompliant' && (
              <ComplianceWarning ncm={device.ncm} onOpen={() => setActiveTab('compliance')} />
            )}
            <p>
              <strong>Name:</strong>{' '}
              {device.globalId ? (
                <a
                  href={`/pc/redirector?ItemID=${device.globalId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {device.name}
                </a>
              ) : (
                device.name
              )}
              {triageHref && (
                <a
                  className="triage-link"
                  href={triageHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open Triage View"
                >
                  <img src="./topo-icon.png" alt="Triage View" width="22" height="22" />
                </a>
              )}
            </p>
            <p><strong>IP:</strong> {device.ip}</p>
            <p><strong>Location:</strong> {device.location || <em>not set</em>}</p>
          </div>
        )}

        {activeTab === 'weather' && (
          <div className="tab-content">
            {weatherLoading && <p>Loading current conditions…</p>}
            {weatherError && (
              <p className="error">
                Couldn't load weather: {weatherError}
                <br />
                <small>
                  Check the API key in App.jsx, and confirm
                  api.openweathermap.org is in the portal CSP connect-src.
                </small>
              </p>
            )}
            {weather && (
              <>
                <p className="weather-headline">
                  <img
                    src={`https://openweathermap.org/img/wn/${weather.weather[0].icon}@2x.png`}
                    alt={weather.weather[0].description}
                    width="50"
                    height="50"
                  />
                  <span>
                    <strong>{Math.round(weather.main.temp)}°F</strong>
                    <br />
                    <small>{weather.weather[0].description}</small>
                  </span>
                </p>
                <p><strong>Feels like:</strong> {Math.round(weather.main.feels_like)}°F</p>
                <p><strong>Humidity:</strong> {weather.main.humidity}%</p>
                <p><strong>Wind:</strong> {Math.round(weather.wind.speed)} mph</p>
                <p><strong>Pressure:</strong> {weather.main.pressure} hPa</p>
              </>
            )}
          </div>
        )}

        {activeTab === 'metrics' && (
          <div className="tab-content">
            {/* metrics.profile "network" puts a `network` key on every device
                (undefined while loading); otherwise the CPU / memory / disk set. */}
            {'network' in device ? (
              <NetworkMetrics network={device.network} />
            ) : (
              <>
                <MetricBar label="CPU Utilization" value={device.cpu} />
                <MetricBar label="Memory Utilization" value={device.memory} />
                <MetricBar label="Disk Used" value={device.disk} />
                <p className="metrics-footnote">
                  <small>Average over the dashboard's time window.</small>
                </p>
              </>
            )}
          </div>
        )}

        {activeTab === 'compliance' && device.ncm && (
          <div className="tab-content">
            <ComplianceDetails ncm={device.ncm} />
          </div>
        )}

        {activeTab === 'alarms' && thresholdMode && (
          <div className="tab-content">
            <ThresholdAlarms alarms={device.thresholdAlarms} selected={selectedSeverities} triageHref={triageHref} />
          </div>
        )}

        {activeTab === 'alarms' && !thresholdMode && (
          <div className="tab-content">
            {alarms.length === 0 && <p>No Alarms</p>}
            {alarms.length > 0 && triageHref && (
              <p className="triage-jump">
                <a href={triageHref} target="_blank" rel="noopener noreferrer">
                  <img src="./topo-icon.png" alt="" width="16" height="16" />
                  Investigate in Triage View →
                </a>
              </p>
            )}
            {alarms.length > 0 && (
              <ul className="alarm-list">
                {alarms.map((a) => {
                  const label = severityLabel(a.severity)
                  return (
                    <li key={a.id} className="alarm-item">
                      <span
                        className="alarm-severity"
                        style={{ background: SEVERITY_COLOR[label] || '#666' }}
                      >
                        {label}
                      </span>
                      <span className="alarm-title">
                        {a.component && (
                          <div className="alarm-component">Interface · {a.component}</div>
                        )}
                        {a.title || '(no title)'}
                        {a.occurredAt && (
                          <><br /><small>{a.occurredAt.toLocaleString()}</small></>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </Popup>
  )
}

// What each NCM compliance status means, in words a reader without NCM
// knowledge can act on. Error and DidNotQualify say only what NCM reported.
const COMPLIANCE_STATUS = {
  compliant: { label: 'Compliant', note: 'Passed every policy in its last NCM audit.' },
  noncompliant: { label: 'Non-Compliant', note: 'Failed one or more policies in its last NCM audit.' },
  notaudited: { label: 'Not Audited', note: 'NCM manages this device but has not audited it against a policy.' },
  error: { label: 'Audit Error', note: 'NCM reported an error for this device\u2019s last audit.' },
  didnotqualify: { label: 'Did Not Qualify', note: 'NCM reported that this device did not qualify for its policies.' },
  unrecognized: { label: 'Unknown', note: 'NCM reported a status this App View does not recognize.' },
  notinncm: { label: 'Not in NCM', note: 'No NCM device matches this device\u2019s name or IP address.' },
  unavailable: { label: 'Unavailable', note: 'Compliance could not be loaded from NCM.' },
}

function ComplianceDetails({ ncm }) {
  const meta = COMPLIANCE_STATUS[ncm.status] || COMPLIANCE_STATUS.unrecognized
  return (
    <>
      <p>
        <strong>Status:</strong>{' '}
        <span className={`compliance-status compliance-status-${ncm.status}`}>{meta.label}</span>
      </p>
      <p className="compliance-note"><small>{meta.note}</small></p>
      {ncm.error && <p className="error"><small>{ncm.error}</small></p>}
      {ncm.link && (
        <p className="compliance-jump">
          <a href={ncm.link} target="_blank" rel="noopener noreferrer">View in NCM →</a>
        </p>
      )}
      {ncm.ncmName && <p><strong>NCM device:</strong> {ncm.ncmName}</p>}
      {ncm.auditTime && <p><strong>Last audit:</strong> {ncm.auditTime.toLocaleString()}</p>}
      {ncm.failedPolicies?.length > 0 && (
        <>
          <p className="compliance-list-label">Failed policies</p>
          <ul className="compliance-policy-list">
            {ncm.failedPolicies.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </>
      )}
    </>
  )
}

const oneDecimal = (v) => Number(v.toFixed(1)).toLocaleString()

// Thresholds variant: the device's threshold alarms (device and interfaces),
// filtered by the severities ticked in the Network menu. `alarms` is null when
// they are not loaded or their query failed — never shown as "No alarms".
function ThresholdAlarms({ alarms, selected, triageHref }) {
  if (alarms == null) return <p><em>Threshold alarms are not available for this device yet.</em></p>
  const { shown, hidden } = partitionBySeverity(alarms, selected)
  const hiddenParts = SEVERITIES.filter((s) => hidden[s]).map((s) => `${hidden[s]} ${s}`)
  const hiddenTotal = SEVERITIES.reduce((n, s) => n + (hidden[s] || 0), 0)
  return (
    <>
      {alarms.length === 0 && <p>No threshold alarms</p>}
      {alarms.length > 0 && shown.length === 0 && <p>No threshold alarms of the ticked severities</p>}
      {hiddenTotal > 0 && (
        <p className="threshold-hidden-note">
          <small>
            {hiddenParts.join(', ')} alarm{hiddenTotal === 1 ? '' : 's'} hidden — tick{' '}
            {SEVERITIES.filter((s) => hidden[s]).join(' / ')} alarms in the Network menu to show{' '}
            {hiddenTotal === 1 ? 'it' : 'them'}.
          </small>
        </p>
      )}
      {shown.length > 0 && triageHref && (
        <p className="triage-jump">
          <a href={triageHref} target="_blank" rel="noopener noreferrer">
            <img src="./topo-icon.png" alt="" width="16" height="16" />
            Investigate in Triage View →
          </a>
        </p>
      )}
      {shown.length > 0 && (
        <ul className="alarm-list threshold-alarm-list">
          {shown.map((a) => (
            <li key={a.id} className="alarm-item">
              <span className="alarm-severity" style={{ background: SEVERITY_COLOR[a.severity] || '#666' }}>
                {a.severity || `Code ${a.rawSeverity}`}
              </span>
              <span className="alarm-title">
                {a.interfaceName && <div className="alarm-component">Interface · {a.interfaceName}</div>}
                {a.ruleName || a.profile || a.description || '(no rule name)'}
                <br />
                <small>
                  {/* MetricValuesMax: the alarm's maximum, not necessarily the current value. */}
                  {a.value != null && <>Max {oneDecimal(a.value)}</>}
                  {a.value != null && a.startTime != null && ' · '}
                  {a.startTime != null && <>raised {new Date(a.startTime * 1000).toLocaleString()}</>}
                </small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function formatBps(bps) {
  const units = [[1e9, 'Gbps'], [1e6, 'Mbps'], [1e3, 'kbps']]
  for (const [scale, unit] of units) if (bps >= scale) return `${oneDecimal(bps / scale)} ${unit}`
  return `${oneDecimal(bps)} bps`
}

function BandwidthLine({ label, pct, bps }) {
  if (pct == null && bps == null) return <p><strong>{label}:</strong> <em>not reported</em></p>
  return (
    <p>
      <strong>{label}:</strong>{' '}
      {pct != null ? `${oneDecimal(pct)}%` : <em>utilization not reported</em>}
      {bps != null && <small> · {formatBps(bps)}</small>}
    </p>
  )
}

// metrics.profile "network": Availability and Bandwidth In / Out. `network` is
// { bandwidth, availability }, null when nothing was reported, or undefined
// while loading. See src/lib/bandwidth.js for how interfaces are combined.
function NetworkMetrics({ network }) {
  if (network === undefined) return <p>Loading metrics…</p>
  const availability = network?.availability ?? { value: null, kind: null }
  const bw = network?.bandwidth ?? null
  return (
    <>
      {availability.value == null && <p><strong>Availability:</strong> <em>not reported</em></p>}
      {availability.value != null && availability.kind === 'availability' && (
        <p><strong>Availability:</strong> {oneDecimal(availability.value)}%</p>
      )}
      {availability.value != null && availability.kind === 'reachability' && (
        <p>
          <strong>Reachability:</strong> {oneDecimal(availability.value)}%
          <br /><small>Availability not reported; share of polls answered instead.</small>
        </p>
      )}
      <BandwidthLine label="Bandwidth In" pct={bw?.utilInPct ?? null} bps={bw?.inBps ?? null} />
      <BandwidthLine label="Bandwidth Out" pct={bw?.utilOutPct ?? null} bps={bw?.outBps ?? null} />
      <p className="metrics-footnote">
        <small>
          {bw
            ? `Bandwidth: all ${bw.interfaces} interface${bw.interfaces === 1 ? '' : 's'} combined, latest sample in the last 15 minutes of the time range. `
            : 'Bandwidth: no interface samples in the last 15 minutes of the time range. '}
          Availability: average over the time range (at most the last 24 hours).
        </small>
      </p>
    </>
  )
}

function ComplianceWarning({ ncm, onOpen }) {
  return (
    <div className="compliance-warning">
      <button type="button" className="compliance-warning-title" onClick={onOpen}>
        ⚠ Configuration non-compliant (NCM)
      </button>
      {ncm.auditTime && <><br /><small>Last audit: {ncm.auditTime.toLocaleString()}</small></>}
      {ncm.failedPolicies?.length > 0 && (
        <><br /><small>Failed: {ncm.failedPolicies.join(', ')}</small></>
      )}
    </div>
  )
}

function OutageWarning({ outage }) {
  // ODIN sometimes returns ETR as a sentinel/malformed string ("Unknown",
  // bad ISO, etc.) — guard against rendering "Invalid Date".
  const etr = formatDateOrNull(outage.estimatedrestorationtime)
  const status = humanize(outage.statuskind)
  const cause = humanize(outage.cause)
  return (
    <div className="outage-warning">
      <strong>⚡ Possible power outage in this area</strong>
      <br />
      <small>{outage.name?.split(',')[0] || 'Unknown utility'}</small>
      <br />
      <small>
        {(outage.metersaffected || 0).toLocaleString()} meters affected
        {status ? ` · ${status}` : ''}
      </small>
      {cause && (
        <><br /><small>Cause: {cause}</small></>
      )}
      {etr && (
        <><br /><small>ETR: {etr}</small></>
      )}
    </div>
  )
}

function formatDateOrNull(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
}

// "awaitingCrewAssignment" → "Awaiting Crew Assignment". Idempotent for
// already-spaced values like "Crew Assessing".
function humanize(s) {
  if (!s) return s
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
}

function MetricBar({ label, value }) {
  if (value == null || !Number.isFinite(value)) {
    return <p>{label}: <em>not available</em></p>
  }
  const pct = Math.max(0, Math.min(100, value))
  const color = value >= 90 ? '#f44336' : value >= 30 ? '#ff9800' : '#4caf50'
  return (
    <div className="cpu-metric">
      <p className="cpu-label">
        <strong>{label}:</strong> {value.toFixed(1)}%
      </p>
      <div className="cpu-bar-track">
        <div
          className="cpu-bar-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  )
}
