// Captures marketing screenshots of Gitr without running Tauri.
//
// The UI runs in headless Chromium against a Vite dev server, on the design preview
// (ui/preview.html), whose mock backend serves synthetic repositories. What you see is the
// real UI; only the repositories are made up. See ui/src/preview/README.md.
//
//   pnpm screenshots                 # every theme and scene
//   pnpm screenshots repo            # just the named scene(s)
//
// Writes, for each theme × scene, to tools/screenshots/out/ (not committed), for looking at:
//   raw/<scene>-<theme>.png   the window's content, 2800×1800
//   <scene>-<theme>.webp      the window on a backdrop
// and copies the framed shots the README shows (PUBLISHED) to docs/screenshots/, which is
// committed.
//
// Gitr has no native title bar: it draws its own caption buttons, so the shot is the whole window.
//
// First run needs a browser: `pnpm exec playwright install chromium`
// (add `--with-deps` on a fresh Linux box).
import { chromium } from 'playwright'
import { createServer } from 'vite-plus'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const UI = join(ROOT, 'ui')
const DOCS = join(ROOT, 'docs', 'screenshots')
const OUT = join(HERE, 'out')

// Window size in CSS px (the default from tauri.conf.json); captured at 2x.
const W = 1400
const H = 900

const THEMES = ['light', 'dark']

// The shots README.md shows; only these are committed.
const PUBLISHED = ['dashboard-light', 'repo-dark', 'history-light']
// WebP quality for the framed shots: text stays sharp at 4x zoom, at ~40% of the PNG's size.
const WEBP_QUALITY = 0.95

// Preview URL parameters per scene; see the table in ui/src/preview/README.md.
const SCENES = {
  dashboard: { scenario: 'default' },
  // `layout` is not a preview parameter: it sets the remembered dashboard layout (compact cards by default).
  'dashboard-detailed': { scenario: 'default', layout: 'detailed' },
  'dashboard-table': { scenario: 'default', layout: 'table' },
  repo: { scenario: 'default', view: 'repo', repo: 'billing-service', file: 'InvoiceExporter.cs', message: 'Export invoices as CSV and PDF' },
  history: { scenario: 'default', view: 'repo', repo: 'billing-service', tab: 'history' },
  // `diff` is not a preview parameter: it sets the remembered diff mode before the page loads.
  split: { scenario: 'default', view: 'repo', repo: 'billing-service', file: 'InvoiceExporter.cs', diff: 'split' },
  // `extent` is not a preview parameter either: it sets the remembered Hunks / Full file choice.
  'full-file': { scenario: 'default', view: 'repo', repo: 'billing-service', file: 'InvoiceExporter.cs', extent: 'full' },
  conflict: { scenario: 'default', view: 'repo', repo: 'identity-server' },
  busy: { scenario: 'many', view: 'repo', repo: 'scheduler' },
  settings: { scenario: 'default', view: 'settings' },
  // `section` is not a preview parameter: it scrolls Settings to that section before the shot.
  'settings-appearance': { scenario: 'default', view: 'settings', section: 'appearance' },
  'first-run': { scenario: 'empty' },
  // `wait` is not a preview parameter: the update check runs 5 s after startup.
  update: { scenario: 'default', update: 'available', wait: 5800 },
}

// The app bundles its own fonts. The drawn title bar uses Inter, a stand-in for Segoe UI there.
const FONTS = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500&display=block'

// Title bar colours (Windows 11 defaults) and backdrop: two glows and a base, from the app palette.
const LOOK = {
  light: { glows: ['#9fb59a', '#8c9bd8'], base: '#e8eae3' },
  dark: { glows: ['#3d4a3c', '#3a4380'], base: '#101210' },
}

async function captureRaw(browser, url, theme, { diff, extent, layout, section, wait, ...params }, out) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
  if (diff) await ctx.addInitScript((mode) => localStorage.setItem('diffMode', mode), diff)
  if (extent) await ctx.addInitScript((e) => localStorage.setItem('diffExtent', e), extent)
  if (layout) await ctx.addInitScript((v) => localStorage.setItem('layout', JSON.stringify({ dashboardView: v })), layout)
  const page = await ctx.newPage()
  const q = new URLSearchParams({ chrome: '0', theme, ...params })
  await page.goto(`${url}preview.html?${q}`)
  await page.addStyleTag({ url: FONTS })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForSelector('#root > *')
  // The preview selects the file and fills the commit box after 400 ms; let that and the diff land.
  await page.waitForTimeout(wait ?? (params.view === 'repo' ? 1200 : 600))
  if (section) await page.evaluate((id) => document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start' }), section)
  await page.mouse.move(W - 5, H - 5)
  await page.screenshot({ path: out })
  await ctx.close()
}

async function frame(page, theme, rawPath, out) {
  const { glows: [a, b], base } = LOOK[theme]
  const img = readFileSync(rawPath).toString('base64')
  await page.setContent(`<!doctype html><link rel="stylesheet" href="${FONTS}"><style>
    html, body { margin: 0; height: 100%; }
    body {
      display: grid; place-items: center;
      background:
        radial-gradient(1200px 800px at 12% 8%, ${a}aa, transparent 60%),
        radial-gradient(1000px 800px at 92% 96%, ${b}88, transparent 60%),
        ${base};
    }
    .win {
      width: ${W}px; height: ${H}px; border-radius: 8px; overflow: hidden;
      box-shadow: 0 0 0 1px rgba(0,0,0,.25), 0 2px 6px rgba(0,0,0,.18), 0 30px 80px rgba(0,0,0,.40);
    }
    .win > img { display: block; width: ${W}px; height: ${H}px; }
  </style>
  <div class="win">
    <img src="data:image/png;base64,${img}">
  </div>`)
  await page.evaluate(() => document.fonts.ready)
  writeFileSync(out, await webp(page, await page.screenshot()))
}

// Chromium only screenshots PNG and JPEG; its canvas encodes WebP.
async function webp(page, png) {
  const data = await page.evaluate(
    async ([b64, quality]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      return canvas.toDataURL('image/webp', quality).split(',')[1]
    },
    [png.toString('base64'), WEBP_QUALITY],
  )
  return Buffer.from(data, 'base64')
}

const args = process.argv.slice(2)
const scenes = args.length ? args : Object.keys(SCENES)
for (const s of scenes) if (!SCENES[s]) throw new Error(`Unknown scene "${s}"; pick from: ${Object.keys(SCENES).join(', ')}`)
for (const dir of [DOCS, join(OUT, 'raw')]) mkdirSync(dir, { recursive: true })

// Off 5173 and not strict, so this can run next to `pnpm dev`.
const server = await createServer({ root: UI, configFile: join(UI, 'vite.config.ts'), logLevel: 'warn', server: { port: 5174, strictPort: false } })
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch()

try {
  const framePage = await browser.newPage({ viewport: { width: W + 160, height: H + 160 }, deviceScaleFactor: 2 })
  for (const theme of THEMES) {
    for (const scene of scenes) {
      const name = `${scene}-${theme}`
      const raw = join(OUT, 'raw', `${name}.png`)
      const framed = join(OUT, `${name}.webp`)
      await captureRaw(browser, url, theme, SCENES[scene], raw)
      await frame(framePage, theme, raw, framed)
      if (PUBLISHED.includes(name)) copyFileSync(framed, join(DOCS, `${name}.webp`))
      console.log(`${name}.webp${PUBLISHED.includes(name) ? '  (published)' : ''}`)
    }
  }
} finally {
  await browser.close()
  await server.close()
}
