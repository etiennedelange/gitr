// Mock data sets for the design preview (preview.html). None of this is real data.
// Pick one with ?scenario=<id> or the toolbar at the bottom of the preview.
import type { Branch, FileDiff, FileEntry, Group, LineStat, RepoBusy, RepoEntry, RepoStatus, RepoSummary } from '../types'
import { BRANCHES, DIFFS, LINES, REPOS, STATUS, SUMMARIES, conflictStatus } from './data'

export interface Scenario {
  id: string
  name: string
  /** One line for the toolbar: what to look at in this data set. */
  about: string
  groups: Group[]
  repos: RepoEntry[]
  summaries: Record<string, RepoSummary>
  status: Record<string, RepoStatus>
  lines: Record<string, Record<string, Omit<LineStat, 'path'>>>
  diffs: Record<string, FileDiff>
  branches: Record<string, Branch[]>
  /** Repos the backend reports as busy (operation in progress). */
  busy: RepoBusy[]
}

const DEFAULT_GROUPS: Group[] = [
  { id: 'work', name: 'Work', roots: ['D:/Repos/Work'] },
  { id: 'personal', name: 'Personal', roots: ['D:/Repos/Personal'] },
]

const base = { status: STATUS, lines: LINES, diffs: DIFFS, branches: BRANCHES, busy: [] as RepoBusy[] }

const summary = (path: string, s: Partial<RepoSummary> = {}): RepoSummary => ({
  path,
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  conflicted: 0,
  remote: {
    kind: 'ado',
    webUrl: `https://dev.azure.com/acme/Platform/_git/${path.split('/').pop()}`,
    owner: 'acme',
    project: 'Platform',
    repo: path.split('/').pop()!,
  },
  error: null,
  operation: null,
  ...s,
})

/** Deterministic pseudo-random numbers so every load looks the same. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32
    return seed / 2 ** 32
  }
}

/** A working tree with `n` changed files spread over a few folders, plus their line counts. */
function bigTree(n: number, stagedShare = 0.3) {
  const r = rng(n * 7919)
  const dirs = [
    'src/Api',
    'src/Domain/Orders',
    'src/Domain/Billing',
    'src/Infrastructure/Persistence',
    'tests/Unit',
    'tests/Integration',
    'tools',
    'docs',
  ]
  const exts = ['.cs', '.cs', '.cs', '.ts', '.json', '.md', '.sql']
  const files: FileEntry[] = []
  const lines: Record<string, Omit<LineStat, 'path'>> = {}
  for (let i = 0; i < n; i++) {
    const file = `${dirs[Math.floor(r() * dirs.length)]}/File${String(i + 1).padStart(3, '0')}${exts[Math.floor(r() * exts.length)]}`
    const staged = r() < stagedShare
    const kind = r() < 0.75 ? 'M' : r() < 0.6 ? 'A' : 'D'
    const untracked = !staged && kind === 'A'
    files.push({
      path: file,
      origPath: null,
      index: staged ? kind : '.',
      worktree: staged ? '.' : untracked ? '?' : kind,
      untracked,
      conflicted: false,
    })
    if (!untracked)
      lines[file] = { added: kind === 'D' ? 0 : Math.floor(r() * 220), removed: kind === 'A' ? 0 : Math.floor(r() * 90), binary: false }
  }
  const status: RepoStatus = { branch: 'main', detached: false, oid: 'c0ffee12', upstream: 'origin/main', ahead: 0, behind: 0, files }
  return { status, lines }
}

/** Many repositories across three groups, every status and every dot size, long names. */
function many(): Scenario {
  const groups: Group[] = [
    { id: 'platform', name: 'Platform', roots: ['D:/Repos/Platform'] },
    { id: 'apps', name: 'Apps', roots: ['D:/Repos/Apps'] },
    { id: 'oss', name: 'Open source and experiments with a long group name', roots: ['D:/Repos/Oss'] },
  ]
  const r = rng(42)
  const repos: RepoEntry[] = []
  const summaries: Record<string, RepoSummary> = {}
  const status: Record<string, RepoStatus> = {}
  const lines: Scenario['lines'] = {}
  // Change counts chosen to hit every step of the magnitude ramp (0, 1–2, 3–9, 10–29, 30+).
  const changeCounts = [0, 0, 1, 2, 4, 7, 9, 12, 18, 27, 34, 61, 140]
  const names: Record<string, string[]> = {
    platform: [
      'gateway',
      'identity-server',
      'billing-service',
      'ledger',
      'notifications',
      'scheduler',
      'telemetry-ingest',
      'search-indexer',
      'feature-flags',
      'audit-log',
      'payments-reconciliation-worker',
      'config-service',
      'rate-limiter',
      'tenant-admin',
    ],
    apps: [
      'mobile-app',
      'driver-app',
      'web-portal',
      'admin-console',
      'kiosk',
      'reporting',
      'customer-self-service-portal-legacy',
      'design-tokens',
      'storybook',
    ],
    oss: ['gitr', 'dotfiles', 'notes', 'stravadash', 'tiny-http', 'a-very-long-repository-name-that-will-not-fit-the-rail'],
  }
  for (const g of groups) {
    for (const name of names[g.id]) {
      const path = `D:/Repos/${g.name.split(' ')[0]}/${name}`
      repos.push({ path, name, groupId: g.id })
      const changes = changeCounts[Math.floor(r() * changeCounts.length)]
      const staged = Math.floor(changes * r() * 0.5)
      const roll = r()
      summaries[path] = summary(path, {
        staged,
        unstaged: changes - staged,
        ahead: roll < 0.25 ? 1 + Math.floor(r() * 6) : 0,
        behind: roll > 0.7 ? 1 + Math.floor(r() * 40) : 0,
      })
      if (changes >= 12) {
        const t = bigTree(changes)
        status[path] = t.status
        lines[path] = t.lines
      }
    }
  }
  // Fixed cases so each state is always present.
  const at = (name: string) => repos.find((x) => x.name === name)!.path
  summaries[at('reporting')] = summary(at('reporting'), {
    error: "Couldn't reach the remote. Check the network or VPN, and the remote address.",
  })
  summaries[at('ledger')] = summary(at('ledger'), { conflicted: 3, unstaged: 2, branch: 'release/2026.10', operation: 'merging' })
  summaries[at('kiosk')] = summary(at('kiosk'), { detached: true, branch: null, upstream: null })
  summaries[at('tiny-http')] = summary(at('tiny-http'), { upstream: null, branch: 'spike/no-upstream' })
  summaries[at('gateway')] = summary(at('gateway'), { unstaged: 140, staged: 12, ahead: 3, behind: 2 })
  const gw = bigTree(152, 0.08)
  status[at('gateway')] = gw.status
  lines[at('gateway')] = gw.lines
  return {
    id: 'many',
    name: 'Many repos',
    about: '29 repos in 3 groups: every status, all five dot sizes, long names, a 152-file change list, two busy repos.',
    groups,
    repos,
    summaries,
    status,
    lines,
    diffs: DIFFS,
    branches: BRANCHES,
    busy: [
      { path: at('scheduler'), op: 'fetching' },
      { path: at('web-portal'), op: 'pulling' },
    ],
  }
}

/** The default set with every repo in a different kind of trouble, and every operation that can stop half-way. */
function errors(): Scenario {
  const kinds: Partial<RepoSummary>[] = [
    { error: 'Sign-in failed or is needed for this remote.' },
    { conflicted: 4, unstaged: 5, operation: 'merging' },
    { error: 'Another git process is using this repository, or one left a lock file behind.' },
    { detached: true, branch: null, upstream: null, conflicted: 1, unstaged: 1, operation: 'rebasing' },
    { behind: 57 },
    { error: 'Git refuses to work in this folder because it is owned by another user.' },
    { conflicted: 2, unstaged: 2, operation: 'cherry-picking' },
    // Conflicts resolved: Continue is enabled.
    { conflicted: 0, unstaged: 1, operation: 'reverting' },
    { detached: true, branch: null, upstream: null, operation: 'bisecting' },
    { conflicted: 1, unstaged: 1, operation: 'applying-patches' },
  ]
  const summaries: Record<string, RepoSummary> = {}
  const status: Record<string, RepoStatus> = { ...STATUS }
  Object.values(SUMMARIES).forEach((s, i) => {
    const k = kinds[i] ?? {}
    summaries[s.path] = { ...s, ...k }
    // An operation's repo lists its conflicted files, so resolving (staging) them enables Continue.
    if (k.operation && k.operation !== 'bisecting') {
      const conflicted = k.conflicted ?? 0
      status[s.path] = conflictStatus(summaries[s.path].branch, conflicted, (k.unstaged ?? 0) - conflicted)
    }
  })
  return {
    id: 'errors',
    name: 'Errors',
    about: 'Sign-in, lock and ownership errors, far behind; a merge, rebase, cherry-pick, revert, bisect and git am in progress.',
    groups: DEFAULT_GROUPS,
    repos: REPOS,
    summaries,
    ...base,
    status,
  }
}

/** Everything up to date: the quiet state. */
function clean(): Scenario {
  const summaries = Object.fromEntries(
    Object.values(SUMMARIES).map((s) => [s.path, { ...s, ahead: 0, behind: 0, staged: 0, unstaged: 0, conflicted: 0, error: null }]),
  )
  const status = Object.fromEntries(Object.entries(STATUS).map(([p, st]) => [p, { ...st, ahead: 0, files: [] }]))
  return {
    id: 'clean',
    name: 'All clean',
    about: 'Nothing to commit anywhere: empty lists and the clean working tree.',
    groups: DEFAULT_GROUPS,
    repos: REPOS,
    summaries,
    ...base,
    status,
  }
}

/** First run: no groups configured, so the app opens Settings. */
function empty(): Scenario {
  return {
    id: 'empty',
    name: 'First run',
    about: 'No groups yet: the app starts in Settings.',
    groups: [],
    repos: [],
    summaries: {},
    ...base,
    status: {},
    lines: {},
  }
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'default',
    name: 'Default',
    about: '12 repos in 2 groups; billing-service has a staged/unstaged change set and a diff.',
    groups: DEFAULT_GROUPS,
    repos: REPOS,
    summaries: SUMMARIES,
    ...base,
  },
  many(),
  errors(),
  clean(),
  empty(),
]

export const scenarioById = (id: string | null) => SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]
