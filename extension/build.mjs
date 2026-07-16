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
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
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
  // Buffer polyfill for base64url operations
  inject: [],
  define: {
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
  },
  logLevel: 'info',
}

// We need a crypto shim because vault.ts imports { randomUUID, createHash } from 'crypto'.
// In the extension we use WebCrypto for hashing and crypto.randomUUID() for IDs.
const cryptoShim = `
export const randomUUID = () => crypto.randomUUID()
export const createHash = (algo) => {
  const chunks = []
  return {
    update(data) { chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : data); return this },
    digest(enc) {
      const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      let offset = 0
      for (const c of chunks) { merged.set(c, offset); offset += c.length }
      return crypto.subtle.digestSync
        ? Buffer.from(crypto.subtle.digestSync('SHA-256', merged)).toString(enc)
        : '(async-hash-not-supported-sync)'
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
writeFileSync(join(outdir, '../crypto-shim.js'), cryptoShim)

const builds = [
  {
    entryPoints: ['extension/background.ts'],
    outfile: join(outdir, 'background.js'),
  },
  {
    entryPoints: ['extension/content.ts'],
    outfile: join(outdir, 'content.js'),
    // Content scripts can't use top-level await in all contexts; use iife
    format: 'iife',
  },
  {
    entryPoints: ['extension/popup/popup.ts'],
    outfile: join(outdir, 'popup/popup.js'),
  },
]

const ctx = await esbuild.context({
  ...sharedConfig,
  entryPoints: builds.flatMap(b => b.entryPoints),
  outdir,
  splitting: true, // share vault code between background + popup
})

// Copy static assets
copyFileSync('extension/manifest.json', join(outdir, 'manifest.json'))
copyFileSync('extension/popup/index.html', join(outdir, 'popup/index.html'))

if (watch) {
  await ctx.watch()
  console.log('Watching for changes...')
} else {
  await ctx.rebuild()
  await ctx.dispose()
  console.log('Extension built to', outdir)
}
