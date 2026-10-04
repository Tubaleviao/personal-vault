// Import of a vCard (.vcf, as in Google Takeout Contacts / Apple Contacts "my card") into claim data.
// Pure functions: no fs, no vault access. Only the first card is read; mixing cards would combine different people.
import type { ImportedAutofillClaim } from './import'

function unescapeValue(v: string): string {
  return v.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

/** Split on unescaped `;`, keeping escapes for later unescaping. */
function splitStructured(v: string): string[] {
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\' && i + 1 < v.length) { cur += v[i] + v[i + 1]; i++ }
    else if (v[i] === ';') { parts.push(cur); cur = '' }
    else cur += v[i]
  }
  parts.push(cur)
  return parts.map(p => unescapeValue(p).trim())
}

function normaliseBirthDate(v: string): string | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T.*)?$/.exec(v.trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * Parse the first vCard (2.1 / 3.0 / 4.0) in `text`. Maps N, FN, EMAIL, TEL, BDAY,
 * ADR, TITLE and ORG to claims; first value per claim type wins. Throws if no card found.
 */
export function parseVCard(text: string): ImportedAutofillClaim[] {
  const body = text.replace(/^﻿/, '')
  // Unfold continuation lines (CRLF/LF followed by space or tab).
  const lines = body.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  const begin = lines.findIndex(l => /^BEGIN:VCARD\s*$/i.test(l))
  if (begin < 0) throw new Error('Not a vCard file')

  const seen = new Map<string, ImportedAutofillClaim>()
  const add = (type: string, raw: string | undefined) => {
    const value = (raw ?? '').trim()
    if (!value || seen.has(type)) return
    seen.set(type, { type, value, source: 'imported', verification: 'none', expiresAt: null, issuerDid: null })
  }

  for (const line of lines.slice(begin + 1)) {
    if (/^END:VCARD\s*$/i.test(line)) break
    const colon = line.indexOf(':')
    if (colon < 0) continue
    // Strip group prefix ("item1.EMAIL") and parameters ("EMAIL;TYPE=work").
    const name = line.slice(0, colon).split(';')[0].replace(/^[^.]*\./, '').toUpperCase()
    const value = line.slice(colon + 1)
    switch (name) {
      case 'N': {
        const [family, given] = splitStructured(value)
        add('schema:familyName', family)
        add('schema:givenName', given)
        break
      }
      case 'FN': add('schema:name', unescapeValue(value)); break
      case 'EMAIL': add('schema:email', unescapeValue(value)); break
      case 'TEL': add('schema:telephone', unescapeValue(value).replace(/^tel:/i, '')); break
      case 'BDAY': add('schema:birthDate', normaliseBirthDate(value) ?? undefined); break
      case 'TITLE': add('schema:jobTitle', unescapeValue(value)); break
      case 'ORG': add('schema:worksFor', splitStructured(value)[0]); break
      case 'ADR': {
        // pobox;ext;street;locality;region;postcode;country
        const f = splitStructured(value)
        add('schema:streetAddress', f[2])
        add('schema:addressLocality', f[3])
        add('schema:addressRegion', f[4])
        add('schema:postalCode', f[5])
        add('schema:addressCountry', f[6])
        break
      }
    }
  }
  return [...seen.values()]
}
