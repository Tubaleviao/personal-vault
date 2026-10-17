import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  CATALOGS_FOR_TEST, createTranslator, resolveLocale, matchLocale, errorMessage, codedError, SUPPORTED_LOCALES, ERROR_CODES,
} from '../src/i18n/test-api'
import { applyI18n, claimLabel, type I18nElement, type I18nRoot } from '../extension/i18n'
import { checkFile, lintRepo } from '../scripts/check-i18n'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

// ── Catalog parity ────────────────────────────────────────────────────────────

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',')

test('every locale catalog has exactly the keys of en, no empty values, same placeholders', () => {
  const en = CATALOGS_FOR_TEST['en']
  assert.ok(Object.keys(en).length > 100)
  for (const loc of SUPPORTED_LOCALES) {
    const cat = CATALOGS_FOR_TEST[loc]
    assert.deepEqual(Object.keys(cat).sort(), Object.keys(en).sort(), `${loc} key set differs from en`)
    for (const [k, v] of Object.entries(cat)) {
      assert.ok(v.trim().length > 0, `${loc}:${k} is empty`)
      if (!/_(one|other|few|many|zero|two)$/.test(k)) {
        assert.equal(placeholders(v), placeholders(en[k]), `${loc}:${k} placeholders differ`)
      }
    }
  }
})

test('every locale directory on disk is registered (data-only locale addition stays honest)', () => {
  const dirs = readdirSync(join(root, 'src/i18n/locales')).sort()
  assert.deepEqual(dirs, [...SUPPORTED_LOCALES].sort())
})

test('manifest __MSG_*__ references exist in every extension locale; locales share keys', () => {
  const manifest = read('extension/manifest.json')
  const refs = [...manifest.matchAll(/__MSG_(\w+)__/g)].map(m => m[1])
  assert.ok(refs.length >= 2)
  const locales = readdirSync(join(root, 'extension/_locales'))
  assert.ok(locales.includes('en') && locales.includes('pt_BR'))
  assert.equal(JSON.parse(manifest).default_locale, 'en')
  const enKeys = Object.keys(JSON.parse(read('extension/_locales/en/messages.json'))).sort()
  for (const loc of locales) {
    const msgs = JSON.parse(read(`extension/_locales/${loc}/messages.json`)) as Record<string, { message: string }>
    assert.deepEqual(Object.keys(msgs).sort(), enKeys, `${loc} keys`)
    for (const r of refs) assert.ok(msgs[r]?.message.trim(), `${loc} missing ${r}`)
  }
})

test('catalog keys referenced by popup / content / html exist', () => {
  const en = CATALOGS_FOR_TEST['en']
  const has = (k: string) => k in en || `${k}_other` in en
  for (const m of read('extension/popup/index.html').matchAll(/data-i18n(?:-\w+(?:-\w+)?)?="([\w.]+)"/g)) {
    assert.ok(has(m[1]), `html key ${m[1]}`)
  }
  for (const m of read('extension/popup/popup.ts').matchAll(/\bt\('(\w+)'/g)) assert.ok(has(`popup.${m[1]}`), `popup key ${m[1]}`)
  for (const m of read('extension/content.ts').matchAll(/tr\.t\('([\w.]+)'/g)) assert.ok(has(m[1]), `content key ${m[1]}`)
  for (const m of read('extension/content.ts').matchAll(/'(content\.\w+)'/g)) assert.ok(has(m[1]), `content key ${m[1]}`)
  for (const m of read('src/i18n/index.ts').matchAll(/'(error\.\w+)'/g)) assert.ok(has(m[1]))
})

test('every error code has a translation in every locale', () => {
  for (const loc of SUPPORTED_LOCALES) for (const c of ERROR_CODES) {
    assert.ok(CATALOGS_FOR_TEST[loc][`error.${c}`], `${loc} error.${c}`)
  }
})

// ── Translator behaviour ──────────────────────────────────────────────────────

test('locale resolution: saved → browser → en', () => {
  assert.equal(resolveLocale('pt-BR', ['en-US']), 'pt-BR')
  assert.equal(resolveLocale(null, ['fr-FR', 'pt-PT']), 'pt-BR')
  assert.equal(resolveLocale('xx', ['de']), 'en')
  assert.equal(resolveLocale(undefined, []), 'en')
  assert.equal(matchLocale('pt_br'), 'pt-BR')
})

test('translator: params, plurals, fallback to en, missing key visible', () => {
  const pt = createTranslator('pt-BR')
  const en = createTranslator('en')
  assert.equal(en.t('content.filled', { count: 1 }), 'Vault filled 1 field')
  assert.equal(en.t('content.filled', { count: 3 }), 'Vault filled 3 fields')
  assert.equal(pt.t('content.filled', { count: 3 }), 'O cofre preencheu 3 campos')
  assert.equal(pt.t('does.not.exist'), 'does.not.exist')
  assert.equal(createTranslator('klingon').locale, 'en')
})

test('Intl formatting follows the locale', () => {
  const d = new Date(Date.UTC(2026, 2, 5, 15, 30))
  assert.match(createTranslator('en').formatDate(d, { dateStyle: 'medium', timeZone: 'UTC' }), /Mar 5, 2026/)
  assert.match(createTranslator('pt-BR').formatDate(d, { dateStyle: 'medium', timeZone: 'UTC' }), /5 de mar\.? de 2026/)
  assert.equal(createTranslator('en').formatNumber(1234.5), '1,234.5')
  assert.equal(createTranslator('pt-BR').formatNumber(1234.5), '1.234,5')
})

test('error codes render translated, with optional detail', () => {
  const pt = createTranslator('pt-BR')
  assert.equal(errorMessage(pt, 'WRONG_PASSPHRASE'), 'Senha incorreta')
  assert.match(errorMessage(pt, codedError('UNKNOWN', 'boom')), /boom/)
  assert.equal(errorMessage(createTranslator('en'), 'NO_VAULT'), 'No vault found')
  assert.match(errorMessage(pt, 'NOT_A_CODE'), /Algo deu errado/)
  assert.doesNotMatch(errorMessage(pt, 'NOT_A_CODE'), /[{}]/)
  assert.doesNotMatch(errorMessage(pt, undefined), /[{}]/)
  assert.equal(errorMessage(pt, 'FOO:bar'), 'Algo deu errado. bar')
})

// ── Popup re-render ───────────────────────────────────────────────────────────

class FakeEl implements I18nElement {
  attrs = new Map<string, string>()
  textContent: string | null
  constructor(attrs: Record<string, string>, text: string) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v)
    this.textContent = text
  }
  getAttribute(n: string) { return this.attrs.get(n) ?? null }
  setAttribute(n: string, v: string) { this.attrs.set(n, v) }
}

function fakePopup(): I18nRoot {
  const els: FakeEl[] = []
  for (const m of read('extension/popup/index.html').matchAll(/<(\w+)([^>]*data-i18n[^>]*)>([^<]*)/g)) {
    const attrs: Record<string, string> = {}
    for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2]
    els.push(new FakeEl(attrs, m[3]))
  }
  return {
    querySelectorAll(sel: string) {
      const attr = sel.slice(1, -1)
      return els.filter(e => e.attrs.has(attr))
    },
  } as I18nRoot
}

test('switching locale re-renders the popup in pt-BR; unsupported falls back to en', () => {
  const root = fakePopup()
  const text = (tr: ReturnType<typeof createTranslator>) => {
    applyI18n(root, tr)
    return [...root.querySelectorAll('[data-i18n]')].map(e => e.textContent)
  }
  const en = text(createTranslator('en'))
  assert.ok(en.includes('Unlock Vault') && en.includes('Lock vault'))
  const pt = text(createTranslator('pt-BR'))
  assert.ok(pt.includes('Desbloquear cofre') && pt.includes('Bloquear cofre'))
  assert.ok(!pt.includes('Lock vault'))
  const placeholders = [...root.querySelectorAll('[data-i18n-placeholder]')].map(e => e.getAttribute('placeholder'))
  assert.ok(placeholders.includes('Senha'))
  const fallback = text(createTranslator('zz-ZZ'))
  assert.deepEqual(fallback, en)
})

test('claim labels are localized, unknown types fall back to short id', () => {
  assert.equal(claimLabel(createTranslator('pt-BR'), 'schema:postalCode'), 'CEP')
  assert.equal(claimLabel(createTranslator('en'), 'schema:postalCode'), 'Postal code')
  assert.equal(claimLabel(createTranslator('en'), 'schema:weird'), 'weird')
})

// ── Hard-coded string lint ────────────────────────────────────────────────────

test('lint: extension and desktop UI have no hard-coded strings', () => {
  assert.deepEqual(lintRepo(root), [])
})

test('lint: detects hard-coded strings, ignores translated and non-text', () => {
  const bad = [
    `el.textContent = 'Save changes'`,
    `el.placeholder = "Enter your name"`,
    "el.title = `Revoke ${n} items`",
    `btn.textContent = ok ? 'Yes please' : t('no')`,
    `node.setAttribute('aria-label', 'Close dialog')`,
    `if (!confirm('Delete everything?')) return`,
  ].join('\n')
  assert.equal(checkFile('x.ts', bad).length, 6)
  const good = [
    `el.textContent = t('save')`,
    `el.textContent = '✕'`,
    "el.textContent = `${t('a')} ${n}`",
    `el.style.color = '#f87171'`,
    `if (x === 'native') el.textContent = tr.t('k', { count: n })`,
    `el.textContent = 'Visible' // i18n-allow`,
  ].join('\n')
  assert.deepEqual(checkFile('x.ts', good), [])
  assert.equal(checkFile('x.tsx', `<button>Save</button>\n<input placeholder="Search here" />`).length, 2)
  assert.deepEqual(checkFile('x.tsx', `<button>{t('desktop.save')}</button>`), [])
  assert.equal(checkFile('x.html', `<h2>Hello world</h2><input placeholder="Type here">`).length, 2)
  assert.deepEqual(checkFile('x.html', `<h2 data-i18n="a.b">Hello</h2><input placeholder="x" data-i18n-placeholder="a.c">`), [])
})

test('desktop catalog keys resolve (no double prefix)', () => {
  for (const loc of ['en', 'pt-BR']) {
    const tr = createTranslator(loc)
    assert.notEqual(tr.t('desktop.nav_claims'), 'desktop.nav_claims')
    assert.notEqual(tr.t('desktop.app_name'), 'desktop.app_name')
  }
})
