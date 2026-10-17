/**
 * i18n lint — fails when user-facing strings are hard-coded in the extension or desktop UI.
 *
 *   npm run i18n:lint
 *
 * Heuristic, not a parser. It flags:
 *   - TS/TSX: `.textContent|innerText|placeholder|title|alt = <literal with words>` (after removing
 *     `t(...)` / `tr.t(...)` calls and `${...}` expressions), `setAttribute('title'|'placeholder'|
 *     'aria-label', literal)`, `alert()/confirm()/prompt()` with literals;
 *   - TSX: JSX text nodes and `placeholder|title|aria-label|alt|label="..."` attributes with words;
 *   - HTML: text nodes / placeholder / title / aria-label without the matching `data-i18n*` attribute.
 * Escape hatch: append `// i18n-allow` (or `<!-- i18n-allow -->`) to a line for non-text values.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep, extname } from 'path'

export interface Finding { file: string; line: number; text: string }

/** A literal counts as "text" when it holds a word of 3+ letters (so '✕', '#fff', 'px', ids pass). */
const HAS_WORDS = /\p{L}{3,}/u
const ALLOW = /i18n-allow/

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length
}

/** Remove translator calls and template expressions so only literal prose remains. */
function stripDynamic(expr: string): string {
  let out = expr
  for (let i = 0; i < 4; i++) out = out.replace(/\b(?:tr\.t|t|err|errorMessage|claimLabel|msg)\s*\((?:[^()]|\([^()]*\))*\)/g, '')
  // Comparisons and option objects hold identifiers, not prose.
  out = out.replace(/[!=]==?\s*(?:'[^']*'|"[^"]*")/g, '').replace(/\{\s*\w+:\s*(?:'[^']*'|"[^"]*")\s*\}/g, '')
  return out.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '')
}

function literalsIn(expr: string): string[] {
  return [...stripDynamic(expr).matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\])*)`/g)]
    .map(m => m[1] ?? m[2] ?? m[3] ?? '')
}

function addIf(findings: Finding[], file: string, src: string, index: number, literals: string[]) {
  const line = lineOf(src, index)
  if (ALLOW.test(src.split('\n')[line - 1] ?? '')) return
  const bad = literals.find(l => HAS_WORDS.test(l))
  if (bad !== undefined) findings.push({ file, line, text: bad.trim().slice(0, 60) })
}

export function checkScript(file: string, src: string): Finding[] {
  const findings: Finding[] = []
  // Skip comment-only lines by blanking them (keeps offsets stable).
  const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, m => ' '.repeat(m.length))

  for (const m of code.matchAll(/\.(?:textContent|innerText|innerHTML|outerHTML|placeholder|title|alt)\s*\+?=\s*([^\n;]*)/g)) {
    addIf(findings, file, src, m.index!, literalsIn(m[1]))
  }
  for (const m of code.matchAll(/setAttribute\(\s*['"](?:title|placeholder|aria-label|alt)['"]\s*,\s*([^\n]*)\)/g)) {
    addIf(findings, file, src, m.index!, literalsIn(m[1]))
  }
  for (const m of code.matchAll(/\b(?:alert|confirm|prompt)\(\s*([^\n]*)\)/g)) {
    addIf(findings, file, src, m.index!, literalsIn(m[1]))
  }
  if (file.endsWith('.tsx')) findings.push(...checkJsx(file, src, code))
  return findings
}

function checkJsx(file: string, src: string, code: string): Finding[] {
  const findings: Finding[] = []
  // Attributes with literal prose.
  for (const m of code.matchAll(/\b(?:placeholder|title|aria-label|alt|label)=("[^"]*"|'[^']*')/g)) {
    addIf(findings, file, src, m.index!, [m[1].slice(1, -1)])
  }
  // JSX text: between `>` and `<`, not containing braces; ignore arrows (=>), generics, comparisons.
  for (const m of code.matchAll(/(?<![=\-<])>([^<>{}=;()\n][^<>{}]*)</g)) {
    const text = m[1].replace(/&\w+;/g, ' ')
    if (/^\s*$/.test(text) || /[;=]/.test(text)) continue
    addIf(findings, file, src, m.index!, [text])
  }
  // Multi-line JSX text nodes.
  for (const m of code.matchAll(/>\s*\n\s*([^<>{}\n=;][^<>{}=;]*)\n\s*</g)) {
    addIf(findings, file, src, m.index!, [m[1]])
  }
  return findings
}

export function checkHtml(file: string, src: string): Finding[] {
  const findings: Finding[] = []
  const body = src.replace(/<(script|style)[\s\S]*?<\/\1>/g, m => ' '.repeat(m.length))
  for (const m of body.matchAll(/<(\w+)([^>]*)>([^<]+)<\/\1>/g)) {
    const [, , attrs, text] = m
    if (/data-i18n=/.test(attrs)) continue
    addIf(findings, file, src, m.index!, [text])
  }
  for (const attr of ['placeholder', 'title', 'aria-label', 'alt']) {
    for (const m of body.matchAll(new RegExp(`<(\\w+)([^>]*?)\\s${attr}="([^"]*)"([^>]*)>`, 'g'))) {
      if (new RegExp(`data-i18n-${attr}=`).test(m[0])) continue
      addIf(findings, file, src, m.index!, [m[3]])
    }
  }
  return findings
}

export function checkFile(file: string, src: string): Finding[] {
  return extname(file) === '.html' ? checkHtml(file, src) : checkScript(file, src)
}

/** UI sources subject to the rule. */
export const UI_ROOTS = ['extension/popup', 'extension/content.ts', 'desktop/src']
const UI_EXT = new Set(['.ts', '.tsx', '.html'])

function walk(p: string, out: string[]) {
  if (statSync(p).isDirectory()) {
    for (const n of readdirSync(p)) if (n !== 'node_modules' && n !== 'dist') walk(join(p, n), out)
  } else if (UI_EXT.has(extname(p)) && !p.endsWith('.d.ts')) out.push(p)
}

export function lintRepo(root: string): Finding[] {
  const files: string[] = []
  for (const r of UI_ROOTS) walk(join(root, r), files)
  const findings: Finding[] = []
  for (const f of files) {
    const rel = relative(root, f).split(sep).join('/')
    findings.push(...checkFile(rel, readFileSync(f, 'utf8')))
  }
  return findings
}

if (require.main === module) {
  const findings = lintRepo(process.cwd())
  for (const f of findings) console.error(`${f.file}:${f.line}: hard-coded UI string "${f.text}" — move it to src/i18n/locales`)
  if (findings.length) {
    console.error(`\n${findings.length} hard-coded string(s). Use t('key') or mark non-text with // i18n-allow.`)
    process.exit(1)
  }
  console.log('i18n lint: ok')
}
