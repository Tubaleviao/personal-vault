/**
 * Extension i18n glue: loads the saved locale preference from chrome.storage.local and builds a
 * translator over the shared catalog (src/i18n). Used by the popup and the content script.
 */
import {
  createTranslator, resolveLocale, browserLocales, LOCALE_STORAGE_KEY, type Translator,
} from '../src/i18n'

export async function getSavedLocale(): Promise<string | null> {
  try {
    const r = await chrome.storage.local.get(LOCALE_STORAGE_KEY)
    const v = r[LOCALE_STORAGE_KEY]
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

export async function saveLocale(locale: string): Promise<void> {
  await chrome.storage.local.set({ [LOCALE_STORAGE_KEY]: locale })
}

export function detectBrowserLocales(): string[] {
  const ui = typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage ? [chrome.i18n.getUILanguage()] : []
  return [...browserLocales(), ...ui]
}

/** saved preference → browser/OS → en */
export async function loadTranslator(): Promise<Translator> {
  return createTranslator(resolveLocale(await getSavedLocale(), detectBrowserLocales()))
}

/** Human label for a claim type ("schema:givenName" → "First name"); unknown types fall back to the short id. */
export function claimLabel(tr: Translator, claimType: string): string {
  const short = claimType.replace('schema:', '')
  const key = `common.claim.${short}`
  const msg = tr.t(key)
  return msg === key ? short : msg
}

/** Minimal element shape applyI18n needs (real DOM elements satisfy it; tests use fakes). */
export interface I18nElement {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  textContent: string | null
}
export interface I18nRoot {
  querySelectorAll(selector: string): ArrayLike<I18nElement> & Iterable<I18nElement>
}

/**
 * Render static markup: `data-i18n="key"` sets textContent; `data-i18n-placeholder` /
 * `data-i18n-title` / `data-i18n-aria-label` set the matching attribute.
 */
export function applyI18n(root: I18nRoot, tr: Translator): void {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n')
    if (key) el.textContent = tr.t(key)
  }
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      const key = el.getAttribute(`data-i18n-${attr}`)
      if (key) el.setAttribute(attr, tr.t(key))
    }
  }
}
