import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Der vollständige BLS-Datensatz (ca. 1,1 MB) wird bewusst als eigener, bei Bedarf geladener Chunk ausgeliefert.
  build: { chunkSizeWarningLimit: 1300 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
