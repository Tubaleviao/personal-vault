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
import type { FillMap, CredentialEntry } from '../src/form-filler'
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
    'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
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
    'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
    'background:#16a34a', 'color:#fff', 'border-radius:8px',
    'padding:10px 16px', 'font-family:system-ui,sans-serif', 'font-size:13px',
    'box-shadow:0 4px 16px rgba(0,0,0,.3)',
  ].join(';'))
  toast.textContent = `Vault filled ${count} field${count === 1 ? '' : 's'}`
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 2500)
}

// ── Login form detection ──────────────────────────────────────────────────────

interface LoginForm {
  passwordEl: HTMLInputElement
  usernameEl: HTMLInputElement | null
}

function detectLoginForm(): LoginForm | null {
  const passwordEl = document.querySelector<HTMLInputElement>('input[type="password"]')
  if (!passwordEl) return null

  // Prefer explicit autocomplete tokens, then common name patterns, then the nearest preceding text input
  let usernameEl: HTMLInputElement | null =
    document.querySelector<HTMLInputElement>('input[type="email"]') ??
    document.querySelector<HTMLInputElement>('input[autocomplete="username"]') ??
    document.querySelector<HTMLInputElement>('input[name*="user"]') ??
    null

  if (!usernameEl) {
    // Walk backward through all inputs to find the first text-like input before the password field
    const allInputs = [...document.querySelectorAll<HTMLInputElement>('input')]
    const pwIdx = allInputs.indexOf(passwordEl)
    for (let i = pwIdx - 1; i >= 0; i--) {
      const el = allInputs[i]
      const t = el.type || 'text'
      if (t === 'text' || t === 'email' || t === '') {
        usernameEl = el
        break
      }
    }
  }

  return { passwordEl, usernameEl }
}

// ── Credential UI ─────────────────────────────────────────────────────────────

let credentialBanner: HTMLElement | null = null

function showCredentialFillBanner(credentials: CredentialEntry[], loginForm: LoginForm) {
  if (credentialBanner) { credentialBanner.remove(); credentialBanner = null }

  const origin = window.location.hostname
  const banner = document.createElement('div')
  banner.id = '__pvault_cred_banner'
  banner.setAttribute('style', [
    'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
    'background:#1e293b', 'color:#f1f5f9', 'border-radius:8px',
    'padding:14px 18px', 'font-family:system-ui,sans-serif', 'font-size:13px',
    'box-shadow:0 4px 24px rgba(0,0,0,.4)', 'max-width:340px', 'line-height:1.5',
  ].join(';'))

  const header = document.createElement('div')
  header.setAttribute('style', 'display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px')

  const title = document.createElement('div')
  title.innerHTML = `<strong style="color:#7dd3fc">Personal Vault</strong><br><span style="color:#94a3b8;font-size:11px">Fill saved credentials for ${origin}?</span>`

  const btnDismiss = document.createElement('button')
  btnDismiss.textContent = '✕'
  btnDismiss.setAttribute('style', 'background:transparent;color:#94a3b8;border:none;cursor:pointer;font-size:14px;padding:4px')
  btnDismiss.onclick = () => { banner.remove(); credentialBanner = null }

  header.appendChild(title)
  header.appendChild(btnDismiss)
  banner.appendChild(header)

  for (const cred of credentials) {
    const row = document.createElement('div')
    row.setAttribute('style', 'display:flex;justify-content:space-between;align-items:center;margin-top:6px')

    const label = document.createElement('span')
    label.textContent = cred.username
    label.setAttribute('style', 'font-size:12px;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px')

    const btnFill = document.createElement('button')
    btnFill.textContent = 'Fill'
    btnFill.setAttribute('style', 'background:#3b82f6;color:#fff;border:none;border-radius:5px;padding:4px 10px;cursor:pointer;font-size:12px;flex-shrink:0')
    btnFill.onclick = async () => {
      banner.remove()
      credentialBanner = null
      const resp = await chrome.runtime.sendMessage<ContentToBackground, BackgroundToContent>({
        type: 'CREDENTIAL_FILL_CONFIRMED',
        claimId: cred.claimId,
      })
      if (resp?.type === 'CREDENTIAL_FILL_DATA') {
        applyCredentialFill(resp.username, resp.password, loginForm)
      }
    }

    row.appendChild(label)
    row.appendChild(btnFill)
    banner.appendChild(row)
  }

  document.body.appendChild(banner)
  credentialBanner = banner
}

function showCredentialSaveBanner(
  username: string,
  origin: string,
  password: string,
  existingClaimId: string | undefined,
  form?: HTMLFormElement,
) {
  if (credentialBanner) { credentialBanner.remove(); credentialBanner = null }

  const hostname = new URL(origin).hostname
  const isUpdate = existingClaimId !== undefined
  const banner = document.createElement('div')
  banner.id = '__pvault_cred_save_banner'
  banner.setAttribute('style', [
    'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
    'background:#1e293b', 'color:#f1f5f9', 'border-radius:8px',
    'padding:14px 18px', 'font-family:system-ui,sans-serif', 'font-size:13px',
    'box-shadow:0 4px 24px rgba(0,0,0,.4)', 'max-width:340px', 'line-height:1.5',
  ].join(';'))

  const header = document.createElement('div')
  header.setAttribute('style', 'display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px')

  const title = document.createElement('div')
  const action = isUpdate ? 'Update saved password' : 'Save password'
  const titleStrong = document.createElement('strong')
  titleStrong.style.color = '#7dd3fc'
  titleStrong.textContent = 'Personal Vault'
  const titleActionText = document.createTextNode(`\n${action} for ${hostname}?`)
  const titleUser = document.createElement('span')
  titleUser.style.cssText = 'color:#94a3b8;font-size:11px'
  titleUser.textContent = username
  title.appendChild(titleStrong)
  title.appendChild(document.createElement('br'))
  title.appendChild(titleActionText)
  title.appendChild(document.createElement('br'))
  title.appendChild(titleUser)

  const btnDismiss = document.createElement('button')
  btnDismiss.textContent = '✕'
  btnDismiss.setAttribute('style', 'background:transparent;color:#94a3b8;border:none;cursor:pointer;font-size:14px;padding:4px')
  btnDismiss.onclick = () => {
    banner.remove()
    credentialBanner = null
    chrome.runtime.sendMessage<ContentToBackground, BackgroundToContent>({ type: 'CREDENTIAL_SAVE_DENIED' }).catch(() => { /* ignore */ })
    if (form) resubmitForm(form)
  }

  header.appendChild(title)
  header.appendChild(btnDismiss)
  banner.appendChild(header)

  const row = document.createElement('div')
  row.setAttribute('style', 'display:flex;gap:8px;margin-top:10px')

  const btnSave = document.createElement('button')
  btnSave.textContent = isUpdate ? 'Update' : 'Save'
  btnSave.setAttribute('style', 'flex:1;background:#16a34a;color:#fff;border:none;border-radius:5px;padding:6px 10px;cursor:pointer;font-size:12px')
  btnSave.onclick = () => {
    banner.remove()
    credentialBanner = null
    chrome.runtime.sendMessage<ContentToBackground, BackgroundToContent>({
      type: 'CREDENTIAL_SAVE_CONFIRMED',
      origin,
      username,
      password,
      existingClaimId,
    }).catch(() => { /* ignore */ })
    if (form) resubmitForm(form)
  }

  const btnNotNow = document.createElement('button')
  btnNotNow.textContent = 'Not now'
  btnNotNow.setAttribute('style', 'flex:1;background:#334155;color:#f1f5f9;border:none;border-radius:5px;padding:6px 10px;cursor:pointer;font-size:12px')
  btnNotNow.onclick = () => {
    banner.remove()
    credentialBanner = null
    chrome.runtime.sendMessage<ContentToBackground, BackgroundToContent>({ type: 'CREDENTIAL_SAVE_DENIED' }).catch(() => { /* ignore */ })
    if (form) resubmitForm(form)
  }

  row.appendChild(btnSave)
  row.appendChild(btnNotNow)
  banner.appendChild(row)
  document.body.appendChild(banner)
  credentialBanner = banner
}

function applyCredentialFill(username: string, password: string, loginForm: LoginForm) {
  const { usernameEl, passwordEl } = loginForm
  if (usernameEl) {
    usernameEl.value = username
    usernameEl.dispatchEvent(new Event('input', { bubbles: true }))
    usernameEl.dispatchEvent(new Event('change', { bubbles: true }))
  }
  passwordEl.value = password
  passwordEl.dispatchEvent(new Event('input', { bubbles: true }))
  passwordEl.dispatchEvent(new Event('change', { bubbles: true }))
}

// ── Main logic ────────────────────────────────────────────────────────────────

// Holds the detected login form so submit handler can reference the elements
let activeLoginForm: LoginForm | null = null
// Prevents re-prompting after the user has filled or dismissed credentials.
// Reset only when the login form disappears (modal closed / page navigated).
let credentialPromptSuppressed = false

async function main() {
  const origin = window.location.origin

  // ── Identity field filling ────────────────────────────────────────────────

  const fields = detectFields()
  if (fields.length > 0) {
    const msg: MsgFormDetected = { type: 'FORM_DETECTED', origin, detectedFields: fields }
    const response = await chrome.runtime.sendMessage<ContentToBackground, BackgroundToContent>(msg)

    if (response) {
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
      } else if (response.type === 'FILL_DATA') {
        const count = applyFillMap(response.fillMap)
        if (count > 0) showFillConfirmation(count)
      }
      // VAULT_LOCKED and APPROVAL_REVOKED: silently skip
    }
  }

  // ── Credential fill detection ─────────────────────────────────────────────

  const loginFormDetected = detectLoginForm()
  if (loginFormDetected) {
    activeLoginForm = loginFormDetected
    if (!credentialPromptSuppressed) {
      const credResp = await chrome.runtime.sendMessage<ContentToBackground, BackgroundToContent>({
        type: 'CREDENTIAL_FORM_DETECTED',
        origin,
      })
      if (credResp?.type === 'CREDENTIAL_FILL_PROMPT') {
        credentialPromptSuppressed = true
        showCredentialFillBanner(credResp.credentials, loginFormDetected)
      }
    }
  }
}

// ── Submit interception (credential save) ─────────────────────────────────────

// Set while we are programmatically re-submitting after the user decides.
let resubmitting = false

function resubmitForm(form: HTMLFormElement) {
  resubmitting = true
  try {
    form.requestSubmit()
  } finally {
    resubmitting = false
  }
}

function sendCredentialSubmit(username: string, password: string, form?: HTMLFormElement) {
  const origin = window.location.origin
  chrome.runtime.sendMessage<ContentToBackground, BackgroundToContent>({
    type: 'CREDENTIAL_SUBMIT',
    origin,
    username,
    password,
  }).then(resp => {
    if (resp?.type === 'CREDENTIAL_SAVE_PROMPT') {
      credentialPromptSuppressed = true
      showCredentialSaveBanner(resp.username, origin, password, resp.existingClaimId, form)
    } else if (form) {
      resubmitForm(form)
    }
  }).catch(() => {
    if (form) resubmitForm(form)
  })
}

// Native form submit (non-AJAX sites)
document.addEventListener('submit', (event: Event) => {
  if (resubmitting) return
  const form = event.target as HTMLFormElement | null
  if (!form || !activeLoginForm) return

  const { passwordEl, usernameEl } = activeLoginForm
  if (!form.contains(passwordEl)) return

  const password = passwordEl.value
  const username = usernameEl?.value ?? ''
  if (!password) return

  // Cancel pending AJAX capture — native submit takes over
  if (ajaxCaptureTimer !== null) {
    clearTimeout(ajaxCaptureTimer)
    ajaxCaptureTimer = null
  }

  // Prevent navigation so the async flow can complete and show the banner.
  event.preventDefault()
  sendCredentialSubmit(username, password, form)
}, { capture: true })

// AJAX login detection: watch for clicks on submit-like buttons, snapshot the
// field values immediately (before the site's handler can clear them), then
// fire after a short delay — cancelled if a native submit event fires first.
let ajaxCaptureTimer: ReturnType<typeof setTimeout> | null = null

document.addEventListener('click', (event: MouseEvent) => {
  const target = event.target as HTMLElement | null
  if (!target) return

  // Match <button type="submit">, <button> (default type is submit), and
  // <input type="submit"> that are inside or near the detected login form.
  const isSubmitLike = !!(
    target.matches('button:not([type="button"]):not([type="reset"])') ||
    target.matches('input[type="submit"]') ||
    target.closest('button:not([type="button"]):not([type="reset"])')
  )
  if (!isSubmitLike) return

  // Use the pre-detected form if available; otherwise scan the DOM now.
  // This handles modals that opened after main() ran.
  const loginForm = activeLoginForm ?? detectLoginForm()
  if (!loginForm) return
  activeLoginForm = loginForm

  const { passwordEl, usernameEl } = loginForm
  const password = passwordEl.value
  const username = usernameEl?.value ?? ''
  if (!password) return

  // Snapshot values now — the site's handler may clear them synchronously
  const capturedPassword = password
  const capturedUsername = username

  if (ajaxCaptureTimer !== null) clearTimeout(ajaxCaptureTimer)

  ajaxCaptureTimer = setTimeout(() => {
    ajaxCaptureTimer = null
    sendCredentialSubmit(capturedUsername, capturedPassword)
  }, 300)
}, { capture: true })

// Run once at document_idle; re-run if the DOM mutates significantly (SPAs).
main().catch(() => { /* extension context may be unavailable */ })

let mutationDebounce: ReturnType<typeof setTimeout> | null = null
new MutationObserver(() => {
  if (mutationDebounce) return
  mutationDebounce = setTimeout(() => {
    mutationDebounce = null
    const hasIdentityBanner = !!document.getElementById('__pvault_banner')
    const hasCredentialBanner = !!document.getElementById('__pvault_cred_banner') || !!document.getElementById('__pvault_cred_save_banner')
    if (hasIdentityBanner || hasCredentialBanner) return

    // Re-run full detection. For login modals that open after page load this is
    // the only opportunity to set activeLoginForm before the user types.
    const loginNow = detectLoginForm()
    const hadLoginForm = activeLoginForm !== null
    if (loginNow && !hadLoginForm) {
      // A login form just appeared (modal opened). Run main() to update
      // activeLoginForm and check for saved credentials to offer.
      main().catch(() => { /* ignore */ })
    } else if (!loginNow && hadLoginForm) {
      // Login form disappeared (modal closed / page navigated).
      activeLoginForm = null
      credentialPromptSuppressed = false
    } else if (detectFields().length > 0) {
      main().catch(() => { /* ignore */ })
    }
  }, 500)
}).observe(document.body, { childList: true, subtree: true })
