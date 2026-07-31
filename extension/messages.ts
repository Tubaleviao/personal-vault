/**
 * Typed message protocol between content script ↔ background service worker.
 *
 * All messages cross the extension message bus via chrome.runtime.sendMessage /
 * chrome.tabs.sendMessage. Using a discriminated union ensures both ends agree
 * on the shape without a runtime schema library.
 */

import type { FillMap, SiteApproval, CredentialEntry } from '../src/form-filler'
import type { VaultHeader } from '../src/vault'

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

/** Popup asks the background to create a brand-new vault. */
export interface MsgCreateVault {
  type: 'CREATE_VAULT'
  passphrase: string
}

/** Response to a CREATE_VAULT request. On success carries the generated mnemonic. */
export interface MsgCreateResult {
  type: 'CREATE_RESULT'
  ok: boolean
  mnemonic?: string
  error?: string
  ownerDid?: string
  activeSource?: 'native' | 'local'
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
  /** Which storage backend holds the currently active vault. */
  activeSource: 'native' | 'local' | null
}

/** Response to an UNLOCK_VAULT request. */
export interface MsgUnlockResult {
  type: 'UNLOCK_RESULT'
  ok: boolean
  error?: string
  ownerDid?: string
  activeSource?: 'native' | 'local'
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

// ── Vault discovery & selection ───────────────────────────────────────────────

export interface VaultListEntry {
  source: 'native' | 'local'
  header: VaultHeader
  /** Filename within the vault directory — only set for native source entries. */
  name?: string
}

/** Popup asks for all discovered vault sources (no decryption needed). */
export interface MsgGetVaultList {
  type: 'GET_VAULT_LIST'
}

/** Popup tells background which storage source to use for the next unlock. */
export interface MsgSelectVault {
  type: 'SELECT_VAULT'
  source: 'native' | 'local'
  /** For native source: the specific vault filename to read. */
  name?: string
}

/** Background returns the list of discovered vault sources. */
export interface MsgVaultList {
  type: 'VAULT_LIST'
  vaults: VaultListEntry[]
}

// ── Vault merge ───────────────────────────────────────────────────────────────

/** Popup asks background to merge claims from a secondary vault into the active one. */
export interface MsgMergeVault {
  type: 'MERGE_VAULT'
  /** The storage source that holds the other vault. */
  source: 'native' | 'local'
  passphrase: string
}

/** Background responds to MERGE_VAULT with how many new claims were imported. */
export interface MsgMergeResult {
  type: 'MERGE_RESULT'
  ok: boolean
  added: number
  error?: string
}

// ── Popup → Background: native host status ────────────────────────────────────

/** Popup asks whether the native desktop host is reachable. */
export interface MsgGetNativeHostStatus {
  type: 'GET_NATIVE_HOST_STATUS'
}

// ── Background → Popup: native host status ────────────────────────────────────

export interface MsgNativeHostStatus {
  type: 'NATIVE_HOST_STATUS'
  available: boolean
}

// ── Native host I/O (extension ↔ desktop app via chrome.runtime.connectNative) ──

/** Read the vault blob from the desktop app's file storage. */
export interface NativeMsgReadVault {
  type: 'READ_VAULT'
  name?: string
}

/** Write the sealed vault blob to the desktop app's file storage. */
export interface NativeMsgWriteVault {
  type: 'WRITE_VAULT'
  blob: string
}

/** Check whether a vault file exists on disk. */
export interface NativeMsgVaultExists {
  type: 'VAULT_EXISTS'
}

/** List all vault files in the desktop vault directory. */
export interface NativeMsgListVaults {
  type: 'LIST_VAULTS'
}

/** Response from the native host for READ_VAULT / VAULT_EXISTS. */
export interface NativeResponseOk {
  ok: true
  blob?: string    // present on READ_VAULT response
  exists?: boolean // present on VAULT_EXISTS response
  vaults?: Array<{ name: string; content: string }> // present on LIST_VAULTS response
}

export interface NativeResponseErr {
  ok: false
  error: string
}

export type NativeRequest = NativeMsgReadVault | NativeMsgWriteVault | NativeMsgVaultExists | NativeMsgListVaults
export type NativeResponse = NativeResponseOk | NativeResponseErr

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
  | MsgCreateVault
  | MsgGetRelayConfig
  | MsgSetRelayConfig
  | MsgSyncVault
  | MsgGetNativeHostStatus
  | MsgGetVaultList
  | MsgSelectVault
  | MsgMergeVault

export type BackgroundToPopup =
  | MsgApprovalsListResult
  | MsgVaultStatus
  | MsgUnlockResult
  | MsgCreateResult
  | MsgRelayConfig
  | MsgSyncResult
  | MsgNativeHostStatus
  | MsgVaultList
  | MsgMergeResult
