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
} from './messages'
import type { SiteApproval } from '../src/form-filler'
import {
  buildFillMap, buildSiteApproval, isSiteApprovalValid, FILL_RULES,
  findCredentialsForOrigin, getCredentialById, CREDENTIAL_CLAIM_TYPE,
} from '../src/form-filler'
import type { CredentialValue } from '../src/form-filler'
import type { Vault, PersistedVault } from '../src/vault'

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
  const result = await chrome.storage.local.get('vault')
  return (result['vault'] as PersistedVault | undefined) ?? null
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
      const { Vault } = await import('../src/vault')
      const vault = await Vault.open(blob, message.passphrase)
      // The DID keypair is derived from the mnemonic in the full flow;
      // for now the passphrase-only path leaves the private key as a placeholder.
      session = {
        vault,
        ownerDid: vault.owner.did,
        ownerPrivateKey: new Uint8Array(0),  // placeholder — full flow via mnemonic restore
        ownerPublicKey: new Uint8Array(0),
      }
      sendResponse({ type: 'UNLOCK_RESULT', ok: true })
    } catch (err) {
      sendResponse({ type: 'UNLOCK_RESULT', ok: false, error: String(err) })
    }
    return
  }

  if (message.type === 'LOCK_VAULT') {
    if (session) {
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
      const existingClaim = session.vault.getClaim(existing.claimId)
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
      const target = session.vault.getClaim(message.existingClaimId)
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
    await chrome.storage.local.set({ vault: blob })
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

  sendResponse(null)
}

// ── Vault lifecycle ───────────────────────────────────────────────────────────

// Lock vault when service worker is about to be suspended
chrome.runtime.onSuspend.addListener(() => {
  if (session) {
    session.vault.lock().catch(() => { /* best effort */ })
    session = null
  }
})
