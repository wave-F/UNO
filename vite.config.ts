import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'esnext',
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
  server: {
    host: true,
    port: 5173,
  },
})
