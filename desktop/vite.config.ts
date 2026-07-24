import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // bip39 (and other Node-ported libs) reference Buffer as a global.
    // Inject it so the WebView can find it at runtime.
    global: 'globalThis',
  },
  resolve: {
    alias: {
      // Allow desktop/src to import vault library modules directly.
      '@vault': path.resolve(__dirname, '../src'),
      // libsodium-wrappers ESM entry (modules-esm/) is broken — missing libsodium.mjs.
      // Force Vite to use the working CJS build instead.
      'libsodium-wrappers': path.resolve(__dirname, '../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js'),
      // Polyfill Node's Buffer for bip39 and other Node-ported libs.
      'buffer': path.resolve(__dirname, 'node_modules/buffer/index.js'),
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
