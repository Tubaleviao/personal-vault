/**
 * Catalog registry. Data-only: one block per locale, one import per namespace file.
 * Namespaces: common, popup, content, desktop, error, verifier.
 */
import enCommon from './locales/en/common.json'
import enPopup from './locales/en/popup.json'
import enContent from './locales/en/content.json'
import enDesktop from './locales/en/desktop.json'
import enError from './locales/en/error.json'
import ptCommon from './locales/pt-BR/common.json'
import ptPopup from './locales/pt-BR/popup.json'
import ptContent from './locales/pt-BR/content.json'
import ptDesktop from './locales/pt-BR/desktop.json'
import ptError from './locales/pt-BR/error.json'

type Flat = Record<string, string>

function ns(prefix: string, data: Flat): Flat {
  const out: Flat = {}
  for (const [k, v] of Object.entries(data)) out[`${prefix}.${k}`] = v
  return out
}

export const CATALOGS: Record<string, Flat> = {
  'en': {
    ...ns('common', enCommon), ...ns('popup', enPopup), ...ns('content', enContent),
    ...enDesktop, ...ns('error', enError),
  },
  'pt-BR': {
    ...ns('common', ptCommon), ...ns('popup', ptPopup), ...ns('content', ptContent),
    ...ptDesktop, ...ns('error', ptError),
  },
}
