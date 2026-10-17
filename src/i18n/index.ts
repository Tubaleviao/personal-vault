/**
 * i18n core — shared by the extension popup, content script, desktop app and verifier page.
 *
 * Catalogs are plain JSON under `locales/<locale>/<namespace>.json`. Keys are flattened as
 * `<namespace>.<key>`. Adding a language is data-only: drop a new `locales/<locale>/` directory
 * and add it to LOCALE_DIRS in `catalogs.ts` (one import line per file, no logic).
 *
 * Core modules never emit user-facing English. They throw/return error codes (see
 * `ERROR_CODES`) and the UI renders `t('error.<code>')`.
 */

import { CATALOGS } from './catalogs'

export type Catalog = Record<string, string>
export type Params = Record<string, string | number>

export const DEFAULT_LOCALE = 'en'
export const LOCALE_STORAGE_KEY = 'pv.locale'

export const SUPPORTED_LOCALES: string[] = Object.keys(CATALOGS)

/** Canonicalise a BCP-47-ish tag to a supported locale, or null. `pt_BR`, `pt-br`, `pt` → `pt-BR`. */
export function matchLocale(tag: string | null | undefined, supported: string[] = SUPPORTED_LOCALES): string | null {
  if (!tag) return null
  const norm = tag.replace('_', '-').toLowerCase()
  const exact = supported.find(l => l.toLowerCase() === norm)
  if (exact) return exact
  const lang = norm.split('-')[0]
  return supported.find(l => l.toLowerCase() === lang)
    ?? supported.find(l => l.toLowerCase().split('-')[0] === lang)
    ?? null
}

/** saved preference → browser/OS locales → `en`. */
export function resolveLocale(
  saved: string | null | undefined,
  browserLocales: readonly string[] = [],
  supported: string[] = SUPPORTED_LOCALES,
): string {
  const fromSaved = matchLocale(saved, supported)
  if (fromSaved) return fromSaved
  for (const b of browserLocales) {
    const m = matchLocale(b, supported)
    if (m) return m
  }
  return DEFAULT_LOCALE
}

export function browserLocales(): string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages?.length ? [...navigator.languages] : navigator.language ? [navigator.language] : []
}

function interpolate(template: string, params?: Params): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}

export interface Translator {
  locale: string
  t(key: string, params?: Params): string
  /** Intl date/time formatting for the active locale. */
  formatDate(d: Date | string | number, opts?: Intl.DateTimeFormatOptions): string
  formatNumber(n: number, opts?: Intl.NumberFormatOptions): string
}

/**
 * Build a translator. Lookup order: active locale → `en` → the key itself (so a missing key
 * is visible, never blank). Plural forms: `key` may have `key_one` / `key_other` variants,
 * chosen by `params.count` through Intl.PluralRules.
 */
export function createTranslator(locale: string = DEFAULT_LOCALE): Translator {
  const active = matchLocale(locale) ?? DEFAULT_LOCALE
  const cat = CATALOGS[active] ?? {}
  const fallback = CATALOGS[DEFAULT_LOCALE] ?? {}
  const rules = new Intl.PluralRules(active)
  const lookup = (k: string) => cat[k] ?? fallback[k]
  return {
    locale: active,
    t(key, params) {
      let msg: string | undefined
      if (params && typeof params.count === 'number') {
        msg = lookup(`${key}_${rules.select(params.count)}`)
      }
      msg ??= lookup(key)
      return msg === undefined ? key : interpolate(msg, params)
    },
    formatDate(d, opts = { dateStyle: 'medium', timeStyle: 'short' }) {
      const date = d instanceof Date ? d : new Date(d)
      return isNaN(date.getTime()) ? String(d) : new Intl.DateTimeFormat(active, opts).format(date)
    },
    formatNumber(n, opts) {
      return new Intl.NumberFormat(active, opts).format(n)
    },
  }
}

/** Stable error codes that cross the core → UI boundary. */
export const ERROR_CODES = [
  'NO_PASSPHRASE', 'NO_VAULT', 'VAULT_LOCKED', 'MNEMONIC_MISMATCH', 'WRONG_PASSPHRASE',
  'INVALID_VAULT_FILE', 'VAULT_FILE_UNREADABLE', 'DESKTOP_AVAILABLE', 'BROWSER_VAULT_EXISTS',
  'ALREADY_ON_DESKTOP', 'DESKTOP_NOT_CONNECTED', 'SOURCE_NOT_FOUND', 'UNKNOWN',
] as const
export type ErrorCode = typeof ERROR_CODES[number]

/** Encode an error code with optional technical detail (`CODE:detail`) for transport as a string. */
export function codedError(code: ErrorCode, detail?: string): string {
  return detail ? `${code}:${detail}` : code
}

/** Render an error code (optionally carrying a detail) as a translated message. */
export function errorMessage(tr: Translator, code: string | undefined | null, detail?: string): string {
  if (!code) return tr.t('error.UNKNOWN')
  const i = code.indexOf(':')
  if (i > 0) { detail = detail ?? code.slice(i + 1); code = code.slice(0, i) }
  const key = `error.${code}`
  const msg = tr.t(key, { detail: detail ?? '' }).trim()
  return msg === key ? tr.t('error.UNKNOWN') + (detail ? `: ${detail}` : '') : msg
}
