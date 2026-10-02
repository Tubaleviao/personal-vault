import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readVaultFile, writeVaultFile, detectDriveMissing, VaultStorageError,
} from '../src/storage'
import type { PersistedVault } from '../src/vault'

const blob = {
  header: { version: '1', ownerId: 'did:key:z', salt: 's', keyVerificationHash: 'h', mnemonicCommitment: 'm', sequenceNumber: 3, scryptN: 65536 },
  encrypted: { nonce: 'n', ciphertext: 'c' },
} as unknown as PersistedVault

async function code(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { assert.ok(e instanceof VaultStorageError); return e.code }
  return 'none'
}

test('write then read round-trips, leaves no .tmp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  const p = join(dir, 'v.vault')
  await writeVaultFile(p, blob)
  assert.deepEqual(await readVaultFile(p), blob)
  assert.deepEqual(await readdir(dir), ['v.vault'])
})

test('empty path -> NOT_CONFIGURED', async () => {
  assert.equal(await code(readVaultFile('')), 'NOT_CONFIGURED')
  assert.equal(await code(writeVaultFile('', blob)), 'NOT_CONFIGURED')
})

test('missing file in existing dir -> NOT_FOUND', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  assert.equal(await code(readVaultFile(join(dir, 'nope.vault'))), 'NOT_FOUND')
})

test('missing parent dir -> DRIVE_MISSING', async () => {
  const p = join(tmpdir(), 'no-such-drive-xyz', 'v.vault')
  assert.equal(await detectDriveMissing(p), true)
  assert.equal(await code(readVaultFile(p)), 'DRIVE_MISSING')
  assert.equal(await code(writeVaultFile(p, blob)), 'DRIVE_MISSING')
})

test('invalid JSON or wrong shape -> CORRUPT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  const a = join(dir, 'a'), b = join(dir, 'b')
  await writeFile(a, 'not json')
  await writeFile(b, '{"foo":1}')
  assert.equal(await code(readVaultFile(a)), 'CORRUPT')
  assert.equal(await code(readVaultFile(b)), 'CORRUPT')
})

test('unreadable file -> PERMISSION_DENIED', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root bypasses permissions')
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  const p = join(dir, 'v')
  await writeVaultFile(p, blob)
  await chmod(p, 0o000)
  assert.equal(await code(readVaultFile(p)), 'PERMISSION_DENIED')
})
