// Synthetic repositories for the design preview. None of this is real data.
import type { Branch, DiffLine, FileDiff, FileEntry, LineStat, RepoEntry, RepoStatus, RepoSummary } from '../types'

const W = 'D:/Repos/Work/'
const P = 'D:/Repos/Personal/'

export const REPOS: RepoEntry[] = [
  ...['billing-service', 'fleet-api', 'mobile-app', 'reporting', 'design-tokens', 'data-pipeline', 'identity-server', 'notifications'].map(
    (name) => ({ path: W + name, name, groupId: 'work' }),
  ),
  ...['gitr', 'dotfiles', 'notes', 'stravadash'].map((name) => ({ path: P + name, name, groupId: 'personal' })),
]

// Two Azure DevOps organisations on the same host, so Sign in asks once for each.
const CONTOSO = ['fleet-api', 'data-pipeline']
const ado = (repo: string, org = CONTOSO.includes(repo) ? 'contoso' : 'acme') => ({
  kind: 'ado' as const,
  webUrl: `https://dev.azure.com/${org}/Platform/_git/${repo}`,
  owner: org,
  project: 'Platform',
  repo,
})
const gh = (repo: string) => ({
  kind: 'github' as const,
  webUrl: `https://github.com/example/${repo}`,
  owner: 'example',
  project: null,
  repo,
})

const sum = (path: string, s: Partial<RepoSummary>): RepoSummary => ({
  path,
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  conflicted: 0,
  remote: path.startsWith(W) ? ado(path.slice(W.length)) : gh(path.slice(P.length)),
  error: null,
  operation: null,
  ...s,
})

export const SUMMARIES: Record<string, RepoSummary> = Object.fromEntries(
  [
    sum(W + 'billing-service', {
      branch: 'feature/invoice-export',
      upstream: 'origin/feature/invoice-export',
      ahead: 2,
      staged: 3,
      unstaged: 5,
    }),
    sum(W + 'fleet-api', { behind: 3 }),
    sum(W + 'mobile-app', { branch: 'release/4.2', upstream: 'origin/release/4.2', ahead: 1 }),
    sum(W + 'reporting', { error: 'Couldn\x27t reach the remote. Check the network or VPN, and the remote address.' }),
    sum(W + 'design-tokens', {}),
    sum(W + 'data-pipeline', { behind: 1, unstaged: 2 }),
    sum(W + 'identity-server', {
      branch: 'fix/token-refresh',
      upstream: 'origin/fix/token-refresh',
      conflicted: 1,
      unstaged: 1,
      operation: 'merging',
    }),
    sum(W + 'notifications', { branch: 'spike/webhooks', upstream: null }),
    sum(P + 'gitr', { branch: 'design/warm-redesign', upstream: null, unstaged: 9 }),
    sum(P + 'dotfiles', {}),
    sum(P + 'notes', { behind: 2 }),
    sum(P + 'stravadash', { ahead: 3 }),
  ].map((s) => [s.path, s]),
)

export const f = (path: string, index: string, worktree: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  path,
  origPath: null,
  index,
  worktree,
  untracked: false,
  conflicted: false,
  ...extra,
})

export const STATUS: Record<string, RepoStatus> = {
  [W + 'billing-service']: {
    branch: 'feature/invoice-export',
    detached: false,
    oid: 'e1d2c3b4',
    upstream: 'origin/feature/invoice-export',
    ahead: 2,
    behind: 0,
    files: [
      f('src/Export/InvoiceExporter.cs', '.', 'M'),
      f('tests/Export/InvoiceExporterTests.cs', '.', 'M'),
      f('src/Legacy/OldExporter.cs', '.', 'D'),
      f('appsettings.json', '.', 'M'),
      f('docs/export-formats.md', '.', '?', { untracked: true }),
      f('tools/invoice-cli/Program.cs', '.', '?', { untracked: true }),
      f('tools/invoice-cli/invoice-cli.csproj', '.', '?', { untracked: true }),
      f('tools/invoice-cli/README.md', '.', '?', { untracked: true }),
      f('src/Export/CsvWriter.cs', 'M', '.'),
      f('src/Export/PdfLayout.cs', 'A', '.'),
      f('src/Export/Formats.cs', 'R', '.', { origPath: 'src/Export/FormatList.cs' }),
    ],
  },
  [W + 'identity-server']: conflictStatus('fix/token-refresh', 1, 0),
}

/**
 * A working tree stopped half-way through an operation: `conflicted` files in conflict and
 * `modified` other unstaged files. Staging a conflicted file in the preview resolves it.
 */
export function conflictStatus(branch: string | null, conflicted: number, modified: number): RepoStatus {
  const names = ['src/Auth/TokenRefresher.cs', 'src/Auth/TokenCache.cs', 'appsettings.json', 'tests/Auth/TokenRefresherTests.cs']
  return {
    branch,
    detached: branch === null,
    oid: '5e1f0a9c',
    upstream: branch ? `origin/${branch}` : null,
    ahead: 0,
    behind: 0,
    files: [
      ...names.slice(0, conflicted).map((p) => f(p, 'U', 'U', { conflicted: true })),
      ...['src/Auth/AuthOptions.cs', 'README.md'].slice(0, modified).map((p) => f(p, '.', 'M')),
    ],
  }
}

/**
 * Untracked folders, listed file by file in the Changes list (`--untracked-files=all`) but
 * counted once on the dashboard (`--untracked-files=normal`), as in the app.
 */
export const UNTRACKED_DIRS: Record<string, string[]> = {
  [W + 'billing-service']: ['tools/invoice-cli/'],
}

export const LINES: Record<string, Record<string, Omit<LineStat, 'path'>>> = {
  [W + 'billing-service']: {
    'src/Export/InvoiceExporter.cs': { added: 38, removed: 12, binary: false },
    'tests/Export/InvoiceExporterTests.cs': { added: 64, removed: 3, binary: false },
    'src/Legacy/OldExporter.cs': { added: 0, removed: 141, binary: false },
    'appsettings.json': { added: 2, removed: 1, binary: false },
    'src/Export/CsvWriter.cs': { added: 17, removed: 9, binary: false },
    'src/Export/PdfLayout.cs': { added: 96, removed: 0, binary: false },
    'src/Export/Formats.cs': { added: 4, removed: 4, binary: false },
  },
}

/** Builds a hunk from lines prefixed with ' ', '+' or '-'. */
function hunk(oldStart: number, newStart: number, header: string, body: string[]) {
  let o = oldStart
  let n = newStart
  const lines: DiffLine[] = body.map((raw) => {
    const kind = raw[0] === '+' ? 'add' : raw[0] === '-' ? 'remove' : 'context'
    const text = raw.slice(1)
    if (kind === 'add') return { kind, oldNo: null, newNo: n++, text }
    if (kind === 'remove') return { kind, oldNo: o++, newNo: null, text }
    return { kind, oldNo: o++, newNo: n++, text }
  })
  const oc = lines.filter((l) => l.kind !== 'add').length
  const nc = lines.filter((l) => l.kind !== 'remove').length
  return { header: `@@ -${oldStart},${oc} +${newStart},${nc} @@ ${header}`, oldStart, newStart, lines }
}

const exporter: FileDiff = {
  binary: false,
  truncated: false,
  hunks: [
    hunk(12, 12, 'namespace Acme.Billing.Export', [
      ' public sealed class InvoiceExporter',
      ' {',
      '     private readonly IInvoiceRepository _invoices;',
      '-    private readonly CsvWriter _csv;',
      '+    private readonly IReadOnlyDictionary<ExportFormat, IInvoiceWriter> _writers;',
      '+    private readonly ILogger<InvoiceExporter> _log;',
      ' ',
      '-    public InvoiceExporter(IInvoiceRepository invoices, CsvWriter csv)',
      '+    public InvoiceExporter(',
      '+        IInvoiceRepository invoices,',
      '+        IEnumerable<IInvoiceWriter> writers,',
      '+        ILogger<InvoiceExporter> log)',
      '     {',
      '         _invoices = invoices;',
      '-        _csv = csv;',
      '+        _writers = writers.ToDictionary(w => w.Format);',
      '+        _log = log;',
      '     }',
    ]),
    hunk(41, 46, 'public async Task<ExportResult> ExportAsync(ExportRequest request, CancellationToken ct)', [
      '         var invoices = await _invoices.ForPeriodAsync(request.From, request.To, ct);',
      '-        if (invoices.Count == 0) return ExportResult.Empty;',
      '-        return await _csv.WriteAsync(invoices, request.Destination, ct);',
      '+        if (invoices.Count == 0)',
      '+        {',
      '+            _log.LogInformation("No invoices between {From} and {To}", request.From, request.To);',
      '+            return ExportResult.Empty;',
      '+        }',
      '+',
      '+        if (!_writers.TryGetValue(request.Format, out var writer))',
      '+            throw new NotSupportedException($"Export format {request.Format} is not available.");',
      '+',
      '+        return await writer.WriteAsync(invoices, request.Destination, ct);',
      '     }',
      ' }',
    ]),
  ],
}

/** The exporter's diff as Full file shows it: the hunks above with the rest of the file around them. */
const exporterFull: FileDiff = {
  binary: false,
  truncated: false,
  hunks: [
    hunk(1, 1, '', [
      ' using System;',
      ' using System.Collections.Generic;',
      ' using System.IO;',
      ' using System.Linq;',
      ' using System.Threading;',
      ' using System.Threading.Tasks;',
      ' using Acme.Billing.Domain;',
      ' ',
      ' namespace Acme.Billing.Export;',
      ' ',
      ' /// <summary>Exports a period of invoices to a file.</summary>',
      ...exporter.hunks[0].lines.map((l) => (l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' ') + l.text),
      ' ',
      '     /// <summary>The formats this exporter can write.</summary>',
      '     public IEnumerable<ExportFormat> Formats => Enum.GetValues<ExportFormat>();',
      ' ',
      '     /// <summary>',
      "     /// Writes every invoice dated within the request's period to its destination,",
      '     /// in the requested format. An empty period writes nothing.',
      '     /// </summary>',
      '     public async Task<ExportResult> ExportAsync(ExportRequest request, CancellationToken ct)',
      '     {',
      '         ArgumentNullException.ThrowIfNull(request);',
      '         ct.ThrowIfCancellationRequested();',
      ' ',
      '         if (request.To < request.From)',
      '             throw new ArgumentException("The period ends before it starts.", nameof(request));',
      ' ',
      '         if (request.Destination is not { CanWrite: true })',
      '             throw new ArgumentException("The destination is not writable.", nameof(request));',
      ' ',
      ...exporter.hunks[1].lines.map((l) => (l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' ') + l.text),
    ]),
  ],
}

export const DIFFS: Record<string, FileDiff> = {
  'src/Export/InvoiceExporter.cs': exporter,
  'src/Export/CsvWriter.cs': exporter,
}

/** What Full file shows for a diff in DIFFS. A diff without an entry shows its hunks either way. */
export const FULL_DIFFS = new Map<FileDiff, FileDiff>([[exporter, exporterFull]])

const br = (name: string, b: Partial<Branch>): Branch => ({
  name,
  remote: false,
  isHead: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  gone: false,
  sha: 'a1b2c3d',
  committedAt: Date.now() / 1000 - 3600 * 5,
  ...b,
})

export const BRANCHES: Record<string, Branch[]> = {
  default: [
    br('feature/invoice-export', {
      isHead: true,
      upstream: 'origin/feature/invoice-export',
      ahead: 2,
      committedAt: Date.now() / 1000 - 1500,
    }),
    br('main', { upstream: 'origin/main', behind: 4, committedAt: Date.now() / 1000 - 86400 * 2 }),
    br('fix/rounding-vat', { upstream: 'origin/fix/rounding-vat', gone: true, committedAt: Date.now() / 1000 - 86400 * 9 }),
    br('spike/pdf-sharp', { committedAt: Date.now() / 1000 - 86400 * 40 }),
    br('origin/feature/invoice-export', { remote: true, committedAt: Date.now() / 1000 - 1500 }),
    br('origin/main', { remote: true, committedAt: Date.now() / 1000 - 3600 * 3 }),
    br('origin/release/2026.10', { remote: true, committedAt: Date.now() / 1000 - 86400 * 4 }),
  ],
}
