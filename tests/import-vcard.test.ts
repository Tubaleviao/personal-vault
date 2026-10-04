import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVCard } from '../src/import-vcard'

const byType = (t: string) => (cs: { type: string; value: string }[]) => cs.find(c => c.type === t)?.value

test('vcard: maps common properties, first card only', () => {
  const text = [
    'BEGIN:VCARD', 'VERSION:3.0',
    'N:Silva;Ana Maria;;;', 'FN:Ana Silva',
    'item1.EMAIL;TYPE=INTERNET;TYPE=HOME:ana@x.co', 'EMAIL:second@x.co',
    'TEL;TYPE=CELL:+55 11 99999-0000',
    'BDAY:19900131', 'TITLE:Engineer', 'ORG:Acme\\, Inc.;Dept',
    'ADR;TYPE=HOME:;;Rua A\\, 1;São Paulo;SP;01000-000;Brazil',
    'END:VCARD', 'BEGIN:VCARD', 'FN:Other Person', 'END:VCARD',
  ].join('\r\n')
  const r = parseVCard(text)
  const get = (t: string) => byType(t)(r)
  assert.equal(get('schema:givenName'), 'Ana Maria')
  assert.equal(get('schema:familyName'), 'Silva')
  assert.equal(get('schema:name'), 'Ana Silva')
  assert.equal(get('schema:email'), 'ana@x.co')
  assert.equal(get('schema:telephone'), '+55 11 99999-0000')
  assert.equal(get('schema:birthDate'), '1990-01-31')
  assert.equal(get('schema:jobTitle'), 'Engineer')
  assert.equal(get('schema:worksFor'), 'Acme, Inc.')
  assert.equal(get('schema:streetAddress'), 'Rua A, 1')
  assert.equal(get('schema:addressLocality'), 'São Paulo')
  assert.equal(get('schema:postalCode'), '01000-000')
  assert.equal(get('schema:addressCountry'), 'Brazil')
  assert.ok(r.every(c => c.source === 'imported' && c.verification === 'none'))
})

test('vcard: unfolds lines, skips blanks and bad birthdays', () => {
  const r = parseVCard('BEGIN:VCARD\nFN:Long\n  Name\nEMAIL:\nBDAY:--0131\nEND:VCARD')
  assert.deepEqual(r.map(c => [c.type, c.value]), [['schema:name', 'Long Name']])
})

test('vcard: throws when no card present', () => {
  assert.throws(() => parseVCard('hello'), /Not a vCard/)
})
