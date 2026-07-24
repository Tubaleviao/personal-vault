/**
 * Audit log — append-only hash chain (Step 3.2.5).
 *
 * Each AuditEntry contains:
 *   prevHash  — SHA-256 hex of the previous entry's canonical JSON (null for genesis)
 *   entryHash — SHA-256 hex of this entry's canonical JSON (including prevHash)
 *
 * This forms a tamper-evident chain: modifying any past entry changes its hash,
 * which breaks the prevHash reference in every subsequent entry.
 *
 * The Vault class calls appendEntry() internally. This module exposes:
 *   - buildEntry()     — construct and hash a new entry
 *   - verifyChain()    — validate the full log integrity
 *   - formatAuditLog() — human-readable display for the audit screen
 */

import { sha256String } from './crypto'
import type { AuditEntry, AuditAction } from './vault'

export type { AuditEntry, AuditAction }

// ── Build a new entry ─────────────────────────────────────────────────────────

export interface NewAuditEntry {
  ownerId: string
  grantId: string | null
  action: AuditAction
  actor: string
  detail: unknown
}

/**
 * Construct a new AuditEntry linked to the previous one.
 * Pass the last entry in the chain as `prev`, or null for the genesis entry.
 */
export function buildEntry(input: NewAuditEntry, prev: AuditEntry | null): AuditEntry {
  const id = globalThis.crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const prevHash = prev ? prev.entryHash : null

  const canonical = canonicalise({ ...input, id, prevHash, createdAt })
  const entryHash = sha256Hex(canonical)

  return {
    id,
    ownerId: input.ownerId,
    grantId: input.grantId,
    action: input.action,
    actor: input.actor,
    detail: input.detail,
    prevHash,
    entryHash,
    createdAt,
  }
}

// ── Chain verification ────────────────────────────────────────────────────────

export interface ChainVerificationResult {
  valid: boolean
  entryCount: number
  firstBrokenAt?: number  // 0-based index of the first invalid entry
  reason?: string
}

/**
 * Verify the full audit log chain from genesis to tail.
 * Returns { valid: true } if the chain is intact.
 */
export function verifyChain(log: AuditEntry[]): ChainVerificationResult {
  if (log.length === 0) return { valid: true, entryCount: 0 }

  for (let i = 0; i < log.length; i++) {
    const entry = log[i]!
    const prev = i === 0 ? null : log[i - 1]!

    // Verify prevHash linkage
    const expectedPrevHash = prev ? prev.entryHash : null
    if (entry.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        entryCount: log.length,
        firstBrokenAt: i,
        reason: `Entry ${i} prevHash mismatch (expected ${expectedPrevHash}, got ${entry.prevHash})`,
      }
    }

    // Verify this entry's own hash
    const canonical = canonicalise({
      ownerId: entry.ownerId,
      grantId: entry.grantId,
      action: entry.action,
      actor: entry.actor,
      detail: entry.detail,
      id: entry.id,
      prevHash: entry.prevHash,
      createdAt: entry.createdAt,
    })
    const expectedHash = sha256Hex(canonical)
    if (entry.entryHash !== expectedHash) {
      return {
        valid: false,
        entryCount: log.length,
        firstBrokenAt: i,
        reason: `Entry ${i} entryHash mismatch — content was tampered with`,
      }
    }
  }

  return { valid: true, entryCount: log.length }
}

// ── Human-readable display ────────────────────────────────────────────────────

export interface AuditLine {
  timestamp: string
  action: AuditAction
  actor: string
  grantId: string | null
  detail: string
  entryHash: string
}

/** Format the audit log for the "who got what, when" UI screen. */
export function formatAuditLog(log: AuditEntry[]): AuditLine[] {
  return [...log].reverse().map(e => ({
    timestamp: e.createdAt,
    action: e.action,
    actor: e.actor,
    grantId: e.grantId,
    detail: e.detail ? JSON.stringify(e.detail) : '',
    entryHash: e.entryHash.slice(0, 12) + '…',
  }))
}

// ── Internal ──────────────────────────────────────────────────────────────────

function canonicalise(obj: object): string {
  return JSON.stringify(sortKeys(obj))
}

function sortKeys(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(val as object).sort()) {
    sorted[k] = sortKeys((val as Record<string, unknown>)[k])
  }
  return sorted
}

function sha256Hex(text: string): string {
  return sha256String(text)
}
