/**
 * Cross-platform `npm run native-host:install`: build the Rust host, then run the
 * platform installer (install.sh on macOS/Linux, install.ps1 on Windows).
 * EXTENSION_ID comes from the environment or a .env.local file at the repo root.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))

function run(cmd, args, cwd = root) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.error) { console.error(`Failed to run ${cmd}: ${r.error.message}`); process.exit(1) }
  if (r.status !== 0) process.exit(r.status ?? 1)
}

let extensionId = process.env.EXTENSION_ID
const envFile = join(root, '.env.local')
if (!extensionId && existsSync(envFile)) {
  const m = readFileSync(envFile, 'utf8').match(/^\s*(?:export\s+)?EXTENSION_ID\s*=\s*["']?([^"'\r\n]+?)["']?\s*$/m)
  if (m) extensionId = m[1]
}

run('cargo', ['build', '--release'], join(root, 'native-host'))

if (process.platform === 'win32') {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'native-host', 'install.ps1')]
  if (extensionId) args.push('-ExtensionId', extensionId)
  run('powershell', args)
} else {
  const args = [join(root, 'native-host', 'install.sh')]
  if (extensionId) args.push('--extension-id', extensionId)
  run('bash', args)
}
