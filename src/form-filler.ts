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

export const FILL_RULES: FillRule[] = [
  {
    claimType: 'schema:givenName',
    selectors: [
      'input[autocomplete="given-name"]',
      'input[name="firstname"]', 'input[name="first_name"]', 'input[name="first-name"]',
      'input[name*="first"][type="text"]',
    ],
    autocompleteTokens: ['given-name'],
  },
  {
    claimType: 'schema:familyName',
    selectors: [
      'input[autocomplete="family-name"]',
      'input[name="lastname"]', 'input[name="last_name"]', 'input[name="last-name"]',
      'input[name*="last"][type="text"]',
    ],
    autocompleteTokens: ['family-name'],
  },
  {
    claimType: 'schema:name',
    selectors: [
      'input[autocomplete="name"]',
      'input[name="fullname"]', 'input[name="full_name"]', 'input[name="name"]',
    ],
    autocompleteTokens: ['name'],
  },
  {
    claimType: 'schema:email',
    selectors: [
      'input[type="email"]',
      'input[autocomplete="email"]',
      'input[name="email"]', 'input[name*="email"]',
    ],
    autocompleteTokens: ['email'],
  },
  {
    claimType: 'schema:telephone',
    selectors: [
      'input[type="tel"]',
      'input[autocomplete="tel"]',
      'input[name="phone"]', 'input[name*="phone"]', 'input[name*="tel"]',
    ],
    autocompleteTokens: ['tel', 'tel-national'],
  },
  {
    claimType: 'schema:birthDate',
    selectors: [
      'input[autocomplete="bday"]',
      'input[name="dob"]', 'input[name="birthdate"]', 'input[name="birth_date"]',
      'input[name*="birth"][type="date"]',
    ],
    autocompleteTokens: ['bday'],
  },
  {
    claimType: 'schema:streetAddress',
    selectors: [
      'input[autocomplete="street-address"]',
      'input[autocomplete="address-line1"]',
      'input[name="address"]', 'input[name="address1"]', 'input[name*="street"]',
    ],
    autocompleteTokens: ['street-address', 'address-line1'],
  },
  {
    claimType: 'schema:addressLocality',
    selectors: [
      'input[autocomplete="address-level2"]',
      'input[name="city"]', 'input[name*="city"]', 'input[name*="locality"]',
    ],
    autocompleteTokens: ['address-level2'],
  },
  {
    claimType: 'schema:addressRegion',
    selectors: [
      'input[autocomplete="address-level1"]',
      'input[name="state"]', 'input[name*="state"]', 'input[name*="region"]',
      'select[name="state"]',
    ],
    autocompleteTokens: ['address-level1'],
  },
  {
    claimType: 'schema:postalCode',
    selectors: [
      'input[autocomplete="postal-code"]',
      'input[name="zip"]', 'input[name*="zip"]', 'input[name*="postal"]',
    ],
    autocompleteTokens: ['postal-code'],
  },
  {
    claimType: 'schema:addressCountry',
    selectors: [
      'input[autocomplete="country"]', 'input[autocomplete="country-name"]',
      'select[autocomplete="country"]', 'select[autocomplete="country-name"]',
      'input[name="country"]', 'select[name="country"]',
    ],
    autocompleteTokens: ['country', 'country-name'],
  },
  {
    claimType: 'schema:jobTitle',
    selectors: [
      'input[autocomplete="organization-title"]',
      'input[name="title"]', 'input[name="job_title"]', 'input[name*="occupation"]',
    ],
    autocompleteTokens: ['organization-title'],
  },
  {
    claimType: 'schema:worksFor',
    selectors: [
      'input[autocomplete="organization"]',
      'input[name="company"]', 'input[name="employer"]', 'input[name*="organization"]',
    ],
    autocompleteTokens: ['organization'],
  },
]

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
      badge: sourceToBadge(claim.source),
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

function sourceToBadge(source: Claim['source']): 'self-attested' | 'verified' | 'imported' {
  if (source === 'issuer-signed') return 'verified'
  if (source === 'imported') return 'imported'
  return 'self-attested'
}
