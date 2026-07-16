/**
 * Typed message protocol between content script ↔ background service worker.
 *
 * All messages cross the extension message bus via chrome.runtime.sendMessage /
 * chrome.tabs.sendMessage. Using a discriminated union ensures both ends agree
 * on the shape without a runtime schema library.
 */

import type { FillMap, SiteApproval } from '../src/form-filler'

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

// ── Union types ───────────────────────────────────────────────────────────────

export type ContentToBackground =
  | MsgFormDetected
  | MsgRequestFill
  | MsgUserApproved
  | MsgUserDenied

export type BackgroundToContent =
  | MsgVaultLocked
  | MsgApprovalRequired
  | MsgFillData
  | MsgApprovalRevoked

export type PopupToBackground =
  | MsgListApprovals
  | MsgRevokeApproval
  | MsgGetVaultStatus
  | MsgUnlockVault
  | MsgLockVault

export type BackgroundToPopup =
  | MsgApprovalsListResult
  | MsgVaultStatus
  | MsgUnlockResult
