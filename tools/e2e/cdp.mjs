// Minimal Chrome DevTools Protocol driver for the running Gitr app (a debug build started with
// GITR_E2E_DEVTOOLS_PORT=<port>, which opens the WebView2 DevTools port). No dependencies:
// uses Node's built-in fetch and WebSocket.
import { writeFileSync } from 'node:fs'

export async function connect(port, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let page
  while (!page) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost'))
    } catch {}
    if (!page) {
      if (Date.now() > deadline) throw new Error(`no app page on DevTools port ${port}`)
      await sleep(300)
    }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method, params }))
    })

  /** Evaluates `expr` in the page (awaiting promises) and returns its JSON value. */
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails
      throw new Error(d.exception?.description ?? d.text)
    }
    return r.result?.result?.value
  }

  /** Polls `expr` until it is truthy; returns its value. */
  const waitFor = async (expr, what, ms = 15000) => {
    const end = Date.now() + ms
    let last
    while (Date.now() < end) {
      try {
        last = await evaluate(expr)
        if (last) return last
      } catch (e) {
        last = e.message
      }
      await sleep(200)
    }
    throw new Error(`timed out waiting for ${what ?? expr} (last: ${JSON.stringify(last)})`)
  }

  const screenshot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  }

  return { send, evaluate, waitFor, screenshot, close: () => ws.close() }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Installed in the page: small DOM helpers. (Native dialogs can't be answered from the page:
 * `__TAURI_INTERNALS__.invoke` is non-writable. Use `answerDialog` instead.)
 */
export const PAGE_HELPERS = `
(() => {
  if (window.__e2e) return true
  const e2e = {}
  const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim()
  e2e.text = text
  e2e.button = (label, scope) => [...(scope || document).querySelectorAll('button')].find((b) => text(b).startsWith(label))
  e2e.click = (label, scope) => {
    const b = e2e.button(label, scope)
    if (!b) throw new Error('no button: ' + label)
    if (b.disabled) throw new Error('disabled: ' + label)
    b.click()
    return true
  }
  e2e.openRepo = (name) => {
    const b = [...document.querySelectorAll('.repo-item')].find((x) => x.querySelector('.repo-name') && text(x.querySelector('.repo-name')) === name)
    if (!b) throw new Error('no repo in sidebar: ' + name)
    b.click()
    return true
  }
  e2e.dashRow = (name) => [...document.querySelectorAll('.row')].find((r) => [...r.querySelectorAll('button')].some((b) => text(b) === name)) || null
  e2e.clearToasts = () => (document.querySelectorAll('.toast button[aria-label=Dismiss]').forEach((b) => b.click()), true)
  e2e.toast = (kind) => [...document.querySelectorAll('.toast' + (kind ? '.' + kind : ''))].at(-1) || null
  e2e.setInput = (input, value) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  window.__e2e = e2e
  return true
})()
`

/**
 * Answers a native dialog (message box or file picker) via Windows UI Automation
 * (tools/e2e/dialog.ps1). Returns the texts the dialog showed.
 */
export async function answerDialog({ title, button = 'Yes', fileName = '', buttonId = 0 }) {
  const { execFile } = await import('node:child_process')
  const script = new URL('./dialog.ps1', import.meta.url)
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', decodeURIComponent(script.pathname.replace(/^\//, '')), '-Title', title, '-Button', button]
  if (fileName) args.push('-FileName', fileName)
  if (buttonId) args.push('-ButtonId', String(buttonId))
  const out = await new Promise((resolve) => execFile('powershell', args, { timeout: 30000 }, (_e, stdout) => resolve(String(stdout))))
  // The dialog text can span several lines; it ends where CLICKED / NO… starts.
  const text = (out.match(/TEXT:([\s\S]*?)\r?\n(?:CLICKED|NO)/) ?? [])[1] ?? ''
  if (!/^CLICKED/m.test(out)) throw new Error(`dialog "${title}": ${out.trim()}`)
  return text
}
