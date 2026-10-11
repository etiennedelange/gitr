// Commit history for the design preview. None of this is real data: subjects, people and
// files are synthetic, generated from a seed so every load looks the same.
import type {
  CommitDetails,
  CommitFile,
  DiffLine,
  FileDiff,
  IntegrateOutcome,
  LogEntry,
  LogPage,
  RefLabel,
  ResetPreview,
  RepoSummary,
} from '../types'

const AUTHORS = [
  ['Etienne de Lange', 'etienne@example.com'],
  ['Thandi Mokoena', 'thandi@example.com'],
  ['Pieter Botha', 'pieter@example.com'],
  ['Ayesha Patel', 'ayesha@example.com'],
  ['Lucas Meyer', 'lucas@example.com'],
] as const

const SUBJECTS = [
  'Add CSV writer for invoice export',
  'Round VAT per line instead of per invoice',
  'Retry token refresh once on 401',
  'Move export formats behind IInvoiceWriter',
  'Log the period when no invoices are found',
  'Fix off-by-one in the monthly statement range',
  'Bump Azure.Identity to 1.13.2',
  'Rename FormatList to Formats',
  'Cache tenant settings for five minutes',
  'Use invariant culture when parsing amounts',
  'Remove the unused PdfSharp spike',
  'Show a clear error when the export folder is missing',
  'Split InvoiceService into query and command parts',
  'Add integration test for credit notes',
  'Handle empty customer reference in the CSV header',
  'Document the export settings in the README',
  'Fix flaky clock-dependent test',
  'Allow PDF export behind a feature flag',
  'Tidy up nullable warnings in Billing.Core',
]

const PATHS = [
  'src/Export/InvoiceExporter.cs',
  'src/Export/CsvWriter.cs',
  'src/Export/PdfWriter.cs',
  'src/Export/ExportFormat.cs',
  'src/Billing.Core/InvoiceService.cs',
  'src/Billing.Core/VatCalculator.cs',
  'src/Auth/TokenStore.cs',
  'tests/Export/InvoiceExporterTests.cs',
  'tests/Billing.Core/VatCalculatorTests.cs',
  'README.md',
  'Directory.Packages.props',
  'docs/export.md',
]

const MERGED = ['fix/rounding-vat', 'feature/credit-notes', 'chore/deps', 'fix/statement-range', 'feature/pdf-export']

const LONG_MESSAGE = `Stream large exports instead of buffering them

Exports for the big tenants built the whole file in memory before writing it,
which pushed the worker past its 2 GB limit at month end.

- CsvWriter now writes rows to the destination stream as they are read.
- The PDF writer still buffers (PdfSharp needs the full document), so it keeps
  the old 50 000 invoice cap and says so in the error.
- ExportResult reports the row count instead of the byte size.

Refs: AB#4127`

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32
    return seed / 2 ** 32
  }
}

const hex = (r: () => number) => Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('')

interface Commit extends LogEntry {
  message: string
  committer: readonly [string, string] | null
  committerTime: number
  files: CommitFile[]
}

interface RepoHistory {
  commits: Commit[]
  /** The last reset, for undo: the commits it took off and the files it put in the working tree. */
  undo: { previousHead: string; removed: Commit[] } | null
}

const histories: Record<string, RepoHistory> = {}

function files(r: () => number, n: number, root: boolean): CommitFile[] {
  const picked = [...PATHS].sort(() => r() - 0.5).slice(0, n)
  return picked.map((path) => {
    const roll = r()
    // Only C# files get renamed (to *Legacy.cs).
    const status = root ? 'A' : roll < 0.62 ? 'M' : roll < 0.8 ? 'A' : roll < 0.9 || !path.endsWith('.cs') ? 'D' : 'R'
    const added = status === 'D' ? 0 : Math.floor(r() * 60) + 1
    const removed = status === 'A' ? 0 : Math.floor(r() * 30)
    return {
      path: status === 'R' ? path.replace(/(\w+)\.cs$/, '$1Legacy.cs') : path,
      origPath: status === 'R' ? path : null,
      status,
      added,
      removed,
      binary: false,
    }
  })
}

function build(summary: RepoSummary, seed: number): Commit[] {
  const r = rng(seed)
  // One repo pages (more than 200 commits); the others are short.
  const total = summary.path.endsWith('billing-service') ? 260 : 40 + Math.floor(r() * 30)
  const branch = summary.branch ?? 'main'
  const unpushed = summary.upstream ? summary.ahead : 4
  let t = Date.now() / 1000 - 25 * 60
  const commits: Commit[] = []
  for (let i = 0; i < total; i++) {
    const root = i === total - 1
    const merge = !root && i > unpushed && i % 9 === 4
    const [name, email] = AUTHORS[Math.floor(r() * AUTHORS.length)]
    const subject = merge
      ? `Merge branch '${MERGED[Math.floor(i / 9) % MERGED.length]}' into ${i < 30 ? branch : 'main'}`
      : root
        ? 'Initial commit'
        : SUBJECTS[(i * 7 + seed) % SUBJECTS.length]
    const fs = files(r, root ? 6 : merge ? 5 : 1 + Math.floor(r() * 5), root)
    if (i === 3) fs.push({ path: 'docs/images/export-dialog.png', origPath: null, status: 'A', added: 0, removed: 0, binary: true })
    const message =
      i === 2 ? LONG_MESSAGE : subject.startsWith('Fix') ? `${subject}\n\nThe test passed only before 23:00 UTC.\n` : `${subject}\n`
    commits.push({
      sha: hex(r),
      parents: [],
      authorName: name,
      authorEmail: email,
      authorTime: Math.round(t),
      subject: i === 2 ? LONG_MESSAGE.split('\n')[0] : subject,
      refs: [],
      unpushed: i < unpushed,
      message,
      // Rebased commits: someone else committed them.
      committer: i % 11 === 6 ? AUTHORS[(i + 1) % AUTHORS.length] : null,
      committerTime: Math.round(t + (i % 11 === 6 ? 3600 * 20 : 0)),
      files: fs,
    })
    t -= 20 * 60 + r() * (i < 12 ? 6 : 40) * 3600
  }
  for (let i = 0; i < commits.length - 1; i++) {
    commits[i].parents = [commits[i + 1].sha]
    if (commits[i].subject.startsWith('Merge')) commits[i].parents.push(hex(r))
  }
  placeRefs(commits, summary)
  return commits
}

/** Branch, remote and tag labels as `git log --decorate` would show them. */
function placeRefs(commits: Commit[], summary: RepoSummary) {
  for (const c of commits) c.refs = c.refs.filter((x) => x.kind === 'tag')
  if (!commits.length) return
  const branch = summary.branch ?? 'main'
  const add = (i: number, ref: RefLabel) => commits[i] && commits[i].refs.push(ref)
  add(0, summary.detached ? { kind: 'head', name: 'HEAD' } : { kind: 'head', name: branch })
  const firstPushed = commits.findIndex((c) => !c.unpushed)
  if (summary.upstream && firstPushed >= 0) add(firstPushed, { kind: 'remote', name: summary.upstream })
  if (branch !== 'main') {
    const i = Math.min(commits.length - 1, Math.max(firstPushed, 0) + 7)
    add(i, { kind: 'local', name: 'main' })
    add(i, { kind: 'remote', name: 'origin/main' })
  }
}

function tag(commits: Commit[]) {
  const at = (i: number, name: string) => commits[i]?.refs.push({ kind: 'tag', name })
  at(14, 'v2.4.0')
  at(33, 'v2.3.1')
  at(58, 'v2.3.0')
}

export function historyOf(summary: RepoSummary): RepoHistory {
  const path = summary.path
  if (!histories[path]) {
    // A brand-new repository: nothing committed yet.
    const unborn = path.endsWith('/notifications')
    let seed = 7
    for (let i = 0; i < path.length; i++) seed = (seed * 31 + path.charCodeAt(i)) >>> 0
    const commits = unborn ? [] : build(summary, seed)
    if (!unborn) tag(commits)
    histories[path] = { commits, undo: null }
  }
  return histories[path]
}

export const headOf = (summary: RepoSummary) => historyOf(summary).commits[0]?.sha ?? null

const strip = (c: Commit): LogEntry => ({
  sha: c.sha,
  parents: c.parents,
  authorName: c.authorName,
  authorEmail: c.authorEmail,
  authorTime: c.authorTime,
  subject: c.subject,
  refs: c.refs,
  unpushed: c.unpushed,
})

export function log(summary: RepoSummary, skip: number, limit: number): LogPage {
  const all = historyOf(summary).commits
  return { commits: all.slice(skip, skip + limit).map(strip), hasMore: all.length > skip + limit }
}

const find = (summary: RepoSummary, sha: string) => {
  const c = historyOf(summary).commits.find((x) => x.sha === sha)
  if (!c) throw new Error(`Unknown commit ${sha.slice(0, 7)}`)
  return c
}

export function details(summary: RepoSummary, sha: string): CommitDetails {
  const c = find(summary, sha)
  return {
    sha: c.sha,
    parents: c.parents,
    authorName: c.authorName,
    authorEmail: c.authorEmail,
    authorTime: c.authorTime,
    committerName: c.committer?.[0] ?? c.authorName,
    committerEmail: c.committer?.[1] ?? c.authorEmail,
    committerTime: c.committerTime,
    message: c.message,
    files: c.files.map((f) => (f.binary ? f : { ...f, ...counts(fileDiff(summary, sha, f.path, SAMPLE)) })),
    truncated: false,
  }
}

/** A plausible diff for a commit's file: the sample diff for edits, whole-file hunks for adds and deletes. */
/** The C# sample the preview serves for edited .cs files (set by preview.ts). */
let SAMPLE: FileDiff = { binary: false, truncated: false, hunks: [] }
export const setSample = (d: FileDiff) => void (SAMPLE = d)

export function fileDiff(summary: RepoSummary, sha: string, file: string, sample: FileDiff): FileDiff {
  const f = find(summary, sha).files.find((x) => x.path === file)
  if (!f) return { binary: false, truncated: false, hunks: [] }
  if (f.binary) return { binary: true, truncated: false, hunks: [] }
  // The C# sample only fits C# files; anything else gets lines in its own language.
  if ((f.status === 'M' || f.status === 'R') && file.endsWith('.cs')) return sample
  if (f.status === 'M' || f.status === 'R') return editOf(file)
  const add = f.status === 'A'
  // The whole file, once: an added or deleted file shows its own content.
  const src = linesFor(file)
  const n = src.length
  const lines: DiffLine[] = src.map((text, i) => ({
    kind: add ? 'add' : 'remove',
    oldNo: add ? null : i + 1,
    newNo: add ? i + 1 : null,
    text,
  }))
  return {
    binary: false,
    truncated: false,
    hunks: [{ header: add ? `@@ -0,0 +1,${n} @@` : `@@ -1,${n} +0,0 @@`, oldStart: add ? 0 : 1, newStart: add ? 1 : 0, lines }],
  }
}

const CS = [
  'namespace Acme.Billing.Export;',
  '',
  'public sealed class PdfWriter : IInvoiceWriter',
  '{',
  '    public ExportFormat Format => ExportFormat.Pdf;',
  '',
  '    public async Task<ExportResult> WriteAsync(IReadOnlyList<Invoice> invoices, Stream destination, CancellationToken ct)',
  '    {',
  '        using var document = new InvoiceDocument(invoices);',
  '        await document.SaveAsync(destination, ct);',
  '        return new ExportResult(invoices.Count);',
  '    }',
  '}',
]
const MD = [
  '# Invoice export',
  '',
  'Exports invoices for a period as CSV or PDF.',
  '',
  '## Settings',
  '',
  '| Setting | Default |',
  '|---|---|',
  '| `Export:Folder` | `D:/Exports` |',
  '| `Export:MaxRows` | `50000` |',
]
const XML = [
  '<Project>',
  '  <ItemGroup>',
  '    <PackageVersion Include="Azure.Identity" Version="1.13.2" />',
  '    <PackageVersion Include="CsvHelper" Version="33.0.1" />',
  '  </ItemGroup>',
  '</Project>',
]
const linesFor = (file: string) => (file.endsWith('.md') ? MD : file.endsWith('.props') ? XML : CS)

const changed = (text: string) => {
  const bumped = text.replace(/\d+(\.\d+)*/, (v) => v + '1')
  return bumped !== text ? bumped : `${text} (streamed)`
}

/** A small edit in the file's own language. */
function editOf(file: string): FileDiff {
  const src = linesFor(file).slice(0, 8)
  const lines: DiffLine[] = []
  let o = 1
  let n = 1
  src.forEach((text, i) => {
    if (i === 4) {
      lines.push({ kind: 'remove', oldNo: o++, newNo: null, text })
      lines.push({ kind: 'add', oldNo: null, newNo: n++, text: changed(text) })
    } else lines.push({ kind: 'context', oldNo: o++, newNo: n++, text })
    if (i === 6)
      lines.push({
        kind: 'add',
        oldNo: null,
        newNo: n++,
        text: file.endsWith('.md') ? 'Large exports are streamed.' : '    // Streams rows as they are read.',
      })
  })
  return { binary: false, truncated: false, hunks: [{ header: `@@ -1,${o - 1} +1,${n - 1} @@`, oldStart: 1, newStart: 1, lines }] }
}

/** Added and removed lines of a diff, so file rows agree with what the diff shows. */
function counts(d: FileDiff) {
  const all = d.hunks.flatMap((h) => h.lines)
  return { added: all.filter((l) => l.kind === 'add').length, removed: all.filter((l) => l.kind === 'remove').length }
}

export function resetPreview(summary: RepoSummary, sha: string): ResetPreview {
  const all = historyOf(summary).commits
  const leaving = all.findIndex((c) => c.sha === sha)
  if (leaving < 0) throw new Error('That commit is not on the current branch.')
  const unpushed = all.slice(0, leaving).filter((c) => c.unpushed).length
  return { leaving, unpushed, onUpstream: summary.upstream ? leaving - unpushed : 0 }
}

/** Takes commits off the top; returns the previous HEAD and the files they changed. */
export function reset(summary: RepoSummary, sha: string): { previousHead: string; files: CommitFile[]; onUpstream: number } {
  const h = historyOf(summary)
  const { leaving, onUpstream } = resetPreview(summary, sha)
  if (leaving === 0) throw new Error('The branch is already at that commit.')
  const previousHead = h.commits[0].sha
  const removed = h.commits.splice(0, leaving)
  h.undo = { previousHead, removed }
  placeRefs(h.commits, summary)
  const seen = new Set<string>()
  const files = removed.flatMap((c) => c.files).filter((f) => !f.binary && !seen.has(f.path) && seen.add(f.path))
  return { previousHead, files, onUpstream }
}

export function undoReset(summary: RepoSummary, previousHead: string): Commit[] {
  const h = historyOf(summary)
  if (!h.undo || h.undo.previousHead !== previousHead) throw new Error('There is no reset to undo.')
  const removed = h.undo.removed
  h.commits.unshift(...removed)
  h.undo = null
  placeRefs(h.commits, summary)
  return removed
}

function prepend(summary: RepoSummary, message: string, fs: CommitFile[]) {
  const h = historyOf(summary)
  const r = rng(h.commits.length * 97 + Date.now())
  const [name, email] = AUTHORS[0]
  const now = Math.round(Date.now() / 1000)
  h.commits.unshift({
    sha: hex(r),
    parents: h.commits[0] ? [h.commits[0].sha] : [],
    authorName: name,
    authorEmail: email,
    authorTime: now,
    subject: message.split('\n')[0],
    refs: [],
    unpushed: true,
    message,
    committer: null,
    committerTime: now,
    files: fs,
  })
  h.undo = null
  placeRefs(h.commits, summary)
}

export function revert(summary: RepoSummary, sha: string, conflict: boolean): IntegrateOutcome {
  const c = find(summary, sha)
  if (conflict) return { kind: 'conflicts', files: 1 }
  const swap = (f: CommitFile): CommitFile => ({
    ...f,
    status: f.status === 'A' ? 'D' : f.status === 'D' ? 'A' : f.status,
    added: f.removed,
    removed: f.added,
  })
  prepend(summary, `Revert "${c.subject}"\n\nThis reverts commit ${c.sha}.\n`, c.files.map(swap))
  return { kind: 'done' }
}

export function committed(summary: RepoSummary, message: string, fs: CommitFile[]) {
  prepend(summary, message, fs)
}

export function pushed(summary: RepoSummary) {
  const h = historyOf(summary)
  for (const c of h.commits) c.unpushed = false
  h.undo = null
  placeRefs(h.commits, summary)
}
