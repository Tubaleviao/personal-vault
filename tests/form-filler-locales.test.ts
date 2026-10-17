import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyField, FILL_RULES, buildFillMap, tokenize, type FieldHints } from '../src/form-filler'
import type { Claim } from '../src/vault'

interface Fixture { hints: FieldHints; expect: string | null }

// English fixtures (baseline accuracy).
const EN: Fixture[] = [
  { hints: { label: 'First name' }, expect: 'schema:givenName' },
  { hints: { name: 'first_name' }, expect: 'schema:givenName' },
  { hints: { label: 'Last name' }, expect: 'schema:familyName' },
  { hints: { placeholder: 'Surname' }, expect: 'schema:familyName' },
  { hints: { label: 'Email address' }, expect: 'schema:email' },
  { hints: { type: 'email' }, expect: 'schema:email' },
  { hints: { label: 'Phone number' }, expect: 'schema:telephone' },
  { hints: { label: 'ZIP code' }, expect: 'schema:postalCode' },
  { hints: { label: 'Street address' }, expect: 'schema:streetAddress' },
  { hints: { label: 'City' }, expect: 'schema:addressLocality' },
  { hints: { label: 'State' }, expect: 'schema:addressRegion' },
  { hints: { label: 'Date of birth' }, expect: 'schema:birthDate' },
  { hints: { label: 'Company' }, expect: 'schema:worksFor' },
  { hints: { label: 'Favourite colour' }, expect: null },
]

// Brazilian fixtures: same coverage (name, surname, email, phone, postal code, tax id, address…).
const PT: Fixture[] = [
  { hints: { label: 'Nome' }, expect: 'schema:givenName' },
  { hints: { name: 'primeiro_nome' }, expect: 'schema:givenName' },
  { hints: { label: 'Sobrenome' }, expect: 'schema:familyName' },
  { hints: { id: 'sobrenome' }, expect: 'schema:familyName' },
  { hints: { label: 'Nome completo' }, expect: 'schema:name' },
  { hints: { label: 'E-mail' }, expect: 'schema:email' },
  { hints: { type: 'email' }, expect: 'schema:email' },
  { hints: { label: 'Telefone com DDD' }, expect: 'schema:telephone' },
  { hints: { placeholder: '(11) 91234-5678', label: 'Celular' }, expect: 'schema:telephone' },
  { hints: { label: 'CEP' }, expect: 'schema:postalCode' },
  { hints: { name: 'cep' }, expect: 'schema:postalCode' },
  { hints: { label: 'CPF' }, expect: 'schema:taxID' },
  { hints: { placeholder: '000.000.000-00', name: 'cpf' }, expect: 'schema:taxID' },
  { hints: { label: 'Endereço' }, expect: 'schema:streetAddress' },
  { hints: { label: 'Logradouro' }, expect: 'schema:streetAddress' },
  { hints: { label: 'Cidade' }, expect: 'schema:addressLocality' },
  { hints: { label: 'Estado' }, expect: 'schema:addressRegion' },
  { hints: { label: 'Data de nascimento' }, expect: 'schema:birthDate' },
  { hints: { label: 'Empresa' }, expect: 'schema:worksFor' },
  { hints: { label: 'Cor favorita' }, expect: null },
]

function accuracy(fx: Fixture[]) {
  return fx.filter(f => classifyField(f.hints) === f.expect).length / fx.length
}

test('form filler classifies English fixtures', () => {
  for (const f of EN) assert.equal(classifyField(f.hints), f.expect, JSON.stringify(f.hints))
})

test('form filler classifies pt-BR fixtures with the same accuracy as English', () => {
  for (const f of PT) assert.equal(classifyField(f.hints), f.expect, JSON.stringify(f.hints))
  assert.equal(accuracy(PT), accuracy(EN))
  assert.equal(accuracy(PT), 1)
})

test('"nome" is not confused with "sobrenome"; longer phrases beat shorter ones', () => {
  assert.equal(classifyField({ label: 'Nome' }), 'schema:givenName')
  assert.equal(classifyField({ label: 'Sobrenome' }), 'schema:familyName')
  assert.equal(classifyField({ label: 'Nome completo' }), 'schema:name')
  assert.equal(classifyField({ label: 'Company name' }), 'schema:worksFor')
})

test('accents and camelCase are normalised', () => {
  assert.deepEqual(tokenize('Endereço Residencial'), ['endereco', 'residencial'])
  assert.deepEqual(tokenize('dataNascimento'), ['data', 'nascimento'])
  assert.equal(classifyField({ name: 'dataNascimento' }), 'schema:birthDate')
})

test('autocomplete tokens still win and match exactly', () => {
  assert.equal(classifyField({ autocomplete: 'given-name', label: 'Sobrenome' }), 'schema:givenName')
  assert.equal(classifyField({ autocomplete: 'section-x shipping postal-code' }), 'schema:postalCode')
})

test('FILL_RULES merge selectors from all locales, including Brazilian ones', () => {
  const sel = (t: string) => FILL_RULES.find(r => r.claimType === t)!.selectors
  assert.ok(sel('schema:postalCode').includes('input[name="cep"]'))
  assert.ok(sel('schema:taxID').includes('input[name="cpf"]'))
  assert.ok(sel('schema:telephone').some(s => s.includes('telefone')))
  assert.ok(sel('schema:email').includes('input[type="email"]'))
})

test('buildFillMap emits a taxID (CPF) entry', () => {
  const claim = { id: '1', type: 'schema:taxID', value: '123.456.789-09', source: 'self-attested', verification: 'none' } as unknown as Claim
  const map = buildFillMap([claim])
  assert.equal(map.length, 1)
  assert.equal(map[0].value, '123.456.789-09')
})

test('classifyField never classifies password/checkbox inputs', () => {
  assert.equal(classifyField({ type: 'password', placeholder: 'Email password' }), null)
  assert.equal(classifyField({ type: 'checkbox', name: 'accept_terms', label: 'Nome' }), null)
})

test('classifyField does not map qualified labels to generic fields', () => {
  for (const label of ['Nome da empresa', 'Nome da mãe', 'Nome de usuário', 'Nome no cartão', 'Estado civil', 'Cidade de nascimento']) {
    const r = classifyField({ type: 'text', label })
    assert.ok(r !== 'schema:givenName' && r !== 'schema:addressRegion' && r !== 'schema:birthDate' && r !== 'schema:addressLocality', `${label} -> ${r}`)
  }
})

test('classifyField still classifies plain pt-BR labels', () => {
  assert.equal(classifyField({ type: 'text', label: 'Sobrenome' }), 'schema:familyName')
  assert.equal(classifyField({ type: 'text', label: 'CPF' }), 'schema:taxID')
})
