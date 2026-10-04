import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { parsePassJson, parsePkpass } from '../src/import-pkpass'

const pass = JSON.stringify({
  formatVersion: 1,
  serialNumber: 'X1',
  generic: {
    primaryFields: [{ key: 'name', label: 'Member', value: ' Ana Silva ' }],
    secondaryFields: [{ key: 'contact', label: 'Email', value: 'ana@x.co' }, { key: 'seat', value: '12A' }],
    backFields: [{ key: 'p', label: 'Phone', value: '+55 11 99999-0000' }, { key: 'email', value: 'dup@x.co' }, { key: 'e', value: '' }],
  },
})

function zip(name: string, data: Buffer, method: 0 | 8): Uint8Array {
  const body = method === 8 ? deflateRawSync(data) : data
  const n = Buffer.from(name)
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8)
  lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26)
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(method, 10)
  cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(0, 42)
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10)
  eo.writeUInt32LE(46 + n.length, 12); eo.writeUInt32LE(30 + n.length + body.length, 16)
  return new Uint8Array(Buffer.concat([lh, n, body, cd, n, eo]))
}

test('pass.json: maps identity fields by key then label, ignores the rest', () => {
  const r = parsePassJson(pass)
  assert.deepEqual(r.map(c => [c.type, c.value]), [
    ['schema:email', 'ana@x.co'],
    ['schema:telephone', '+55 11 99999-0000'],
  ])
  assert.ok(r.every(c => c.source === 'imported' && c.verification === 'none'))
})

test('pass.json: rejects non-pass JSON', () => {
  assert.throws(() => parsePassJson('{"a":1}'), /Not an Apple Wallet/)
})

test('pkpass: reads deflated and stored pass.json', async () => {
  for (const m of [8, 0] as const) {
    const r = await parsePkpass(zip('pass.json', Buffer.from(pass), m))
    assert.equal(r.length, 2)
  }
})

test('pkpass: rejects non-zip and zip without pass.json', async () => {
  await assert.rejects(parsePkpass(new Uint8Array(40)), /not a \.pkpass/i)
  await assert.rejects(parsePkpass(zip('other.json', Buffer.from('{}'), 0)), /not found/)
})
