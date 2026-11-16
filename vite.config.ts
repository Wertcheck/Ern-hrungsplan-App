import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Der vollständige BLS-Datensatz (ca. 1,1 MB) wird bewusst als eigener, bei Bedarf geladener Chunk ausgeliefert.
  build: { chunkSizeWarningLimit: 1300, rollupOptions: { input: { index: 'index.html', bench: 'llm-bench.html' } } },
  // Das KI-Backend läuft lokal auf 127.0.0.1:8787; der Browser spricht nur den eigenen Ursprung (/api) an – kein CORS, keine Schlüssel im Frontend.
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  preview: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
