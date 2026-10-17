/**
 * Form-filler module — vault-side logic for the browser extension wedge feature (Step 3.2.4).
 *
 * Responsibilities:
 *   - Map vault Claim types (schema.org vocabulary) to HTML input field selectors
 *   - Build a FillMap: { fieldName → claimValue } for a given set of approved claim IDs
 *   - Produce a SiteGrant: a scoped, short-lived grant recording that this site
 *     was approved to receive this field set
 *
 * What does NOT live here:
 *   - The browser extension runtime (content script, background worker, popup)
 *   - Vault crypto — this module only reads already-unlocked Claim objects
 *
 * Claim type vocabulary (schema.org prefixed):
 *   schema:givenName       → input[name*=first], input[autocomplete*=given-name], ...
 *   schema:familyName      → input[name*=last], input[autocomplete*=family-name], ...
 *   schema:email           → input[type=email], input[name*=email], ...
 *   schema:telephone       → input[type=tel], input[name*=phone], ...
 *   schema:birthDate       → input[type=date][name*=birth], input[name*=dob], ...
 *   schema:streetAddress   → input[name*=address], input[autocomplete*=street-address], ...
 *   schema:addressLocality → input[name*=city], input[autocomplete*=address-level2], ...
 *   schema:addressRegion   → input[name*=state], input[autocomplete*=address-level1], ...
 *   schema:postalCode      → input[name*=zip], input[name*=postal], ...
 *   schema:addressCountry  → input[name*=country], select[name*=country], ...
 *   schema:jobTitle        → input[name*=title], input[name*=occupation], ...
 *   schema:worksFor        → input[name*=employer], input[name*=company], ...
 */

import type { Claim } from './vault'
import enFields from './form-filler/locales/en.json'
import ptFields from './form-filler/locales/pt-BR.json'

// ── Field mapping ─────────────────────────────────────────────────────────────

/**
 * A FillRule describes how a vault claim type maps to HTML form fields.
 * Selectors are tried in order; the first matching element wins.
 * `autocomplete` is the W3C autocomplete token — the most reliable signal.
 */
export interface FillRule {
  /** The schema.org / vc: claim type this rule covers */
  claimType: string
  /** Ordered list of CSS selectors to try (most-specific first) */
  selectors: string[]
  /** HTML autocomplete attribute tokens that also match */
  autocompleteTokens: string[]
}

/**
 * Per-locale field-matching data (src/form-filler/locales/<locale>.json). Adding a language is
 * data-only: add a JSON file and one entry to FIELD_LOCALES. Selectors and autocomplete tokens
 * are unioned across locales (a pt-BR page can be filled by an en-locale user); `keywords` are
 * accent-stripped label / name / placeholder phrases used by classifyField().
 */
interface LocaleFieldData { selectors: string[]; autocomplete: string[]; keywords: string[] }
type LocaleFile = Record<string, LocaleFieldData>

export const FIELD_LOCALES: Record<string, LocaleFile> = {
  'en': enFields as LocaleFile,
  'pt-BR': ptFields as LocaleFile,
}

/** Claim types the filler understands, in tie-break priority order. */
const CLAIM_TYPE_ORDER = [
  'schema:givenName', 'schema:familyName', 'schema:name', 'schema:email', 'schema:telephone',
  'schema:birthDate', 'schema:streetAddress', 'schema:addressLocality', 'schema:addressRegion',
  'schema:postalCode', 'schema:addressCountry', 'schema:jobTitle', 'schema:worksFor', 'schema:taxID',
]

function uniq<T>(xs: T[]): T[] { return [...new Set(xs)] }

export const FILL_RULES: FillRule[] = CLAIM_TYPE_ORDER.map(claimType => {
  const parts = Object.values(FIELD_LOCALES).map(l => l[claimType]).filter(Boolean)
  return {
    claimType,
    selectors: uniq(parts.flatMap(p => p.selectors)),
    autocompleteTokens: uniq(parts.flatMap(p => p.autocomplete)),
  }
})

// ── Locale-aware field classification ─────────────────────────────────────────

/** Attributes of a form control that can identify its meaning. */
export interface FieldHints {
  name?: string | null
  id?: string | null
  label?: string | null
  placeholder?: string | null
  autocomplete?: string | null
  type?: string | null
}

/** Lowercase, strip diacritics, split camelCase and punctuation into word tokens. */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return []
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function containsSequence(tokens: string[], seq: string[]): boolean {
  if (seq.length === 0 || seq.length > tokens.length) return false
  for (let i = 0; i + seq.length <= tokens.length; i++) {
    if (seq.every((w, j) => tokens[i + j] === w)) return true
  }
  return false
}

/** Input types that never take a personal-data value (a password or checkbox must not be auto-filled). */
export const NON_FILLABLE_TYPES = new Set([
  'password', 'checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image', 'hidden', 'range', 'color',
])

/** Words that turn a generic label ("Nome da mãe", "Company name") into a different field. */
const QUALIFIER_TOKENS = new Set([
  'mae', 'pai', 'empresa', 'usuario', 'user', 'username', 'login', 'cartao', 'card', 'company',
  'mother', 'father', 'civil', 'nascimento', 'birth', 'birthplace', 'conjuge', 'spouse', 'password', 'senha',
])
/** "Country code", "Phone type", "Extension" are sibling fields: never fill them with the full country / number. */
const SUB_FIELD_TOKENS = new Set([
  'code', 'codigo', 'type', 'tipo', 'extension', 'ramal', 'prefix', 'prefixo', 'dial',
])
const SUB_FIELD_TYPES = new Set(['schema:telephone', 'schema:addressCountry'])
const PLACE_TOKENS = new Set(['cidade', 'city', 'estado', 'state', 'municipio', 'pais', 'country'])
const QUALIFIABLE_TYPES = new Set([
  'schema:givenName', 'schema:familyName', 'schema:name', 'schema:addressLocality', 'schema:addressRegion',
])

const KEYWORD_INDEX = CLAIM_TYPE_ORDER.map(claimType => ({
  claimType,
  keywords: uniq(Object.values(FIELD_LOCALES).flatMap(l => l[claimType]?.keywords ?? [])).map(tokenize),
}))

/**
 * Decide which claim type a form control wants, in any supported locale.
 * Order: exact autocomplete token → input type → most specific keyword (longest phrase) found in
 * name / id / label / placeholder; ties go to the earlier entry in CLAIM_TYPE_ORDER.
 * Returns null when nothing matches.
 */
export function classifyField(h: FieldHints): string | null {
  if (h.type && NON_FILLABLE_TYPES.has(h.type)) return null
  if (h.autocomplete) {
    const toks = h.autocomplete.split(' ')
    for (const rule of FILL_RULES) {
      if (rule.autocompleteTokens.some(t => toks.includes(t))) return rule.claimType
    }
  }
  if (h.type === 'email') return 'schema:email'
  if (h.type === 'tel') return 'schema:telephone'

  const sources = [h.name, h.id, h.label, h.placeholder].map(tokenize).filter(t => t.length > 0)
  const vetoed = sources.some(tokens => tokens.some(t => QUALIFIER_TOKENS.has(t)))
  // "Cidade de nascimento" asks for a place of birth, not a date.
  const subField = sources.some(tokens => tokens.some(t => SUB_FIELD_TOKENS.has(t)))
  const birthPlace = sources.some(tokens => tokens.some(t => PLACE_TOKENS.has(t)))
  let best: { claimType: string; score: number } | null = null
  let ambiguous = false
  for (const { claimType, keywords } of KEYWORD_INDEX) {
    if (vetoed && QUALIFIABLE_TYPES.has(claimType)) continue
    if (subField && SUB_FIELD_TYPES.has(claimType)) continue
    if (birthPlace && claimType === 'schema:birthDate') continue
    for (const kw of keywords) {
      if (!sources.some(tokens => containsSequence(tokens, kw))) continue
      if (!best || kw.length > best.score) { best = { claimType, score: kw.length }; ambiguous = false }
      else if (kw.length === best.score && claimType !== best.claimType) ambiguous = true
    }
  }
  return best && !ambiguous ? best.claimType : null
}

// ── FillMap ───────────────────────────────────────────────────────────────────

/**
 * A FillMap is the output of buildFillMap(). It maps each applicable
 * FillRule (by claimType) to its resolved string value.
 *
 * The browser extension content script receives this map and uses the
 * selectors from FILL_RULES to locate fields and inject the values.
 */
export interface FillEntry {
  claimType: string
  value: string
  selectors: string[]
  autocompleteTokens: string[]
  /** Provenance badge passed through to the UI hint */
  badge: 'self-attested' | 'verified' | 'imported'
}

export type FillMap = FillEntry[]

/**
 * Build a FillMap from a set of approved Claim objects.
 *
 * Only claims that have a corresponding FillRule are included.
 * The Claim.value is serialised to a string appropriate for filling into an
 * input element (dates as YYYY-MM-DD, everything else as String()).
 */
export function buildFillMap(claims: Claim[]): FillMap {
  const result: FillMap = []

  for (const rule of FILL_RULES) {
    const claim = claims.find(c => c.type === rule.claimType)
    if (!claim) continue

    const value = claimValueToString(rule.claimType, claim.value)
    if (value === null) continue

    result.push({
      claimType: rule.claimType,
      value,
      selectors: rule.selectors,
      autocompleteTokens: rule.autocompleteTokens,
      badge: sourceToBadge(claim.source, claim.verification),
    })
  }

  return result
}

// ── SiteApproval ──────────────────────────────────────────────────────────────

/**
 * Records that the user approved a specific origin to receive a specific set of
 * claim types. Stored in extension local storage (not the vault) because it is
 * browser-specific and not sensitive — it contains no claim values.
 */
export interface SiteApproval {
  id: string
  origin: string          // e.g. "https://example.com"
  claimTypes: string[]    // the claim types the user approved for this site
  grantId: string         // the Grant in the vault that backs this approval
  createdAt: string
  expiresAt: string | null
  /** Explicitly revoked by the user via the popup. A revoked approval is kept as a tombstone
   *  so the background can send APPROVAL_REVOKED instead of re-prompting. */
  revoked?: boolean
}

/**
 * Build a SiteApproval record. The caller is responsible for persisting it
 * (extension storage) and recording the corresponding Grant in the vault.
 */
export function buildSiteApproval(options: {
  id: string
  origin: string
  claimTypes: string[]
  grantId: string
  expiresAt: Date | null
}): SiteApproval {
  return {
    id: options.id,
    origin: options.origin,
    claimTypes: options.claimTypes,
    grantId: options.grantId,
    createdAt: new Date().toISOString(),
    expiresAt: options.expiresAt?.toISOString() ?? null,
  }
}

/**
 * Check whether a SiteApproval is still valid (not expired and not revoked).
 */
export function isSiteApprovalValid(approval: SiteApproval): boolean {
  if (approval.revoked) return false
  if (!approval.expiresAt) return true
  return new Date(approval.expiresAt) > new Date()
}

/**
 * Given a FillMap and the set of claim types this site was approved for,
 * return only the entries the site is permitted to receive.
 */
export function filterFillMapForSite(fillMap: FillMap, approvedClaimTypes: string[]): FillMap {
  const approved = new Set(approvedClaimTypes)
  return fillMap.filter(entry => approved.has(entry.claimType))
}

// ── Credential management ─────────────────────────────────────────────────────

export const CREDENTIAL_CLAIM_TYPE = 'credential:login'

export interface CredentialValue {
  origin: string
  username: string
  password: string
}

/** Safe credential descriptor returned to the content script — password intentionally absent. */
export interface CredentialEntry {
  claimId: string
  origin: string
  username: string
}

/** Return all credential:login claims matching the exact origin. */
export function findCredentialsForOrigin(claims: Claim[], origin: string): CredentialEntry[] {
  return claims
    .filter(c => c.type === CREDENTIAL_CLAIM_TYPE)
    .map(c => {
      const v = c.value as CredentialValue
      return { claimId: c.id, origin: v.origin, username: v.username }
    })
    .filter(e => e.origin === origin)
}

/** Find one credential by claim ID and return the full value including password.
 *  Only called after the user has clicked Fill. */
export function getCredentialById(claims: Claim[], claimId: string): CredentialValue | null {
  const claim = claims.find(c => c.id === claimId && c.type === CREDENTIAL_CLAIM_TYPE)
  if (!claim) return null
  return claim.value as CredentialValue
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function claimValueToString(claimType: string, value: unknown): string | null {
  if (value === null || value === undefined) return null

  // Date-like claims: normalise to YYYY-MM-DD for date inputs (must precede the generic string guard)
  if (claimType === 'schema:birthDate' && typeof value === 'string') {
    const d = new Date(value)
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  }

  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)

  if (typeof value === 'object') {
    // Structured address object — for addressLocality, addressRegion, etc.
    const obj = value as Record<string, unknown>
    const key = claimType.replace('schema:', '')
    if (key in obj) return String(obj[key])
    // Last-resort: JSON stringify (shows in field, user can correct)
    return JSON.stringify(value)
  }

  return String(value)
}

function sourceToBadge(
  source: Claim['source'],
  verification: Claim['verification'],
): 'self-attested' | 'verified' | 'imported' {
  if (source === 'issuer-signed' && verification === 'verified') return 'verified'
  if (source === 'issuer-signed') return 'imported'
  if (source === 'imported') return 'imported'
  return 'self-attested'
}
