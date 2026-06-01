import { useEffect, useRef, useState } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { getConfig } from '../lib/config.js'

const METRICS = [
  { key: 'latency',    label: 'Latency - Average',    column: 'Latency - Avg'    },
  { key: 'dataLoss',   label: 'Data Loss - Average',  column: 'Data Loss - Avg'  },
  { key: 'dataJitter', label: 'Data Jitter - Average', column: 'Data Jitter - Avg' },
]

const BAND_COLORS = ['#388e3c', '#fbc02d', '#f57c00', '#d32f2f']
const ROW_LEVEL_NAME = ['good', 'minor', 'warn', 'bad']

const WIDE_THRESHOLD_PX = 380

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

// AppNeta paths are MP→target, not MP↔MP — so the row pivot is the source
// MP only (no destination column). Each row averages all paths originating
// from that MP across the three cycled metrics.
function computeMpAverages(paths) {
  const sums = new Map()
  for (const p of paths) {
    const id = p.sourceDeviceId
    let s = sums.get(id)
    if (!s) {
      s = { name: p.sourceName, latS: 0, latC: 0, lossS: 0, lossC: 0, jitS: 0, jitC: 0 }
      sums.set(id, s)
    }
    if (p.latency    != null) { s.latS  += p.latency;    s.latC++  }
    if (p.dataLoss   != null) { s.lossS += p.dataLoss;   s.lossC++ }
    if (p.dataJitter != null) { s.jitS  += p.dataJitter; s.jitC++  }
  }
  const rows = []
  for (const [id, s] of sums) {
    rows.push({
      id,
      name: s.name,
      latency:    s.latC  ? s.latS  / s.latC  : null,
      dataLoss:   s.lossC ? s.lossS / s.lossC : null,
      dataJitter: s.jitC  ? s.jitS  / s.jitC  : null,
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

function renderContent(div, metricIdx, paths, hiddenDeviceIds, filter) {
  const thresholds = getConfig().appnetaPaths.thresholds
  const metric = METRICS[metricIdx]
  const bands = thresholds[metric.key] || [0, 0, 0]
  const allRows = computeMpAverages(paths || [])
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
    wrapEl.innerHTML = '<div class="tunnel-legend-empty">No AppNeta path data yet.</div>'
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
      levelFor(r.latency,    thresholds.latency),
      levelFor(r.dataLoss,   thresholds.dataLoss),
      levelFor(r.dataJitter, thresholds.dataJitter),
    )
    const rowClass = worst > 0 ? ` class="tunnel-row-${ROW_LEVEL_NAME[worst]}"` : ''
    const checked = hidden.has(r.id) ? '' : ' checked'
    return (
      `<tr${rowClass}>` +
        `<td class="tunnel-legend-check-col">` +
          `<input type="checkbox" data-device-id="${r.id}"${checked} aria-label="Toggle ${escapeHtml(r.name || '')} paths">` +
        `</td>` +
        `<td>${escapeHtml(r.name || '?')}</td>` +
        METRICS.map((m) =>
          `<td class="metric-col${m.key === metric.key ? ' active' : ''}">${fmt(r[m.key])}</td>`
        ).join('') +
      `</tr>`
    )
  }).join('')

  const prevScroll = wrapEl.scrollTop
  wrapEl.innerHTML =
    `<table class="tunnel-legend-table">` +
      `<thead><tr>` +
        `<th class="tunnel-legend-check-col">` +
          `<input type="checkbox" data-toggle-all aria-label="Toggle all MPs">` +
        `</th>` +
        `<th>MP</th>${headerCells}` +
      `</tr></thead>` +
      `<tbody>${rowsHtml}</tbody>` +
    `</table>`
  wrapEl.scrollTop = prevScroll

  // Tri-state header checkbox: checked when ALL rows are visible,
  // unchecked when ALL are hidden, indeterminate when partial.
  // Indeterminate must be set as a property (not an HTML attribute).
  // Tri-state reflects the FULL MP set (not the filtered subset), because the
  // "select all" callback toggles every MP — keeping the checkbox and its
  // action on the same universe avoids hiding MPs the filter excluded.
  const headerCb = wrapEl.querySelector('input[data-toggle-all]')
  if (headerCb) {
    const allVisible  = allRows.length > 0 && allRows.every((r) => !hidden.has(r.id))
    const noneVisible = allRows.length > 0 && allRows.every((r) =>  hidden.has(r.id))
    headerCb.checked = allVisible
    headerCb.indeterminate = !allVisible && !noneVisible
  }
}

/**
 * AppNeta "MPs" panel. Same two-effect DOM-preservation pattern as
 * TunnelLegend: effect 1 (deps [map, hidden]) creates the control once;
 * effect 2 (deps [hidden, metricIdx, paths, hiddenDeviceIds]) mutates
 * contents in place. Rebuilding the div on every data refresh breaks drag
 * + CSS-resize when a map resize coincides with a re-render — see the
 * tunnel-legend memory entry.
 *
 * Reuses .tunnel-legend CSS classes for visual consistency.
 */
export default function AppNetaLegend({ paths, hiddenDeviceIds, onToggleDevice, onToggleAll }) {
  const map = useMap()
  const [hidden, setHidden] = useState(false)
  const [metricIdx, setMetricIdx] = useState(0)
  const [filter, setFilter] = useState('')
  const positionRef = useRef({ x: 0, y: 0 })
  const widthRef = useRef(null)
  const heightRef = useRef(null)
  const divRef = useRef(null)

  const onToggleRef = useRef(onToggleDevice)
  useEffect(() => { onToggleRef.current = onToggleDevice }, [onToggleDevice])
  const onToggleAllRef = useRef(onToggleAll)
  useEffect(() => { onToggleAllRef.current = onToggleAll }, [onToggleAll])

  useEffect(() => {
    if (hidden) return

    const control = L.control({ position: 'bottomright' })
    let draggable
    let resizeObs

    control.onAdd = () => {
      const div = L.DomUtil.create('div', 'tunnel-legend appneta-legend')
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
        '<div class="legend-title" title="Drag to move">AppNeta MPs</div>' +
        `<div class="tunnel-legend-bands">${bandsHtml}</div>` +
        '<div class="tunnel-legend-thresholds"></div>' +
        '<div class="tunnel-legend-selector">' +
          '<button class="tunnel-legend-arrow" data-dir="-1" aria-label="Previous metric">&#9664;</button>' +
          '<span class="tunnel-legend-metric-name"></span>' +
          '<button class="tunnel-legend-arrow" data-dir="1" aria-label="Next metric">&#9654;</button>' +
        '</div>' +
        '<div class="tunnel-legend-filter">' +
          '<input type="search" class="tunnel-legend-filter-input" placeholder="Filter MPs…" aria-label="Filter MPs">' +
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

  useEffect(() => {
    if (hidden) return
    const div = divRef.current
    if (!div) return
    renderContent(div, metricIdx, paths, hiddenDeviceIds, filter)
  }, [hidden, metricIdx, paths, hiddenDeviceIds, filter])

  return null
}
