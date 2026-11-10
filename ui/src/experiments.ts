import { useSyncExternalStore } from 'react'

// Experimental features, off until switched on in Settings → Experiments. Each is remembered on
// this computer only (like the theme), and applies right away without Save.

const KEY = 'expDiffSpotlight'

const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on'
  } catch {
    return false
  }
}

export function setDiffSpotlight(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, 'on')
    else localStorage.removeItem(KEY)
  } catch {
    // Storage unavailable: the choice then lasts until the page closes.
    memory = on
  }
  listeners.forEach((fn) => fn())
}

let memory = false

/** Spotlight diff: unchanged lines recede, removed code is struck through, the hovered row lights up. */
export function useDiffSpotlight(): boolean {
  return useSyncExternalStore(subscribe, () => load() || memory)
}
