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
import type { SiteApproval, CredentialEntry } from '../../src/form-filler'
import { isSiteApprovalValid } from '../../src/form-filler'
import { errorMessage, SUPPORTED_LOCALES, type Translator, createTranslator, type Params } from '../../src/i18n'
import { loadTranslator, saveLocale, applyI18n, claimLabel } from '../i18n'

/** Active translator; swapped by setLocale() and used by every render function. */
let tr: Translator = createTranslator()
const t = (key: string, params?: Params) => tr.t(`popup.${key}`, params)
const err = (code: string | undefined | null) => errorMessage(tr, code)

/** Claim/merge summary: "3 new claims" + optional change counts, rendered per locale. */
function mergeSummary(added: number, changes?: { deleted: number; remoteWins: number; grantsRevoked: number }): string {
  const base = added > 0 ? t('mergedClaims', { count: added }) : t('noNewClaims')
  const parts: string[] = []
  if (changes?.deleted) parts.push(t('changeDeleted', { count: changes.deleted }))
  if (changes?.remoteWins) parts.push(t('changeReplaced', { count: changes.remoteWins }))
  if (changes?.grantsRevoked) parts.push(t('changeGrantsRevoked', { count: changes.grantsRevoked }))
  return parts.length ? `${base} (${parts.join(', ')})` : base
}

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
const approvalsSection = document.getElementById('approvals-section')!
const credentialList = document.getElementById('credential-list')!
const credentialsSection = document.getElementById('credentials-section')!
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

let _validApprovals: SiteApproval[] = []
let _credentials: CredentialEntry[] = []

/** Show each list only when it has data; show "No data" when both are empty. */
function updateEmptyState() {
  approvalsSection.style.display = _validApprovals.length > 0 ? 'block' : 'none'
  credentialsSection.style.display = _credentials.length > 0 ? 'block' : 'none'
  noApprovals.style.display = _validApprovals.length === 0 && _credentials.length === 0 ? 'block' : 'none'
}

function renderCredentials(credentials: CredentialEntry[]) {
  _credentials = credentials
  credentialList.innerHTML = ''
  for (const cred of credentials) {
    const li = document.createElement('li')
    li.className = 'approval-item'

    const info = document.createElement('div')
    info.style.flex = '1'

    const origin = document.createElement('div')
    origin.className = 'approval-origin'
    origin.textContent = cred.origin

    const username = document.createElement('div')
    username.className = 'approval-types'
    username.textContent = cred.username

    info.appendChild(origin)
    info.appendChild(username)
    li.appendChild(info)
    credentialList.appendChild(li)
  }
  updateEmptyState()
}

function renderApprovals(approvals: SiteApproval[]) {
  approvalList.innerHTML = ''
  const valid = approvals.filter(isSiteApprovalValid)
  _validApprovals = valid
  updateEmptyState()

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
    types.textContent = approval.claimTypes.map(ct => claimLabel(tr, ct)).join(', ')
    if (approval.expiresAt) types.textContent += ` · ${t('expires', { date: tr.formatDate(approval.expiresAt) })}`

    info.appendChild(origin)
    info.appendChild(types)

    const revokeBtn = document.createElement('button')
    revokeBtn.className = 'revoke-btn'
    revokeBtn.title = t('revokeAccess')
    revokeBtn.textContent = '✕'
    revokeBtn.onclick = () => revokeApproval(approval.id)

    li.appendChild(info)
    li.appendChild(revokeBtn)
    approvalList.appendChild(li)
  }
}

function showUnlocked(ownerDid: string, approvals: SiteApproval[], showExport = false, credentials: CredentialEntry[] = []) {
  statusDot.classList.add('unlocked')
  didShort.textContent = ownerDid !== 'unknown' ? ownerDid.slice(-8) : ''
  lockedView.style.display = 'none'
  unlockedView.style.display = 'block'
  mainPanel.style.display = 'block'
  mergePanel.style.display = 'none'
  exportSection.style.display = showExport ? 'block' : 'none'
  exportStatus.textContent = ''
  renderApprovals(approvals)
  renderCredentials(credentials)
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
      : t(v.source === 'local' ? 'browserVault' : 'desktopVault')

    const card = document.createElement('div')
    card.style.cssText = 'background:#1e293b;border:1px solid #334155;border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px'

    const labelRow = document.createElement('div')
    labelRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center'

    const nameEl = document.createElement('span')
    nameEl.style.cssText = 'font-size:12px;font-weight:600;color:#7dd3fc'
    nameEl.textContent = friendlyName

    const badgeEl = document.createElement('span')
    badgeEl.style.cssText = 'font-size:10px;color:#64748b'
    badgeEl.textContent = t(v.source === 'native' ? 'sourceDesktop' : 'sourceBrowser')

    labelRow.appendChild(nameEl)
    labelRow.appendChild(badgeEl)

    const form = document.createElement('form')
    form.style.cssText = 'display:flex;gap:6px'
    form.autocomplete = 'off'

    const input = document.createElement('input')
    input.type = 'password'
    input.placeholder = t('passphrasePlaceholder')
    input.style.cssText = 'flex:1;background:#0f172a;border:1px solid #334155;border-radius:6px;color:#f1f5f9;font-size:12px;padding:6px 8px;outline:none;min-width:0'

    const btn = document.createElement('button')
    btn.type = 'submit'
    btn.className = 'btn-primary'
    btn.style.cssText = 'flex-shrink:0;font-size:11px;padding:6px 10px'
    btn.textContent = t('merge')

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
      btn.textContent = t('merging')
      status.textContent = ''

      const mergeRes = await send<BackgroundToPopup>({
        type: 'MERGE_VAULT', source: v.source, name: v.name, passphrase,
      }) as { type: 'MERGE_RESULT'; ok: boolean; added: number; changes?: { deleted: number; remoteWins: number; grantsRevoked: number }; error?: string } | null

      input.value = ''
      btn.removeAttribute('disabled')
      btn.textContent = t('merge')

      if (!mergeRes?.ok) {
        status.style.color = '#f87171'
        status.textContent = mergeRes?.error ? err(mergeRes.error) : t('wrongPassphraseOrError')
        return
      }

      // Merge succeeded — delete the source vault
      btn.setAttribute('disabled', 'true')
      status.style.color = '#64748b'
      status.textContent = t('deletingSource')

      const delRes = await send<BackgroundToPopup>({
        type: 'DELETE_VAULT', source: v.source, name: v.name,
      }) as { type: 'DELETE_RESULT'; ok: boolean; error?: string } | null

      btn.removeAttribute('disabled')

      if (!delRes?.ok) {
        status.style.color = '#fbbf24'
        status.textContent = t('deleteSourceFailed', { summary: mergeSummary(mergeRes.added, mergeRes.changes), error: delRes?.error ? err(delRes.error) : t('unknownError') })
        return
      }

      status.style.color = '#22c55e'
      status.textContent = t('sourceDeleted', { summary: mergeSummary(mergeRes.added, mergeRes.changes) })
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
  const [approvalsRes, credentialsRes, vaultListRes, nativeStatusRes] = await Promise.all([
    send<BackgroundToPopup>({ type: 'LIST_APPROVALS' }).catch(() => null) as Promise<{ type: 'APPROVALS_LIST'; approvals: SiteApproval[] } | null>,
    send<BackgroundToPopup>({ type: 'LIST_CREDENTIALS' }).catch(() => null) as Promise<{ type: 'CREDENTIALS_LIST'; credentials: CredentialEntry[] } | null>,
    send<BackgroundToPopup>({ type: 'GET_VAULT_LIST' }).catch(() => null) as Promise<{ type: 'VAULT_LIST'; vaults: VaultListEntry[] } | null>,
    send<BackgroundToPopup>({ type: 'GET_NATIVE_HOST_STATUS' }).catch(() => null) as Promise<{ type: 'NATIVE_HOST_STATUS'; available: boolean } | null>,
  ])

  if (approvalsRes?.type === 'APPROVALS_LIST') renderApprovals(approvalsRes.approvals)
  if (credentialsRes?.type === 'CREDENTIALS_LIST') renderCredentials(credentialsRes.credentials)

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
    const [approvalsRes, credentialsRes, vaultListRes, nativeStatusRes] = await Promise.all([
      send<BackgroundToPopup>({ type: 'LIST_APPROVALS' }) as Promise<{ type: 'APPROVALS_LIST'; approvals: SiteApproval[] } | null>,
      send<BackgroundToPopup>({ type: 'LIST_CREDENTIALS' }).catch(() => null) as Promise<{ type: 'CREDENTIALS_LIST'; credentials: CredentialEntry[] } | null>,
      send<BackgroundToPopup>({ type: 'GET_VAULT_LIST' }) as Promise<{ type: 'VAULT_LIST'; vaults: VaultListEntry[] } | null>,
      send<BackgroundToPopup>({ type: 'GET_NATIVE_HOST_STATUS' }) as Promise<{ type: 'NATIVE_HOST_STATUS'; available: boolean } | null>,
    ])

    const activeSource = statusRes.activeSource
    const showExport = activeSource === 'local' && nativeStatusRes?.available === true
    showUnlocked(statusRes.ownerDid, approvalsRes?.approvals ?? [], showExport, credentialsRes?.type === 'CREDENTIALS_LIST' ? credentialsRes.credentials : [])

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
    vaultSourceBadge.textContent = t(source === 'native' ? 'badgeDesktop' : 'badgeBrowser')
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
  vaultPickerSubtitle.textContent = t('pickerFound', { count: vaults.length })

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
      : t('browserVault')
    label.textContent = v.source === 'native' ? friendlyName : t('browserVaultStorage')

    const meta = document.createElement('div')
    meta.className = 'vault-picker-meta'
    const seq = v.header.sequenceNumber ?? 0
    meta.textContent = `${t('revision', { seq })} · ${t(v.source === 'native' ? 'sourceDesktop' : 'sourceBrowser')} · ${v.header.ownerId.slice(0, 8)}`

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
    errorMsg.textContent = res?.error ? err(res.error) : t('unlockFailed')
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
    createErrorMsg.textContent = t('passphraseMismatch')
    createErrorMsg.style.display = 'block'
    return
  }

  const res = await send<BackgroundToPopup>({ type: 'CREATE_VAULT', passphrase }) as { type: 'CREATE_RESULT'; ok: boolean; mnemonic?: string; error?: string; ownerDid?: string; activeSource?: 'native' | 'local' } | null
  if (!res?.ok) {
    createErrorMsg.textContent = res?.error ? err(res.error) : t('createFailed')
    createErrorMsg.style.display = 'block'
    return
  }

  createPassphrase.value = ''
  createPassphraseConfirm.value = ''
  if (!res.mnemonic) {
    createErrorMsg.textContent = t('mnemonicUnavailable')
    createErrorMsg.style.display = 'block'
    return
  }
  showMnemonicPanel(res.mnemonic, res.ownerDid, res.activeSource)
})

copyMnemonicBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(mnemonicDisplay.textContent ?? '').catch(() => { /* non-critical */ })
  copyMnemonicBtn.textContent = t('copied')
  setTimeout(() => { copyMnemonicBtn.textContent = t('copy') }, 2000)
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
  exportStatus.textContent = t('exporting')

  const res = await send<BackgroundToPopup>({ type: 'EXPORT_TO_DESKTOP' }) as { type: 'EXPORT_RESULT'; ok: boolean; name?: string; error?: string } | null

  exportBtn.removeAttribute('disabled')

  if (!res?.ok) {
    exportStatus.style.color = '#f87171'
    exportStatus.textContent = res?.error ? err(res.error) : t('exportFailed')
    return
  }

  exportStatus.style.color = '#22c55e'
  if (res.name) {
    exportStatus.textContent = t('exportSavedAs', { name: res.name })
  } else {
    exportStatus.textContent = t('exportSaved')
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
  toggle.textContent = t(unlocked ? 'importFile' : 'restoreFile')
  toggle.style.cssText = 'width:100%;background:transparent;border:1px solid #334155;border-radius:6px;color:#94a3b8;font-size:12px;font-weight:500;padding:7px 12px;cursor:pointer'

  const form = document.createElement('div')
  form.style.cssText = 'display:none;flex-direction:column;gap:6px'
  const file = document.createElement('input')
  file.type = 'file'
  file.accept = '.json,.vault,application/json'
  const pass = document.createElement('input')
  pass.type = 'password'
  pass.placeholder = t('filePassphrasePlaceholder')
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'btn-primary'
  go.textContent = t(unlocked ? 'mergeIntoVault' : 'restoreVault')
  const status = document.createElement('div')
  status.style.cssText = 'font-size:11px;min-height:14px'
  form.append(file, pass, go, status)

  toggle.onclick = () => { form.style.display = form.style.display === 'none' ? 'flex' : 'none' }
  go.onclick = async () => {
    const f = file.files?.[0]
    if (!f || !pass.value) {
      status.style.color = '#f87171'
      status.textContent = t('chooseFile')
      return
    }
    go.setAttribute('disabled', 'true')
    status.style.color = '#64748b'
    status.textContent = t('importing')
    try {
      const text = await f.text()
      const res = await send<BackgroundToPopup>({ type: 'IMPORT_VAULT_FILE', text, passphrase: pass.value }) as
        { type: 'MERGE_RESULT'; ok: boolean; added: number; changes?: { deleted: number; remoteWins: number; grantsRevoked: number }; error?: string }
        | { type: 'IMPORT_FILE_RESULT'; ok: boolean; error?: string } | null
      pass.value = ''
      if (!res?.ok) {
        status.style.color = '#f87171'
        status.textContent = res?.error ? err(res.error) : t('importFailed')
        return
      }
      status.style.color = '#22c55e'
      if (res.type === 'MERGE_RESULT') {
        status.textContent = `${t('imported', { count: res.added })}${res.changes ? mergeSummary(0, res.changes).replace(t('noNewClaims'), '') : ''}`
      } else {
        await init()
      }
    } catch (e) {
      pass.value = ''
      status.style.color = '#f87171'
      status.textContent = t('importFailedDetail', { detail: e instanceof Error ? e.message : String(e) })
    } finally {
      go.removeAttribute('disabled')
    }
  }
  container.append(toggle, form)
}

// Show whether the desktop native host is reachable
async function updateNativeBadge() {
  const res = await send<BackgroundToPopup>({ type: 'GET_NATIVE_HOST_STATUS' }) as { type: 'NATIVE_HOST_STATUS'; available: boolean } | null
  if (res?.available) {
    nativeBadge.textContent = t('nativeConnected')
    nativeBadge.classList.add('connected')
    nativeBadge.title = t('nativeConnectedTitle')
  } else {
    nativeBadge.textContent = t('nativeOffline')
    nativeBadge.classList.remove('connected')
    nativeBadge.title = t('nativeOfflineTitle')
  }
}

// ── Locale ────────────────────────────────────────────────────────────────────

/** Language selector in the header: lists every catalog, native names via Intl.DisplayNames. */
function mountLanguageSelect() {
  const sel = document.getElementById('lang-select') as HTMLSelectElement
  sel.innerHTML = ''
  for (const loc of SUPPORTED_LOCALES) {
    const opt = document.createElement('option')
    opt.value = loc
    opt.textContent = new Intl.DisplayNames([loc], { type: 'language' }).of(loc) ?? loc
    sel.appendChild(opt)
  }
  sel.value = tr.locale
  sel.onchange = () => { void setLocale(sel.value) }
}

/** Switch language: persist the choice, re-translate static markup, re-render dynamic views. */
async function setLocale(locale: string) {
  await saveLocale(locale)
  await startI18n()
  mountFileImports()
  await init()
  await updateNativeBadge()
}

async function startI18n() {
  tr = await loadTranslator()
  document.documentElement.lang = tr.locale
  applyI18n(document, tr)
  mountLanguageSelect()
}

function mountFileImports() {
  for (const id of ['file-import-locked', 'file-import-unlocked']) document.getElementById(id)!.replaceChildren()
  mountFileImport(document.getElementById('file-import-locked')!, false)
  mountFileImport(document.getElementById('file-import-unlocked')!, true)
}

async function boot() {
  await startI18n()
  mountFileImports()
  await init()
  await updateNativeBadge()
}
boot().catch(() => showLocked())
