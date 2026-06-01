import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'
import App from './App.jsx'
import { loadRuntimeConfig } from './lib/config.js'

// Leaflet default marker icons don't load via Vite/Webpack without this fix.
// Leaflet's CSS references icon images by relative URL, but bundlers don't
// emit them as static assets. We import them explicitly and re-point the
// default Icon at the bundler-emitted URLs.
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png'
import iconUrl from 'leaflet/dist/images/marker-icon.png'
import shadowUrl from 'leaflet/dist/images/marker-shadow.png'

delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl,
  iconUrl,
  shadowUrl,
})

const root = createRoot(document.getElementById('root'))

loadRuntimeConfig()
  .then(() => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  })
  .catch((e) => {
    root.render(
      <div className="status-banner status-error">
        Failed to load runtime-config.json: {e.message}
      </div>
    )
  })
