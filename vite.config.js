import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' makes all asset URLs in the built index.html relative.
// This is essential for App View deployment: the portal serves the app
// from a path we don't control, and absolute paths would 404.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
  },
})
