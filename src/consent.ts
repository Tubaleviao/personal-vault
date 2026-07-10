/**
 * Grant consent layer — create, sign, validate, and revoke grants (Steps 2.4, 3.2.7).
 *
 * A Grant is the core consent primitive:
 *   { grantee, claims[], purpose, expiry, mode, singleUse } — signed by the owner DID key.
 *
 * This module handles the application-layer consent logic that sits on top of
 * the Vault class (which handles persistence) and the DID module (which handles
 * identity and signing).
 *
 * Flow:
 *   createGrant()     — build and sign the grant object
 *   validateGrant()   — check signature, expiry, status
 *   createPushGrant() — convenience wrapper that also builds the encrypted bundle
 *   revokeGrant()     — delegates to Vault.revokeGrant() after validation
 */

import { randomUUID } from 'crypto'
import { signWithDID, verifyWithDID } from './did'
import { createBundle, encodeToken } from './sharing'
import type { Vault, Grant, Claim } from './vault'

// ── Grant creation ────────────────────────────────────────────────────────────

export interface GrantInput {
  granteeRef: string
  claimIds: string[]
  purpose: string
  mode: 'push' | 'pull'
  singleUse: boolean
  expiresAt: Date | null
}

export interface SignedGrantResult {
  grant: Grant
  ownerSig: string
}

/**
 * Build a signed grant object. The ownerSig covers the canonical grant payload
 * (excluding ownerSig itself), binding the grant to the owner's DID.
 */
export async function createGrant(
  input: GrantInput,
  ownerId: string,
  ownerDid: string,
  ownerPrivateKey: Uint8Array,
): Promise<SignedGrantResult> {
  const id = randomUUID()
  const createdAt = new Date().toISOString()

  const canonical = canonicalGrantPayload({
    id,
    ownerId,
    granteeRef: input.granteeRef,
    claimIds: input.claimIds,
    purpose: input.purpose,
    mode: input.mode,
    singleUse: input.singleUse,
    expiresAt: input.expiresAt?.toISOString() ?? null,
    createdAt,
  })

  const ownerSig = await signWithDID(canonical, ownerPrivateKey)

  const grant: Grant = {
    id,
    ownerId,
    granteeRef: input.granteeRef,
    claimIds: input.claimIds,
    purpose: input.purpose,
    mode: input.mode,
    singleUse: input.singleUse,
    expiresAt: input.expiresAt?.toISOString() ?? null,
    ownerSig,
    status: 'active',
    createdAt,
    revokedAt: null,
  }

  return { grant, ownerSig }
}

// ── Grant validation ──────────────────────────────────────────────────────────

export type GrantValidationResult =
  | { valid: true }
  | { valid: false; reason: 'signature-invalid' | 'revoked' | 'expired' | 'unknown-grant' }

/**
 * Validate a grant — check signature, status, and expiry.
 * Callers (relay, verifier) use this before serving data.
 */
export async function validateGrant(grant: Grant, ownerDid: string): Promise<GrantValidationResult> {
  // Check status first (cheapest)
  if (grant.status === 'revoked') return { valid: false, reason: 'revoked' }
  if (grant.status === 'expired') return { valid: false, reason: 'expired' }

  // Check wall-clock expiry
  if (grant.expiresAt && new Date(grant.expiresAt) < new Date()) {
    return { valid: false, reason: 'expired' }
  }

  // Verify the owner's signature
  const canonical = canonicalGrantPayload({
    id: grant.id,
    ownerId: grant.ownerId,
    granteeRef: grant.granteeRef,
    claimIds: grant.claimIds,
    purpose: grant.purpose,
    mode: grant.mode,
    singleUse: grant.singleUse,
    expiresAt: grant.expiresAt,
    createdAt: grant.createdAt,
  })

  const sigValid = await verifyWithDID(canonical, grant.ownerSig, ownerDid)
  if (!sigValid) return { valid: false, reason: 'signature-invalid' }

  return { valid: true }
}

// ── Push grant convenience ────────────────────────────────────────────────────

export interface PushGrantResult {
  grant: Grant
  token: string   // base64url token ready for QR / link
}

/**
 * Create a push grant and immediately build the encrypted shareable bundle.
 * This is the primary "share claims" user action (Step 3.2.3 combined with 2.4).
 */
export async function createPushGrant(options: {
  vault: Vault
  claimIds: string[]
  granteeRef: string
  purpose: string
  expiresAt: Date | null
  ownerDid: string
  ownerPrivateKey: Uint8Array
  ownerPublicKey: Uint8Array
  encryptionKey: Uint8Array
}): Promise<PushGrantResult> {
  const claims: Claim[] = options.claimIds.map(id => options.vault.getClaim(id))

  const { bundle, grant } = await createBundle({
    claims,
    granteeRef: options.granteeRef,
    purpose: options.purpose,
    expiresAt: options.expiresAt,
    ownerPrivateKey: options.ownerPrivateKey,
    ownerPublicKey: options.ownerPublicKey,
    encryptionKey: options.encryptionKey,
  })

  // Backfill ownerId from vault
  const filledGrant: Grant = { ...grant, ownerId: options.vault.owner.id }
  options.vault.addGrant(filledGrant)

  const token = encodeToken(bundle)
  return { grant: filledGrant, token }
}

// ── Revocation ────────────────────────────────────────────────────────────────

/**
 * Revoke a grant. For pull grants this immediately invalidates relay access.
 * For push grants, the copied bundle cannot be recalled, but this records the
 * revocation in the audit log and marks the grant as revoked.
 */
export function revokeGrant(vault: Vault, grantId: string): void {
  vault.revokeGrant(grantId)
}

// ── Internal ──────────────────────────────────────────────────────────────────

function canonicalGrantPayload(fields: {
  id: string
  ownerId: string
  granteeRef: string
  claimIds: string[]
  purpose: string
  mode: string
  singleUse: boolean
  expiresAt: string | null
  createdAt: string
}): string {
  // Sort keys for deterministic canonical form
  return JSON.stringify(fields, Object.keys(fields).sort())
}
