// Import of an Apple Wallet pass (.pkpass) into claim data.
// A .pkpass is a ZIP holding `pass.json`. Only holder-identity fields (name, email, phone) are mapped;
// pass-specific data (barcodes, serial numbers, seats) is never imported. Pure: no fs, browser-safe.
import { autofillFieldToClaimType, makeImportedClaim, type ImportedAutofillClaim } from './import'

const FIELD_GROUPS = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields'] as const
const MAX_PASS_JSON = 5 * 1024 * 1024

/**
 * Parse the text of a pass's `pass.json`. Fields are matched by `key`, then by `label`
 * (e.g. key "passenger" is ignored, key "email" or label "Phone" is mapped). First value per claim type wins.
 */
export function parsePassJson(text: string): ImportedAutofillClaim[] {
  const data = JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown>
  if (!data || typeof data !== 'object' || typeof data.formatVersion !== 'number') {
    throw new Error('Not an Apple Wallet pass.json file')
  }
  const seen = new Map<string, ImportedAutofillClaim>()
  // Pass style key (boardingPass, generic, storeCard, ...) holds the field groups.
  for (const style of Object.values(data)) {
    if (!style || typeof style !== 'object' || Array.isArray(style)) continue
    for (const group of FIELD_GROUPS) {
      const fields = (style as Record<string, unknown>)[group]
      if (!Array.isArray(fields)) continue
      for (const f of fields) {
        if (!f || typeof f !== 'object') continue
        const { key, label, value } = f as { key?: unknown; label?: unknown; value?: unknown }
        if (typeof value !== 'string' && typeof value !== 'number') continue
        const v = String(value).trim()
        if (!v) continue
        const type =
          (typeof key === 'string' ? autofillFieldToClaimType(key) : null) ??
          (typeof label === 'string' ? autofillFieldToClaimType(label) : null)
        if (type && !seen.has(type)) seen.set(type, makeImportedClaim(type, v))
      }
    }
  }
  return [...seen.values()]
}

/** Extract `pass.json` text from a .pkpass ZIP using its central directory. */
export async function extractPassJson(zip: Uint8Array): Promise<string> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Not a .pkpass file (no ZIP directory)')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt .pkpass ZIP directory')
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const usize = dv.getUint32(p + 24, true)
    const nlen = dv.getUint16(p + 28, true)
    const xlen = dv.getUint16(p + 30, true)
    const clen = dv.getUint16(p + 32, true)
    const lho = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nlen))
    p += 46 + nlen + xlen + clen
    if (name !== 'pass.json') continue
    if (usize > MAX_PASS_JSON) throw new Error('pass.json too large')
    if (lho + 30 > zip.length || dv.getUint32(lho, true) !== 0x04034b50) throw new Error('Corrupt .pkpass ZIP entry')
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true)
    const raw = zip.subarray(start, start + csize)
    if (raw.length !== csize) throw new Error('Corrupt .pkpass ZIP entry')
    if (method === 0) return new TextDecoder().decode(raw)
    if (method !== 8) throw new Error(`Unsupported ZIP compression method ${method}`)
    const stream = new Blob([new Uint8Array(raw)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    const out = new Uint8Array(await new Response(stream).arrayBuffer())
    if (out.length > MAX_PASS_JSON) throw new Error('pass.json too large')
    return new TextDecoder().decode(out)
  }
  throw new Error('pass.json not found in .pkpass')
}

/** Parse a .pkpass file (ZIP bytes) into claims. Throws if it is not a valid pass. */
export async function parsePkpass(zip: Uint8Array): Promise<ImportedAutofillClaim[]> {
  return parsePassJson(await extractPassJson(zip))
}
