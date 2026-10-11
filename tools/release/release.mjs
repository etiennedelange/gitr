#!/usr/bin/env node
// Release helper. No dependencies, so it runs before `pnpm install`.
//
//   node tools/release/release.mjs version 0.2.0   set the app version and date the CHANGELOG section
//   node tools/release/release.mjs check v0.2.0    fail unless the tag matches the version in Cargo.toml
//   node tools/release/release.mjs notes 0.2.0     print that version's CHANGELOG section (release notes)
//   node tools/release/release.mjs updater-manifest 0.2.0 <setup.exe> <setup.exe.sig>
//                                                  print latest.json for the in-app updater
//
// The version lives in one place, [workspace.package] in Cargo.toml. tauri.conf.json has no
// version, so Tauri takes it from src-tauri's Cargo.toml, which inherits the workspace one.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    default:
      fail('usage: release.mjs version <x.y.z> | check <vX.Y.Z> | notes <x.y.z> | updater-manifest <x.y.z> <exe> <sig>');
  }
}

// Imported by release.test.mjs: no command runs then. (import.meta.main needs Node 24.2.)
if (import.meta.main) main(process.argv.slice(2));
