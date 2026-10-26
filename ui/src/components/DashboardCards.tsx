import { ArrowDownToLine, Code, Ellipsis, GitBranch, SquareTerminal } from 'lucide-react'
import { api } from '../api'
import { notifyError, useBatch, useBatchRunning } from '../hooks'
import { useApp, type Fresh } from '../store'
import { useRepoMenu } from '../repoMenu'
import { groupStyle, type GroupColor } from '../lib/groupColor'
import { absoluteTime, relativeTime } from '../lib/time'
import { needsAttention, type Row } from '../lib/git'
import { CountChips, Divergence, StatusMark } from './Marks'
import { RepoStatusText } from './RepoStatusText'
import type { DashboardView } from '../layout'
import type { RepoSummary } from '../types'

/** A run of cards under one heading ("Needs attention", a group); no label for an unbanded list. */
export interface CardSection {
  key: string
  label?: string
  count?: number
  color?: GroupColor
  rows: Row[]
}

/** How long a card's highlight plays after something new arrives; it matches the CSS animation. */
export const FLASH_MS = 1600

const HOST: Record<string, string> = { github: 'GitHub', ado: 'Azure DevOps' }

const FRESH_LABEL: Record<Fresh['kind'], string> = {
  trouble: 'New problem',
  behind: 'New incoming commits',
  dirty: 'New changes',
  ahead: 'New outgoing commits',
}

interface Props {
  view: Exclude<DashboardView, 'table'>
  sections: CardSection[]
  cursor: string | null
  setCursor: (path: string) => void
  /** Group colours by group id, when there is more than one group. */
  colors: Map<string, GroupColor> | null
  groupNames: Map<string, string>
}

/** The dashboard as cards: compact ones in a dense grid, or detailed ones with the last commit. */
export function DashboardCards({ view, sections, cursor, setCursor, colors, groupNames }: Props) {
  return (
    <>
      {sections.map((sec, i) => (
        <section key={sec.key} className="card-section" aria-label={sec.label}>
          {sec.label && (
            <div className={`card-band ${i === 0 ? 'first' : ''}`} style={groupStyle(sec.color)}>
              {sec.color && <span className="group-swatch" aria-hidden />}
              {sec.label}
              <span className="band-count">{sec.count}</span>
            </div>
          )}
          <div className={`card-grid ${view}`}>
            {sec.rows.map((row) => (
              <RepoCard
                key={row.repo.path}
                view={view}
                row={row}
                cursor={row.repo.path === cursor}
                setCursor={setCursor}
                // Under its group's own heading a card doesn't repeat the group.
                color={sec.color ? undefined : colors?.get(row.repo.groupId)}
                groupName={colors && !sec.color ? groupNames.get(row.repo.groupId) : undefined}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

function RepoCard({
  view,
  row,
  cursor,
  setCursor,
  color,
  groupName,
}: {
  view: Props['view']
  row: Row
  cursor: boolean
  setCursor: (path: string) => void
  color: GroupColor | undefined
  groupName: string | undefined
}) {
  const { repo, summary: s } = row
  const setView = useApp((st) => st.setView)
  const failed = useApp((st) => st.batch[repo.path]?.state === 'error')
  const fresh = useApp((st) => st.fresh[repo.path])
  const markSeen = useApp((st) => st.markSeen)
  const batch = useBatch()
  const running = useBatchRunning()
  const repoMenu = useRepoMenu()
  const open = () => {
    markSeen(repo.path)
    setView({ kind: 'repo', path: repo.path })
  }
  // Played once per arrival: the key is its time, and once it is old a re-render draws no flash.
  const flashing = !!fresh && Date.now() - fresh.at < FLASH_MS
  const behind = s?.behind ?? 0

  const tools = (
    <span className="card-tools">
      <button
        className="icon"
        tabIndex={-1}
        title="Open in VS Code"
        aria-label={`Open ${repo.name} in VS Code`}
        onClick={(e) => {
          e.stopPropagation()
          api.openWith(repo.path, 'vsCode').catch(notifyError)
        }}
      >
        <Code className="ico" aria-hidden />
      </button>
      <button
        className="icon"
        tabIndex={-1}
        title="Open terminal here"
        aria-label={`Open a terminal in ${repo.name}`}
        onClick={(e) => {
          e.stopPropagation()
          api.openWith(repo.path, 'terminal').catch(notifyError)
        }}
      >
        <SquareTerminal className="ico" aria-hidden />
      </button>
      <button
        className="icon"
        tabIndex={-1}
        title="More (Shift+F10)"
        aria-label={`More actions for ${repo.name}`}
        onClick={(e) => {
          e.stopPropagation()
          setCursor(repo.path)
          repoMenu(repo.path)(e)
        }}
      >
        <Ellipsis className="ico" aria-hidden />
      </button>
    </span>
  )
  // What the repo is waiting for: a pull when it is behind. It never competes with a primary button.
  const next = behind > 0 && !s?.operation && (
    <button
      className="quiet small next next-behind"
      tabIndex={-1}
      disabled={running}
      title={`Pull ${behind} incoming commit${behind === 1 ? '' : 's'}`}
      onClick={(e) => {
        e.stopPropagation()
        batch.mutate({ op: 'pull', paths: [repo.path], interactive: true })
      }}
    >
      <ArrowDownToLine className="ico" aria-hidden />
      Pull ↓{behind}
    </button>
  )

  return (
    <article
      className={`repo-card ${view} ${cursor ? 'cursor' : ''} ${needsAttention(s, failed) ? 'urgent' : ''}`}
      data-path={repo.path}
      aria-label={repo.name}
      aria-current={cursor ? 'true' : undefined}
      style={color ? groupStyle(color) : undefined}
      onClick={() => {
        setCursor(repo.path)
        markSeen(repo.path)
      }}
      onMouseEnter={() => markSeen(repo.path)}
      onDoubleClick={open}
      onContextMenu={repoMenu(repo.path)}
    >
      {flashing && <span key={fresh.at} className={`card-flash ${fresh.kind}`} aria-hidden />}
      <div className="card-body">
        <div className="card-top">
          <StatusMark summary={s} />
          <button className="link repo-link card-name" tabIndex={-1} onClick={open} title={repo.path}>
            {repo.name}
          </button>
          {view === 'detailed' && groupName && (
            <span className="card-group">
              <span className="group-swatch" aria-hidden />
              {groupName}
            </span>
          )}
          {view === 'compact' && color && <span className="group-swatch" title={groupName} aria-hidden />}
          <span className="card-counts">
            {view === 'compact' && <CountChips summary={s} />}
            {fresh && !fresh.seen && (
              <span className={`fresh-dot ${fresh.kind}`} title={`${FRESH_LABEL[fresh.kind]} since you last looked`}>
                <span className="sr-only">{FRESH_LABEL[fresh.kind]}</span>
              </span>
            )}
          </span>
          {view === 'detailed' && s?.remote && (
            <button
              className="link card-remote"
              tabIndex={-1}
              title={`Open ${repo.name} on ${HOST[s.remote.kind] ?? 'the web'}`}
              onClick={(e) => {
                e.stopPropagation()
                api.openRemote(repo.path, { kind: 'repo' }).catch(notifyError)
              }}
            >
              {HOST[s.remote.kind] ?? s.remote.owner}
            </button>
          )}
        </div>
        <div className="card-branch mono" title={s?.branch ? (s.upstream ? `${s.branch} → ${s.upstream}` : s.branch) : undefined}>
          <GitBranch className="ico" aria-hidden />
          <span className="ellipsis">{s?.detached ? '(detached)' : (s?.branch ?? '…')}</span>
          {view === 'detailed' && s?.upstream && <span className="card-upstream ellipsis">→ {s.upstream}</span>}
        </div>
        {view === 'compact' ? (
          <div className="card-mid">
            {!!(s?.behind || s?.ahead) && <Divergence summary={s} />}
            <span className="ellipsis status-cell">
              <RepoStatusText
                path={repo.path}
                summary={s}
                idle={s && !changesOf(s) && !s.behind && !s.ahead && <span className="muted">Up to date</span>}
              />
            </span>
          </div>
        ) : (
          <Detail path={repo.path} summary={s} />
        )}
      </div>
      <div className="card-foot">
        {view === 'detailed' && (
          <span className="ellipsis status-cell card-word">
            <RepoStatusText path={repo.path} summary={s} hideError idle={s && <IdleWord s={s} />} />
          </span>
        )}
        {tools}
        {next}
      </div>
    </article>
  )
}

const changesOf = (s: RepoSummary) => s.staged + s.unstaged + s.conflicted

/** The detailed card's middle: changes, behind and ahead side by side, then the last commit. */
function Detail({ path, summary: s }: { path: string; summary: RepoSummary | undefined }) {
  if (!s) return <div className="card-detail" />
  const changes = s.staged + s.unstaged + s.conflicted
  const pct = (n: number) => `${(n / changes) * 100}%`
  const head = s.lastCommit
  return (
    <div className="card-detail">
      {s.error ? (
        <p className="card-alert" title={path}>
          {s.error}
        </p>
      ) : (
        <>
          <div className="card-stats">
            <Stat n={changes} mark="±" cls="dirty" label="changes" />
            <Stat n={s.behind} mark="↓" cls="behind" label="behind" />
            <Stat n={s.ahead} mark="↑" cls="ahead" label="ahead" />
          </div>
          {changes > 0 && (
            <div
              className="card-mix"
              role="img"
              aria-label={[
                s.conflicted && `${s.conflicted} conflicted`,
                s.staged && `${s.staged} staged`,
                s.unstaged && `${s.unstaged} unstaged`,
              ]
                .filter(Boolean)
                .join(', ')}
            >
              {s.conflicted > 0 && <span className="mix-conflict" style={{ width: pct(s.conflicted) }} />}
              {s.staged > 0 && <span className="mix-staged" style={{ width: pct(s.staged) }} />}
              {s.unstaged > 0 && <span className="mix-unstaged" style={{ width: pct(s.unstaged) }} />}
            </div>
          )}
        </>
      )}
      {head && (
        <div className="card-commit">
          {s.head && <span className="mono sha">{s.head.slice(0, 7)}</span>}
          <span className="ellipsis subject" title={head.subject}>
            {head.subject}
          </span>
          <span className="when" title={absoluteTime(head.time)}>
            {relativeTime(head.time)}
          </span>
        </div>
      )}
    </div>
  )
}

function Stat({ n, mark, cls, label }: { n: number; mark: string; cls: string; label: string }) {
  return (
    <span className={`card-stat ${n ? cls : 'zero'}`}>
      <b aria-hidden>{n ? `${mark}${n}` : '–'}</b>
      <span aria-hidden>{label}</span>
      <span className="sr-only">
        {n || 'no'} {label}
      </span>
    </span>
  )
}

/** The detailed card's foot when nothing else is going on: what the counts add up to. */
function IdleWord({ s }: { s: RepoSummary }) {
  const parts = [s.staged && `${s.staged} staged`, s.unstaged && `${s.unstaged} unstaged`].filter(Boolean)
  if (parts.length) return <span className="muted">{parts.join(' · ')}</span>
  if (s.behind || s.ahead) return null
  return <span className="muted">Up to date</span>
}
