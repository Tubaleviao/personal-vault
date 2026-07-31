/**
 * Extension build script (esbuild).
 *
 * Usage:
 *   node extension/build.mjs          # production build
 *   node extension/build.mjs --watch  # watch mode for development
 *
 * Output: extension/dist/  — load this directory as an unpacked extension in Chrome.
 *
 * The vault library (src/*.ts) uses Node built-ins (crypto, Buffer).
 * We polyfill them for the browser context via esbuild's `inject` + `define` options.
 * libsodium-wrappers is bundled as a CJS module (the ESM entry is broken in this env).
 */

import esbuild from 'esbuild'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const watch = process.argv.includes('--watch')
const outdir = new URL('./dist/', import.meta.url).pathname

mkdirSync(outdir, { recursive: true })
mkdirSync(join(outdir, 'popup'), { recursive: true })

const sharedConfig = {
  bundle: true,
  platform: 'browser',
  target: ['chrome120'],
  format: 'esm',
  // Inject the Buffer polyfill so bip39 (which uses Buffer as a Node global) works
  // in the browser context. The define entry maps the global name to the export.
  inject: ['./extension/buffer-polyfill.js'],
  define: {
    'Buffer': 'Buffer',
    // Node crypto built-in: randomUUID is available as crypto.randomUUID() in browsers
    'process.env.NODE_ENV': '"production"',
  },
  external: [
    // libsodium ships a pre-built browser bundle — reference it directly at runtime
    // via importScripts in the service worker. Don't bundle it through esbuild.
  ],
  alias: {
    // Redirect Node built-ins to browser-compatible stubs
    'crypto': './crypto-shim.js',
    // Force the CJS entry — the ESM entry (dist/modules-esm/) imports a
    // non-existent libsodium.mjs and breaks esbuild's bundler.
    'libsodium-wrappers': './node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js',
  },
  logLevel: 'info',
}

// We need a crypto shim because vault.ts imports { randomUUID, createHash } from 'crypto'.
// In the extension we use WebCrypto for hashing and crypto.randomUUID() for IDs.
const cryptoShim = `
export const timingSafeEqual = (a, b) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
export const randomUUID = () => crypto.randomUUID()
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n))
export const scryptSync = () => { throw new Error('scryptSync unavailable in browser') }
export const createHash = (algo) => {
  const chunks = []
  return {
    update(data) { chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : data); return this },
    digest(_enc) {
      // Synchronous SHA-256 is not available in browser WebCrypto; callers in the
      // extension code path use digestAsync() instead.
      return '(sync-hash-unavailable-in-browser)'
    },
    async digestAsync(enc) {
      const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      let offset = 0
      for (const c of chunks) { merged.set(c, offset); offset += c.length }
      const buf = await crypto.subtle.digest('SHA-256', merged)
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('')
    },
  }
}
`
writeFileSync('crypto-shim.js', cryptoShim)

// background + popup share vault code via ESM chunks (code splitting)
const esmCtx = await esbuild.context({
  ...sharedConfig,
  entryPoints: ['extension/background.ts', 'extension/popup/popup.ts'],
  outdir,
  splitting: true,
  format: 'esm',
})

// content script must be a self-contained IIFE — no import statements allowed
// in classic scripts injected by the extension manifest
const iifeCtx = await esbuild.context({
  ...sharedConfig,
  entryPoints: ['extension/content.ts'],
  outfile: join(outdir, 'content.js'),
  splitting: false,
  format: 'iife',
})

// Copy static assets
copyFileSync('extension/manifest.json', join(outdir, 'manifest.json'))
copyFileSync('extension/popup/index.html', join(outdir, 'popup/index.html'))

// Copy icons
const iconsDir = join(outdir, 'icons')
mkdirSync(iconsDir, { recursive: true })
for (const file of readdirSync('extension/icons')) {
  copyFileSync(join('extension/icons', file), join(iconsDir, file))
}

if (watch) {
  await Promise.all([esmCtx.watch(), iifeCtx.watch()])
  console.log('Watching for changes...')
} else {
  await Promise.all([esmCtx.rebuild(), iifeCtx.rebuild()])
  await Promise.all([esmCtx.dispose(), iifeCtx.dispose()])
  console.log('Extension built to', outdir)
}
