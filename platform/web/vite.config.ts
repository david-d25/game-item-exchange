import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The site lives under /exchange/ behind the gateway (see nginx/default.conf.template).
// In development the same path is proxied to core, so the app never needs to know where core runs.
const coreUrl = process.env.VITE_CORE_URL ?? 'http://localhost:8080'

const apiProxy = {
  '/exchange/api': {
    target: coreUrl,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/exchange\/api/, '/api'),
  },
}

export default defineConfig({
  base: '/exchange/',
  plugins: [react()],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
  },
})
