import { List, ListTree } from 'lucide-react'
import { useLayout } from '../layout'

/** Shows changed files as a folder tree or as a flat list; the choice is shared and remembered. */
export function FileViewToggle() {
  const view = useLayout((s) => s.fileView)
  const setView = useLayout((s) => s.setFileView)
  return (
    <div className="segmented icons" role="group" aria-label="Show files as">
      <button className={view === 'tree' ? 'on' : ''} aria-pressed={view === 'tree'} title="Tree" onClick={() => setView('tree')}>
        <ListTree className="ico" aria-hidden />
        <span className="sr-only">Tree</span>
      </button>
      <button className={view === 'list' ? 'on' : ''} aria-pressed={view === 'list'} title="List" onClick={() => setView('list')}>
        <List className="ico" aria-hidden />
        <span className="sr-only">List</span>
      </button>
    </div>
  )
}
