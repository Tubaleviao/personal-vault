/**
 * Popup script — runs in the extension popup context.
 *
 * Communicates with the background service worker to:
 *   - Show vault lock/unlock state
 *   - List active site approvals
 *   - Revoke individual site approvals
 *   - Lock the vault
 */

import type { PopupToBackground, BackgroundToPopup } from '../messages'
import type { SiteApproval } from '../../src/form-filler'
import { isSiteApprovalValid } from '../../src/form-filler'

async function send<T extends BackgroundToPopup>(msg: PopupToBackground): Promise<T | null> {
  try {
    return await chrome.runtime.sendMessage<PopupToBackground, T>(msg)
  } catch {
    return null
  }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const statusDot = document.getElementById('status-dot')!
const didShort = document.getElementById('did-short')!
const lockedView = document.getElementById('locked-view')!
const unlockedView = document.getElementById('unlocked-view')!
const passphraseInput = document.getElementById('passphrase') as HTMLInputElement
const mnemonicInput = document.getElementById('mnemonic-input') as HTMLInputElement
const unlockForm = document.getElementById('unlock-form') as HTMLFormElement
const errorMsg = document.getElementById('error-msg')!
const approvalList = document.getElementById('approval-list')!
const noApprovals = document.getElementById('no-approvals')!
const lockBtn = document.getElementById('lock-btn')!
const relayUrlInput = document.getElementById('relay-url') as HTMLInputElement
const saveRelayBtn = document.getElementById('save-relay-btn')!
const syncBtn = document.getElementById('sync-btn')!
const syncStatus = document.getElementById('sync-status')!
const nativeBadge = document.getElementById('native-badge')!

// ── Render ────────────────────────────────────────────────────────────────────

function renderApprovals(approvals: SiteApproval[]) {
  approvalList.innerHTML = ''
  const valid = approvals.filter(isSiteApprovalValid)

  if (valid.length === 0) {
    noApprovals.style.display = 'block'
    return
  }
  noApprovals.style.display = 'none'

  for (const approval of valid) {
    const li = document.createElement('li')
    li.className = 'approval-item'

    const info = document.createElement('div')
    info.style.flex = '1'

    const origin = document.createElement('div')
    origin.className = 'approval-origin'
    origin.textContent = approval.origin

    const types = document.createElement('div')
    types.className = 'approval-types'
    types.textContent = approval.claimTypes.map(t => t.replace('schema:', '')).join(', ')

    info.appendChild(origin)
    info.appendChild(types)

    const revokeBtn = document.createElement('button')
    revokeBtn.className = 'revoke-btn'
    revokeBtn.title = 'Revoke access'
    revokeBtn.textContent = '✕'
    revokeBtn.onclick = () => revokeApproval(approval.id)

    li.appendChild(info)
    li.appendChild(revokeBtn)
    approvalList.appendChild(li)
  }
}

function renderSyncStatus(relayUrl: string, lastSyncedAt: string | null) {
  relayUrlInput.value = relayUrl
  if (!relayUrl) {
    syncStatus.textContent = 'Enter a relay URL to enable sync.'
    return
  }
  syncStatus.textContent = lastSyncedAt
    ? `Last synced: ${new Date(lastSyncedAt).toLocaleString()}`
    : 'Never synced.'
}

function showUnlocked(ownerDid: string, approvals: SiteApproval[]) {
  statusDot.classList.add('unlocked')
  didShort.textContent = ownerDid.slice(-8)
  lockedView.style.display = 'none'
  unlockedView.style.display = 'block'
  renderApprovals(approvals)
}

function showLocked() {
  statusDot.classList.remove('unlocked')
  didShort.textContent = ''
  lockedView.style.display = 'block'
  unlockedView.style.display = 'none'
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function revokeApproval(id: string) {
  const res = await send<BackgroundToPopup>({ type: 'REVOKE_APPROVAL', approvalId: id }) as { type: 'APPROVALS_LIST'; approvals: SiteApproval[] } | null
  if (res?.type === 'APPROVALS_LIST') renderApprovals(res.approvals)
}

async function lockVault() {
  await send<BackgroundToPopup>({ type: 'LOCK_VAULT' })
  showLocked()
}

async function saveRelayUrl() {
  const url = relayUrlInput.value.trim()
  const res = await send<BackgroundToPopup>({ type: 'SET_RELAY_CONFIG', relayUrl: url }) as { type: 'RELAY_CONFIG'; relayUrl: string; lastSyncedAt: string | null } | null
  if (res) renderSyncStatus(res.relayUrl, res.lastSyncedAt)
}

async function syncNow() {
  syncBtn.textContent = 'Syncing…'
  syncBtn.setAttribute('disabled', 'true')
  syncStatus.textContent = ''

  const res = await send<BackgroundToPopup>({ type: 'SYNC_VAULT' }) as { type: 'SYNC_RESULT'; ok: boolean; action?: string; syncedAt?: string; error?: string } | null

  syncBtn.textContent = 'Sync now'
  syncBtn.removeAttribute('disabled')

  if (!res || !res.ok) {
    syncStatus.textContent = `Error: ${res?.error ?? 'Unknown error'}`
    syncStatus.style.color = '#f87171'
    return
  }

  syncStatus.style.color = '#22c55e'
  const actionLabel: Record<string, string> = {
    'pushed': 'Pushed to relay',
    'pulled': 'Pulled from relay — unlock again to load',
    'already-current': 'Already up to date',
    'first-push': 'Registered and pushed',
  }
  syncStatus.textContent = (res.action ? actionLabel[res.action] ?? res.action : 'Done') +
    (res.syncedAt ? ` · ${new Date(res.syncedAt).toLocaleTimeString()}` : '')
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const statusRes = await send<BackgroundToPopup>({ type: 'GET_VAULT_STATUS' }) as { type: 'VAULT_STATUS'; unlocked: boolean; ownerDid: string | null } | null

  if (!statusRes || !statusRes.unlocked || !statusRes.ownerDid) {
    showLocked()
    return
  }

  const [approvalsRes, relayRes] = await Promise.all([
    send<BackgroundToPopup>({ type: 'LIST_APPROVALS' }) as Promise<{ type: 'APPROVALS_LIST'; approvals: SiteApproval[] } | null>,
    send<BackgroundToPopup>({ type: 'GET_RELAY_CONFIG' }) as Promise<{ type: 'RELAY_CONFIG'; relayUrl: string; lastSyncedAt: string | null } | null>,
  ])

  showUnlocked(statusRes.ownerDid, approvalsRes?.approvals ?? [])
  if (relayRes) renderSyncStatus(relayRes.relayUrl, relayRes.lastSyncedAt)
}

// ── Events ────────────────────────────────────────────────────────────────────

unlockForm.addEventListener('submit', async e => {
  e.preventDefault()
  errorMsg.style.display = 'none'
  const passphrase = passphraseInput.value.trim()
  if (!passphrase) return
  const mnemonic = mnemonicInput.value.trim() || undefined

  const res = await send<BackgroundToPopup>({ type: 'UNLOCK_VAULT', passphrase, mnemonic }) as { type: 'UNLOCK_RESULT'; ok: boolean; error?: string } | null
  if (!res?.ok) {
    errorMsg.textContent = res?.error ?? 'Failed to unlock vault'
    errorMsg.style.display = 'block'
    passphraseInput.value = ''
    return
  }

  passphraseInput.value = ''
  mnemonicInput.value = ''
  await init()
})

lockBtn.addEventListener('click', lockVault)
saveRelayBtn.addEventListener('click', saveRelayUrl)
syncBtn.addEventListener('click', syncNow)

// Show whether the desktop native host is reachable
async function updateNativeBadge() {
  const res = await send<BackgroundToPopup>({ type: 'GET_NATIVE_HOST_STATUS' }) as { type: 'NATIVE_HOST_STATUS'; available: boolean } | null
  if (res?.available) {
    nativeBadge.textContent = 'desktop connected'
    nativeBadge.classList.add('connected')
    nativeBadge.title = 'Vault I/O routed through the desktop app'
  } else {
    nativeBadge.textContent = 'desktop offline'
    nativeBadge.classList.remove('connected')
    nativeBadge.title = 'Desktop app not detected — using browser storage'
  }
}

init().catch(() => showLocked())
updateNativeBadge().catch(() => { /* non-critical */ })
