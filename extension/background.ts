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
  buildFillMap, buildSiteApproval, isSiteApprovalValid, filterFillMapForSite, FILL_RULES,
} from '../src/form-filler'
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
        ? rule.autocompleteTokens.some(t => field.autocomplete!.includes(t))
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
    sendResponse({ type: 'APPROVALS_LIST', approvals })
    return
  }

  if (message.type === 'REVOKE_APPROVAL') {
    const approvals = await loadApprovals()
    const updated = approvals.filter(a => a.id !== message.approvalId)
    await saveApprovals(updated)
    // Also revoke the corresponding vault grant if vault is unlocked
    if (session) {
      const revoked = approvals.find(a => a.id === message.approvalId)
      if (revoked) {
        try { session.vault.revokeGrant(revoked.grantId) } catch { /* grant may already be gone */ }
      }
    }
    sendResponse({ type: 'APPROVALS_LIST', approvals: updated })
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
      const filtered = filterFillMapForSite(fillMap, existing.claimTypes)
      sendResponse({ type: 'FILL_DATA', fillMap: filtered })
      return
    }

    // Check if this site was previously revoked
    const revoked = approvals.find(a => a.origin === message.origin && !isSiteApprovalValid(a))
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
    const filtered = filterFillMapForSite(fillMap, message.claimTypes)

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

    sendResponse({ type: 'FILL_DATA', fillMap: filtered })
    return
  }

  if (message.type === 'USER_DENIED') {
    // No action needed — we simply don't store an approval
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
    const filtered = filterFillMapForSite(fillMap, existing.claimTypes)
    sendResponse({ type: 'FILL_DATA', fillMap: filtered })
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

// Expose a simple unlock API for the popup (called after passphrase entry)
// The popup sends a message type not in the union — handled here separately.
chrome.runtime.onMessage.addListener((message: { type: string; passphrase?: string }, _sender, sendResponse) => {
  if (message.type !== 'UNLOCK_VAULT') return false

  if (!message.passphrase) { sendResponse({ ok: false, error: 'No passphrase' }); return true }

  loadVaultBlob().then(async blob => {
    if (!blob) { sendResponse({ ok: false, error: 'No vault found' }); return }

    const { Vault } = await import('../src/vault')
    const vault = await Vault.open(blob, message.passphrase!)

    // For now the DID keypair must be provided separately or derived from recovery
    // In the full flow the popup would send the keypair alongside the passphrase
    session = {
      vault,
      ownerDid: vault.owner.did,
      ownerPrivateKey: new Uint8Array(0),  // placeholder — full flow via popup
      ownerPublicKey: new Uint8Array(0),
    }
    sendResponse({ ok: true })
  }).catch(err => {
    sendResponse({ ok: false, error: String(err) })
  })

  return true
})
