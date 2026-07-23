import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Allow desktop/src to import vault library modules directly.
      '@vault': path.resolve(__dirname, '../src'),
    },
  },
  // Vite serves files relative to project root; keep build output in dist/
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // Tauri dev server host
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  // Prevent Vite from obscuring Rust/Tauri error messages during dev
  clearScreen: false,
})
