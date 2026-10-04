// Import of an Apple Wallet pass (.pkpass) into claim data.
// A .pkpass is a ZIP holding `pass.json`. Only holder-identity fields (name, email, phone) are mapped;
// pass-specific data (barcodes, serial numbers, seats) is never imported. Pure: no fs, browser-safe.
import { autofillFieldToClaimType, makeImportedClaim, type ImportedAutofillClaim } from './import'

// backFields are excluded: they carry issuer contact details (support email/phone), not the holder's.
const FIELD_GROUPS = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields'] as const
const HOLDER_NAME_FIELDS = new Set(['name', 'passenger', 'passengername', 'membername', 'holdername', 'cardholder'])

function passFieldToClaimType(field: string): string | null {
  if (HOLDER_NAME_FIELDS.has(field.toLowerCase().replace(/[^a-z0-9]/g, ''))) return 'schema:name'
  return autofillFieldToClaimType(field)
}
// Bare 'member'/'holder' are excluded: on store cards they usually hold a tier or member number, not a name.
const STYLE_KEYS = ['boardingPass', 'coupon', 'eventTicket', 'generic', 'storeCard'] as const
const MAX_PASS_JSON = 5 * 1024 * 1024

/**
 * Parse the text of a pass's `pass.json`. Fields are matched by `key`, then by `label`
 * (e.g. key "passenger" maps to the name, key "email" or label "Phone" to contact details). First value per claim type wins.
 */
export function parsePassJson(text: string): ImportedAutofillClaim[] {
  const data = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>
  if (!data || typeof data !== 'object' || typeof data.formatVersion !== 'number') {
    throw new Error('Not an Apple Wallet pass.json file')
  }
  const seen = new Map<string, ImportedAutofillClaim>()
  // Pass style key (boardingPass, generic, storeCard, ...) holds the field groups.
  for (const styleKey of STYLE_KEYS) {
    const style = data[styleKey]
    if (!style || typeof style !== 'object' || Array.isArray(style)) continue
    for (const group of FIELD_GROUPS) {
      const fields = (style as Record<string, unknown>)[group]
      if (!Array.isArray(fields)) continue
      for (const f of fields) {
        if (!f || typeof f !== 'object') continue
        const { key, label, value } = f as { key?: unknown; label?: unknown; value?: unknown }
        // JSON numbers are skipped: they cannot carry a leading "+" or "0" of a phone number.
        if (typeof value !== 'string') continue
        const v = value.trim()
        if (!v) continue
        const type =
          (typeof key === 'string' ? passFieldToClaimType(key) : null) ??
          (typeof label === 'string' ? passFieldToClaimType(label) : null)
        if (type && !seen.has(type)) seen.set(type, makeImportedClaim(type, v))
      }
    }
  }
  return [...seen.values()]
}

/** Inflate raw deflate data, aborting as soon as output passes MAX_PASS_JSON (guards against decompression bombs). */
async function inflateCapped(raw: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > MAX_PASS_JSON) {
        await reader.cancel()
        throw new Error('pass.json too large')
      }
      chunks.push(value)
    }
  } catch (e) {
    if (e instanceof Error && e.message === 'pass.json too large') throw e
    throw new Error('Corrupt .pkpass ZIP entry')
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
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
  type Entry = { flags: number; method: number; csize: number; usize: number; lho: number }
  let root: Entry | null = null
  let nested: Entry | null = null
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt .pkpass ZIP directory')
    const nlen = dv.getUint16(p + 28, true)
    const entry: Entry = {
      flags: dv.getUint16(p + 8, true),
      method: dv.getUint16(p + 10, true),
      csize: dv.getUint32(p + 20, true),
      usize: dv.getUint32(p + 24, true),
      lho: dv.getUint32(p + 42, true),
    }
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nlen))
    p += 46 + nlen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true)
    // Prefer the root pass.json; fall back to the first '<dir>/pass.json'.
    if (name.replace(/^\.\//, '') === 'pass.json') { root = entry; break }
    if (nested === null && /^[^/]+\/pass\.json$/.test(name)) nested = entry
  }
  const found = root ?? nested
  if (found) {
    const { flags, method, csize, usize, lho } = found
    if (flags & 1) throw new Error('Encrypted .pkpass is not supported')
    if (csize === 0xffffffff || usize === 0xffffffff || usize > MAX_PASS_JSON || csize > MAX_PASS_JSON) throw new Error('pass.json too large')
    if (lho + 30 > zip.length || dv.getUint32(lho, true) !== 0x04034b50) throw new Error('Corrupt .pkpass ZIP entry')
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true)
    const raw = zip.subarray(start, start + csize)
    if (raw.length !== csize) throw new Error('Corrupt .pkpass ZIP entry')
    if (method === 0) return new TextDecoder().decode(raw)
    if (method !== 8) throw new Error(`Unsupported ZIP compression method ${method}`)
    return new TextDecoder().decode(await inflateCapped(raw))
  }
  throw new Error('pass.json not found in .pkpass')
}

/** Parse a .pkpass file (ZIP bytes) into claims. Throws if it is not a valid pass. */
export async function parsePkpass(zip: Uint8Array): Promise<ImportedAutofillClaim[]> {
  return parsePassJson(await extractPassJson(zip))
}
