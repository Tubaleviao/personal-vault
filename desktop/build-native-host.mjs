/**
 * Build the native messaging host binary and stage it for Tauri bundling.
 * Cross-platform replacement for build-native-host.sh.
 *
 *   cd desktop && node build-native-host.mjs
 *
 * The binary and manifest are copied to src-tauri/resources/ where tauri.conf.json
 * picks them up as bundle resources. The bundled name has no extension on every
 * platform (that is the name tauri.conf.json lists), so on Windows the .exe is
 * copied to the extensionless name.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const hostDir = join(repoRoot, 'native-host')
const resources = join(repoRoot, 'desktop', 'src-tauri', 'resources')
const bin = 'personal-vault-native-host'
const built = bin + (process.platform === 'win32' ? '.exe' : '')

console.log('Building native host...')
const r = spawnSync('cargo', ['build', '--release'], { cwd: hostDir, stdio: 'inherit' })
if (r.error) { console.error(`Failed to run cargo: ${r.error.message}`); process.exit(1) }
if (r.status !== 0) process.exit(r.status ?? 1)

console.log('Staging resources...')
mkdirSync(resources, { recursive: true })
copyFileSync(join(hostDir, 'target', 'release', built), join(resources, bin))
copyFileSync(join(hostDir, 'com.personal_vault.json'), join(resources, 'com.personal_vault.json'))
console.log(`Done. Resources staged at ${resources}`)
