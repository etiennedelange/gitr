import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ArrowUpFromLine, Sparkles, Square, Undo2 } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ask } from '@tauri-apps/plugin-dialog'
import { api, errorMessage } from '../api'
import { notifyError, useBusy } from '../hooks'
import { useApp } from '../store'
import { operationCommand } from '../lib/operation'
import { runCommit } from '../lib/send'

const drafts = new Map<string, string>()

interface Props {
  path: string
  stagedCount: number
  branch: string | null
}

export function CommitBox({ path, stagedCount, branch }: Props) {
  const [message, setMessageState] = useState(() => drafts.get(path) ?? '')
  const [amend, setAmend] = useState(false)
  const [generating, setGenerating] = useState(false)
  // Shared backend busy state (also covers staging, pulls, Fetch all … on this repo).
  const busyOp = useBusy(path)
  // Guards against a second Ctrl+Enter before the backend reports busy (it would queue another commit).
  const submitting = useRef(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)

  const qc = useQueryClient()
  // The last commit when it can be undone (unpushed, not a merge); refreshed on repo-summary.
  const lastCommit = useQuery({ queryKey: ['lastCommit', path], queryFn: () => api.lastCommitUndo(path) })

  const setMessage = (m: string) => {
    drafts.set(path, m)
    setMessageState(m)
  }

  // A commit landed (from this box, or "Commit without hooks" in the hook panel): start fresh.
  const commits = useApp((st) => st.commits[path] ?? 0)
  const seenCommits = useRef(commits)
  useEffect(() => {
    if (commits === seenCommits.current) return
    seenCommits.current = commits
    setMessage('')
    setAmend(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commits])

  // During a merge, committing concludes it. During the others git goes on with `--continue`
  // (Continue in the banner), or, in a bisect, by marking commits good or bad in a terminal.
  const operation = useApp((st) => st.summaries[path]?.operation ?? null)
  const noCommit = !!operation && operation !== 'merging'
  const canCommit = !!message.trim() && (stagedCount > 0 || amend) && !busyOp && !generating && !noCommit

  // Prefill the merge message once, when a merge is in progress and the box is empty.
  const mergePrefilled = useRef(false)
  useEffect(() => {
    if (operation !== 'merging') {
      mergePrefilled.current = false
      return
    }
    if (mergePrefilled.current || message.trim()) return
    mergePrefilled.current = true
    api.mergeMessage(path).then(
      (m) => m && setMessage(m),
      () => {},
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation, path])

  const generate = async () => {
    if (generating) {
      api.cancelGeneration()
      return
    }
    if (stagedCount === 0) return
    const previousMessage = message
    setAiError(null)
    setGenerating(true)
    let streamed = ''
    try {
      const unlisten = await listen<{ path: string; text: string }>('ai-delta', ({ payload }) => {
        if (payload.path !== path) return
        streamed += payload.text
        setMessage(streamed)
      })
      try {
        setMessage('')
        setMessage(await api.generateCommitMessage(path))
      } finally {
        unlisten()
      }
    } catch (e) {
      setMessage(previousMessage)
      const msg = errorMessage(e)
      if (msg !== 'Cancelled') setAiError(msg)
    } finally {
      setGenerating(false)
      ref.current?.focus()
    }
  }

  // The last commit's message put in the box by Amend, so turning Amend off can take it out again.
  const prefilled = useRef<string | null>(null)
  const toggleAmend = async (on: boolean) => {
    setAmend(on)
    if (!on) {
      if (prefilled.current !== null && message === prefilled.current) setMessage('')
      prefilled.current = null
      return
    }
    if (!message.trim()) {
      try {
        const last = await api.lastCommitMessage(path)
        prefilled.current = last
        setMessage(last)
      } catch (e) {
        notifyError(e)
      }
    }
  }

  const commit = async (andPush: boolean) => {
    if (!canCommit || submitting.current) return
    submitting.current = true
    try {
      // The last commit can't be undone once it is pushed (or is a merge); rewriting it then
      // diverges from the remote.
      if (amend && lastCommit.isSuccess && !lastCommit.data) {
        const question = 'The last commit is already pushed or is a merge. Amending it rewrites history that others may have.'
        if (!(await ask(question, { title: 'Amend pushed commit?', kind: 'warning', okLabel: 'Amend', cancelLabel: 'Cancel' }))) return
      }
      await runCommit(path, message, amend, andPush)
    } finally {
      submitting.current = false
    }
  }

  // No confirmation: nothing is lost (the changes stay staged, the message comes back).
  const undoLastCommit = async () => {
    const last = lastCommit.data
    if (!last || busyOp || operation || submitting.current) return
    submitting.current = true
    try {
      const msg = await api.undoLastCommit(path)
      setAmend(false)
      // A draft typed meanwhile is not overwritten; the undone message stays in the reflog.
      const keepsDraft = !!message.trim() && message !== msg
      if (!keepsDraft) setMessage(msg)
      useApp.getState().toast('info', `Undid commit “${last.subject}”${keepsDraft ? ' (your draft message was kept)' : ''}`)
      qc.invalidateQueries({ queryKey: ['lastCommit', path] })
    } catch (e) {
      notifyError(e)
    } finally {
      submitting.current = false
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        generate()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <section className="commit-box">
      <textarea
        data-pane
        aria-label="Commit message"
        spellCheck
        autoComplete="off"
        ref={ref}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={
          stagedCount || amend
            ? 'Commit message (Ctrl+Enter commits, Ctrl+Shift+Enter commits & pushes)'
            : 'Stage files, then describe the change here'
        }
        readOnly={generating}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault()
            commit(e.shiftKey)
          }
        }}
      />
      {aiError && <div className="banner error small selectable">{aiError}</div>}
      {noCommit && operation === 'bisecting' && (
        <div className="hint" role="note">
          Mark commits in a terminal: <code>git bisect good</code> or <code>git bisect bad</code>
        </div>
      )}
      {noCommit && operation !== 'bisecting' && (
        <div className="hint" role="note">
          Continue in the banner above, or in a terminal: <code>git {operationCommand(operation)} --continue</code>
        </div>
      )}
      <div className="commit-options">
        <button
          className={`quiet small ai ${generating ? 'generating' : ''}`}
          disabled={!generating && stagedCount === 0}
          onClick={generate}
          title={stagedCount === 0 && !generating ? 'Stage files to generate a message (Ctrl+G)' : 'Generate with Copilot (Ctrl+G)'}
        >
          {generating ? <Square className="ico" aria-hidden /> : <Sparkles className="ico" aria-hidden />}
          {generating ? 'Stop' : 'Generate'}
        </button>
        <label className="check">
          <input type="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} /> Amend
        </label>
        <div className="spacer" />
        {lastCommit.data && (
          <button
            className="quiet small"
            disabled={!!busyOp || !!operation}
            title={`Undo “${lastCommit.data.subject}”: its changes go back to Staged`}
            onClick={undoLastCommit}
          >
            <Undo2 className="ico" aria-hidden />
            Undo last commit
          </button>
        )}
      </div>
      {/* Commit and Push sit together as one split action; Push commits first. */}
      <div className="commit-actions send">
        <button className="primary commit-main" disabled={!canCommit} onClick={() => commit(false)} title="Ctrl+Enter">
          {busyOp === 'committing'
            ? 'Committing…'
            : amend
              ? `Amend last commit${branch ? ` on ${branch}` : ''}`
              : `Commit${stagedCount ? ` ${stagedCount} file${stagedCount === 1 ? '' : 's'}` : ''}${branch ? ` to ${branch}` : ''}`}
        </button>
        <button
          className="primary commit-push"
          disabled={!canCommit}
          onClick={() => commit(true)}
          aria-label="Commit and push"
          title="Commit, then push (Ctrl+Shift+Enter)"
        >
          <ArrowUpFromLine className="ico" aria-hidden />
          Push
        </button>
      </div>
    </section>
  )
}
