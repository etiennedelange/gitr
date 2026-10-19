// Writes THIRD_PARTY_NOTICES.txt: every Rust crate and npm package that ships in the Windows
// build, with its licence and the licence texts it carries. `--check` fails if the file is stale.
// No dependencies: it reads `cargo metadata` and `pnpm licenses`.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const out = join(root, 'THIRD_PARTY_NOTICES.txt')
const TARGET = 'x86_64-pc-windows-msvc'
const LICENCE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)([-._].*)?$/i

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

// On Windows `pnpm` on PATH is often pnpm.cmd, which execFileSync can't start (ENOENT). Under
// `pnpm notices` pnpm passes its own path in npm_execpath: the pnpm binary, or a script for node.
function pnpm(args) {
  const self = process.env.npm_execpath
  if (!self || !/pnpm/i.test(self)) return run('pnpm', args)
  return /\.[cm]?js$/i.test(self) ? run(process.execPath, [self, ...args]) : run(self, args)
}

// Licence files in a package's root, plus the files in a REUSE-style `LICENSES/` folder.
function licenceTexts(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => LICENCE_FILE.test(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) =>
      e.isDirectory()
        ? readdirSync(join(dir, e.name)).sort().map((f) => join(dir, e.name, f))
        : [join(dir, e.name)],
    )
    .map((f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n').trim())
    .filter(Boolean)
}

// Rust: normal (not dev or build) dependencies reachable from the workspace, for the Windows target.
function rustPackages() {
  const meta = JSON.parse(run('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', TARGET]))
  const byId = new Map(meta.packages.map((p) => [p.id, p]))
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]))
  const members = new Set(meta.workspace_members)
  const seen = new Set()
  const stack = [...members]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg)
    }
  }
  return [...seen]
    .filter((id) => !members.has(id))
    .map((id) => byId.get(id))
    .flatMap((p) => [
      {
        ecosystem: 'Rust crate',
        name: p.name,
        version: p.version,
        licence: p.license ?? p.license_file ?? 'unknown',
        source: p.repository ?? `https://crates.io/crates/${p.name}`,
        texts: licenceTexts(dirname(p.manifest_path)),
      },
      ...(p.name === 'two-face' ? twoFaceGrammars(p) : []),
    ])
}

// two-face bundles bat's syntax grammars, each under its own licence. Their texts are in the
// crate's acknowledgements file: zlib-compressed bincode of `{ for_syntaxes: Vec<License>,
// for_themes: Vec<License> }`, where `License { ty: LicenseType, text: String, rel_path: PathBuf }`.
// Gitr uses only the syntaxes.
function twoFaceGrammars(p) {
  const buf = inflateSync(readFileSync(join(dirname(p.manifest_path), 'generated', 'acknowledgements_full.bin')))
  const TYPES = ['Sublime', 'MIT', 'BSD-2-Clause', 'BSD-2-Clause-FreeBSD', 'Unlicense', 'BSD-3-Clause', 'Apache-2.0', 'WTFPL']
  let at = 0
  const u32 = () => ((at += 4), buf.readUInt32LE(at - 4))
  const u64 = () => ((at += 8), Number(buf.readBigUInt64LE(at - 8)))
  const str = () => {
    const n = u64()
    return ((at += n), buf.toString('utf8', at - n, at))
  }
  return Array.from({ length: u64() }, () => {
    const ty = TYPES[u32()]
    if (!ty) throw new Error('Unknown licence type in two-face acknowledgements; update TYPES in generate.mjs')
    const text = str().replace(/\r\n/g, '\n').trim()
    const relPath = str()
    // syntaxes/02_Extra/Kotlin/LICENSE -> Kotlin
    const grammar = relPath.split('/').slice(2, -1).join('/')
    return {
      ecosystem: `syntax grammar bundled in two-face ${p.version}`,
      name: `${grammar} grammar`,
      version: relPath,
      licence: ty,
      source: `https://codeberg.org/CosmicHarper/two-face/src/tag/v${p.version}/generated/acknowledgements_full.md`,
      texts: [text],
    }
  })
}

// npm: production dependencies of the UI, which Vite bundles into the app.
function npmPackages() {
  const byLicence = JSON.parse(pnpm(['--silent', '--filter', 'ui', 'licenses', 'list', '--prod', '--json']))
  return Object.values(byLicence)
    .flat()
    .flatMap((p) =>
      p.versions.map((version, i) => ({
        ecosystem: 'npm package',
        name: p.name,
        version,
        licence: p.license,
        source: p.homepage ?? `https://www.npmjs.com/package/${p.name}`,
        texts: existsSync(p.paths[i]) ? licenceTexts(p.paths[i]) : [],
      })),
    )
}

function render(packages) {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
  packages.sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version))
  // Many packages carry byte-identical licence texts; print each text once and refer to it.
  const textIds = new Map()
  const texts = []
  const refs = (p) =>
    p.texts.map((t) => {
      const key = createHash('sha256').update(t).digest('hex')
      if (!textIds.has(key)) {
        textIds.set(key, texts.length + 1)
        texts.push({ text: t, users: [] })
      }
      const n = textIds.get(key)
      texts[n - 1].users.push(`${p.name} ${p.version}`)
      return `[${n}]`
    })

  const lines = [
    'THIRD-PARTY NOTICES',
    '',
    'Gitr includes the third-party software listed below. Each component is used under the',
    'licence shown. The full licence texts the components ship with follow the list, numbered;',
    'the list refers to them by number. Source for every component is available at the link given.',
    '',
    'Generated by tools/notices/generate.mjs (run `pnpm notices`). Do not edit by hand.',
    '',
    '',
    'COMPONENTS',
    '==========',
    '',
  ]
  for (const p of packages) {
    const r = refs(p)
    lines.push(`${p.name} ${p.version} (${p.ecosystem})`)
    lines.push(`  Licence: ${p.licence}`)
    lines.push(`  Source:  ${p.source}`)
    lines.push(`  Texts:   ${r.length ? r.join(' ') : 'none shipped with the package; see the source link'}`)
    lines.push('')
  }
  lines.push('', 'LICENCE TEXTS', '=============', '')
  texts.forEach(({ text, users }, i) => {
    lines.push(`----- [${i + 1}] used by: ${users.join(', ')}`, '', text, '', '')
  })
  return lines.join('\n').trimEnd() + '\n'
}

const text = render([...rustPackages(), ...npmPackages()])
if (process.argv.includes('--check')) {
  // Compare ignoring line endings: a Windows checkout may have CRLF.
  const current = existsSync(out) ? readFileSync(out, 'utf8').replace(/\r\n/g, '\n') : ''
  if (current !== text) {
    console.error('THIRD_PARTY_NOTICES.txt is out of date. Run `pnpm notices` and commit the result.')
    process.exit(1)
  }
  console.log('THIRD_PARTY_NOTICES.txt is up to date.')
} else {
  writeFileSync(out, text)
  console.log(`Wrote ${out}`)
}
