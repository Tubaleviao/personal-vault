// Import of third-party autofill data (Chrome / Google Takeout) into claim data.
// Pure functions: no fs, no vault access. Callers pass results to Vault.addClaim().

export interface ImportedAutofillClaim {
  type: string
  value: string
  source: 'imported'
  verification: 'none'
}

/** Autofill field name (lowercased, separators stripped) → claim type. */
const FIELD_TO_CLAIM: Record<string, string> = {
  givenname: 'schema:givenName',
  firstname: 'schema:givenName',
  familyname: 'schema:familyName',
  lastname: 'schema:familyName',
  surname: 'schema:familyName',
  name: 'schema:name',
  fullname: 'schema:name',
  email: 'schema:email',
  emailaddress: 'schema:email',
  tel: 'schema:telephone',
  phone: 'schema:telephone',
  telephone: 'schema:telephone',
  phonenumber: 'schema:telephone',
}

function normaliseField(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '')
}

/** Map a raw autofill field name to a claim type, or null if unsupported. */
export function autofillFieldToClaimType(field: string): string | null {
  return FIELD_TO_CLAIM[normaliseField(field)] ?? null
}

function collect(pairs: Iterable<[string, unknown]>): ImportedAutofillClaim[] {
  // Keep the first value seen per claim type (Takeout lists most-used first).
  const seen = new Map<string, ImportedAutofillClaim>()
  for (const [field, raw] of pairs) {
    if (typeof raw !== 'string') continue
    const value = raw.trim()
    if (!value) continue
    const type = autofillFieldToClaimType(field)
    if (!type || seen.has(type)) continue
    seen.set(type, { type, value, source: 'imported', verification: 'none' })
  }
  return [...seen.values()]
}

/**
 * Parse Google Takeout Chrome `Autofill.json`: `{ "Autofill": [{ "name", "value" }, ...] }`.
 * Throws on malformed JSON or unexpected shape.
 */
export function parseTakeoutAutofill(text: string): ImportedAutofillClaim[] {
  const data = JSON.parse(text) as { Autofill?: unknown }
  if (!data || typeof data !== 'object' || !Array.isArray(data.Autofill)) {
    throw new Error('Not a Takeout Autofill.json file')
  }
  const pairs: [string, unknown][] = []
  for (const e of data.Autofill) {
    if (e && typeof e === 'object') pairs.push([String((e as any).name ?? ''), (e as any).value])
  }
  return collect(pairs)
}

/** RFC 4180-ish CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some(f => f !== '')) rows.push(row)
  return rows
}

/**
 * Parse a CSV with a header row whose column names are autofill fields
 * (e.g. `First Name,Last Name,Email,Phone`). Uses the first data row that
 * supplies each claim type.
 */
export function parseAutofillCsv(text: string): ImportedAutofillClaim[] {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''))
  if (!header) return []
  const pairs: [string, unknown][] = []
  for (const row of rows) header.forEach((h, i) => pairs.push([h, row[i]]))
  return collect(pairs)
}
