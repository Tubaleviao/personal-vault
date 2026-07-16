/**
 * Content script — injected into every page at document_idle.
 *
 * Responsibilities:
 *   1. Scan the DOM for form fields that match vault claim types.
 *   2. Message the background worker with detected fields.
 *   3. Receive a FillMap (or approval-required / vault-locked response).
 *   4. Inject values into matching fields on user confirmation.
 *   5. Show a minimal, non-intrusive UI hint (a small overlay button).
 *
 * The content script never holds vault data between page loads.
 * All state lives in the background service worker.
 */

import type {
  ContentToBackground, BackgroundToContent,
  MsgFormDetected, DetectedField,
} from './messages'
import type { FillMap } from '../src/form-filler'
import { FILL_RULES } from '../src/form-filler'

// ── Field detection ───────────────────────────────────────────────────────────

const KNOWN_SELECTORS = FILL_RULES.flatMap(r => r.selectors)
const KNOWN_AUTOCOMPLETE = new Set(FILL_RULES.flatMap(r => r.autocompleteTokens))

function detectFields(): DetectedField[] {
  const inputs = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]), select'
  )

  const found: DetectedField[] = []

  for (const el of inputs) {
    const autocomplete = el.getAttribute('autocomplete')
    const name = el.getAttribute('name')?.toLowerCase() ?? null
    const inputType = el instanceof HTMLInputElement ? (el.type || 'text') : 'select'

    const matchesSelector = KNOWN_SELECTORS.some(sel => {
      try { return el.matches(sel) } catch { return false }
    })
    const matchesAutocomplete = autocomplete
      ? autocomplete.split(' ').some(token => KNOWN_AUTOCOMPLETE.has(token))
      : false

    if (matchesSelector || matchesAutocomplete) {
      found.push({
        selector: buildSelector(el),
        autocomplete,
        name,
        inputType,
      })
    }
  }

  return found
}

function buildSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`
  const name = el.getAttribute('name')
  if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`
  return el.tagName.toLowerCase()
}

// ── Fill injection ────────────────────────────────────────────────────────────

function applyFillMap(fillMap: FillMap): number {
  let filled = 0
  for (const entry of fillMap) {
    let el: Element | null = null
    for (const sel of entry.selectors) {
      try { el = document.querySelector(sel) } catch { /* bad selector */ }
      if (el) break
    }
    if (!el) continue

    if (el instanceof HTMLInputElement) {
      el.value = entry.value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      filled++
    } else if (el instanceof HTMLSelectElement) {
      const option = [...el.options].find(o =>
        o.value.toLowerCase() === entry.value.toLowerCase() ||
        o.text.toLowerCase() === entry.value.toLowerCase()
      )
      if (option) {
        el.value = option.value
        el.dispatchEvent(new Event('change', { bubbles: true }))
        filled++
      }
    }
  }
  return filled
}

// ── Inline approval UI ────────────────────────────────────────────────────────

let promptBanner: HTMLElement | null = null

function showApprovalPrompt(claimTypes: string[], onApprove: (types: string[], persist: boolean) => void, onDeny: () => void) {
  if (promptBanner) promptBanner.remove()

  const banner = document.createElement('div')
  banner.id = '__pvault_banner'
  banner.setAttribute('style', [
    'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483647',
    'background:#1e293b', 'color:#f1f5f9', 'border-radius:8px',
    'padding:14px 18px', 'font-family:system-ui,sans-serif', 'font-size:13px',
    'box-shadow:0 4px 24px rgba(0,0,0,.4)', 'max-width:320px', 'line-height:1.5',
  ].join(';'))

  const label = document.createElement('div')
  label.style.marginBottom = '10px'
  label.innerHTML = `<strong style="color:#7dd3fc">Personal Vault</strong><br>Fill ${claimTypes.length} field${claimTypes.length === 1 ? '' : 's'} from your vault?<br><span style="color:#94a3b8;font-size:11px">${claimTypes.map(t => t.replace('schema:', '')).join(', ')}</span>`

  const row = document.createElement('div')
  row.setAttribute('style', 'display:flex;gap:8px;margin-top:10px')

  const btnFill = document.createElement('button')
  btnFill.textContent = 'Fill once'
  btnFill.setAttribute('style', 'flex:1;background:#3b82f6;color:#fff;border:none;border-radius:5px;padding:6px 10px;cursor:pointer;font-size:12px')
  btnFill.onclick = () => { banner.remove(); onApprove(claimTypes, false) }

  const btnAlways = document.createElement('button')
  btnAlways.textContent = 'Always allow'
  btnAlways.setAttribute('style', 'flex:1;background:#16a34a;color:#fff;border:none;border-radius:5px;padding:6px 10px;cursor:pointer;font-size:12px')
  btnAlways.onclick = () => { banner.remove(); onApprove(claimTypes, true) }

  const btnDeny = document.createElement('button')
  btnDeny.textContent = '✕'
  btnDeny.setAttribute('style', 'background:transparent;color:#94a3b8;border:none;cursor:pointer;font-size:14px;padding:4px')
  btnDeny.onclick = () => { banner.remove(); onDeny() }

  row.appendChild(btnFill)
  row.appendChild(btnAlways)

  const header = document.createElement('div')
  header.setAttribute('style', 'display:flex;justify-content:space-between;align-items:flex-start')
  header.appendChild(label)
  header.appendChild(btnDeny)

  banner.appendChild(header)
  banner.appendChild(row)
  document.body.appendChild(banner)
  promptBanner = banner
}

function showFillConfirmation(count: number) {
  const toast = document.createElement('div')
  toast.setAttribute('style', [
    'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483647',
    'background:#16a34a', 'color:#fff', 'border-radius:8px',
    'padding:10px 16px', 'font-family:system-ui,sans-serif', 'font-size:13px',
    'box-shadow:0 4px 16px rgba(0,0,0,.3)',
  ].join(';'))
  toast.textContent = `Vault filled ${count} field${count === 1 ? '' : 's'}`
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 2500)
}

// ── Main logic ────────────────────────────────────────────────────────────────

async function main() {
  const fields = detectFields()
  if (fields.length === 0) return

  const origin = window.location.origin

  const msg: MsgFormDetected = { type: 'FORM_DETECTED', origin, detectedFields: fields }
  const response = await chrome.runtime.sendMessage<ContentToBackground, BackgroundToContent>(msg)

  if (!response) return

  if (response.type === 'VAULT_LOCKED') {
    // Don't bother the user — extension badge shows lock state
    return
  }

  if (response.type === 'APPROVAL_REQUIRED') {
    showApprovalPrompt(
      response.availableClaimTypes,
      (types, persist) => {
        chrome.runtime.sendMessage<ContentToBackground, BackgroundToContent>({
          type: 'USER_APPROVED', origin, claimTypes: types, persist,
        }).then(r => {
          if (r?.type === 'FILL_DATA') {
            const count = applyFillMap(r.fillMap)
            if (count > 0) showFillConfirmation(count)
          }
        }).catch(() => { /* vault locked between approval and fill */ })
      },
      () => {
        chrome.runtime.sendMessage<ContentToBackground, BackgroundToContent>({ type: 'USER_DENIED', origin })
          .catch(() => { /* ignore */ })
      }
    )
    return
  }

  if (response.type === 'FILL_DATA') {
    const count = applyFillMap(response.fillMap)
    if (count > 0) showFillConfirmation(count)
    return
  }

  if (response.type === 'APPROVAL_REVOKED') {
    // Silently skip — user previously revoked access for this site
    return
  }
}

// Run once at document_idle; re-run if the DOM mutates significantly (SPAs).
main().catch(() => { /* extension context may be unavailable */ })

let mutationDebounce: ReturnType<typeof setTimeout> | null = null
new MutationObserver(() => {
  if (mutationDebounce) return
  mutationDebounce = setTimeout(() => {
    mutationDebounce = null
    const fields = detectFields()
    if (fields.length > 0 && !document.getElementById('__pvault_banner')) {
      main().catch(() => { /* ignore */ })
    }
  }, 1500)
}).observe(document.body, { childList: true, subtree: true })
