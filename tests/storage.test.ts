import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readdir, chmod, symlink, lstat } from 'node:fs/promises'
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

test('overwrites existing vault and leaves no .tmp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  const p = join(dir, 'v.vault')
  await writeVaultFile(p, blob)
  const next = { ...blob, header: { ...blob.header, sequenceNumber: 4 } } as PersistedVault
  await writeVaultFile(p, next)
  assert.deepEqual(await readVaultFile(p), next)
  assert.deepEqual(await readdir(dir), ['v.vault'])
})

test('header missing required fields -> CORRUPT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  const p = join(dir, 'v')
  await writeFile(p, '{"header":{"ownerId":"x","salt":"y"},"encrypted":{}}')
  assert.equal(await code(readVaultFile(p)), 'CORRUPT')
})

test('path that is a directory is not mislabelled CORRUPT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  await assert.rejects(readVaultFile(dir), (e: unknown) => !(e instanceof VaultStorageError))
})

test('unreadable file -> PERMISSION_DENIED', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root bypasses permissions')
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  const p = join(dir, 'v')
  await writeVaultFile(p, blob)
  await chmod(p, 0o000)
  assert.equal(await code(readVaultFile(p)), 'PERMISSION_DENIED')
})

test('writes through a symlinked vault path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  const real = join(dir, 'real.vault')
  const link = join(dir, 'link.vault')
  await writeVaultFile(real, blob)
  await symlink(real, link)
  await writeVaultFile(link, { ...blob, header: { ...blob.header, sequenceNumber: 4 } } as PersistedVault)
  assert.ok((await lstat(link)).isSymbolicLink())
  assert.equal((await readVaultFile(real)).header.sequenceNumber, 4)
})

test('long vault filename still writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  const p = join(dir, 'a'.repeat(240) + '.vault')
  await writeVaultFile(p, blob)
  assert.deepEqual(await readVaultFile(p), blob)
})

test('implausible scryptN -> CORRUPT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  const p = join(dir, 'v.vault')
  await writeFile(p, JSON.stringify({ ...blob, header: { ...blob.header, scryptN: 1 } }))
  assert.equal(await code(readVaultFile(p)), 'CORRUPT')
})

test('legacy header without scryptN is readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  const p = join(dir, 'v.vault')
  const legacy = { ...blob, header: { ...blob.header } } as any
  delete legacy.header.scryptN
  await writeFile(p, JSON.stringify(legacy))
  assert.deepEqual(await readVaultFile(p), legacy)
})

test('out-of-range scryptN -> CORRUPT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  const p = join(dir, 'v.vault')
  await writeFile(p, JSON.stringify({ ...blob, header: { ...blob.header, scryptN: 2 ** 30 } }))
  assert.equal(await code(readVaultFile(p)), 'CORRUPT')
})

test('dangling symlink is not replaced -> DRIVE_MISSING', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-'))
  const link = join(dir, 'v.vault')
  await symlink(join(dir, 'gone-drive', 'v.vault'), link)
  assert.equal(await code(writeVaultFile(link, blob)), 'DRIVE_MISSING')
  assert.ok((await lstat(link)).isSymbolicLink())
})
