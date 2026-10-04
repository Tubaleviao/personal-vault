import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTakeoutAutofill, parseAutofillCsv, parseCsv, autofillFieldToClaimType } from '../src/import'

test('field names map to claim types', () => {
  assert.equal(autofillFieldToClaimType('First Name'), 'schema:givenName')
  assert.equal(autofillFieldToClaimType('family-name'), 'schema:familyName')
  assert.equal(autofillFieldToClaimType('E-mail'), 'schema:email')
  assert.equal(autofillFieldToClaimType('credit_card'), null)
})

test('takeout: maps known fields, first value wins, skips blanks/unknown', () => {
  const text = JSON.stringify({ Autofill: [
    { name: 'email', value: 'a@b.co' },
    { name: 'email', value: 'other@b.co' },
    { name: 'phone', value: '  ' },
    { name: 'search_q', value: 'cats' },
    { name: 'first_name', value: ' Ana ' },
  ] })
  assert.deepEqual(parseTakeoutAutofill(text), [
    { type: 'schema:email', value: 'a@b.co', source: 'imported', verification: 'none', expiresAt: null, issuerDid: null },
    { type: 'schema:givenName', value: 'Ana', source: 'imported', verification: 'none', expiresAt: null, issuerDid: null },
  ])
})

test('takeout: rejects wrong shape', () => {
  assert.throws(() => parseTakeoutAutofill('{}'))
  assert.throws(() => parseTakeoutAutofill('nope'))
})

test('csv parser handles quotes, escaped quotes, CRLF, blank lines', () => {
  assert.deepEqual(parseCsv('a,"b,1","c""d"\r\n\r\nx,y,z\n'), [['a', 'b,1', 'c"d'], ['x', 'y', 'z']])
})

test('autofill csv: header columns to claims, BOM tolerated', () => {
  const claims = parseAutofillCsv('\uFEFFFirst Name,Last Name,Email,Zip\nAna,"Silva, Jr",a@b.co,123\n')
  assert.deepEqual(claims.map(c => [c.type, c.value]), [
    ['schema:givenName', 'Ana'],
    ['schema:familyName', 'Silva, Jr'],
    ['schema:email', 'a@b.co'],
  ])
  assert.deepEqual(parseAutofillCsv(''), [])
})

test('prototype-key and numbered field names are not mapped', () => {
  assert.equal(autofillFieldToClaimType('constructor'), null)
  assert.equal(autofillFieldToClaimType('email2'), null)
})

test('csv: mid-field quote is literal, semicolon delimiter detected', () => {
  assert.deepEqual(parseCsv('a,5" x,c\n1,2,3'), [['a', '5" x', 'c'], ['1', '2', '3']])
  const claims = parseAutofillCsv('First Name;Email\nAna;a@b.co\n')
  assert.deepEqual(claims.map(c => [c.type, c.value]), [['schema:givenName', 'Ana'], ['schema:email', 'a@b.co']])
})

test('takeout: higher count wins', () => {
  const text = JSON.stringify({ Autofill: [
    { name: 'email', value: 'old@b.co', count: 1 },
    { name: 'email', value: 'main@b.co', count: 9 },
  ] })
  assert.equal(parseTakeoutAutofill(text)[0].value, 'main@b.co')
})
