/**
 * Popup script — runs in the extension popup context.
 *
 * Communicates with the background service worker to:
 *   - Show vault lock/unlock state
 *   - List active site approvals
 *   - Revoke individual site approvals
 *   - Lock the vault
 */

import type { PopupToBackground, BackgroundToPopup, VaultListEntry } from '../messages'
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

// Vault picker UI
const vaultPickerPanel = document.getElementById('vault-picker-view')!
const vaultPickerList = document.getElementById('vault-picker-list')!
const vaultPickerSubtitle = document.getElementById('vault-picker-subtitle')!
const pickerCreateBtn = document.getElementById('picker-create-btn')!

// Unlock panel extras
const vaultSourceBadge = document.getElementById('vault-source-badge')!
const backToPickerBtn = document.getElementById('back-to-picker')!

// Merge offer UI
const mergeOffer = document.getElementById('merge-offer')!
const mergeSourceLabel = document.getElementById('merge-source-label')!
const mergeForm = document.getElementById('merge-form') as HTMLFormElement
const mergePassphrase = document.getElementById('merge-passphrase') as HTMLInputElement
const mergeStatus = document.getElementById('merge-status')!

// Create-vault UI
const unlockPanel = document.getElementById('unlock-view')!
const createPanel = document.getElementById('create-view')!
const mnemonicPanel = document.getElementById('mnemonic-view')!
const toggleCreateBtn = document.getElementById('toggle-create')!
const toggleUnlockBtn = document.getElementById('toggle-unlock')!
const createForm = document.getElementById('create-form') as HTMLFormElement
const createPassphrase = document.getElementById('create-passphrase') as HTMLInputElement
const createPassphraseConfirm = document.getElementById('create-passphrase-confirm') as HTMLInputElement
const createErrorMsg = document.getElementById('create-error-msg')!
const mnemonicDisplay = document.getElementById('mnemonic-display')!
const copyMnemonicBtn = document.getElementById('copy-mnemonic-btn')!
const mnemonicDoneBtn = document.getElementById('mnemonic-done-btn')!

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
  // Reset all child panels to a clean state; init() will show the right one.
  vaultPickerPanel.style.display = 'none'
  unlockPanel.style.display = 'none'
  createPanel.style.display = 'none'
  mnemonicPanel.style.display = 'none'
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function revokeApproval(id: string) {
  const res = await send<BackgroundToPopup>({ type: 'REVOKE_APPROVAL', approvalId: id }) as { type: 'APPROVALS_LIST'; approvals: SiteApproval[] } | null
  if (res?.type === 'APPROVALS_LIST') renderApprovals(res.approvals)
}

async function lockVault() {
  await send<BackgroundToPopup>({ type: 'LOCK_VAULT' })
  await init()
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

// ── Transition helpers ────────────────────────────────────────────────────────

/**
 * Show the unlocked vault view immediately using data already in hand from the
 * unlock/create response, then fill in secondary data (approvals, relay config)
 * with best-effort follow-up messages. Never calls showLocked() — if secondary
 * messages fail because the SW suspended, the vault view stays shown.
 */
async function transitionToUnlocked(ownerDid: string, activeSource: 'native' | 'local' | null) {
  // Show the vault immediately — don't wait for secondary data.
  showUnlocked(ownerDid, [])

  // Fetch secondary data with individual error handling so a suspended SW on
  // any one of these doesn't abort the transition.
  const [approvalsRes, relayRes, vaultListRes] = await Promise.all([
    send<BackgroundToPopup>({ type: 'LIST_APPROVALS' }).catch(() => null) as Promise<{ type: 'APPROVALS_LIST'; approvals: SiteApproval[] } | null>,
    send<BackgroundToPopup>({ type: 'GET_RELAY_CONFIG' }).catch(() => null) as Promise<{ type: 'RELAY_CONFIG'; relayUrl: string; lastSyncedAt: string | null } | null>,
    send<BackgroundToPopup>({ type: 'GET_VAULT_LIST' }).catch(() => null) as Promise<{ type: 'VAULT_LIST'; vaults: VaultListEntry[] } | null>,
  ])

  // Backfill approvals if we got them
  if (approvalsRes?.type === 'APPROVALS_LIST') renderApprovals(approvalsRes.approvals)
  if (relayRes?.type === 'RELAY_CONFIG') renderSyncStatus(relayRes.relayUrl, relayRes.lastSyncedAt)

  const vaults = (vaultListRes?.type === 'VAULT_LIST' ? vaultListRes.vaults : null) ?? []
  const mergeTarget = vaults.find(v => v.source !== activeSource)
  if (mergeTarget) {
    mergeSourceLabel.textContent = mergeTarget.source === 'local' ? 'browser storage' : 'desktop vault file'
    mergeOffer.dataset['source'] = mergeTarget.source
    mergeOffer.style.display = 'block'
  } else {
    mergeOffer.style.display = 'none'
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

/** Vaults discovered in the last init() call — used by back-to-picker. */
let _discoveredVaults: VaultListEntry[] = []

async function init() {
  const statusRes = await send<BackgroundToPopup>({ type: 'GET_VAULT_STATUS' }) as { type: 'VAULT_STATUS'; unlocked: boolean; ownerDid: string | null; activeSource: 'native' | 'local' | null } | null

  if (statusRes?.unlocked && statusRes.ownerDid) {
    const [approvalsRes, relayRes, vaultListRes] = await Promise.all([
      send<BackgroundToPopup>({ type: 'LIST_APPROVALS' }) as Promise<{ type: 'APPROVALS_LIST'; approvals: SiteApproval[] } | null>,
      send<BackgroundToPopup>({ type: 'GET_RELAY_CONFIG' }) as Promise<{ type: 'RELAY_CONFIG'; relayUrl: string; lastSyncedAt: string | null } | null>,
      send<BackgroundToPopup>({ type: 'GET_VAULT_LIST' }) as Promise<{ type: 'VAULT_LIST'; vaults: VaultListEntry[] } | null>,
    ])

    showUnlocked(statusRes.ownerDid, approvalsRes?.approvals ?? [])
    if (relayRes) renderSyncStatus(relayRes.relayUrl, relayRes.lastSyncedAt)

    // Show merge offer if a second vault source exists alongside the active one
    const vaults = vaultListRes?.vaults ?? []
    const activeSource = statusRes.activeSource
    const mergeTarget = vaults.find(v => v.source !== activeSource)
    if (mergeTarget) {
      mergeSourceLabel.textContent = mergeTarget.source === 'local' ? 'browser storage' : 'desktop vault file'
      mergeOffer.dataset['source'] = mergeTarget.source
      mergeOffer.style.display = 'block'
    } else {
      mergeOffer.style.display = 'none'
    }
    return
  }

  // Locked — discover vaults to decide which panel to show
  showLocked()
  const vaultListRes = await send<BackgroundToPopup>({ type: 'GET_VAULT_LIST' }) as { type: 'VAULT_LIST'; vaults: VaultListEntry[] } | null
  const vaults = vaultListRes?.vaults ?? []
  _discoveredVaults = vaults

  if (vaults.length === 0) {
    showCreatePanel()
  } else {
    // Always show the picker so the user can see which vault they're unlocking.
    showVaultPickerPanel(vaults)
  }
}

// ── Create-vault flow ─────────────────────────────────────────────────────────

function showUnlockPanel(source?: 'native' | 'local') {
  vaultPickerPanel.style.display = 'none'
  unlockPanel.style.display = 'block'
  createPanel.style.display = 'none'
  mnemonicPanel.style.display = 'none'
  if (source) {
    vaultSourceBadge.textContent = source === 'native' ? 'Desktop' : 'Browser'
    vaultSourceBadge.style.display = 'inline'
  } else {
    vaultSourceBadge.textContent = ''
    vaultSourceBadge.style.display = 'none'
  }
  // Show back button only if there are vaults to go back to
  backToPickerBtn.style.display = _discoveredVaults.length > 0 ? 'inline' : 'none'
}

function showCreatePanel() {
  vaultPickerPanel.style.display = 'none'
  unlockPanel.style.display = 'none'
  createPanel.style.display = 'block'
  mnemonicPanel.style.display = 'none'
}

let _pendingOwnerDid: string | null = null
let _pendingActiveSource: 'native' | 'local' | null = null

function showMnemonicPanel(mnemonic: string, ownerDid?: string, activeSource?: 'native' | 'local') {
  vaultPickerPanel.style.display = 'none'
  unlockPanel.style.display = 'none'
  createPanel.style.display = 'none'
  mnemonicPanel.style.display = 'block'
  mnemonicDisplay.textContent = mnemonic
  _pendingOwnerDid = ownerDid ?? null
  _pendingActiveSource = activeSource ?? null
}

function showVaultPickerPanel(vaults: VaultListEntry[]) {
  vaultPickerList.innerHTML = ''
  vaultPickerSubtitle.textContent = vaults.length === 1
    ? 'One vault found. Click it to unlock.'
    : `${vaults.length} vaults found. Select one to unlock.`

  for (const v of vaults) {
    const item = document.createElement('button')
    item.className = 'vault-picker-item'
    item.style.width = '100%'
    item.style.textAlign = 'left'
    item.style.cursor = 'pointer'
    item.style.border = '1px solid #334155'
    item.style.background = '#1e293b'
    item.style.borderRadius = '6px'
    item.style.padding = '10px 12px'

    const label = document.createElement('div')
    label.className = 'vault-picker-label'
    label.textContent = v.source === 'native' ? 'Desktop vault (file on disk)' : 'Browser vault (extension storage)'

    const meta = document.createElement('div')
    meta.className = 'vault-picker-meta'
    const seq = v.header.sequenceNumber ?? 0
    meta.textContent = `Rev ${seq} · ${v.header.ownerId.slice(0, 12)}`

    item.appendChild(label)
    item.appendChild(meta)
    item.onclick = async () => {
      await send<BackgroundToPopup>({ type: 'SELECT_VAULT', source: v.source })
      showUnlockPanel(v.source)
    }
    vaultPickerList.appendChild(item)
  }

  vaultPickerPanel.style.display = 'block'
  unlockPanel.style.display = 'none'
  createPanel.style.display = 'none'
  mnemonicPanel.style.display = 'none'
}

// ── Events ────────────────────────────────────────────────────────────────────

unlockForm.addEventListener('submit', async e => {
  e.preventDefault()
  errorMsg.style.display = 'none'
  const passphrase = passphraseInput.value.trim()
  if (!passphrase) return
  const mnemonic = mnemonicInput.value.trim() || undefined

  const res = await send<BackgroundToPopup>({ type: 'UNLOCK_VAULT', passphrase, mnemonic }) as { type: 'UNLOCK_RESULT'; ok: boolean; error?: string; ownerDid?: string; activeSource?: 'native' | 'local' } | null
  if (!res?.ok) {
    errorMsg.textContent = res?.error ?? 'Failed to unlock vault'
    errorMsg.style.display = 'block'
    passphraseInput.value = ''
    return
  }

  passphraseInput.value = ''
  mnemonicInput.value = ''
  // Use ownerDid from the response directly — avoids a GET_VAULT_STATUS round-trip
  // that would race against MV3 SW suspension. Fall back to 'unknown' so we still
  // show the vault view even if the field was missing (shouldn't happen for valid vaults).
  await transitionToUnlocked(res.ownerDid ?? 'unknown', res.activeSource ?? null)
})

lockBtn.addEventListener('click', lockVault)
saveRelayBtn.addEventListener('click', saveRelayUrl)
syncBtn.addEventListener('click', syncNow)

toggleCreateBtn.addEventListener('click', showCreatePanel)
toggleUnlockBtn.addEventListener('click', () => showUnlockPanel())
backToPickerBtn.addEventListener('click', () => showVaultPickerPanel(_discoveredVaults))

createForm.addEventListener('submit', async e => {
  e.preventDefault()
  createErrorMsg.style.display = 'none'
  const passphrase = createPassphrase.value
  const confirm = createPassphraseConfirm.value
  if (!passphrase) return
  if (passphrase !== confirm) {
    createErrorMsg.textContent = 'Passphrases do not match'
    createErrorMsg.style.display = 'block'
    return
  }

  const res = await send<BackgroundToPopup>({ type: 'CREATE_VAULT', passphrase }) as { type: 'CREATE_RESULT'; ok: boolean; mnemonic?: string; error?: string; ownerDid?: string; activeSource?: 'native' | 'local' } | null
  if (!res?.ok) {
    createErrorMsg.textContent = res?.error ?? 'Failed to create vault'
    createErrorMsg.style.display = 'block'
    return
  }

  createPassphrase.value = ''
  createPassphraseConfirm.value = ''
  if (!res.mnemonic) {
    createErrorMsg.textContent = 'Vault created but recovery phrase unavailable'
    createErrorMsg.style.display = 'block'
    return
  }
  showMnemonicPanel(res.mnemonic, res.ownerDid, res.activeSource)
})

copyMnemonicBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(mnemonicDisplay.textContent ?? '').catch(() => { /* non-critical */ })
  copyMnemonicBtn.textContent = 'Copied!'
  setTimeout(() => { copyMnemonicBtn.textContent = 'Copy to clipboard' }, 2000)
})

mnemonicDoneBtn.addEventListener('click', () => {
  if (_pendingOwnerDid) {
    transitionToUnlocked(_pendingOwnerDid, _pendingActiveSource).catch(() => showLocked())
  } else {
    init().catch(() => showLocked())
  }
})

pickerCreateBtn.addEventListener('click', showCreatePanel)

mergeForm.addEventListener('submit', async e => {
  e.preventDefault()
  const passphrase = mergePassphrase.value
  if (!passphrase) return

  const source = mergeOffer.dataset['source'] as 'native' | 'local' | undefined
  if (!source) return

  mergeStatus.textContent = 'Merging…'
  mergeStatus.style.color = '#64748b'

  const res = await send<BackgroundToPopup>({ type: 'MERGE_VAULT', source, passphrase }) as { type: 'MERGE_RESULT'; ok: boolean; added: number; error?: string } | null
  mergePassphrase.value = ''

  if (!res?.ok) {
    mergeStatus.textContent = `Error: ${res?.error ?? 'Unknown error'}`
    mergeStatus.style.color = '#f87171'
    return
  }

  mergeStatus.style.color = '#22c55e'
  mergeStatus.textContent = res.added > 0
    ? `Merged ${res.added} claim${res.added === 1 ? '' : 's'} successfully`
    : 'No new claims to merge'
  mergeOffer.style.display = 'none'
})

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
