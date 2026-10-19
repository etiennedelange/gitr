/**
 * Syntax colours for the preview's diffs. The app colours with real grammars in Rust; this is a
 * rough stand-in for the preview's C# and XML samples, one line at a time.
 */
import type { DiffLine, DiffSyntax, FileDiff, Span, Token } from '../types'

const CS_KEYWORDS = new Set(
  (
    'abstract as async await base bool break case catch class const continue decimal default do double else enum ' +
    'false finally for foreach if in int interface internal is long namespace new null out override private ' +
    'protected public readonly record return sealed static string struct switch this throw true try using var ' +
    'virtual void while'
  ).split(' '),
)

// Comments, strings, numbers, then words (a word before `(` is a call).
const CS_RULE = /(\/\/.*$)|(\$?"(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)(?=\s*(\()?)/g
// Tags and attribute names.
const XML_RULE = /(<\/?)([\w.:-]+)|([\w.:-]+)(?==")|("[^"]*")/g

function csLine(text: string): Span[] {
  const out: Span[] = []
  for (const m of text.matchAll(CS_RULE)) {
    const at = m.index
    const end = at + m[0].length
    let token: Token | null = null
    if (m[1]) token = 'comment'
    else if (m[2]) token = 'string'
    else if (m[3]) token = 'number'
    else if (CS_KEYWORDS.has(m[4])) token = 'keyword'
    else if (m[5]) token = 'function'
    else if (/^[A-Z]/.test(m[4]) && text[at - 1] !== '.') token = 'type'
    if (token) out.push([at, end, token])
  }
  return out
}

function xmlLine(text: string): Span[] {
  const out: Span[] = []
  for (const m of text.matchAll(XML_RULE)) {
    if (m[2]) out.push([m.index + m[1].length, m.index + m[0].length, 'tag'])
    else if (m[3]) out.push([m.index, m.index + m[0].length, 'attribute'])
    else out.push([m.index, m.index + m[0].length, 'string'])
  }
  return out
}

export function syntaxOf(file: string, diff: FileDiff): DiffSyntax {
  const colour = file.endsWith('.cs') ? csLine : /\.(props|xml|csproj)$/.test(file) ? xmlLine : null
  const syntax: DiffSyntax = { old: {}, new: {} }
  if (!colour) return syntax
  const lines: DiffLine[] = diff.hunks.flatMap((h) => h.lines)
  for (const l of lines) {
    if (l.kind === 'remove' && l.oldNo != null) syntax.old[l.oldNo] = colour(l.text)
    else if ((l.kind === 'add' || l.kind === 'context') && l.newNo != null) syntax.new[l.newNo] = colour(l.text)
  }
  return syntax
}
