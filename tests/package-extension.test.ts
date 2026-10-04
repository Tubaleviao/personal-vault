import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { createZip, crc32 } from '../scripts/zip'
import { storeManifest, collectEntries, missingReferences } from '../scripts/package-extension'

test('crc32 matches known vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('storeManifest drops key only', () => {
  const out = JSON.parse(storeManifest(JSON.stringify({ name: 'x', key: 'K', version: '1' })))
  assert.deepEqual(out, { name: 'x', version: '1' })
})

test('collectEntries strips key, skips maps, uses posix paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ext-'))
  try {
    mkdirSync(join(dir, 'popup'))
    writeFileSync(join(dir, 'manifest.json'), '{"key":"K","version":"1"}')
    writeFileSync(join(dir, 'background.js'), 'x')
    writeFileSync(join(dir, 'background.js.map'), 'm')
    writeFileSync(join(dir, 'popup', 'index.html'), '<p>')
    const entries = collectEntries(dir)
    assert.deepEqual(entries.map(e => e.name), ['background.js', 'manifest.json', 'popup/index.html'])
    assert.ok(!entries.find(e => e.name === 'manifest.json')!.data.toString().includes('"key"'))
  } finally { rmSync(dir, { recursive: true }) }
})

test('missingReferences flags manifest paths absent from dist', () => {
  const m = JSON.stringify({
    background: { service_worker: 'background.js' },
    content_scripts: [{ js: ['content.js'] }],
    action: { default_popup: 'popup/index.html' },
    icons: { 16: 'icons/icon16.png' },
  })
  assert.deepEqual(missingReferences(m, ['background.js', 'content.js', 'popup/index.html', 'icons/icon16.png']), [])
  assert.deepEqual(missingReferences(m, ['background.js', 'icons/icon16.png']), ['content.js', 'popup/index.html'])
})

const hasUnzip = spawnSync('unzip', ['-v']).status === 0
test('createZip output is readable by unzip', { skip: !hasUnzip && 'unzip not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'zip-'))
  try {
    const big = Buffer.from('hello world '.repeat(500))
    const f = join(dir, 'a.zip')
    writeFileSync(f, createZip([{ name: 'a.txt', data: big }, { name: 'd/b.txt', data: Buffer.from('b') }]))
    assert.equal(execFileSync('unzip', ['-p', f, 'a.txt']).toString(), big.toString())
    assert.equal(execFileSync('unzip', ['-p', f, 'd/b.txt']).toString(), 'b')
    execFileSync('unzip', ['-t', f])
  } finally { rmSync(dir, { recursive: true }) }
})
