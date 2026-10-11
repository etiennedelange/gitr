// Minimal WebDriver client for tauri-driver (plain HTTP, no deps).
import { writeFileSync } from 'node:fs'
const BASE = 'http://127.0.0.1:4444'
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json()
  if (j.value && j.value.error) throw new Error(`${path}: ${j.value.error} ${j.value.message}`)
  return j.value
}
export async function session(app) {
  const v = await call('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: app } } } })
  const id = v.sessionId
  const s = {
    js: (script, ...args) => call('POST', `/session/${id}/execute/sync`, { script, args }),
    shot: async (file) => writeFileSync(file, Buffer.from(await call('GET', `/session/${id}/screenshot`), 'base64')),
    quit: () => call('DELETE', `/session/${id}`).catch(() => {}),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
  s.text = (sel) => s.js(`const e = document.querySelector(arguments[0]); return e ? e.textContent : null`, sel)
  s.texts = (sel) => s.js(`return [...document.querySelectorAll(arguments[0])].map(e => e.textContent)`, sel)
  /** Clicks the button whose text or aria-label matches. */
  s.click = (re) => s.js(`const re = new RegExp(arguments[0]); const b = [...document.querySelectorAll('button')].find(b => re.test(b.getAttribute('aria-label') || '') || re.test(b.textContent.trim())); if (!b) return false; b.click(); return true`, re)
  s.waitFor = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await s.sleep(200) } }
  return s
}
