import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, TriangleAlert } from 'lucide-react'
import { api, errorMessage } from '../api'
import type { LogEntry, ResetMode } from '../types'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
/** "It is", "They are", "1 of them is", "2 of them are". */
const ofThem = (n: number, all: number) => (n === all ? (all === 1 ? 'It is' : 'They are') : `${n} of them ${n === 1 ? 'is' : 'are'}`)

/**
 * Asks how to move the branch back to `commit`: soft (changes staged) or mixed (changes
 * unstaged). There is deliberately no hard reset, so working-tree files never change.
 */
export function ResetDialog(props: {
  path: string
  commit: LogEntry
  /** The branch name, or "HEAD" when detached. */
  target: string
  upstream: string | null
  onCancel: () => void
  onReset: (mode: ResetMode) => void
}) {
  const { commit: c } = props
  const [mode, setMode] = useState<ResetMode>('mixed')
  const preview = useQuery({
    queryKey: ['resetPreview', props.path, c.sha],
    queryFn: () => api.resetPreview(props.path, c.sha),
    staleTime: 0,
  })
  const p = preview.data
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    // Without showModal (older engines, jsdom) the dialog still opens, just not modally.
    if (!el.open) {
      if (typeof el.showModal === 'function') el.showModal()
      else el.setAttribute('open', '')
    }
    cancel.current?.focus()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="reset-dialog"
      aria-labelledby="reset-title"
      onCancel={(e) => {
        e.preventDefault()
        props.onCancel()
      }}
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          if (p) props.onReset(mode)
        }}
      >
        <h2 id="reset-title">
          Reset {props.target} to <span className="mono">{c.sha.slice(0, 7)}</span>
        </h2>
        <p className="reset-subject selectable">{c.subject || '(no message)'}</p>
        <p className="reset-leaving">
          {p
            ? `${plural(p.leaving, 'commit')} ${p.leaving === 1 ? 'leaves the branch. Its' : 'leave the branch. Their'} changes stay in your working tree.`
            : preview.isError
              ? null
              : 'Counting the commits that leave the branch…'}
        </p>
        {preview.isError && <div className="banner error small selectable">{errorMessage(preview.error)}</div>}

        <fieldset className="reset-modes">
          <legend className="sr-only">Keep the changes of those commits</legend>
          <label className={mode === 'mixed' ? 'on' : ''}>
            <input type="radio" name="mode" value="mixed" checked={mode === 'mixed'} onChange={() => setMode('mixed')} />
            <span>
              <span className="mode-name">Keep changes unstaged</span>
              <span className="mode-hint">
                Mixed reset. They show up under Unstaged in Changes, and anything already staged is unstaged too.
              </span>
            </span>
          </label>
          <label className={mode === 'soft' ? 'on' : ''}>
            <input type="radio" name="mode" value="soft" checked={mode === 'soft'} onChange={() => setMode('soft')} />
            <span>
              <span className="mode-name">Keep changes staged</span>
              <span className="mode-hint">Soft reset. They are staged, ready to commit again.</span>
            </span>
          </label>
        </fieldset>

        {p && p.unpushed > 0 && (
          <p className="reset-note">
            <ArrowUp className="ico ahead" aria-hidden />
            <span>
              {ofThem(p.unpushed, p.leaving)} not on any remote. Undo reset brings {p.unpushed === 1 ? 'it' : 'them'} back right after;
              later, only the reflog does.
            </span>
          </p>
        )}
        {p && p.onUpstream > 0 && (
          <p className="reset-note warn" role="note">
            <TriangleAlert className="ico" aria-hidden />
            <span>
              {ofThem(p.onUpstream, p.leaving)} already on <span className="mono">{props.upstream ?? 'the remote'}</span>. Your branch will
              be behind it, and Pull would bring {p.onUpstream === 1 ? 'it' : 'them'} back. Gitr never force-pushes.
            </span>
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" ref={cancel} onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!p}>
            Reset {props.target}
          </button>
        </div>
      </form>
    </dialog>
  )
}
