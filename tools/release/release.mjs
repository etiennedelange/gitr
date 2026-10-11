#!/usr/bin/env node
// Release helper. No dependencies, so it runs before `pnpm install`.
//
//   node tools/release/release.mjs version 0.2.0   set the app version and date the CHANGELOG section
//   node tools/release/release.mjs check v0.2.0    fail unless the tag matches the version in Cargo.toml
//   node tools/release/release.mjs notes 0.2.0     print that version's CHANGELOG section (release notes)
//   node tools/release/release.mjs updater-manifest 0.2.0 <setup.exe> <setup.exe.sig>
//                                                  print latest.json for the in-app updater
//   node tools/release/release.mjs skip-ci <base> <head>
//                                                  print true if base..head changes nothing CI tests:
//                                                  only Markdown files, or a release's version bump
//
// The version lives in one place, [workspace.package] in Cargo.toml. tauri.conf.json has no
// version, so Tauri takes it from src-tauri's Cargo.toml, which inherits the workspace one.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cargoToml = join(root, 'Cargo.toml');
const changelog = join(root, 'CHANGELOG.md');

// Semver without build metadata; a pre-release (0.2.0-beta.1) becomes a GitHub pre-release.
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const WORKSPACE_VERSION = /(\[workspace\.package\][^[]*?\nversion\s*=\s*")([^"]+)(")/;

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

export function readVersion() {
  const match = readFileSync(cargoToml, 'utf8').match(WORKSPACE_VERSION);
  if (!match) fail('no version in [workspace.package] in Cargo.toml');
  return match[2];
}

export function parseVersion(arg) {
  const version = (arg ?? '').replace(/^v/, '');
  if (!SEMVER.test(version)) fail(`"${arg ?? ''}" is not a version like 1.2.0 or 1.2.0-beta.1`);
  return version;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The lines under "## [version]" up to the next "## " heading.
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const heading = new RegExp(`^## \\[${escape(version)}\\]`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

// Where the release workflow uploads the installer; the updater downloads it from there.
export const RELEASES = 'https://github.com/etiennedelange/gitr/releases';

// latest.json, read by tauri-plugin-updater from releases/latest/download/latest.json.
// `signature` is the content of the .sig file that `tauri build` writes next to the installer.
export function updaterManifest({ version, notes, exe, signature, date = new Date() }) {
  return {
    version,
    notes: notes ?? '',
    pub_date: date.toISOString(),
    platforms: {
      'windows-x86_64': {
        url: `${RELEASES}/download/v${version}/${encodeURIComponent(basename(exe))}`,
        signature: signature.trim(),
      },
    },
  };
}

// The files a release PR touches. CHANGELOG.md may change freely; it isn't code.
const RELEASE_FILES = new Set(['Cargo.toml', 'Cargo.lock', 'CHANGELOG.md']);

// Cargo.lock with the workspace crates' versions blanked: they have no `source` line, every
// crate from crates.io or git has one.
function lockWithoutWorkspaceVersions(text) {
  return text
    .split(/\n(?=\[\[package\]\])/)
    .map((block) => (/^source = /m.test(block) ? block : block.replace(/^version = ".*"$/m, 'version = "*"')))
    .join('\n');
}

// Whether a change only sets the app version (Cargo.toml's [workspace.package] and the workspace
// crates in Cargo.lock) and edits the CHANGELOG, as `release.mjs version` does. `files` are the
// changed paths; `before` and `after` read a path's content on each side (null if missing).
export function versionOnlyChange(files, before, after) {
  if (!files.length || files.some((f) => !RELEASE_FILES.has(f))) return false;
  const same = (file, normalize) => {
    const [a, b] = [before(file), after(file)];
    return a !== null && b !== null && normalize(a) === normalize(b);
  };
  const blankVersion = (text) => text.replace(WORKSPACE_VERSION, '$1*$3');
  return (
    (!files.includes('Cargo.toml') || same('Cargo.toml', blankVersion)) &&
    (!files.includes('Cargo.lock') || same('Cargo.lock', lockWithoutWorkspaceVersions))
  );
}

// Whether CI has nothing to build or test in a change: it touches only Markdown files (docs,
// the CHANGELOG; the UI formatter ignores *.md too), plus at most a release's version bump.
export function nothingToTest(files, before, after) {
  if (!files.length) return false;
  const rest = files.filter((f) => !f.toLowerCase().endsWith('.md'));
  return !rest.length || versionOnlyChange(rest, before, after);
}

export function setVersion(version) {
  const current = readVersion();
  writeFileSync(cargoToml, readFileSync(cargoToml, 'utf8').replace(WORKSPACE_VERSION, `$1${version}$3`));
  // Updates only the workspace crates' entries in Cargo.lock.
  execFileSync('cargo', ['update', '--workspace', '--offline'], { cwd: root, stdio: 'inherit' });

  const text = readFileSync(changelog, 'utf8');
  if (changelogSection(text, version) !== null) {
    console.log(`CHANGELOG.md already has a [${version}] section; left as it is.`);
  } else if (!/^## \[Unreleased\]/m.test(text)) {
    fail('CHANGELOG.md has no "## [Unreleased]" heading');
  } else {
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(changelog, text.replace(/^## \[Unreleased\]/m, `## [Unreleased]\n\n## [${version}] - ${date}`));
  }
  console.log(`Version ${current} -> ${version}. Review the diff, open a PR, squash-merge it, then tag v${version} on main.`);
}

function main([command, arg, ...rest]) {
  switch (command) {
    case 'version':
      setVersion(parseVersion(arg));
      break;
    case 'check': {
      const version = parseVersion(arg);
      const current = readVersion();
      if (current !== version) fail(`tag ${arg} does not match version ${current} in Cargo.toml`);
      console.log(version);
      break;
    }
    case 'notes': {
      const version = parseVersion(arg);
      const section = changelogSection(readFileSync(changelog, 'utf8'), version);
      if (!section) fail(`CHANGELOG.md has no entries under "## [${version}]"`);
      console.log(section);
      break;
    }
    case 'updater-manifest': {
      const version = parseVersion(arg);
      const [exe, sig] = rest;
      if (!exe || !sig) fail('usage: release.mjs updater-manifest <x.y.z> <setup.exe> <setup.exe.sig>');
      const notes = changelogSection(readFileSync(changelog, 'utf8'), version);
      const manifest = updaterManifest({ version, notes, exe, signature: readFileSync(sig, 'utf8') });
      console.log(JSON.stringify(manifest, null, 2));
      break;
    }
    case 'skip-ci': {
      const [base, head] = [arg, rest[0]];
      if (!base || !head) fail('usage: release.mjs skip-ci <base> <head>');
      const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      const show = (rev) => (file) => {
        try {
          return git('show', `${rev}:${file}`);
        } catch {
          return null;
        }
      };
      const files = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
      console.log(nothingToTest(files, show(base), show(head)));
      break;
    }
    default:
      fail('usage: release.mjs version <x.y.z> | check <vX.Y.Z> | notes <x.y.z> | updater-manifest <x.y.z> <exe> <sig> | skip-ci <base> <head>');
  }
}

// Imported by the tests: no command runs then. import.meta.main needs Node 24.2; CI runners may
// run this with their own older Node, so compare the script path there.
const isMain = import.meta.main ?? (!!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url);
if (isMain) main(process.argv.slice(2));
