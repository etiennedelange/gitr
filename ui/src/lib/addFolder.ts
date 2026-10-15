import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { open } from '@tauri-apps/plugin-dialog'
import { api } from '../api'
import { notifyError, useRescan } from '../hooks'
import { useApp } from '../store'
import type { Config, Group, RepoEntry } from '../types'
import { nextGroupColor } from './groupColor'

/** "D:\Repos\" → "Repos". */
export const folderName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p

/** Windows paths compare without case, slash style or a trailing separator. */
const norm = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase()

/** The group whose folders already cover `dir` (the same folder, one inside it, or one around it). */
export function overlapping(groups: Group[], dir: string): { group: Group; root: string } | null {
  const d = norm(dir)
  for (const group of groups) {
    for (const root of group.roots) {
      const r = norm(root)
      if (d === r || d.startsWith(r + '\\') || r.startsWith(d + '\\')) return { group, root }
    }
  }
  return null
}

export const pickFolder = async () => {
  const dir = await open({ directory: true, multiple: false, title: 'Choose a folder containing repositories' })
  return typeof dir === 'string' ? dir : null
}

/**
 * Adds a folder of repositories from anywhere in the app: as a new group named after the folder,
 * or to an existing group. Saves the settings straight away and rescans, so the repositories
 * appear without a trip to Settings. Unsaved Settings edits keep the new folder too.
 */
export function useAddFolder() {
  const qc = useQueryClient()
  const rescan = useRescan()
  const [pending, setPending] = useState(false)

  const add = async (groupId?: string) => {
    const saved = qc.getQueryData<Config>(['config'])
    if (!saved || pending) return
    const dir = await pickFolder()
    if (!dir) return
    const { toast } = useApp.getState()
    const clash = overlapping(saved.groups, dir)
    if (clash) {
      toast(
        'info',
        norm(clash.root) === norm(dir)
          ? `${dir} is already in ${clash.group.name}`
          : `${dir} overlaps ${clash.root} in ${clash.group.name}. Change the folders in Settings.`,
      )
      return
    }
    const target = groupId ? saved.groups.find((g) => g.id === groupId) : undefined
    const added: Group = target
      ? { ...target, roots: [...target.roots, dir] }
      : { id: crypto.randomUUID(), name: folderName(dir), roots: [dir], color: nextGroupColor(saved.groups) }
    const withFolder = (c: Config): Config => ({
      ...c,
      groups: target ? c.groups.map((g) => (g.id === target.id ? { ...g, roots: [...g.roots, dir] } : g)) : [...c.groups, added],
    })
    const next = withFolder(saved)
    const inGroup = (repos: RepoEntry[] | undefined) => (repos ?? []).filter((r) => r.groupId === added.id).length
    const before = inGroup(qc.getQueryData<RepoEntry[]>(['repos']))
    setPending(true)
    try {
      await api.saveConfig(next)
      qc.setQueryData(['config'], next)
      // Edits left unsaved in Settings carry the new folder, so a later Save doesn't drop it. The
      // base must be the cached object itself: Settings only resumes a draft whose base is.
      const draft = useApp.getState().settingsDraft
      const base = qc.getQueryData<Config>(['config']) ?? next
      useApp.getState().setSettingsDraft(draft ? { base, draft: withFolder(draft.draft) } : null)
    } catch (e) {
      notifyError(e)
      setPending(false)
      return
    }
    try {
      // The rescan reports its own failure; the folder is saved either way.
      const repos = await rescan.mutateAsync().catch(() => null)
      if (!repos) return
      const found = inGroup(repos) - before
      const where = target ? ` to ${target.name}` : ''
      toast(
        'info',
        found
          ? `Added ${folderName(dir)}${where}: ${found} ${found === 1 ? 'repository' : 'repositories'}`
          : `Added ${folderName(dir)}${where}. No repositories found in it yet.`,
      )
    } finally {
      setPending(false)
    }
  }

  return { add, pending: pending || rescan.isPending }
}
