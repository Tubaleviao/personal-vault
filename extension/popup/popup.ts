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
const unlockForm = document.getElementById('unlock-form') as HTMLFormElement
const errorMsg = document.getElementById('error-msg')!
const approvalList = document.getElementById('approval-list')!
const noApprovals = document.getElementById('no-approvals')!
const lockBtn = document.getElementById('lock-btn')!

// ── Render ────────────────────────────────────────────────────────────────────

function renderApprovals(approvals: SiteApproval[]) {
  approvalList.innerHTML = ''
  const valid = approvals.filter(a => !a.expiresAt || new Date(a.expiresAt) > new Date())

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
  await chrome.runtime.sendMessage({ type: 'LOCK_VAULT' })
  showLocked()
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const statusRes = await send<BackgroundToPopup>({ type: 'GET_VAULT_STATUS' }) as { type: 'VAULT_STATUS'; unlocked: boolean; ownerDid: string | null } | null

  if (!statusRes || !statusRes.unlocked || !statusRes.ownerDid) {
    showLocked()
    return
  }

  const approvalsRes = await send<BackgroundToPopup>({ type: 'LIST_APPROVALS' }) as { type: 'APPROVALS_LIST'; approvals: SiteApproval[] } | null
  showUnlocked(statusRes.ownerDid, approvalsRes?.approvals ?? [])
}

// ── Events ────────────────────────────────────────────────────────────────────

unlockForm.addEventListener('submit', async e => {
  e.preventDefault()
  errorMsg.style.display = 'none'
  const passphrase = passphraseInput.value.trim()
  if (!passphrase) return

  const res = await chrome.runtime.sendMessage({ type: 'UNLOCK_VAULT', passphrase }) as { ok: boolean; error?: string } | null
  if (!res?.ok) {
    errorMsg.textContent = res?.error ?? 'Failed to unlock vault'
    errorMsg.style.display = 'block'
    passphraseInput.value = ''
    return
  }

  passphraseInput.value = ''
  await init()
})

lockBtn.addEventListener('click', lockVault)

init().catch(() => showLocked())
