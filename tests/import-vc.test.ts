import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVCWalletExport } from '../src/import-vc'

const vc = (extra: object = {}) => ({
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  type: ['VerifiableCredential'],
  issuer: 'did:example:issuer',
  issuanceDate: '2024-01-01T00:00:00Z',
  expirationDate: '2030-01-01T00:00:00Z',
  credentialSubject: { id: 'did:example:me', degree: 'BSc', age: 30, empty: '' },
  ...extra,
})

test('single VC: maps subject fields, stringifies, skips id/empty, unproven = none', async () => {
  const claims = await parseVCWalletExport(JSON.stringify(vc()))
  assert.deepEqual(claims.map(c => [c.type, c.value]), [['vc:degree', 'BSc'], ['vc:age', '30']])
  assert.ok(claims.every(c => c.verification === 'none' && c.source === 'issuer-signed'))
  assert.equal(claims[0].issuerDid, 'did:example:issuer')
  assert.equal(claims[0].expiresAt, '2030-01-01T00:00:00Z')
})

test('array and wrapper shapes are accepted; JWT strings ignored', async () => {
  const inner = vc({ issuer: { id: 'did:example:i2' } })
  assert.equal((await parseVCWalletExport(JSON.stringify([vc(), inner]))).length, 4)
  const vp = { type: ['VerifiablePresentation'], verifiableCredential: [inner, 'eyJhbGciOi.x.y'] }
  const claims = await parseVCWalletExport(JSON.stringify(vp))
  assert.equal(claims.length, 2)
  assert.equal(claims[0].issuerDid, 'did:example:i2')
})

test('bogus proof never yields verified', async () => {
  const proof = { type: 'Ed25519Signature2020', created: 'x', verificationMethod: 'did:example:issuer#k', proofPurpose: 'assertionMethod', proofValue: 'zabc' }
  const claims = await parseVCWalletExport(JSON.stringify(vc({ proof })))
  assert.ok(claims.every(c => c.verification === 'none'))
})

test('rejects malformed JSON and no-credential files', async () => {
  await assert.rejects(parseVCWalletExport('nope'))
  await assert.rejects(parseVCWalletExport('{"a":1}'))
})

test('expired credential is never verified; missing proofValue does not throw', async () => {
  const bad = { type: 'Ed25519Signature2020', created: 'x', verificationMethod: 'did:example:issuer#k', proofPurpose: 'assertionMethod' }
  const claims = await parseVCWalletExport(JSON.stringify([vc({ proof: bad }), vc({ expirationDate: '2020-01-01T00:00:00Z' })]))
  assert.ok(claims.length > 0 && claims.every(c => c.verification === 'none'))
})

test('array credentialSubject is imported', async () => {
  const claims = await parseVCWalletExport(JSON.stringify(vc({ credentialSubject: [{ a: '1' }, { b: '2' }] })))
  assert.equal(claims.length, 2)
})

test('ownerDid given: subject naming someone else is never verified', async () => {
  const claims = await parseVCWalletExport(JSON.stringify(vc()), 'did:example:other')
  assert.ok(claims.length > 0 && claims.every(c => c.verification === 'none'))
})
