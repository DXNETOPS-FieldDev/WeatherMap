/**
 * Runtime config loader. Reads runtime-config.json from the same folder as
 * index.html so the customer can change values (OWM API key, map defaults,
 * OData tuning) without a rebuild — just edit the file in the unzipped
 * App View and refresh.
 *
 * main.jsx awaits loadRuntimeConfig() before mounting React, so by the
 * time any component renders, getConfig() is safe to call synchronously.
 */

let cached = null

export async function loadRuntimeConfig() {
  if (cached) return cached
  const response = await fetch('./runtime-config.json', { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Failed to load runtime-config.json: HTTP ${response.status}`)
  }
  cached = await response.json()
  return cached
}

export function getConfig() {
  if (!cached) {
    throw new Error('Runtime config not loaded — call loadRuntimeConfig() first')
  }
  return cached
}
