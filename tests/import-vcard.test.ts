import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVCard, countVCards, listVCards } from '../src/import-vcard'

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
  const r = parseVCard(text, { card: 0 })
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

test('vcard: rejects multi-card files unless a card is chosen', () => {
  const text = 'BEGIN:VCARD\nFN:A\nEND:VCARD\nBEGIN:VCARD\nFN:B\nEND:VCARD'
  assert.equal(countVCards(text), 2)
  assert.throws(() => parseVCard(text), /2 cards/)
  assert.equal(byType('schema:name')(parseVCard(text, { card: 1 })), 'B')
  assert.throws(() => parseVCard(text, { card: 5 }), /No vCard/)
})

test('vcard: decodes quoted-printable with soft breaks', () => {
  const r = parseVCard('BEGIN:VCARD\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=C3=81lvaro=20=\nPrata\nEND:VCARD')
  assert.equal(byType('schema:name')(r), 'Álvaro Prata')
})

test('vcard: takes one whole ADR, not a mix', () => {
  const r = parseVCard('BEGIN:VCARD\nADR;TYPE=WORK:;;;Recife;PE;;Brazil\nADR;TYPE=HOME:;;Rua A;Sao Paulo;SP;01000;Brazil\nEND:VCARD')
  assert.equal(byType('schema:addressLocality')(r), 'Sao Paulo')
  assert.equal(byType('schema:addressRegion')(r), 'SP')
  assert.equal(byType('schema:streetAddress')(r), 'Rua A')
})

test('vcard: validates birthdays', () => {
  const bd = (v: string) => byType('schema:birthDate')(parseVCard(`BEGIN:VCARD\nBDAY:${v}\nEND:VCARD`))
  assert.equal(bd('19901399'), undefined)
  assert.equal(bd('1604-03-05'), undefined)
  assert.equal(bd('1990-0131'), undefined)
  assert.equal(bd('19900230'), undefined)
  assert.equal(bd('1992-02-29'), '1992-02-29')
})

test('vcard: PREF wins, tel: params stripped, quoted colon in params', () => {
  const r = parseVCard([
    'BEGIN:VCARD', 'EMAIL;TYPE=work:old@corp.com', 'EMAIL;PREF=1:me@home.com',
    'TEL;VALUE=uri:tel:+551133334444;ext=123',
    'ADR;LABEL="Rua A: 1":;;Rua A;SP;SP;01000;Brazil', 'END:VCARD',
  ].join('\n'))
  assert.equal(byType('schema:email')(r), 'me@home.com')
  assert.equal(byType('schema:telephone')(r), '+551133334444')
  assert.equal(byType('schema:streetAddress')(r), 'Rua A')
  assert.equal(byType('schema:addressLocality')(r), 'SP')
})

test('vcard: card without END:VCARD still parses', () => {
  assert.equal(byType('schema:name')(parseVCard('BEGIN:VCARD\nFN:X')), 'X')
})

test('vcard: throws when no card present', () => {
  assert.throws(() => parseVCard('hello'), /Not a vCard/)
})

test('vcard: unterminated card followed by another still counts as two', () => {
  const text = 'BEGIN:VCARD\nFN:A\nBEGIN:VCARD\nFN:B\nEND:VCARD'
  assert.equal(countVCards(text), 2)
  assert.throws(() => parseVCard(text), /2 cards/)
  assert.deepEqual(listVCards(text), [{ index: 0, name: 'A' }, { index: 1, name: 'B' }])
})

test('vcard: empty cards ignored', () => {
  assert.equal(countVCards('BEGIN:VCARD\nEND:VCARD\nBEGIN:VCARD\nFN:A\nEND:VCARD'), 1)
})

test('vcard: empty tel: does not hide a valid TEL; escaped ; kept', () => {
  assert.equal(byType('schema:telephone')(parseVCard('BEGIN:VCARD\nTEL:tel:\nTEL:+1 555\nEND:VCARD')), '+1 555')
  assert.equal(byType('schema:telephone')(parseVCard('BEGIN:VCARD\nTEL:555\\;12\nEND:VCARD')), '555;12')
})

test('vcard: quoted TYPE list with pref, PREF address beats street-only one', () => {
  const r = parseVCard('BEGIN:VCARD\nEMAIL;TYPE=home:b@x.co\nEMAIL;TYPE="work,pref":a@x.co\nADR;PREF=1:;;;SP;SP;;BR\nADR:;;Rua B;Rio;RJ;1;BR\nEND:VCARD')
  assert.equal(byType('schema:email')(r), 'a@x.co')
  assert.equal(byType('schema:addressLocality')(r), 'SP')
})

test('vcard: QP encoded separators stay data; non-BMP survives', () => {
  const r = parseVCard('BEGIN:VCARD\nN;ENCODING=QUOTED-PRINTABLE:Silva=3BJr;Ana\nFN;ENCODING=QUOTED-PRINTABLE:A 😀\nEND:VCARD')
  assert.equal(byType('schema:familyName')(r), 'Silva;Jr')
  assert.equal(byType('schema:givenName')(r), 'Ana')
  assert.equal(byType('schema:name')(r), 'A 😀')
})
