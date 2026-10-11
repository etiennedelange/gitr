import { useSyncExternalStore } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

/** "system" follows the Windows light/dark setting (which Windows can schedule). */
export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'theme'

// Everything showing the theme (the sidebar toggle, the Settings select) re-renders through these.
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((fn) => fn())
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

const prefersDark = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches

export function loadThemePref(): ThemePref {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  return pref === 'system' ? (prefersDark() ? 'dark' : 'light') : pref
}

/** Applies `pref` to the page and to the native title bar and menus (null = follow Windows). */
export function applyTheme(pref: ThemePref) {
  document.documentElement.dataset.theme = resolveTheme(pref)
  try {
    getCurrentWindow()
      .setTheme(pref === 'system' ? null : pref)
      .catch(() => {})
  } catch {
    // Not running inside Tauri (tests).
  }
}

export function saveThemePref(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, pref)
  } catch {
    // Storage unavailable: the choice still applies for this session.
  }
  applyTheme(pref)
  changed()
}

/** The chosen preference and the theme it shows now; follows changes from anywhere. */
export function useTheme(): { pref: ThemePref; resolved: 'light' | 'dark' } {
  const pref = useSyncExternalStore(subscribe, loadThemePref)
  const resolved = useSyncExternalStore(subscribe, () => resolveTheme(loadThemePref()))
  return { pref, resolved }
}

/** Re-applies the theme when Windows switches light/dark while "system" is chosen. */
export function watchSystemTheme(): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    if (loadThemePref() === 'system') applyTheme('system')
    changed()
  }
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
