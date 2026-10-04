// Import of a vCard (.vcf, as in Google Takeout Contacts / Apple Contacts "my card") into claim data.
// Pure functions: no fs, no vault access. One card is read per call; mixing cards would combine different people.
import { makeImportedClaim, type ImportedAutofillClaim } from './import'

interface Prop { name: string; params: string[]; value: string; rank: number }

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

/** Index of the first `sep` outside double quotes, or -1. */
function indexOutsideQuotes(s: string, sep: string): number {
  let q = false
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') q = !q
    else if (s[i] === sep && !q) return i
  }
  return -1
}

function splitParams(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (const ch of s) {
    if (ch === '"') { q = !q; cur += ch }
    else if (ch === ';' && !q) { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

function decodeQuotedPrintable(v: string, charset: string): string {
  const bytes: number[] = []
  const enc = new TextEncoder()
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(v.slice(i + 1, i + 3))) {
      const b = parseInt(v.slice(i + 1, i + 3), 16)
      // An encoded structural char is data, not a separator: keep it escaped for later splitting.
      if (b === 0x3b || b === 0x2c || b === 0x5c) bytes.push(0x5c)
      bytes.push(b)
      i += 2
    } else {
      const cp = v.codePointAt(i)!
      bytes.push(...enc.encode(String.fromCodePoint(cp)))
      if (cp > 0xffff) i++
    }
  }
  const label = /^(iso-8859-1|latin1|windows-1252)$/i.test(charset) ? 'windows-1252' : 'utf-8'
  return new TextDecoder(label).decode(Uint8Array.from(bytes))
}

function normaliseBirthDate(v: string): string | null {
  const m = /^(\d{4})(-?)(\d{2})\2(\d{2})(?:T.*)?$/.exec(v.trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[3]), Number(m[4])]
  // 1604 is Apple's placeholder year for birthdays without a year.
  if (y === 1604 || mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null
  return `${m[1]}-${m[3]}-${m[4]}`
}

function prefRank(params: string[]): number {
  let rank = Infinity
  for (const p of params) {
    const [k, v = ''] = p.replace(/"/g, '').split('=')
    const key = k.trim().toUpperCase()
    if (key === 'PREF' && v) rank = Math.min(rank, Number(v) || 1)
    else if (key === 'PREF' || v.toUpperCase().split(',').includes('PREF')) rank = Math.min(rank, 1)
  }
  return rank
}

function splitCards(text: string): string[][] {
  const lines = text.replace(/^﻿/, '').replace(/\r\n|\r/g, '\n').split('\n')
  // Join quoted-printable soft line breaks (trailing "=") before general unfolding.
  const joined: string[] = []
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i]
    if (/^[^:]*;\s*ENCODING=QUOTED-PRINTABLE/i.test(l) || /^[^:]*;\s*QUOTED-PRINTABLE/i.test(l)) {
      while (l.endsWith('=') && i + 1 < lines.length) l = l.slice(0, -1) + lines[++i]
    }
    joined.push(l)
  }
  const unfolded = joined.join('\n').replace(/\n[ \t]/g, '').split('\n')
  const cards: string[][] = []
  let cur: string[] | null = null
  for (const l of unfolded) {
    if (/^BEGIN:VCARD\s*$/i.test(l)) { if (cur) cards.push(cur); cur = [] } // a new BEGIN closes an unterminated card
    else if (/^END:VCARD\s*$/i.test(l)) { if (cur) cards.push(cur); cur = null }
    else if (cur) cur.push(l)
  }
  if (cur) cards.push(cur) // missing END:VCARD
  return cards.filter(c => c.some(l => l.trim() !== ''))
}

/** Display name (FN, else N) of each card, in order, so a caller can offer a choice. */
export function listVCards(text: string): { index: number; name: string }[] {
  return splitCards(text).map((lines, index) => {
    const props = parseProps(lines)
    const fn = unescapeValue(pick(props, 'FN')?.value ?? '').trim()
    const n = pick(props, 'N', p => splitStructured(p.value).slice(0, 2).some(Boolean))
    const [family = '', given = ''] = n ? splitStructured(n.value) : []
    return { index, name: fn || `${given} ${family}`.trim() }
  })
}

/** Number of cards in `text`. A Google Takeout "All Contacts.vcf" holds the whole address book. */
export function countVCards(text: string): number {
  return splitCards(text).length
}

function parseProps(lines: string[]): Prop[] {
  const props: Prop[] = []
  for (const line of lines) {
    const colon = indexOutsideQuotes(line, ':')
    if (colon < 0) continue
    const [head, ...rest] = splitParams(line.slice(0, colon))
    const params = rest.map(p => p.trim())
    // Strip group prefix ("item1.EMAIL").
    const name = head.replace(/^[^.]*\./, '').toUpperCase()
    let value = line.slice(colon + 1)
    if (params.some(p => /^(ENCODING=)?QUOTED-PRINTABLE$/i.test(p))) {
      const cs = params.find(p => /^CHARSET=/i.test(p))?.slice(8) ?? 'utf-8'
      value = decodeQuotedPrintable(value, cs)
    }
    props.push({ name, params, value, rank: prefRank(params) })
  }
  return props
}

/** Preferred (lowest PREF rank, else first) property with a non-empty mapped value. */
function pick(props: Prop[], name: string, nonEmpty: (p: Prop) => boolean = p => p.value.trim() !== ''): Prop | undefined {
  let best: Prop | undefined
  for (const p of props) {
    if (p.name !== name || !nonEmpty(p)) continue
    if (!best || p.rank < best.rank) best = p
  }
  return best
}

/**
 * Parse one vCard (2.1 / 3.0 / 4.0) in `text`. Maps N, FN, EMAIL, TEL, BDAY, ADR, TITLE
 * and ORG to claims; the PREF-marked (else first) property wins, and N / ADR are taken
 * whole from a single property. Throws if no card is found, or if the file holds several
 * cards and `opts.card` (0-based) does not say which one is the owner's.
 */
export function parseVCard(text: string, opts: { card?: number } = {}): ImportedAutofillClaim[] {
  const cards = splitCards(text)
  if (cards.length === 0) throw new Error('Not a vCard file')
  if (opts.card === undefined && cards.length > 1) {
    throw new Error(`vCard file contains ${cards.length} cards; choose which one is yours`)
  }
  const lines = cards[opts.card ?? 0]
  if (!lines) throw new Error(`No vCard at index ${opts.card}`)
  const props = parseProps(lines)

  const seen = new Map<string, ImportedAutofillClaim>()
  const add = (type: string, raw: string | undefined) => {
    const value = (raw ?? '').trim()
    if (value && !seen.has(type)) seen.set(type, makeImportedClaim(type, value))
  }

  const n = pick(props, 'N', p => splitStructured(p.value).slice(0, 2).some(Boolean))
  if (n) {
    const [family, given] = splitStructured(n.value)
    add('schema:familyName', family)
    add('schema:givenName', given)
  }
  add('schema:name', unescapeValue(pick(props, 'FN')?.value ?? ''))
  add('schema:email', unescapeValue(pick(props, 'EMAIL')?.value ?? ''))
  // vCard 4.0 may use a tel: URI, possibly with ;ext= / ;phone-context= parameters.
  const telValue = (p: Prop) => (/^tel:/i.test(p.value.trim()) ? p.value.trim().slice(4).split(';')[0] : unescapeValue(p.value)).trim()
  const tel = pick(props, 'TEL', p => telValue(p) !== '')
  add('schema:telephone', tel ? telValue(tel) : undefined)
  const bday = pick(props, 'BDAY', p => normaliseBirthDate(p.value) !== null)
  add('schema:birthDate', bday ? normaliseBirthDate(bday.value) ?? undefined : undefined)
  add('schema:jobTitle', unescapeValue(pick(props, 'TITLE')?.value ?? ''))
  const org = pick(props, 'ORG', p => !!splitStructured(p.value)[0])
  add('schema:worksFor', org ? splitStructured(org.value)[0] : undefined)
  // pobox;ext;street;locality;region;postcode;country. Prefer an ADR with a street, then use it whole.
  const anyAdr = pick(props, 'ADR', p => splitStructured(p.value).some(Boolean))
  // An explicit PREF wins outright; otherwise prefer an ADR with a street.
  const adr = anyAdr && anyAdr.rank < Infinity ? anyAdr : pick(props, 'ADR', p => !!splitStructured(p.value)[2]) ?? anyAdr
  if (adr) {
    const f = splitStructured(adr.value)
    add('schema:streetAddress', f[2])
    add('schema:addressLocality', f[3])
    add('schema:addressRegion', f[4])
    add('schema:postalCode', f[5])
    add('schema:addressCountry', f[6])
  }
  return [...seen.values()]
}
