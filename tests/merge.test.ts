import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vault } from '../src/vault'
import type { PersistedVault, Grant } from '../src/vault'
import { detectDivergence, mergeVaults, mergeVaultsWithSummary } from '../src/storage'
import { verifyChain } from '../src/audit'

const PW = 'correct horse battery staple'

async function base(setup: (v: Vault) => void): Promise<PersistedVault> {
  const v = await Vault.create({ passphrase: PW, did: 'did:key:z', mnemonicCommitment: 'm' })
  setup(v)
  return v.lock()
}

async function edit(p: PersistedVault, fn: (v: Vault) => void): Promise<PersistedVault> {
  const v = await Vault.open(p, PW)
  fn(v)
  return v.lock()
}

const claim = (value: string) => ({ type: 'name', value, source: 'self-attested' as const, verification: 'self' as const, expiresAt: null, issuerDid: null })
const grant = (id: string): Grant => ({
  id, ownerId: 'x', granteeRef: 'app', claimIds: [], purpose: 'p', mode: 'push', singleUse: false,
  expiresAt: null, ownerSig: 's', status: 'active', createdAt: new Date().toISOString(), revokedAt: null,
})
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('detectDivergence: base sequence and owner checks', async () => {
  const b = await base(() => {})
  const l = await edit(b, () => {})
  const r = await edit(b, () => {})
  const baseSeq = b.header.sequenceNumber
  assert.equal(detectDivergence(l, r, baseSeq), true)
  assert.equal(detectDivergence(l, b, baseSeq), false)   // remote unchanged
  assert.equal(detectDivergence(b, r, baseSeq), false)   // local unchanged
  assert.equal(detectDivergence(l, r), true)             // same seq, different content
  assert.equal(detectDivergence(l, l), false)
  const other = await base(() => {})
  assert.equal(detectDivergence(l, other, 0), false)
})

test('merge: identical, conflict (last updatedAt wins), new on each side', async () => {
  let same = '', conflict = ''
  const b = await base(v => { same = v.addClaim(claim('same')).id; conflict = v.addClaim(claim('old')).id })
  await sleep(5)
  const l = await edit(b, v => { v.updateClaim(conflict, { value: 'local' }); v.addClaim(claim('L-new')) })
  await sleep(5)
  const r = await edit(b, v => { v.updateClaim(conflict, { value: 'remote' }); v.addClaim(claim('R-new')) })

  const { vault, summary } = await mergeVaultsWithSummary(l, r, PW)
  assert.equal(summary.identical, 1)
  assert.equal(summary.remoteWins, 1)
  assert.equal(summary.onlyLocal, 1)
  assert.equal(summary.onlyRemote, 1)
  assert.deepEqual(summary.overwritten.map(o => o.kept), ['remote'])

  const m = await Vault.open(vault, PW)
  assert.equal(m.getClaim(conflict).value, 'remote')
  assert.equal(m.getClaim(same).value, 'same')
  assert.deepEqual(m.listClaims().map(c => c.value).sort(), ['L-new', 'R-new', 'remote', 'same'])
})

test('merge: local wins when local edit is later', async () => {
  let id = ''
  const b = await base(v => { id = v.addClaim(claim('old')).id })
  await sleep(5)
  const r = await edit(b, v => v.updateClaim(id, { value: 'remote' }))
  await sleep(5)
  const l = await edit(b, v => v.updateClaim(id, { value: 'local' }))
  const m = await Vault.open(await mergeVaults(l, r, PW), PW)
  assert.equal(m.getClaim(id).value, 'local')
})

test('merge: delete beats modify, either direction', async () => {
  let a = '', c = ''
  const b = await base(v => { a = v.addClaim(claim('a')).id; c = v.addClaim(claim('c')).id })
  await sleep(5)
  const l = await edit(b, v => { v.deleteClaim(a); v.updateClaim(c, { value: 'c2' }) })
  const r = await edit(b, v => { v.updateClaim(a, { value: 'a2' }); v.deleteClaim(c) })
  const m = await Vault.open(await mergeVaults(l, r, PW), PW)
  assert.equal(m.listClaims().length, 0)
  // and the other way round
  const m2 = await Vault.open(await mergeVaults(r, l, PW), PW)
  assert.equal(m2.listClaims().length, 0)
})

test('merge: revocation wins on either side; new grants included', async () => {
  const b = await base(v => { v.addGrant(grant('g1')); v.addGrant(grant('g2')) })
  const l = await edit(b, v => { v.revokeGrant('g1'); v.addGrant(grant('gl')) })
  const r = await edit(b, v => { v.revokeGrant('g2'); v.addGrant(grant('gr')) })
  const { vault, summary } = await mergeVaultsWithSummary(l, r, PW)
  assert.equal(summary.grantsRevoked, 1)
  assert.equal(summary.grantsAdded, 1)
  const m = await Vault.open(vault, PW)
  const status = Object.fromEntries(m.listGrants().map(g => [g.id, g.status]))
  assert.deepEqual(status, { g1: 'revoked', g2: 'revoked', gl: 'active', gr: 'active' })
})

test('merge: audit chain intact, merge entry records remote tail, sequence = max + 1', async () => {
  const b = await base(v => v.addClaim(claim('x')))
  const l = await edit(b, v => v.addClaim(claim('l')))
  const r = await edit(b, v => { v.addClaim(claim('r1')); v.addClaim(claim('r2')) })
  const rv = await Vault.open(r, PW)
  const rTail = rv.getAuditLog().filter(e => e.action !== 'vault-unlocked').pop()!
  const merged = await mergeVaults(l, r, PW)
  assert.equal(merged.header.sequenceNumber, Math.max(l.header.sequenceNumber, r.header.sequenceNumber) + 1)
  const log = (await Vault.open(merged, PW)).getAuditLog()
  assert.equal(verifyChain(log).valid, true)
  const entry = log.find(e => e.action === 'merge')!
  assert.ok(entry)
  const detail = entry.detail as { mergedFromHash: string; mergedFromSequence: number }
  assert.equal(detail.mergedFromSequence, r.header.sequenceNumber)
  assert.match(detail.mergedFromHash, /^[0-9a-f]{64}$/)
  assert.ok(rTail.entryHash)
})

test('merge: wrong passphrase and foreign vault are rejected', async () => {
  const l = await base(() => {})
  const r = await edit(l, () => {})
  await assert.rejects(mergeVaults(l, r, 'nope'), /Incorrect passphrase/)
  const other = await base(() => {})
  await assert.rejects(mergeVaults(l, other, PW), /different owners/)
})

test('merge: re-imported claim after delete survives merge', async () => {
  let saved: any
  const b = await base(v => { saved = v.addClaim(claim('Ann')) })
  const l = await edit(b, v => { v.deleteClaim(saved.id); v.importClaim(saved) })
  const r = await edit(b, () => {})
  const merged = await Vault.open(await mergeVaults(l, r, PW), PW)
  assert.equal(merged.listClaims().some(c => c.id === saved.id), true)
})

test('merge: revived claim survives a copy that still has the older tombstone', async () => {
  let saved: any
  const b = await base(v => { saved = v.addClaim(claim('Ann')) })
  const del = await edit(b, v => { v.deleteClaim(saved.id) })
  const revived = await edit(del, v => { v.importClaim(saved) })
  const once = await mergeVaults(revived, del, PW)
  assert.equal((await Vault.open(once, PW)).listClaims().some(c => c.id === saved.id), true)
  const twice = await mergeVaults(once, del, PW)
  assert.equal((await Vault.open(twice, PW)).listClaims().some(c => c.id === saved.id), true)
})

test('merge: remote-only audit entries are preserved and chain verifies', async () => {
  const b = await base(() => {})
  const l = await edit(b, v => { v.addClaim(claim('L')) })
  const r = await edit(b, v => { v.addClaim(claim('R')) })
  const merged = await Vault.open(await mergeVaults(l, r, PW), PW)
  const log = merged.getAuditLog()
  const entry: any = log.find(e => e.action === 'merge')
  assert.ok(entry.detail.mergedEntries.some((e: any) => e.action === 'claim-added'))
  assert.equal(verifyChain(log).valid, true)
})

test('repeat merge does not re-embed remote audit entries', async () => {
  const b = await base(() => {})
  const l = await edit(b, v => { v.addClaim(claim('L')) })
  const r = await edit(b, v => { v.addClaim(claim('R')) })
  const first = await mergeVaults(l, r, PW)
  const second = await mergeVaults(first, r, PW)
  const embedded = (p: PersistedVault) => edit(p, () => {}).then(async q => {
    const v = await Vault.open(q, PW)
    const n = v.getAuditLog().filter(e => e.action === 'merge')
      .reduce((s, e) => s + ((e.detail as any).mergedEntries?.length ?? 0), 0)
    await v.discard()
    return n
  })
  const n1 = await embedded(first)
  const n2 = await embedded(second)
  assert.ok(n1 > 0)
  // Only the throw-away remote's own unlock entry may be new; earlier entries are not re-embedded.
  assert.ok(n2 <= n1 + 1, `embedded ${n2} vs ${n1}`)
})

test('merge keeps the later tombstone when both sides deleted a claim', async () => {
  let id = ''
  const b = await base(v => { id = v.addClaim(claim('X')).id })
  const l = await edit(b, v => { v.deleteClaim(id) })
  await sleep(5)
  const r = await edit(b, v => { v.deleteClaim(id) })
  const m = await mergeVaults(l, r, PW)
  const v = await Vault.open(m, PW)
  assert.equal(v.listClaims().some(c => c.id === id), false)
  await v.discard()
})
