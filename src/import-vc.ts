// Import of Verifiable Credentials exported from a VC wallet into claim data.
// No fs, no vault access. Callers pass results to Vault.addClaim().
import { importVC, type RawVC } from './did'

export interface ImportedWalletClaim {
  type: string
  /** Always a string: non-string credential subject values are JSON-encoded. */
  value: string
  source: 'issuer-signed'
  verification: 'verified' | 'none'
  expiresAt: string | null
  issuerDid: string
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function looksLikeVC(v: unknown): v is RawVC {
  return isObject(v)
    && (typeof v.issuer === 'string' || (isObject(v.issuer) && typeof v.issuer.id === 'string'))
    && isObject(v.credentialSubject)
}

/** Collect VCs from a bare VC, an array, or a wrapper (VP / wallet export) holding them. */
function extractVCs(data: unknown): RawVC[] {
  if (Array.isArray(data)) return data.flatMap(extractVCs)
  if (!isObject(data)) return []
  if (looksLikeVC(data)) return [data]
  for (const key of ['verifiableCredential', 'credentials', 'vcs']) {
    if (key in data) return extractVCs(data[key])
  }
  return []
}

/**
 * Parse a VC wallet export (JSON: single VC, array of VCs, or a Verifiable
 * Presentation / `{ credentials: [...] }` wrapper) into claims. Proofs are
 * checked via `importVC`; claims are `verified` only on a valid Ed25519Signature2020
 * proof. Entries that are not JSON-LD VCs (e.g. JWT strings) are ignored.
 * Throws on malformed JSON or when no credential is found.
 */
export async function parseVCWalletExport(text: string): Promise<ImportedWalletClaim[]> {
  const vcs = extractVCs(JSON.parse(text.replace(/^﻿/, '')))
  if (vcs.length === 0) throw new Error('No verifiable credentials found')
  const out: ImportedWalletClaim[] = []
  for (const vc of vcs) {
    for (const c of await importVC(vc)) {
      if (c.value === null || c.value === undefined || c.value === '') continue
      out.push({ ...c, value: typeof c.value === 'string' ? c.value : JSON.stringify(c.value) })
    }
  }
  return out
}
