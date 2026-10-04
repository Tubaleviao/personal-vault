// Import of third-party autofill data (Chrome / Google Takeout) into claim data.
// Pure functions: no fs, no vault access. Callers pass results to Vault.addClaim(); they should skip types the vault already holds.

export interface ImportedAutofillClaim {
  type: string
  value: string
  source: 'imported'
  verification: 'none'
  expiresAt: null
  issuerDid: null
}

/** Autofill field name (lowercased, separators stripped) → claim type. */
const FIELD_TO_CLAIM = new Map<string, string>(Object.entries({
  givenname: 'schema:givenName',
  firstname: 'schema:givenName',
  familyname: 'schema:familyName',
  lastname: 'schema:familyName',
  surname: 'schema:familyName',
  fullname: 'schema:name',
  email: 'schema:email',
  emailaddress: 'schema:email',
  tel: 'schema:telephone',
  phone: 'schema:telephone',
  telephone: 'schema:telephone',
  phonenumber: 'schema:telephone',
}))

function normaliseField(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Map a raw autofill field name to a claim type, or null if unsupported. */
export function autofillFieldToClaimType(field: string): string | null {
  return FIELD_TO_CLAIM.get(normaliseField(field)) ?? null
}

/** Build an imported, unverified claim. */
export function makeImportedClaim(type: string, value: string): ImportedAutofillClaim {
  return { type, value, source: 'imported', verification: 'none', expiresAt: null, issuerDid: null }
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
    seen.set(type, makeImportedClaim(type, value))
  }
  return [...seen.values()]
}

/**
 * Parse Google Takeout Chrome `Autofill.json`: `{ "Autofill": [{ "name", "value" }, ...] }`.
 * Throws on malformed JSON or unexpected shape.
 */
export function parseTakeoutAutofill(text: string): ImportedAutofillClaim[] {
  const data = JSON.parse(text.replace(/^\uFEFF/, '')) as { Autofill?: unknown }
  if (!data || typeof data !== 'object' || !Array.isArray(data.Autofill)) {
    throw new Error('Not a Takeout Autofill.json file')
  }
  const entries = data.Autofill.filter((e): e is { name?: unknown; value?: unknown; count?: unknown } => !!e && typeof e === 'object')
  const usage = (e: { count?: unknown }) => (typeof e.count === 'number' ? e.count : 0)
  // Most-used first; Array.sort is stable so file order breaks ties.
  entries.sort((a, b) => usage(b) - usage(a))
  return collect(entries.map((e): [string, unknown] => [String(e.name ?? ''), e.value]))
}

/** RFC 4180-ish CSV parser (quoted fields, escaped quotes, CRLF). A quote only opens a quoted section at the start of a field. */
export function parseCsv(text: string, delimiter = ','): string[][] {
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
    } else if (c === '"' && field === '') quoted = true
    else if (c === delimiter) { row.push(field); field = '' }
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
 * (e.g. `First Name,Last Name,Email,Phone`). Uses the first data row only.
 */
export function parseAutofillCsv(text: string): ImportedAutofillClaim[] {
  const body = text.replace(/^\uFEFF/, '')
  // Locales such as pt-BR export with ';' — pick it when the header line has no commas.
  const headerLine = body.split(/\r\n|\r|\n/, 1)[0]
  // Count delimiters outside quotes so a comma inside a quoted column name does not decide.
  const unquoted = headerLine.replace(/"[^"]*"/g, '')
  const delimiter = !unquoted.includes(',') && unquoted.includes(';') ? ';' : ','
  const [header, ...rows] = parseCsv(body, delimiter)
  if (!header) return []
  const pairs: [string, unknown][] = []
  // One row only: mixing columns from different rows would combine different people's data.
  for (const row of rows.slice(0, 1)) header.forEach((h, i) => pairs.push([h, row[i]]))
  return collect(pairs)
}
