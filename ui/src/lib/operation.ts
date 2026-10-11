import type { Operation } from '../types'

/** The git subcommand that owns the state: "merge", "rebase", "cherry-pick", "revert", "bisect", "am" */
export function operationCommand(op: Operation): string {
  switch (op) {
    case 'merging':
      return 'merge'
    case 'rebasing':
      return 'rebase'
    case 'cherry-picking':
      return 'cherry-pick'
    case 'reverting':
      return 'revert'
    case 'bisecting':
      return 'bisect'
    case 'applying-patches':
      return 'am'
  }
}

/** "merge", "rebase", "cherry-pick", "revert", "bisect", "patch series" (for "the {noun}") */
export function operationNoun(op: Operation): string {
  return op === 'applying-patches' ? 'patch series' : operationCommand(op)
}

/** "Merge in progress", "Applying patches (git am)" */
export function operationTitle(op: Operation): string {
  if (op === 'applying-patches') return 'Applying patches (git am)'
  const noun = operationNoun(op)
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} in progress`
}

/** A bisect goes on by marking commits good or bad, not with `--continue`. */
export const canContinue = (op: Operation) => op !== 'bisecting'

/** `--skip` drops the commit it stopped on; a merge has none, `bisect skip` means something else. */
export const canSkip = (op: Operation) => op === 'rebasing' || op === 'cherry-picking' || op === 'reverting' || op === 'applying-patches'
