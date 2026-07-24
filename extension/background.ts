/**
 * Background service worker — the vault-aware broker for the extension.
 *
 * This is the only part of the extension that ever touches the vault or
 * the FillMap. Content scripts and the popup communicate with it via messages.
 *
 * Lifecycle:
 *   - Service workers are terminated after ~30 s of inactivity (MV3 rule).
 *     The vault is unlocked in memory; locking on termination is handled by
 *     chrome.runtime.onSuspend. Persistence uses chrome.storage.local for
 *     SiteApprovals and the sealed vault blob.
 *
 * Vault state:
 *   - The vault blob is stored in chrome.storage.local under key 'vault'.
 *   - The unlocked Vault instance lives in memory only.
 *   - The owner keypair (for grant signing) is derived from the mnemonic and
 *     held in memory alongside the Vault instance.
 *
 * NOTE: This module imports from the compiled JS output of the vault library.
 * In the extension build step (see extension/README.md) a bundler (esbuild)
 * resolves these paths. The import paths reference the source directly for
 * clarity; the build config maps them to the compiled bundle.
 */

import type {
  ContentToBackground, BackgroundToContent,
  PopupToBackground, BackgroundToPopup,
  MsgFormDetected,
  VaultListEntry,
} from './messages'
import type { SiteApproval } from '../src/form-filler'
import {
  buildFillMap, buildSiteApproval, isSiteApprovalValid, FILL_RULES,
  findCredentialsForOrigin, getCredentialById, CREDENTIAL_CLAIM_TYPE,
} from '../src/form-filler'
import type { CredentialValue } from '../src/form-filler'
import { Vault } from '../src/vault'
import type { PersistedVault } from '../src/vault'
import { syncVault } from '../src/relay'
import type { RelayConfig } from '../src/relay'
import { generateMnemonicBundle, restoreFromMnemonic, verifyMnemonicCommitment } from '../src/recovery'
import { didFromSeed } from '../src/did'
import { isNativeHostAvailable, nativeReadVault, nativeWriteVault } from './nativeHost'

// ── Native host availability (cached per service-worker lifetime) ──────────────

/** null = not yet probed; true/false = cached result */
let _nativeHostAvailable: boolean | null = null

// ── Vault source selection ─────────────────────────────────────────────────────

/**
 * Which storage backend to use when loading the vault.
 * null = auto (native if available, local otherwise).
 * Reset to null on lock so each session starts with a fresh discovery.
 */
let _selectedVaultSource: 'native' | 'local' | null = null

async function useNativeHost(): Promise<boolean> {
  if (_nativeHostAvailable === null) {
    _nativeHostAvailable = await isNativeHostAvailable()
  }
  return _nativeHostAvailable
}

// ── In-memory vault session ───────────────────────────────────────────────────

interface VaultSession {
  vault: Vault
  ownerDid: string
  ownerPrivateKey: Uint8Array
  ownerPublicKey: Uint8Array
}

let session: VaultSession | null = null

// ── Storage helpers ───────────────────────────────────────────────────────────

async function loadApprovals(): Promise<SiteApproval[]> {
  const result = await chrome.storage.local.get('siteApprovals')
  return (result['siteApprovals'] as SiteApproval[] | undefined) ?? []
}

async function saveApprovals(approvals: SiteApproval[]): Promise<void> {
  await chrome.storage.local.set({ siteApprovals: approvals })
}

async function loadVaultBlob(): Promise<PersistedVault | null> {
  if (_selectedVaultSource === 'local') {
    const result = await chrome.storage.local.get('vault')
    return (result['vault'] as PersistedVault | undefined) ?? null
  }
  if (await useNativeHost()) {
    try { return await nativeReadVault() } catch { /* fall through to storage */ }
  }
  const result = await chrome.storage.local.get('vault')
  return (result['vault'] as PersistedVault | undefined) ?? null
}

/**
 * Probe both storage backends and return vault headers without decrypting.
 * Order: native first, local second.
 */
async function discoverVaults(): Promise<VaultListEntry[]> {
  const vaults: VaultListEntry[] = []

  if (await useNativeHost()) {
    try {
      const blob = await nativeReadVault()
      if (blob?.header) vaults.push({ source: 'native', header: blob.header })
    } catch { /* host reachable but no vault file */ }
  }

  const local = await chrome.storage.local.get('vault')
  const localBlob = local['vault'] as PersistedVault | undefined
  if (localBlob?.header) vaults.push({ source: 'local', header: localBlob.header })

  return vaults
}

async function saveVaultBlob(blob: PersistedVault): Promise<void> {
  // Always write to the same backend that was selected for loading, so reads
  // and writes can never land in different backends (split-brain).
  if (_selectedVaultSource === 'local') {
    await chrome.storage.local.set({ vault: blob })
    return
  }
  if (await useNativeHost()) {
    try { await nativeWriteVault(blob); return } catch {
      _nativeHostAvailable = null
      _selectedVaultSource = 'local'
    }
  }
  await chrome.storage.local.set({ vault: blob })
}

// ── Relay config helpers ──────────────────────────────────────────────────────

interface RelayStorage {
  relayUrl: string
  lastSyncedAt: string | null
}

async function loadRelayConfig(): Promise<RelayStorage> {
  const result = await chrome.storage.local.get('relayConfig')
  return (result['relayConfig'] as RelayStorage | undefined) ?? { relayUrl: '', lastSyncedAt: null }
}

async function saveRelayConfig(config: RelayStorage): Promise<void> {
  await chrome.storage.local.set({ relayConfig: config })
}

// ── Available claim types for a detected set of fields ────────────────────────

function matchAvailableClaimTypes(
  detectedFields: MsgFormDetected['detectedFields'],
  vaultClaimTypes: Set<string>,
): string[] {
  const matched = new Set<string>()

  for (const rule of FILL_RULES) {
    if (!vaultClaimTypes.has(rule.claimType)) continue

    const hasMatchingField = detectedFields.some(field => {
      const autocompleteMatch = field.autocomplete
        ? rule.autocompleteTokens.some(t => field.autocomplete!.split(' ').includes(t))
        : false

      const selectorMatch = rule.selectors.some(sel => {
        // We can't run querySelector in the background — match by name/autocomplete heuristics
        if (field.name) {
          const nameLower = field.name.toLowerCase()
          const selectorLower = sel.toLowerCase()
          return selectorLower.includes(nameLower) || nameLower.includes(
            selectorLower.replace(/.*\*=["']?([^"'\]]+)["']?\].*/, '$1')
          )
        }
        return false
      })

      return autocompleteMatch || selectorMatch
    })

    if (hasMatchingField) matched.add(rule.claimType)
  }

  return [...matched]
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((
  message: ContentToBackground | PopupToBackground,
  _sender,
  sendResponse,
) => {
  handleMessage(message, sendResponse)
  return true // keep message channel open for async response
})

async function handleMessage(
  message: ContentToBackground | PopupToBackground,
  sendResponse: (response: BackgroundToContent | BackgroundToPopup | null) => void,
): Promise<void> {
  // ── Vault lifecycle messages ───────────────────────────────────────────────

  if (message.type === 'UNLOCK_VAULT') {
    if (!message.passphrase) {
      sendResponse({ type: 'UNLOCK_RESULT', ok: false, error: 'No passphrase' })
      return
    }

    const blob = await loadVaultBlob()
    if (!blob) {
      sendResponse({ type: 'UNLOCK_RESULT', ok: false, error: 'No vault found' })
      return
    }

    try {
      const vault = await Vault.open(blob, message.passphrase)

      let ownerPrivateKey = new Uint8Array(0)
      let ownerPublicKey = new Uint8Array(0)

      if (message.mnemonic) {
        const bundle = await restoreFromMnemonic(message.mnemonic)
        if (bundle) {
          if (!verifyMnemonicCommitment(message.mnemonic, vault.header.mnemonicCommitment)) {
            sendResponse({ type: 'UNLOCK_RESULT', ok: false, error: 'Recovery phrase does not match this vault' })
            return
          }
          ownerPrivateKey = bundle.keypair.privateKey
          ownerPublicKey = bundle.keypair.publicKey
        }
      }

      session = {
        vault,
        ownerDid: vault.owner.did,
        ownerPrivateKey,
        ownerPublicKey,
      }
      sendResponse({ type: 'UNLOCK_RESULT', ok: true })
    } catch (err) {
      sendResponse({ type: 'UNLOCK_RESULT', ok: false, error: String(err) })
    }
    return
  }

  if (message.type === 'CREATE_VAULT') {
    if (!message.passphrase) {
      sendResponse({ type: 'CREATE_RESULT', ok: false, error: 'No passphrase' })
      return
    }

    // Check each backend independently so we can route creation to a free slot.
    const nativeAvail = await useNativeHost()
    let nativeHasVault = false
    let nativeProbeOk = false
    if (nativeAvail) {
      try {
        nativeHasVault = !!(await nativeReadVault())
        nativeProbeOk = true
      } catch { /* treat as occupied — clobbering an unread vault is data loss */ }
    }
    const localResult = await chrome.storage.local.get('vault')
    const localHasVault = !!(localResult['vault'])

    // Prefer native when available and confirmed empty; fall back to local.
    let targetSource: 'native' | 'local'
    if (nativeAvail && nativeProbeOk && !nativeHasVault) {
      targetSource = 'native'
    } else if (!localHasVault) {
      targetSource = 'local'
    } else {
      const error = (nativeAvail && nativeProbeOk && nativeHasVault && localHasVault)
        ? 'Both storage backends already have a vault. Use the vault picker to select one to unlock.'
        : 'A vault already exists. Unlock it instead.'
      sendResponse({ type: 'CREATE_RESULT', ok: false, error })
      return
    }

    try {
      const bundle = await generateMnemonicBundle()
      const didDoc = await didFromSeed(bundle.keypair.privateKey.slice(0, 32))

      const vault = await Vault.create({
        passphrase: message.passphrase,
        did: didDoc.id,
        mnemonicCommitment: bundle.mnemonicCommitment,
      })

      const blob = await vault.seal()

      // Write directly to the chosen backend — do not go through saveVaultBlob
      // so we don't accidentally overwrite the existing vault in the other slot.
      if (targetSource === 'native') {
        await nativeWriteVault(blob)
      } else {
        await chrome.storage.local.set({ vault: blob })
      }
      _selectedVaultSource = targetSource

      session = {
        vault,
        ownerDid: didDoc.id,
        ownerPrivateKey: bundle.keypair.privateKey,
        ownerPublicKey: bundle.keypair.publicKey,
      }

      sendResponse({ type: 'CREATE_RESULT', ok: true, mnemonic: bundle.mnemonic })
    } catch (err) {
      sendResponse({ type: 'CREATE_RESULT', ok: false, error: String(err) })
    }
    return
  }

  if (message.type === 'LOCK_VAULT') {
    if (session) {
      session.ownerPrivateKey.fill(0)
      session.ownerPublicKey.fill(0)
      session.vault.lock().catch(() => { /* best effort */ })
      session = null
    }
    sendResponse(null)
    return
  }

  // ── Popup messages ─────────────────────────────────────────────────────────

  if (message.type === 'GET_VAULT_STATUS') {
    sendResponse({
      type: 'VAULT_STATUS',
      unlocked: session !== null,
      ownerDid: session?.ownerDid ?? null,
      activeSource: session !== null ? (_selectedVaultSource ?? ((_nativeHostAvailable) ? 'native' : 'local')) : null,
    })
    return
  }

  if (message.type === 'LIST_APPROVALS') {
    const approvals = await loadApprovals()
    // Only surface non-revoked approvals to the popup
    sendResponse({ type: 'APPROVALS_LIST', approvals: approvals.filter(isSiteApprovalValid) })
    return
  }

  if (message.type === 'REVOKE_APPROVAL') {
    const approvals = await loadApprovals()
    // Mark as revoked (tombstone) rather than deleting so APPROVAL_REVOKED can be sent on revisit
    const updated = approvals.map(a =>
      a.id === message.approvalId ? { ...a, revoked: true } : a
    )
    await saveApprovals(updated)
    // Also revoke the corresponding vault grant if vault is unlocked
    if (session) {
      const target = approvals.find(a => a.id === message.approvalId)
      if (target) {
        try { session.vault.revokeGrant(target.grantId) } catch { /* grant may already be gone */ }
      }
    }
    sendResponse({ type: 'APPROVALS_LIST', approvals: updated.filter(isSiteApprovalValid) })
    return
  }

  // ── Content script messages ────────────────────────────────────────────────

  if (message.type === 'FORM_DETECTED') {
    if (!session) {
      sendResponse({ type: 'VAULT_LOCKED' })
      return
    }

    const approvals = await loadApprovals()
    const existing = approvals.find(a => a.origin === message.origin && isSiteApprovalValid(a))

    if (existing) {
      // Site already approved — deliver fill data immediately
      const allClaims = session.vault.listClaims()
      const approved = allClaims.filter(c => existing.claimTypes.includes(c.type))
      const fillMap = buildFillMap(approved)
      sendResponse({ type: 'FILL_DATA', fillMap })
      return
    }

    // Check if this site was explicitly revoked — send APPROVAL_REVOKED so the
    // content script silently skips rather than re-prompting the user.
    const revoked = approvals.find(a => a.origin === message.origin && a.revoked)
    if (revoked) {
      sendResponse({ type: 'APPROVAL_REVOKED', origin: message.origin })
      return
    }

    // New site — compute which claim types are available and prompt user
    const vaultClaimTypes = new Set(session.vault.listClaims().map(c => c.type))
    const available = matchAvailableClaimTypes(message.detectedFields, vaultClaimTypes)

    if (available.length === 0) {
      sendResponse(null) // nothing to offer
      return
    }

    sendResponse({ type: 'APPROVAL_REQUIRED', availableClaimTypes: available, origin: message.origin })
    return
  }

  if (message.type === 'USER_APPROVED') {
    if (!session) {
      sendResponse({ type: 'VAULT_LOCKED' })
      return
    }

    const allClaims = session.vault.listClaims()
    const approved = allClaims.filter(c => message.claimTypes.includes(c.type))
    const fillMap = buildFillMap(approved)

    if (message.persist) {
      // Record a pull-mode grant in the vault for the audit log
      const grantId = crypto.randomUUID()
      const approval = buildSiteApproval({
        id: crypto.randomUUID(),
        origin: message.origin,
        claimTypes: message.claimTypes,
        grantId,
        expiresAt: null,
      })

      // Record in vault audit log via a minimal grant
      try {
        const grant = {
          id: grantId,
          ownerId: session.vault.owner.id,
          granteeRef: message.origin,
          claimIds: approved.map(c => c.id),
          purpose: 'form-fill',
          mode: 'pull' as const,
          singleUse: false,
          expiresAt: null,
          ownerSig: '',
          status: 'active' as const,
          createdAt: new Date().toISOString(),
          revokedAt: null,
        }
        session.vault.addGrant(grant)
        const blob = await session.vault.seal()
        await saveVaultBlob(blob)
      } catch { /* vault state error — approval still proceeds */ }

      const approvals = await loadApprovals()
      approvals.push(approval)
      await saveApprovals(approvals)
    }

    sendResponse({ type: 'FILL_DATA', fillMap })
    return
  }

  if (message.type === 'USER_DENIED') {
    // No action needed — we simply don't store an approval
    sendResponse(null)
    return
  }

  // ── Credential messages ────────────────────────────────────────────────────

  if (message.type === 'CREDENTIAL_FORM_DETECTED') {
    if (!session) { sendResponse({ type: 'VAULT_LOCKED' }); return }
    const claims = session.vault.listClaims()
    const entries = findCredentialsForOrigin(claims, message.origin)
    if (entries.length === 0) { sendResponse(null); return }
    sendResponse({ type: 'CREDENTIAL_FILL_PROMPT', credentials: entries })
    return
  }

  if (message.type === 'CREDENTIAL_FILL_CONFIRMED') {
    if (!session) { sendResponse({ type: 'VAULT_LOCKED' }); return }
    const cred = getCredentialById(session.vault.listClaims(), message.claimId)
    if (!cred) { sendResponse(null); return }
    sendResponse({ type: 'CREDENTIAL_FILL_DATA', username: cred.username, password: cred.password })
    return
  }

  if (message.type === 'CREDENTIAL_SUBMIT') {
    if (!session) { sendResponse({ type: 'VAULT_LOCKED' }); return }
    const claims = session.vault.listClaims()
    const existing = findCredentialsForOrigin(claims, message.origin)
      .find(e => e.username === message.username)

    if (existing) {
      let existingClaim
      try { existingClaim = session.vault.getClaim(existing.claimId) } catch { sendResponse(null); return }
      const existingValue = existingClaim.value as CredentialValue
      if (existingValue.password === message.password) { sendResponse(null); return }
      sendResponse({ type: 'CREDENTIAL_SAVE_PROMPT', username: message.username, existingClaimId: existing.claimId })
    } else {
      sendResponse({ type: 'CREDENTIAL_SAVE_PROMPT', username: message.username })
    }
    return
  }

  if (message.type === 'CREDENTIAL_SAVE_CONFIRMED') {
    if (!session) { sendResponse({ type: 'VAULT_LOCKED' }); return }
    const value: CredentialValue = {
      origin: message.origin,
      username: message.username,
      password: message.password,
    }

    if (message.existingClaimId) {
      let target
      try { target = session.vault.getClaim(message.existingClaimId) } catch { sendResponse(null); return }
      if (target.type !== CREDENTIAL_CLAIM_TYPE) { sendResponse(null); return }
      session.vault.updateClaim(message.existingClaimId, { value })
    } else {
      session.vault.addClaim({
        type: CREDENTIAL_CLAIM_TYPE,
        value,
        source: 'self-attested',
        verification: 'none',
        expiresAt: null,
        issuerDid: null,
      })
    }

    const blob = await session.vault.seal()
    await saveVaultBlob(blob)
    sendResponse(null)
    return
  }

  if (message.type === 'CREDENTIAL_SAVE_DENIED') {
    sendResponse(null)
    return
  }

  if (message.type === 'REQUEST_FILL') {
    if (!session) { sendResponse({ type: 'VAULT_LOCKED' }); return }

    const approvals = await loadApprovals()
    const existing = approvals.find(a => a.origin === message.origin && isSiteApprovalValid(a))
    if (!existing) { sendResponse(null); return }

    const allClaims = session.vault.listClaims()
    const approved = allClaims.filter(c => existing.claimTypes.includes(c.type))
    const fillMap = buildFillMap(approved)
    sendResponse({ type: 'FILL_DATA', fillMap })
    return
  }

  // ── Sync / relay messages ──────────────────────────────────────────────────

  if (message.type === 'GET_RELAY_CONFIG') {
    const config = await loadRelayConfig()
    sendResponse({ type: 'RELAY_CONFIG', relayUrl: config.relayUrl, lastSyncedAt: config.lastSyncedAt })
    return
  }

  if (message.type === 'SET_RELAY_CONFIG') {
    const existing = await loadRelayConfig()
    await saveRelayConfig({ ...existing, relayUrl: message.relayUrl })
    sendResponse({ type: 'RELAY_CONFIG', relayUrl: message.relayUrl, lastSyncedAt: existing.lastSyncedAt })
    return
  }

  if (message.type === 'SYNC_VAULT') {
    if (!session) {
      sendResponse({ type: 'SYNC_RESULT', ok: false, error: 'Vault is locked' })
      return
    }

    const relayStorage = await loadRelayConfig()
    if (!relayStorage.relayUrl) {
      sendResponse({ type: 'SYNC_RESULT', ok: false, error: 'No relay URL configured' })
      return
    }

    if (session.ownerPrivateKey.length === 0) {
      sendResponse({ type: 'SYNC_RESULT', ok: false, error: 'Signing keypair not available — unlock with your recovery mnemonic to enable sync' })
      return
    }

    try {
      const localBlob = await session.vault.seal()
      await saveVaultBlob(localBlob)

      const relayConfig: RelayConfig = {
        url: relayStorage.relayUrl,
        ownerId: session.vault.owner.id,
      }

      const { blob, result } = await syncVault(
        relayConfig,
        localBlob,
        session.ownerPrivateKey,
        session.ownerPublicKey,
      )

      // If remote was newer, replace local storage with the pulled blob.
      // We can't re-open in-memory without the passphrase (never stored), so the
      // in-memory session keeps the current state; the updated blob will be loaded
      // on next unlock.
      if (result.action === 'pulled') {
        await saveVaultBlob(blob)
      }

      const syncedAt = new Date().toISOString()
      await saveRelayConfig({ relayUrl: relayStorage.relayUrl, lastSyncedAt: syncedAt })

      sendResponse({ type: 'SYNC_RESULT', ok: true, action: result.action, syncedAt })
    } catch (err) {
      sendResponse({ type: 'SYNC_RESULT', ok: false, error: String(err) })
    }
    return
  }

  if (message.type === 'GET_VAULT_LIST') {
    const vaults = await discoverVaults()
    sendResponse({ type: 'VAULT_LIST', vaults })
    return
  }

  if (message.type === 'SELECT_VAULT') {
    _selectedVaultSource = message.source
    sendResponse(null)
    return
  }

  if (message.type === 'MERGE_VAULT') {
    if (!session) {
      sendResponse({ type: 'MERGE_RESULT', ok: false, added: 0, error: 'Vault is locked' })
      return
    }

    let otherBlob: PersistedVault | null = null
    try {
      if (message.source === 'local') {
        const result = await chrome.storage.local.get('vault')
        otherBlob = (result['vault'] as PersistedVault | undefined) ?? null
      } else {
        otherBlob = await nativeReadVault()
      }
    } catch (err) {
      sendResponse({ type: 'MERGE_RESULT', ok: false, added: 0, error: `Could not read vault: ${err}` })
      return
    }

    if (!otherBlob) {
      sendResponse({ type: 'MERGE_RESULT', ok: false, added: 0, error: 'No vault found at that source' })
      return
    }

    try {
      const other = await Vault.open(otherBlob, message.passphrase)
      const otherClaims = other.listClaims()
      other.lock().catch(() => { /* best effort */ })

      let added = 0
      for (const claim of otherClaims) {
        const before = session.vault.listClaims().length
        session.vault.importClaim(claim)
        if (session.vault.listClaims().length > before) added++
      }

      const blob = await session.vault.seal()
      await saveVaultBlob(blob)

      sendResponse({ type: 'MERGE_RESULT', ok: true, added })
    } catch (err) {
      sendResponse({ type: 'MERGE_RESULT', ok: false, added: 0, error: String(err) })
    }
    return
  }

  if (message.type === 'GET_NATIVE_HOST_STATUS') {
    const available = await useNativeHost()
    sendResponse({ type: 'NATIVE_HOST_STATUS', available })
    return
  }

  sendResponse(null)
}

// ── Vault lifecycle ───────────────────────────────────────────────────────────

// Lock vault when service worker is about to be suspended
chrome.runtime.onSuspend.addListener(() => {
  if (session) {
    session.ownerPrivateKey.fill(0)
    session.ownerPublicKey.fill(0)
    session.vault.lock().catch(() => { /* best effort */ })
    session = null
  }
})
