#!/usr/bin/env node
// Release helper. No dependencies, so it runs before `pnpm install`.
//
//   node tools/release/release.mjs version 0.2.0   set the app version and date the CHANGELOG section
//   node tools/release/release.mjs check v0.2.0    fail unless the tag matches the version in Cargo.toml
//   node tools/release/release.mjs notes 0.2.0     print that version's CHANGELOG section (release notes)
//
// The version lives in one place, [workspace.package] in Cargo.toml. tauri.conf.json has no
// version, so Tauri takes it from src-tauri's Cargo.toml, which inherits the workspace one.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

function readVersion() {
  const match = readFileSync(cargoToml, 'utf8').match(WORKSPACE_VERSION);
  if (!match) fail('no version in [workspace.package] in Cargo.toml');
  return match[2];
}

function parseVersion(arg) {
  const version = (arg ?? '').replace(/^v/, '');
  if (!SEMVER.test(version)) fail(`"${arg ?? ''}" is not a version like 1.2.0 or 1.2.0-beta.1`);
  return version;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The lines under "## [version]" up to the next "## " heading.
function changelogSection(text, version) {
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

function setVersion(version) {
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

const [command, arg] = process.argv.slice(2);
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
  default:
    fail('usage: release.mjs version <x.y.z> | check <vX.Y.Z> | notes <x.y.z>');
}
