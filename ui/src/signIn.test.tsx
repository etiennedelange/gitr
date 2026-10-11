import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useApp } from './store'
import type { BatchOp, BatchProgress, RepoSummary } from './types'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('./api', () => ({
  api: { runBatch: vi.fn() },
  errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e),
  errorDetail: () => null,
  asCmdError: () => null,
}))

const { api } = await import('./api')
const { SignInBanner } = await import('./components/SignInBanner')
const { useBatch } = await import('./hooks')

const ok = (path: string, op: BatchOp = 'fetch'): BatchProgress => ({ path, op, state: 'ok', message: null, kind: null, signIn: false })
const needsSignIn = (path: string, op: BatchOp = 'fetch'): BatchProgress => ({
  path,
  op,
  state: 'error',
  message: 'Sign-in needed',
  kind: 'auth',
  signIn: true,
})
const refused = (path: string, op: BatchOp = 'fetch'): BatchProgress => ({
  path,
  op,
  state: 'error',
  message: 'The remote refused access',
  kind: 'auth',
  signIn: false,
})
const setBatch = (...ps: BatchProgress[]) => useApp.setState({ batch: Object.fromEntries(ps.map((p) => [p.path, p])) })
/** Repo → server, through the summary's remote like the real dashboard data. */
/** `server` is "host/owner", e.g. "dev.azure.com/acme". */
const onServer = (map: Record<string, string>) =>
  useApp.setState({
    summaries: Object.fromEntries(
      Object.entries(map).map(([p, server]) => {
        const [host, owner = 'x'] = server.split('/')
        return [p, { path: p, remote: { webUrl: `https://${host}/${owner}/r`, owner } } as unknown as RepoSummary]
      }),
    ),
  })
const calls = () => vi.mocked(api.runBatch).mock.calls.map(([op, paths, interactive]) => [op, paths, !!interactive])
const clickSignIn = () => act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })))

beforeEach(() => {
  vi.clearAllMocks()
  useApp.setState({ batch: {}, summaries: {}, toasts: [], signingIn: false, signInDismissed: false })
})
afterEach(cleanup)

describe('sign-in banner', () => {
  it('signs in once per server: one interactive run, then the rest without prompting', async () => {
    onServer({ 'C:/w/a': 'ado', 'C:/w/b': 'ado', 'C:/w/c': 'github' })
    setBatch(needsSignIn('C:/w/a'), needsSignIn('C:/w/b'), needsSignIn('C:/w/c', 'pull'), ok('C:/w/d'))
    const signedIn = new Set<string>()
    const host = (p: string) => (p === 'C:/w/c' ? 'github' : 'ado')
    vi.mocked(api.runBatch).mockImplementation(async (op: BatchOp, paths: string[], interactive?: boolean) => {
      if (interactive) paths.forEach((p) => signedIn.add(host(p)))
      return paths.map((p) => (signedIn.has(host(p)) ? ok(p, op) : needsSignIn(p, op)))
    })
    render(<SignInBanner running={false} />)
    expect(screen.getByRole('alert')).toHaveTextContent('3 repositories need you to sign in')
    await clickSignIn()
    expect(calls()).toEqual([
      ['fetch', ['C:/w/a'], true],
      ['fetch', ['C:/w/b'], false],
      ['pull', ['C:/w/c'], false],
      ['pull', ['C:/w/c'], true],
    ])
    expect(screen.queryByRole('alert')).toBeNull()
    expect(useApp.getState().toasts.map((t) => t.kind)).toEqual(['info'])
  })

  it('a failed sign-in does not stop the others, and each server gets at most one window', async () => {
    // "bad" fails every time (no access); a and a2 share its server, b is elsewhere.
    onServer({
      'C:/w/bad': 'dev.azure.com/acme',
      'C:/w/a': 'dev.azure.com/acme',
      'C:/w/a2': 'dev.azure.com/acme',
      'C:/w/b': 'github.com/me',
    })
    setBatch(needsSignIn('C:/w/bad'), needsSignIn('C:/w/a'), needsSignIn('C:/w/a2'), needsSignIn('C:/w/b'))
    vi.mocked(api.runBatch).mockImplementation(async (op: BatchOp, paths: string[]) =>
      paths.map((p) => (p === 'C:/w/bad' ? needsSignIn(p, op) : ok(p, op))),
    )
    render(<SignInBanner running={false} />)
    await clickSignIn()
    const interactive = calls().filter((c) => c[2])
    expect(interactive).toEqual([['fetch', ['C:/w/bad'], true]])
    expect(calls()[1]).toEqual(['fetch', ['C:/w/bad', 'C:/w/a', 'C:/w/a2', 'C:/w/b'], false])
    expect(
      Object.values(useApp.getState().batch)
        .filter((p) => p.signIn)
        .map((p) => p.path),
    ).toEqual(['C:/w/bad'])
    const toast = useApp.getState().toasts[0]
    expect(toast).toMatchObject({ kind: 'error', message: "Signing in didn't work everywhere. 1 repository still needs a sign-in." })
    expect(toast.detail).toContain('bad: Sign-in needed')
  })

  it('a skipped interactive run is not taken for a successful sign-in', async () => {
    setBatch(needsSignIn('C:/w/a'))
    vi.mocked(api.runBatch).mockImplementation(async (op: BatchOp, paths: string[], interactive?: boolean) =>
      interactive ? [{ ...ok(paths[0], op), state: 'skipped', message: 'Stopped fetching.' }] : paths.map((p) => needsSignIn(p, op)),
    )
    render(<SignInBanner running={false} />)
    await clickSignIn()
    expect(useApp.getState().toasts[0]).toMatchObject({ kind: 'error' })
    expect(useApp.getState().toasts[0].detail).toContain('Stopped fetching.')
  })

  it('a backend error ends Sign in with an error toast and re-enables the button', async () => {
    setBatch(needsSignIn('C:/w/a'))
    vi.mocked(api.runBatch).mockRejectedValue({ message: 'Unknown repository' })
    render(<SignInBanner running={false} />)
    await clickSignIn()
    expect(useApp.getState().toasts.map((t) => [t.kind, t.message])).toEqual([['error', 'Unknown repository']])
    expect(useApp.getState().signingIn).toBe(false)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  it('stays up, disabled, while Sign in runs, even when no repo is marked for a moment', async () => {
    setBatch(needsSignIn('C:/w/a'))
    let finish!: (r: BatchProgress[]) => void
    vi.mocked(api.runBatch).mockImplementationOnce(() => new Promise((r) => (finish = r)))
    render(<SignInBanner running={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    // The backend reports the repo as running again, so for a moment nothing "needs sign-in".
    act(() => useApp.getState().setBatch({ ...ok('C:/w/a'), state: 'running' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Signing in…')
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled()
    vi.mocked(api.runBatch).mockResolvedValue([])
    await act(async () => finish([ok('C:/w/a')]))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Dismiss closes the banner but keeps every row result', () => {
    setBatch(needsSignIn('C:/w/a'), ok('C:/w/b'))
    const { rerender } = render(<SignInBanner running />)
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(<SignInBanner running={false} />)
    expect(screen.getByRole('alert')).toHaveTextContent('1 repository needs you to sign in')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss sign-in reminder' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(Object.keys(useApp.getState().batch)).toEqual(['C:/w/a', 'C:/w/b'])
    useApp.getState().clearBatch()
    expect(useApp.getState().signInDismissed).toBe(false)
  })

  it('each Azure DevOps organisation is its own server, though all are on dev.azure.com', async () => {
    onServer({ 'C:/w/a': 'dev.azure.com/acme', 'C:/w/a2': 'dev.azure.com/acme', 'C:/w/b': 'dev.azure.com/Globex' })
    setBatch(needsSignIn('C:/w/a'), needsSignIn('C:/w/a2'), needsSignIn('C:/w/b'))
    const signedIn = new Set<string>()
    const org = (p: string) => (p === 'C:/w/b' ? 'globex' : 'acme')
    vi.mocked(api.runBatch).mockImplementation(async (op: BatchOp, paths: string[], interactive?: boolean) => {
      if (interactive) paths.forEach((p) => signedIn.add(org(p)))
      return paths.map((p) => (signedIn.has(org(p)) ? ok(p, op) : needsSignIn(p, op)))
    })
    render(<SignInBanner running={false} />)
    await clickSignIn()
    expect(calls().filter((c) => c[2])).toEqual([
      ['fetch', ['C:/w/a'], true],
      ['fetch', ['C:/w/b'], true],
    ])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('auth errors that a sign-in cannot fix get no banner', () => {
    setBatch(refused('C:/w/a'))
    render(<SignInBanner running={false} />)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('batch summary', () => {
  it('counts repos that need a sign-in apart from failures (a 403 is a failure)', async () => {
    vi.mocked(api.runBatch).mockResolvedValue([ok('a'), needsSignIn('b'), needsSignIn('c'), refused('d')])
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useBatch(), { wrapper })
    await act(async () => void (await result.current.mutateAsync({ op: 'fetch', paths: ['a', 'b', 'c', 'd'] })))
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual(['Fetched 1/4, 2 need sign-in, 1 failed'])
    expect(api.runBatch).toHaveBeenCalledWith('fetch', ['a', 'b', 'c', 'd'], false)
  })

  it('a single-repo action from the menu runs interactively', async () => {
    vi.mocked(api.runBatch).mockResolvedValue([ok('a')])
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useBatch(), { wrapper })
    await act(async () => void (await result.current.mutateAsync({ op: 'pull', paths: ['a'], interactive: true })))
    expect(api.runBatch).toHaveBeenCalledWith('pull', ['a'], true)
  })
})
