/**
 * Typed message protocol between content script ↔ background service worker.
 *
 * All messages cross the extension message bus via chrome.runtime.sendMessage /
 * chrome.tabs.sendMessage. Using a discriminated union ensures both ends agree
 * on the shape without a runtime schema library.
 */

import type { FillMap, SiteApproval, CredentialEntry } from '../src/form-filler'

// ── Content → Background ──────────────────────────────────────────────────────

/** Content script found form fields; asks whether the site is approved. */
export interface MsgFormDetected {
  type: 'FORM_DETECTED'
  origin: string
  /** Autocomplete tokens and name attributes the content script found. */
  detectedFields: DetectedField[]
}

export interface DetectedField {
  selector: string
  autocomplete: string | null
  name: string | null
  inputType: string
}

/** Content script requests the fill map for an already-approved site. */
export interface MsgRequestFill {
  type: 'REQUEST_FILL'
  origin: string
}

// ── Background → Content ──────────────────────────────────────────────────────

/** Vault is locked; content script should show "unlock vault" hint. */
export interface MsgVaultLocked {
  type: 'VAULT_LOCKED'
}

/** Site is not yet approved; content script shows the approval prompt. */
export interface MsgApprovalRequired {
  type: 'APPROVAL_REQUIRED'
  /** The claim types available in the vault that match detected fields. */
  availableClaimTypes: string[]
  origin: string
}

/** Deliver fill data to the content script. */
export interface MsgFillData {
  type: 'FILL_DATA'
  fillMap: FillMap
}

/** Site is known but currently revoked / expired. */
export interface MsgApprovalRevoked {
  type: 'APPROVAL_REVOKED'
  origin: string
}

// ── Content → Background (user actions) ──────────────────────────────────────

/** User approved filling this site with the given claim types. */
export interface MsgUserApproved {
  type: 'USER_APPROVED'
  origin: string
  claimTypes: string[]
  /** If true, persist approval; if false, approve once for this page load only. */
  persist: boolean
}

/** User dismissed / denied filling for this site. */
export interface MsgUserDenied {
  type: 'USER_DENIED'
  origin: string
}

// ── Popup → Background (sync) ─────────────────────────────────────────────────

/** Popup reads the current relay configuration. */
export interface MsgGetRelayConfig {
  type: 'GET_RELAY_CONFIG'
}

/** Popup saves a relay URL (empty string = disable sync). */
export interface MsgSetRelayConfig {
  type: 'SET_RELAY_CONFIG'
  relayUrl: string
}

/** Popup triggers a manual sync (push or pull). */
export interface MsgSyncVault {
  type: 'SYNC_VAULT'
}

// ── Background → Popup (sync) ─────────────────────────────────────────────────

export interface MsgRelayConfig {
  type: 'RELAY_CONFIG'
  relayUrl: string
  lastSyncedAt: string | null
}

export interface MsgSyncResult {
  type: 'SYNC_RESULT'
  ok: boolean
  action?: 'pushed' | 'pulled' | 'already-current' | 'first-push'
  syncedAt?: string
  error?: string
}

// ── Popup → Background ────────────────────────────────────────────────────────

/** Popup requests the list of current site approvals. */
export interface MsgListApprovals {
  type: 'LIST_APPROVALS'
}

/** Popup requests revocation of a specific site approval. */
export interface MsgRevokeApproval {
  type: 'REVOKE_APPROVAL'
  approvalId: string
}

/** Popup requests the vault unlock state. */
export interface MsgGetVaultStatus {
  type: 'GET_VAULT_STATUS'
}

/** Popup asks the background to unlock the vault with a passphrase. */
export interface MsgUnlockVault {
  type: 'UNLOCK_VAULT'
  passphrase: string
  /** Optional: supply the BIP-39 mnemonic to also unlock the signing keypair (needed for sync). */
  mnemonic?: string
}

/** Popup asks the background to lock the vault and clear the in-memory session. */
export interface MsgLockVault {
  type: 'LOCK_VAULT'
}

// ── Background → Popup ────────────────────────────────────────────────────────

export interface MsgApprovalsListResult {
  type: 'APPROVALS_LIST'
  approvals: SiteApproval[]
}

export interface MsgVaultStatus {
  type: 'VAULT_STATUS'
  unlocked: boolean
  ownerDid: string | null
}

/** Response to an UNLOCK_VAULT request. */
export interface MsgUnlockResult {
  type: 'UNLOCK_RESULT'
  ok: boolean
  error?: string
}

// ── Credential messages: Content → Background ─────────────────────────────────

/** Content detected a login form (has a password field). */
export interface MsgCredentialFormDetected {
  type: 'CREDENTIAL_FORM_DETECTED'
  origin: string
}

/** Content captured username + password from a submitted form. */
export interface MsgCredentialSubmit {
  type: 'CREDENTIAL_SUBMIT'
  origin: string
  username: string
  password: string
}

/** User confirmed saving / updating the credential in the save banner. */
export interface MsgCredentialSaveConfirmed {
  type: 'CREDENTIAL_SAVE_CONFIRMED'
  origin: string
  username: string
  password: string
  /** present = update existing credential, absent = new */
  existingClaimId?: string
}

/** User dismissed the save banner without saving. */
export interface MsgCredentialSaveDenied {
  type: 'CREDENTIAL_SAVE_DENIED'
}

/** User picked an account from the fill banner. */
export interface MsgCredentialFillConfirmed {
  type: 'CREDENTIAL_FILL_CONFIRMED'
  claimId: string
}

// ── Credential messages: Background → Content ─────────────────────────────────

/** Prompt to fill — carries usernames only, never passwords. */
export interface MsgCredentialFillPrompt {
  type: 'CREDENTIAL_FILL_PROMPT'
  credentials: CredentialEntry[]
}

/** Actual fill data — sent only after user confirms fill. */
export interface MsgCredentialFillData {
  type: 'CREDENTIAL_FILL_DATA'
  username: string
  password: string
}

/** Prompt to save a new password or update an existing one. */
export interface MsgCredentialSavePrompt {
  type: 'CREDENTIAL_SAVE_PROMPT'
  username: string
  /** present = "Update saved password?", absent = "Save password?" */
  existingClaimId?: string
}

// ── Union types ───────────────────────────────────────────────────────────────

export type ContentToBackground =
  | MsgFormDetected
  | MsgRequestFill
  | MsgUserApproved
  | MsgUserDenied
  | MsgCredentialFormDetected
  | MsgCredentialSubmit
  | MsgCredentialSaveConfirmed
  | MsgCredentialSaveDenied
  | MsgCredentialFillConfirmed

export type BackgroundToContent =
  | MsgVaultLocked
  | MsgApprovalRequired
  | MsgFillData
  | MsgApprovalRevoked
  | MsgCredentialFillPrompt
  | MsgCredentialFillData
  | MsgCredentialSavePrompt

export type PopupToBackground =
  | MsgListApprovals
  | MsgRevokeApproval
  | MsgGetVaultStatus
  | MsgUnlockVault
  | MsgLockVault
  | MsgGetRelayConfig
  | MsgSetRelayConfig
  | MsgSyncVault

export type BackgroundToPopup =
  | MsgApprovalsListResult
  | MsgVaultStatus
  | MsgUnlockResult
  | MsgRelayConfig
  | MsgSyncResult
