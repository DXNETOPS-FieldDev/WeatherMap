import { useState, useEffect } from 'react'
import { Popup } from 'react-leaflet'
import { topSeverity } from '../api/spectrum.js'
import { getConfig } from '../lib/config.js'

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
export default function TabbedPopup({ device, apiKey }) {
  const [activeTab, setActiveTab] = useState('site')
  const [weather, setWeather] = useState(null)
  const [weatherError, setWeatherError] = useState(null)
  const [weatherLoading, setWeatherLoading] = useState(false)

  const alarms = device.alarms || []
  const severityClass = `popup-severity-${(topSeverity(alarms) || 'normal').toLowerCase()}`
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
    <Popup minWidth={280} maxWidth={340} className={severityClass}>
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
            <MetricBar label="CPU Utilization" value={device.cpu} />
            <MetricBar label="Memory Utilization" value={device.memory} />
            <MetricBar label="Disk Used" value={device.disk} />
            <p className="metrics-footnote">
              <small>Average over the dashboard's time window.</small>
            </p>
          </div>
        )}

        {activeTab === 'compliance' && device.ncm && (
          <div className="tab-content">
            <ComplianceDetails ncm={device.ncm} />
          </div>
        )}

        {activeTab === 'alarms' && (
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
