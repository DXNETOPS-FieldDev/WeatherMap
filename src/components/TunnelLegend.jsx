import { useEffect, useRef, useState } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { getConfig } from '../lib/config.js'

const METRICS = [
  { key: 'jitter',     label: 'Jitter - Average',      column: 'Jitter - Average'      },
  { key: 'latency',    label: 'Latency - Average',     column: 'Latency - Average'     },
  { key: 'packetLoss', label: 'Packet Loss - Average', column: 'Packet Loss - Average' },
]

const BAND_COLORS = ['#388e3c', '#fbc02d', '#f57c00', '#d32f2f']
const ROW_LEVEL_NAME = ['good', 'minor', 'warn', 'bad']

// Container width above which all 3 metric columns become visible.
const WIDE_THRESHOLD_PX = 380

// Returns 0/1/2/3 for the band the value falls into, or -1 for no data.
// Mirrors levelFor() in TunnelLayer.jsx — kept inline so the legend's
// row-tinting logic doesn't pull in the polyline-rendering module.
function levelFor(value, bands) {
  if (value == null) return -1
  if (value > bands[2]) return 3
  if (value > bands[1]) return 2
  if (value > bands[0]) return 1
  return 0
}

function fmt(n) {
  if (n == null) return '—'
  return (Math.round(n * 10) / 10).toFixed(1)
}

function computeSiteAverages(tunnels, devicesById) {
  const sums = new Map()
  for (const t of tunnels) {
    for (const id of [t.sourceId, t.destId]) {
      let s = sums.get(id)
      if (!s) {
        s = { jS: 0, jC: 0, lS: 0, lC: 0, pS: 0, pC: 0 }
        sums.set(id, s)
      }
      if (t.jitter != null)     { s.jS += t.jitter;     s.jC++ }
      if (t.latency != null)    { s.lS += t.latency;    s.lC++ }
      if (t.packetLoss != null) { s.pS += t.packetLoss; s.pC++ }
    }
  }
  const rows = []
  for (const [id, s] of sums) {
    const device = devicesById.get(id)
    if (!device) continue
    rows.push({
      id,
      name: device.name,
      jitter:     s.jC ? s.jS / s.jC : null,
      latency:    s.lC ? s.lS / s.lC : null,
      packetLoss: s.pC ? s.pS / s.pC : null,
    })
  }
  rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  return rows
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function renderContent(div, metricIdx, tunnels, devicesById, hiddenDeviceIds, filter) {
  const thresholds = getConfig().tunnels.thresholds
  const metric = METRICS[metricIdx]
  const bands = thresholds[metric.key] || [0, 0, 0]
  const allRows = computeSiteAverages(tunnels || [], devicesById || new Map())
  const hidden = hiddenDeviceIds || new Set()
  const q = (filter || '').trim().toLowerCase()
  const rows = q
    ? allRows.filter((r) => (r.name || '').toLowerCase().includes(q))
    : allRows

  const thresholdsEl = div.querySelector('.tunnel-legend-thresholds')
  if (thresholdsEl) {
    thresholdsEl.innerHTML = bands.map((t) => `<span>${t}</span>`).join('')
  }

  const nameEl = div.querySelector('.tunnel-legend-metric-name')
  if (nameEl) nameEl.textContent = metric.label

  const wrapEl = div.querySelector('.tunnel-legend-table-wrap')
  if (!wrapEl) return

  if (!allRows.length) {
    wrapEl.innerHTML = '<div class="tunnel-legend-empty">No tunnel data yet.</div>'
    return
  }
  if (!rows.length) {
    wrapEl.innerHTML = `<div class="tunnel-legend-empty">No matches for "${escapeHtml(filter)}".</div>`
    return
  }

  const headerCells = METRICS.map((m) =>
    `<th class="metric-col${m.key === metric.key ? ' active' : ''}">${escapeHtml(m.column)}</th>`
  ).join('')
  const rowsHtml = rows.map((r) => {
    const worst = Math.max(
      levelFor(r.jitter,     thresholds.jitter),
      levelFor(r.latency,    thresholds.latency),
      levelFor(r.packetLoss, thresholds.packetLoss),
    )
    const rowClass = worst > 0 ? ` class="tunnel-row-${ROW_LEVEL_NAME[worst]}"` : ''
    const checked = hidden.has(r.id) ? '' : ' checked'
    return (
      `<tr${rowClass}>` +
        `<td class="tunnel-legend-check-col">` +
          `<input type="checkbox" data-device-id="${r.id}"${checked} aria-label="Toggle ${escapeHtml(r.name || '')} tunnels">` +
        `</td>` +
        `<td>${escapeHtml(r.name || '?')}</td>` +
        METRICS.map((m) =>
          `<td class="metric-col${m.key === metric.key ? ' active' : ''}">${fmt(r[m.key])}</td>`
        ).join('') +
      `</tr>`
    )
  }).join('')

  // Preserve the wrap container (it owns the flex/scroll styling and the
  // ResizeObserver-driven height); only swap its contents. Save/restore
  // scrollTop so a metric switch or checkbox toggle doesn't snap the
  // table back to the top when the user was scrolled mid-list.
  const prevScroll = wrapEl.scrollTop
  wrapEl.innerHTML =
    `<table class="tunnel-legend-table">` +
      `<thead><tr>` +
        `<th class="tunnel-legend-check-col">` +
          `<input type="checkbox" data-toggle-all aria-label="Toggle all sites">` +
        `</th>` +
        `<th>Location</th>${headerCells}` +
      `</tr></thead>` +
      `<tbody>${rowsHtml}</tbody>` +
    `</table>`
  wrapEl.scrollTop = prevScroll

  // Tri-state header checkbox: checked when ALL rows are visible,
  // unchecked when ALL are hidden, indeterminate when partial.
  // Indeterminate must be set as a property (not an HTML attribute).
  // Tri-state reflects the FULL site set (not the filtered subset), because
  // the "select all" callback toggles every site — keeping the checkbox and
  // its action on the same universe avoids hiding sites the filter excluded.
  const headerCb = wrapEl.querySelector('input[data-toggle-all]')
  if (headerCb) {
    const allVisible  = allRows.length > 0 && allRows.every((r) => !hidden.has(r.id))
    const noneVisible = allRows.length > 0 && allRows.every((r) =>  hidden.has(r.id))
    headerCb.checked = allVisible
    headerCb.indeterminate = !allVisible && !noneVisible
  }
}

/**
 * SDWAN-style "Sites" panel. Control + draggable + resize observer are
 * created ONCE per show (effect deps [map, hidden]); data/metric changes
 * mutate the existing DOM in place (effect deps [hidden, metricIdx, tunnels,
 * devicesById]). Rebuilding on every data change broke drag/resize state
 * when a map resize coincided with a re-render — keeping the same div +
 * draggable instance avoids that race entirely.
 */
export default function TunnelLegend({ tunnels, devicesById, hiddenDeviceIds, onToggleDevice, onToggleAll }) {
  const map = useMap()
  const [hidden, setHidden] = useState(false)
  const [metricIdx, setMetricIdx] = useState(0)
  const [filter, setFilter] = useState('')
  const positionRef = useRef({ x: 0, y: 0 })
  const widthRef = useRef(null)
  const heightRef = useRef(null)
  const divRef = useRef(null)

  // Ref so the delegated change listener (attached once in effect 1) always
  // calls the latest onToggleDevice without making effect 1 re-run on
  // every parent re-render — which would rebuild the div and re-break
  // drag + CSS-resize state (see top-of-file note).
  const onToggleRef = useRef(onToggleDevice)
  useEffect(() => { onToggleRef.current = onToggleDevice }, [onToggleDevice])
  const onToggleAllRef = useRef(onToggleAll)
  useEffect(() => { onToggleAllRef.current = onToggleAll }, [onToggleAll])

  // Mount the control once per show. Does NOT depend on data/metric, so
  // user-driven drag/CSS-resize state survives all data refreshes.
  useEffect(() => {
    if (hidden) return

    const control = L.control({ position: 'bottomright' })
    let draggable
    let resizeObs

    control.onAdd = () => {
      const div = L.DomUtil.create('div', 'tunnel-legend')
      if (widthRef.current)  div.style.width  = widthRef.current  + 'px'
      if (heightRef.current) div.style.height = heightRef.current + 'px'
      if (widthRef.current && widthRef.current >= WIDE_THRESHOLD_PX) {
        div.classList.add('wide')
      }

      const bandsHtml = BAND_COLORS.map(
        (c) => `<div class="tunnel-legend-band" style="background:${c}"></div>`
      ).join('')

      div.innerHTML =
        '<button class="legend-close" title="Hide legend" aria-label="Hide legend">×</button>' +
        '<div class="legend-title" title="Drag to move">Sites</div>' +
        `<div class="tunnel-legend-bands">${bandsHtml}</div>` +
        '<div class="tunnel-legend-thresholds"></div>' +
        '<div class="tunnel-legend-selector">' +
          '<button class="tunnel-legend-arrow" data-dir="-1" aria-label="Previous metric">&#9664;</button>' +
          '<span class="tunnel-legend-metric-name"></span>' +
          '<button class="tunnel-legend-arrow" data-dir="1" aria-label="Next metric">&#9654;</button>' +
        '</div>' +
        '<div class="tunnel-legend-filter">' +
          '<input type="search" class="tunnel-legend-filter-input" placeholder="Filter sites…" aria-label="Filter sites">' +
        '</div>' +
        '<div class="tunnel-legend-table-wrap"></div>'

      L.DomEvent.disableClickPropagation(div)
      L.DomEvent.disableScrollPropagation(div)

      const closeBtn = div.querySelector('.legend-close')
      L.DomEvent.on(closeBtn, 'click', () => setHidden(true))

      for (const btn of div.querySelectorAll('.tunnel-legend-arrow')) {
        const dir = Number(btn.getAttribute('data-dir'))
        L.DomEvent.on(btn, 'click', (e) => {
          L.DomEvent.stop(e)
          setMetricIdx((i) => (i + dir + METRICS.length) % METRICS.length)
        })
      }

      // Filter input lives in the static DOM (not the rebuilt table wrap) so
      // it keeps focus + value across the periodic data refresh. stopPropagation
      // on keydown keeps "-"/arrows from triggering Leaflet map keyboard nav.
      const filterInput = div.querySelector('.tunnel-legend-filter-input')
      if (filterInput) {
        L.DomEvent.on(filterInput, 'input', () => setFilter(filterInput.value))
        L.DomEvent.on(filterInput, 'keydown', L.DomEvent.stopPropagation)
      }

      // Delegated change listener for both per-device checkboxes AND the
      // header "select all" checkbox. Bound to the panel root once and
      // never re-attached, so the in-place table re-render in
      // renderContent() doesn't lose handlers.
      const onChange = (e) => {
        const cb = e.target
        if (!(cb && cb.tagName === 'INPUT' && cb.type === 'checkbox')) return
        if (cb.hasAttribute('data-toggle-all')) {
          if (onToggleAllRef.current) onToggleAllRef.current(cb.checked)
        } else if (cb.dataset.deviceId != null) {
          const id = Number(cb.dataset.deviceId)
          if (onToggleRef.current) onToggleRef.current(id)
        }
      }
      div.addEventListener('change', onChange)
      div._onChange = onChange

      if (typeof ResizeObserver !== 'undefined') {
        resizeObs = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const w = entry.contentRect.width
            const h = entry.contentRect.height
            widthRef.current = w
            heightRef.current = h
            div.classList.toggle('wide', w >= WIDE_THRESHOLD_PX)
          }
        })
        resizeObs.observe(div)
      }

      const titleEl = div.querySelector('.legend-title')
      draggable = new L.Draggable(div, titleEl)
      draggable.enable()
      draggable.on('drag', () => {
        L.DomUtil.setPosition(div, draggable._newPos)
        positionRef.current = { x: draggable._newPos.x, y: draggable._newPos.y }
      })

      if (positionRef.current.x || positionRef.current.y) {
        L.DomUtil.setPosition(div, positionRef.current)
      }

      divRef.current = div
      return div
    }
    control.addTo(map)
    return () => {
      if (resizeObs) resizeObs.disconnect()
      if (draggable) draggable.disable()
      const d = divRef.current
      if (d && d._onChange) d.removeEventListener('change', d._onChange)
      control.remove()
      divRef.current = null
    }
  }, [map, hidden])

  // Update DOM contents on data/metric/selection change without rebuilding
  // the div (which would invalidate draggable + CSS-resize state).
  useEffect(() => {
    if (hidden) return
    const div = divRef.current
    if (!div) return
    renderContent(div, metricIdx, tunnels, devicesById, hiddenDeviceIds, filter)
  }, [hidden, metricIdx, tunnels, devicesById, hiddenDeviceIds, filter])

  return null
}
