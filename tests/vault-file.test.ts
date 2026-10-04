import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVaultFileText } from '../src/vault-file'

const good = {
  header: { version: '1', ownerId: 'did:key:z', salt: 's', keyVerificationHash: 'h', sequenceNumber: 2, scryptN: 65536 },
  encrypted: { nonce: 'n', ciphertext: 'c' },
}

test('valid vault text parses', () => {
  assert.deepEqual(parseVaultFileText(JSON.stringify(good)), good)
})

test('non-JSON, wrong shape and bad scryptN return null', () => {
  assert.equal(parseVaultFileText('not json'), null)
  assert.equal(parseVaultFileText('null'), null)
  assert.equal(parseVaultFileText('{}'), null)
  assert.equal(parseVaultFileText(JSON.stringify({ ...good, encrypted: {} })), null)
  assert.equal(parseVaultFileText(JSON.stringify({ ...good, header: { ...good.header, scryptN: 1024 } })), null)
})
