/**
 * Package extension/dist/ as a Chrome Web Store upload zip.
 *
 *   npm run extension:package   # builds, then writes extension/personal-vault-extension-<version>.zip
 *
 * The store manages the signing key, so the dev-only "key" field is removed from the
 * manifest inside the zip (extension/manifest.json itself is left untouched).
 */
import { execFileSync } from 'child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
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

if (require.main === module) {
  const root = join(__dirname, '..')
  execFileSync('node', [join(root, 'extension/build.mjs')], { stdio: 'inherit', cwd: root })
  const dist = join(root, 'extension/dist')
  const entries = collectEntries(dist)
  if (!entries.some(e => e.name === 'manifest.json')) throw new Error('extension/dist has no manifest.json')
  const { version } = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const outFile = join(root, 'extension', `personal-vault-extension-${version}.zip`)
  writeFileSync(outFile, createZip(entries))
  console.log(`Wrote ${outFile} (${entries.length} files)`)
}
