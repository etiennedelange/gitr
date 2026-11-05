import { statusClass } from '../lib/git'
import type { RepoSummary } from '../types'

const LABEL: Record<string, string> = {
  unknown: 'Loading',
  error: 'Error',
  conflict: 'Conflicts',
  operation: 'Operation in progress',
  dirty: 'Uncommitted changes',
  behind: 'Behind upstream',
  ahead: 'Ahead of upstream',
  clean: 'Clean',
}

/**
 * A repository's state as one small mark: a filled dot in the state's colour, a hollow ring when
 * clean, a red ring for an error and a solid red dot for conflicts. The numbers beside it carry the
 * counts, so colour never stands alone.
 */
export function StatusMark({ summary }: { summary: RepoSummary | undefined }) {
  const kind = statusClass(summary).split(' ')[1]
  return <span className={`dot ${kind}`} role="img" aria-label={LABEL[kind]} title={LABEL[kind]} />
}

/** A compact count chip for sighted users; the full wording is there for screen readers. */
export function Chip({ cls, mark, text }: { cls: string; mark: string; text: string }) {
  return (
    <span className={`badge ${cls}`} title={text}>
      <span aria-hidden>{mark}</span>
      <span className="sr-only">{text}</span>
    </span>
  )
}

/** ±n uncommitted, ↓n behind, ↑n ahead: the same chips in the rail and the switcher. */
export function CountChips({ summary, only }: { summary: RepoSummary | undefined; only?: 'changes' | 'sync' }) {
  const s = summary
  const changes = s ? s.staged + s.unstaged + s.conflicted : 0
  return (
    <>
      {only !== 'sync' && changes ? <Chip cls="dirty" mark={`±${changes}`} text={`${changes} uncommitted`} /> : null}
      {only !== 'changes' && s?.behind ? <Chip cls="behind" mark={`↓${s.behind}`} text={`${s.behind} behind`} /> : null}
      {only !== 'changes' && s?.ahead ? <Chip cls="ahead" mark={`↑${s.ahead}`} text={`${s.ahead} ahead`} /> : null}
    </>
  )
}

/**
 * Behind and ahead as two right-aligned numerals with their arrows, ↓ in teal and ↑ in green.
 * A zero leaves its cell empty, so the columns only carry what needs a pull or a push.
 */
export function Divergence({ summary }: { summary: RepoSummary | undefined }) {
  const behind = summary?.behind ?? 0
  const ahead = summary?.ahead ?? 0
  if (!summary?.upstream && !behind && !ahead) {
    return <span className="divergence none" title={summary ? 'No upstream branch' : undefined} />
  }
  return (
    <span className="divergence">
      <span className="dv-side dv-behind" title={behind ? `${behind} behind` : undefined}>
        {behind ? (
          <>
            <span className="dv-num" aria-hidden>
              ↓{behind}
            </span>
            <span className="sr-only">{behind} behind</span>
          </>
        ) : null}
      </span>
      <span className="dv-side dv-ahead" title={ahead ? `${ahead} ahead` : undefined}>
        {ahead ? (
          <>
            <span className="dv-num" aria-hidden>
              ↑{ahead}
            </span>
            <span className="sr-only">{ahead} ahead</span>
          </>
        ) : null}
      </span>
    </span>
  )
}

/** A branch in two tones: the folder path recedes and the branch's own name reads first. */
export function BranchName({ name }: { name: string }) {
  const cut = name.lastIndexOf('/') + 1
  return (
    <>
      {cut > 0 && <span className="branch-path">{name.slice(0, cut)}</span>}
      {name.slice(cut)}
    </>
  )
}
