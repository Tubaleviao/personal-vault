import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  createTranslator, resolveLocale, matchLocale, browserLocales,
  LOCALE_STORAGE_KEY, SUPPORTED_LOCALES,
} from '@vault/i18n'
import type { Translator } from '@vault/i18n'
import { StorageError } from './tauriVault'
import { UiError } from './uiError'

export interface I18n extends Translator {
  setLocale: (locale: string) => void
  /** `t(prefix + value)` when that key exists, otherwise the raw value (for open-ended identifiers). */
  tOr: (prefix: string, value: string) => string
  /** Render any thrown value as a translated, user-facing message. */
  describeError: (err: unknown) => string
}

const I18nContext = createContext<I18n | null>(null)

function readSaved(): string | null {
  try { return localStorage.getItem(LOCALE_STORAGE_KEY) } catch { return null }
}

/** Code → catalog key mapping for known English messages thrown by the core library. */
const CORE_MESSAGES: [RegExp, string][] = [
  [/^Incorrect passphrase/, 'desktop.err_wrong_passphrase'],
  [/^Vault is locked/, 'desktop.err_vault_locked'],
  [/different owners/, 'desktop.err_different_owners'],
  [/^Claim not found/, 'desktop.err_claim_not_found'],
]

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState(() => resolveLocale(readSaved(), browserLocales()))

  useEffect(() => { document.documentElement.lang = locale }, [locale])

  const setLocale = useCallback((next: string) => {
    const m = matchLocale(next)
    if (!m) return
    try { localStorage.setItem(LOCALE_STORAGE_KEY, m) } catch { /* storage unavailable */ }
    setLocaleState(m)
  }, [])

  const value = useMemo<I18n>(() => {
    const tr = createTranslator(locale)
    const tOr = (prefix: string, v: string) => {
      const key = prefix + v
      const msg = tr.t(key)
      return msg === key ? v : msg
    }
    const describeError = (err: unknown): string => {
      if (err instanceof UiError) return tr.t(err.key, err.params)
      if (err instanceof StorageError) {
        const base = tr.t(`desktop.storage_err_${err.code}`)
        return err.detail && (err.code === 'IO' || err.code === 'NOT_CONFIGURED') ? `${base} (${err.detail})` : base
      }
      const msg = err instanceof Error ? err.message : String(err)
      for (const [re, key] of CORE_MESSAGES) if (re.test(msg)) return tr.t(key)
      return tr.t('desktop.err_generic', { detail: msg })
    }
    return { ...tr, setLocale, tOr, describeError }
  }, [locale, setLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>')
  return ctx
}

/** Language picker listing every supported locale by its native name. */
export function LanguageSelect({ style }: { style?: React.CSSProperties }) {
  const { locale, setLocale, t } = useI18n()
  const nativeName = (l: string) => {
    try { return new Intl.DisplayNames([l], { type: 'language' }).of(l) ?? l } catch { return l }
  }
  return (
    <select
      style={style}
      value={locale}
      aria-label={t('desktop.language')}
      title={t('desktop.language')}
      onChange={e => setLocale(e.target.value)}
    >
      {SUPPORTED_LOCALES.map(l => <option key={l} value={l}>{nativeName(l)}</option>)}
    </select>
  )
}
