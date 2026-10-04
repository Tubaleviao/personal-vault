/**
 * Package extension/dist/ as a Chrome Web Store upload zip.
 *
 *   npm run extension:package   # builds, then writes extension/personal-vault-extension-<version>.zip
 *
 * The store manages the signing key, so the dev-only "key" field is removed from the
 * manifest inside the zip (extension/manifest.json itself is left untouched).
 */
import { execFileSync } from 'child_process'
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, relative, sep } from 'path'
import { createZip, type ZipEntry } from './zip'

export function storeManifest(raw: string): string {
  const manifest = JSON.parse(raw)
  delete manifest.key
  return JSON.stringify(manifest, null, 2) + '\n'
}

export function collectEntries(dir: string): ZipEntry[] {
  const out: ZipEntry[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      const rel = relative(dir, p).split(sep).join('/')
      if (rel.endsWith('.map')) continue
      const data = rel === 'manifest.json'
        ? Buffer.from(storeManifest(readFileSync(p, 'utf8')))
        : readFileSync(p)
      out.push({ name: rel, data })
    }
  }
  walk(dir)
  return out
}

/** Paths the manifest points at that are missing from the packaged entries. */
export function missingReferences(manifestRaw: string, names: string[]): string[] {
  const m = JSON.parse(manifestRaw)
  const refs: string[] = []
  if (m.background?.service_worker) refs.push(m.background.service_worker)
  for (const cs of m.content_scripts ?? []) refs.push(...(cs.js ?? []), ...(cs.css ?? []))
  if (m.action?.default_popup) refs.push(m.action.default_popup)
  refs.push(...Object.values<string>(m.icons ?? {}), ...Object.values<string>(m.action?.default_icon ?? {}))
  const have = new Set(names)
  return refs.filter(r => !have.has(r))
}

if (require.main === module) {
  const root = join(__dirname, '..')
  const dist = join(root, 'extension/dist')
  // build.mjs never cleans its outdir; stale hashed chunks would otherwise ship in the zip.
  rmSync(dist, { recursive: true, force: true })
  execFileSync('node', [join(root, 'extension/build.mjs')], { stdio: 'inherit', cwd: root })
  const entries = collectEntries(dist)
  if (!entries.some(e => e.name === 'manifest.json')) throw new Error('extension/dist has no manifest.json')
  const missing = missingReferences(readFileSync(join(dist, 'manifest.json'), 'utf8'), entries.map(e => e.name))
  if (missing.length) throw new Error(`manifest references files missing from dist: ${missing.join(', ')}`)
  const { version } = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const outFile = join(root, 'extension', `personal-vault-extension-${version}.zip`)
  writeFileSync(outFile, createZip(entries))
  console.log(`Wrote ${outFile} (${entries.length} files)`)
}
