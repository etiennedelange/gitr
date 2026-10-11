import { Menu } from '@tauri-apps/api/menu'
import { api } from './api'
import { notifyError } from './hooks'
import { withInspect, type MenuEntry } from './lib/menus'
import { useApp } from './store'

const toOptions = (e: MenuEntry) =>
  e.kind === 'separator'
    ? { item: 'Separator' as const }
    : e.kind === 'predefined'
      ? { item: e.item, text: e.text }
      : { id: e.id, text: e.text, enabled: e.enabled, action: () => e.action() }

/** Shows a native context menu at the cursor. Adds "Inspect" when dev tools are available. */
export async function showMenu(items: MenuEntry[]) {
  const all = withInspect(items, useApp.getState().devtools, () => void api.openDevtools().catch(notifyError))
  if (!all.length) return
  try {
    const menu = await Menu.new({ items: all.map(toOptions) })
    await menu.popup()
  } catch (e) {
    notifyError(e)
  }
}

/** Writes text to the clipboard, falling back to execCommand if the async API is unavailable. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}
