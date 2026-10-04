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
const nativeBadge = document.getElementById('native-badge')!

// Vault picker UI
const vaultPickerPanel = document.getElementById('vault-picker-view')!
const vaultPickerList = document.getElementById('vault-picker-list')!
const vaultPickerSubtitle = document.getElementById('vault-picker-subtitle')!
const pickerCreateBtn = document.getElementById('picker-create-btn')!

// Unlock panel extras
const vaultSourceBadge = document.getElementById('vault-source-badge')!
const backToPickerBtn = document.getElementById('back-to-picker')!

// Export UI
const exportSection = document.getElementById('export-section')!
const exportBtn = document.getElementById('export-btn')!
const exportStatus = document.getElementById('export-status')!

// Merge UI
const mainPanel = document.getElementById('main-panel')!
const mergePanel = document.getElementById('merge-panel')!
const importBtn = document.getElementById('import-btn')!
const mergeBackBtn = document.getElementById('merge-back-btn')!
const mergeVaultList = document.getElementById('merge-vault-list')!
const mergeEmpty = document.getElementById('merge-empty')!

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

function showUnlocked(ownerDid: string, approvals: SiteApproval[], showExport = false) {
  statusDot.classList.add('unlocked')
  didShort.textContent = ownerDid !== 'unknown' ? ownerDid.slice(-8) : ''
  lockedView.style.display = 'none'
  unlockedView.style.display = 'block'
  mainPanel.style.display = 'block'
  mergePanel.style.display = 'none'
  exportSection.style.display = showExport ? 'block' : 'none'
  exportStatus.textContent = ''
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

// ── Merge panel ───────────────────────────────────────────────────────────────

/** Vaults available for merging — set by transitionToUnlocked/init and used when the user opens the merge panel. */
let _mergeableVaults: VaultListEntry[] = []

function renderMergeOffer(others: VaultListEntry[]) {
  _mergeableVaults = others
  // Show import button only when there are other vaults
  importBtn.style.display = others.length > 0 ? 'block' : 'none'
}

function showMergePanel() {
  mainPanel.style.display = 'none'
  mergePanel.style.display = 'block'

  mergeVaultList.innerHTML = ''
  if (_mergeableVaults.length === 0) {
    mergeEmpty.style.display = 'block'
    return
  }
  mergeEmpty.style.display = 'none'

  for (const v of _mergeableVaults) {
    const friendlyName = v.name
      ? v.name.replace(/\.json$/, '').replace(/-/g, ' ')
      : (v.source === 'local' ? 'Browser vault' : 'Desktop vault')

    const card = document.createElement('div')
    card.style.cssText = 'background:#1e293b;border:1px solid #334155;border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px'

    const labelRow = document.createElement('div')
    labelRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center'

    const nameEl = document.createElement('span')
    nameEl.style.cssText = 'font-size:12px;font-weight:600;color:#7dd3fc'
    nameEl.textContent = friendlyName

    const badgeEl = document.createElement('span')
    badgeEl.style.cssText = 'font-size:10px;color:#64748b'
    badgeEl.textContent = v.source === 'native' ? 'desktop' : 'browser'

    labelRow.appendChild(nameEl)
    labelRow.appendChild(badgeEl)

    const form = document.createElement('form')
    form.style.cssText = 'display:flex;gap:6px'
    form.autocomplete = 'off'

    const input = document.createElement('input')
    input.type = 'password'
    input.placeholder = 'Passphrase'
    input.style.cssText = 'flex:1;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#f1f5f9;font-size:12px;padding:6px 8px;outline:none;min-width:0'

    const btn = document.createElement('button')
    btn.type = 'submit'
    btn.className = 'btn-primary'
    btn.style.cssText = 'flex-shrink:0;font-size:11px;padding:6px 10px'
    btn.textContent = 'Merge'

    const status = document.createElement('div')
    status.style.cssText = 'font-size:11px;min-height:14px'

    form.appendChild(input)
    form.appendChild(btn)
    card.appendChild(labelRow)
    card.appendChild(form)
    card.appendChild(status)
    mergeVaultList.appendChild(card)

    form.addEventListener('submit', async e => {
      e.preventDefault()
      const passphrase = input.value
      if (!passphrase) return
      btn.setAttribute('disabled', 'true')
      btn.textContent = 'Merging…'
      status.textContent = ''

      const mergeRes = await send<BackgroundToPopup>({
        type: 'MERGE_VAULT', source: v.source, name: v.name, passphrase,
      }) as { type: 'MERGE_RESULT'; ok: boolean; added: number; error?: string } | null

      input.value = ''
      btn.removeAttribute('disabled')
      btn.textContent = 'Merge'

      if (!mergeRes?.ok) {
        status.style.color = '#f87171'
        status.textContent = mergeRes?.error ?? 'Wrong passphrase or error'
        return
      }

      // Merge succeeded — delete the source vault
      btn.setAttribute('disabled', 'true')
      status.style.color = '#64748b'
      status.textContent = 'Deleting source vault…'

      const delRes = await send<BackgroundToPopup>({
        type: 'DELETE_VAULT', source: v.source, name: v.name,
      }) as { type: 'DELETE_RESULT'; ok: boolean; error?: string } | null

      btn.removeAttribute('disabled')

      if (!delRes?.ok) {
        status.style.color = '#fbbf24'
        const addedText = mergeRes.added > 0 ? `Merged ${mergeRes.added} claim${mergeRes.added === 1 ? '' : 's'}` : 'No new claims'
        status.textContent = `${addedText} — could not delete source: ${delRes?.error ?? 'unknown error'}`
        return
      }

      const addedText = mergeRes.added > 0 ? `Merged ${mergeRes.added} claim${mergeRes.added === 1 ? '' : 's'}` : 'No new claims'
      status.style.color = '#22c55e'
      status.textContent = `${addedText} — source vault deleted`
      _mergeableVaults = _mergeableVaults.filter(x => !(x.source === v.source && x.name === v.name))
      setTimeout(() => card.remove(), 2500)
    })
  }
}

// ── Transition helpers ────────────────────────────────────────────────────────

/**
 * Show the unlocked vault view immediately using data already in hand from the
 * unlock/create response, then fill in secondary data (approvals)
 * with best-effort follow-up messages. Never calls showLocked() — if secondary
 * messages fail because the SW suspended, the vault view stays shown.
 */
async function transitionToUnlocked(ownerDid: string, activeSource: 'native' | 'local' | null) {
  // Show the vault immediately — don't wait for secondary data.
  showUnlocked(ownerDid, [])

  // Fetch secondary data with individual error handling so a suspended SW on
  // any one of these doesn't abort the transition.
  const [approvalsRes, vaultListRes, nativeStatusRes] = await Promise.all([
    send<BackgroundToPopup>({ type: 'LIST_APPROVALS' }).catch(() => null) as Promise<{ type: 'APPROVALS_LIST'; approvals: SiteApproval[] } | null>,
    send<BackgroundToPopup>({ type: 'GET_VAULT_LIST' }).catch(() => null) as Promise<{ type: 'VAULT_LIST'; vaults: VaultListEntry[] } | null>,
    send<BackgroundToPopup>({ type: 'GET_NATIVE_HOST_STATUS' }).catch(() => null) as Promise<{ type: 'NATIVE_HOST_STATUS'; available: boolean } | null>,
  ])

  if (approvalsRes?.type === 'APPROVALS_LIST') renderApprovals(approvalsRes.approvals)

  const vaults = (vaultListRes?.type === 'VAULT_LIST' ? vaultListRes.vaults : null) ?? []
  const others = vaults.filter(v => !(v.source === activeSource && (!v.name || v.name === _selectedNativeVaultName)))
  renderMergeOffer(others)

  const showExport = activeSource === 'local' && nativeStatusRes?.available === true
  exportSection.style.display = showExport ? 'block' : 'none'
}

let _selectedNativeVaultName: string | null = null

// ── Init ──────────────────────────────────────────────────────────────────────

/** Vaults discovered in the last init() call — used by back-to-picker. */
let _discoveredVaults: VaultListEntry[] = []

async function init() {
  const statusRes = await send<BackgroundToPopup>({ type: 'GET_VAULT_STATUS' }) as { type: 'VAULT_STATUS'; unlocked: boolean; ownerDid: string | null; activeSource: 'native' | 'local' | null } | null

  if (statusRes?.unlocked && statusRes.ownerDid) {
    const [approvalsRes, vaultListRes, nativeStatusRes] = await Promise.all([
      send<BackgroundToPopup>({ type: 'LIST_APPROVALS' }) as Promise<{ type: 'APPROVALS_LIST'; approvals: SiteApproval[] } | null>,
      send<BackgroundToPopup>({ type: 'GET_VAULT_LIST' }) as Promise<{ type: 'VAULT_LIST'; vaults: VaultListEntry[] } | null>,
      send<BackgroundToPopup>({ type: 'GET_NATIVE_HOST_STATUS' }) as Promise<{ type: 'NATIVE_HOST_STATUS'; available: boolean } | null>,
    ])

    const activeSource = statusRes.activeSource
    const showExport = activeSource === 'local' && nativeStatusRes?.available === true
    showUnlocked(statusRes.ownerDid, approvalsRes?.approvals ?? [], showExport)

    const vaults = vaultListRes?.vaults ?? []
    const others = vaults.filter(v => !(v.source === activeSource && (!v.name || v.name === _selectedNativeVaultName)))
    renderMergeOffer(others)
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
    const friendlyName = v.name
      ? v.name.replace(/\.json$/, '').replace(/-/g, ' ')
      : 'Browser vault'
    label.textContent = v.source === 'native' ? friendlyName : 'Browser vault (extension storage)'

    const meta = document.createElement('div')
    meta.className = 'vault-picker-meta'
    const seq = v.header.sequenceNumber ?? 0
    meta.textContent = `Rev ${seq} · ${v.source === 'native' ? 'desktop' : 'browser'} · ${v.header.ownerId.slice(0, 8)}`

    item.appendChild(label)
    item.appendChild(meta)
    item.onclick = async () => {
      _selectedNativeVaultName = v.name ?? null
      await send<BackgroundToPopup>({ type: 'SELECT_VAULT', source: v.source, name: v.name })
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
exportBtn.addEventListener('click', async () => {
  exportBtn.setAttribute('disabled', 'true')
  exportStatus.style.color = '#64748b'
  exportStatus.textContent = 'Exporting…'

  const res = await send<BackgroundToPopup>({ type: 'EXPORT_TO_DESKTOP' }) as { type: 'EXPORT_RESULT'; ok: boolean; name?: string; error?: string } | null

  exportBtn.removeAttribute('disabled')

  if (!res?.ok) {
    exportStatus.style.color = '#f87171'
    exportStatus.textContent = res?.error ?? 'Export failed'
    return
  }

  exportStatus.style.color = '#22c55e'
  if (res.name) {
    exportStatus.textContent = `Saved as "${res.name}" — use Import in the desktop app to merge it`
  } else {
    exportStatus.textContent = 'Vault saved to desktop — now the primary storage'
    exportSection.style.display = 'none'
  }
})

importBtn.addEventListener('click', showMergePanel)
mergeBackBtn.addEventListener('click', () => {
  mergePanel.style.display = 'none'
  mainPanel.style.display = 'block'
})

// ── Vault file import (no-desktop-app fallback) ───────────────────────────────

/**
 * Builds a "pick a vault file + passphrase" control. Unlocked: merges the file's
 * claims into the active vault. Locked: installs it as the browser vault.
 */
function mountFileImport(container: HTMLElement, unlocked: boolean) {
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.textContent = unlocked ? 'Import vault file…' : 'Restore from a vault file…'
  toggle.style.cssText = 'width:100%;background:transparent;border:1px solid #334155;border-radius:6px;color:#94a3b8;font-size:12px;font-weight:500;padding:7px 12px;cursor:pointer'

  const form = document.createElement('div')
  form.style.cssText = 'display:none;flex-direction:column;gap:6px'
  const file = document.createElement('input')
  file.type = 'file'
  file.accept = '.json,.vault,application/json'
  const pass = document.createElement('input')
  pass.type = 'password'
  pass.placeholder = 'Passphrase of that vault'
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'btn-primary'
  go.textContent = unlocked ? 'Merge into this vault' : 'Restore vault'
  const status = document.createElement('div')
  status.style.cssText = 'font-size:11px;min-height:14px'
  form.append(file, pass, go, status)

  toggle.onclick = () => { form.style.display = form.style.display === 'none' ? 'flex' : 'none' }
  go.onclick = async () => {
    const f = file.files?.[0]
    if (!f || !pass.value) {
      status.style.color = '#f87171'
      status.textContent = 'Choose a file and enter its passphrase'
      return
    }
    go.setAttribute('disabled', 'true')
    status.style.color = '#64748b'
    status.textContent = 'Importing…'
    try {
      const text = await f.text()
      const res = await send<BackgroundToPopup>({ type: 'IMPORT_VAULT_FILE', text, passphrase: pass.value }) as
        { type: 'MERGE_RESULT'; ok: boolean; added: number; error?: string }
        | { type: 'IMPORT_FILE_RESULT'; ok: boolean; error?: string } | null
      pass.value = ''
      if (!res?.ok) {
        status.style.color = '#f87171'
        status.textContent = res?.error ?? 'Import failed'
        return
      }
      status.style.color = '#22c55e'
      if (res.type === 'MERGE_RESULT') {
        status.textContent = `Imported ${res.added} new claim${res.added === 1 ? '' : 's'}`
      } else {
        await init()
      }
    } catch (err) {
      pass.value = ''
      status.style.color = '#f87171'
      status.textContent = `Import failed: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      go.removeAttribute('disabled')
    }
  }
  container.append(toggle, form)
}

mountFileImport(document.getElementById('file-import-locked')!, false)
mountFileImport(document.getElementById('file-import-unlocked')!, true)

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
