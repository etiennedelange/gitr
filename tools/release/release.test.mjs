// pnpm test:tools (node --test)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changelogSection, nothingToTest, updaterManifest, versionOnlyChange } from './release.mjs';

test('latest.json points at the release asset and carries the signature', () => {
  const manifest = updaterManifest({
    version: '0.3.0',
    notes: '### Added\n- Updates',
    exe: 'target/release/bundle/nsis/Gitr_0.3.0_x64-setup.exe',
    signature: 'dW50cnVzdGVkIGNvbW1lbnQ=\n',
    date: new Date('2026-10-11T09:00:00Z'),
  });
  assert.deepEqual(manifest, {
    version: '0.3.0',
    notes: '### Added\n- Updates',
    pub_date: '2026-10-11T09:00:00.000Z',
    platforms: {
      'windows-x86_64': {
        url: 'https://github.com/etiennedelange/gitr/releases/download/v0.3.0/Gitr_0.3.0_x64-setup.exe',
        signature: 'dW50cnVzdGVkIGNvbW1lbnQ=',
      },
    },
  });
});

test('latest.json without CHANGELOG notes has empty notes', () => {
  const manifest = updaterManifest({ version: '0.3.0', notes: null, exe: 'a.exe', signature: 's' });
  assert.equal(manifest.notes, '');
  assert.match(manifest.pub_date, /^\d{4}-\d\d-\d\dT/);
});

test('changelogSection stops at the next version', () => {
  const text = '# Changelog\n\n## [Unreleased]\n\n## [0.3.0] - 2026-10-11\n\n### Added\n- Updates\n\n## [0.2.0] - 2026-09-01\n- Old';
  assert.equal(changelogSection(text, '0.3.0'), '### Added\n- Updates');
  assert.equal(changelogSection(text, '9.9.9'), null);
});

const toml = (v, extra = '') => `[workspace]\nmembers = ["src-tauri"]\n\n[workspace.package]\nversion = "${v}"\nedition = "2024"\n${extra}`;
const lock = (app, serde = '1.0.0') =>
  `version = 4\n\n[[package]]\nname = "gitr"\nversion = "${app}"\ndependencies = [\n "serde",\n]\n\n[[package]]\nname = "serde"\nversion = "${serde}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n`;
const sides = (before, after) => [(f) => before[f] ?? null, (f) => after[f] ?? null];

test('versionOnlyChange accepts what release.mjs version changes', () => {
  const [b, a] = sides(
    { 'Cargo.toml': toml('0.1.1'), 'Cargo.lock': lock('0.1.1'), 'CHANGELOG.md': '## [Unreleased]\n- x' },
    { 'Cargo.toml': toml('0.1.2'), 'Cargo.lock': lock('0.1.2'), 'CHANGELOG.md': '## [Unreleased]\n\n## [0.1.2]\n- x' },
  );
  assert.equal(versionOnlyChange(['CHANGELOG.md', 'Cargo.lock', 'Cargo.toml'], b, a), true);
  assert.equal(versionOnlyChange(['CHANGELOG.md'], b, a), true);
});

test('versionOnlyChange refuses anything else', () => {
  const before = { 'Cargo.toml': toml('0.1.1'), 'Cargo.lock': lock('0.1.1') };
  const check = (files, after) => versionOnlyChange(files, ...sides(before, after));
  // Another file.
  assert.equal(check(['Cargo.toml', 'src-tauri/src/lib.rs'], { 'Cargo.toml': toml('0.1.2') }), false);
  // Another line in Cargo.toml (a new dependency, a profile change).
  assert.equal(check(['Cargo.toml'], { 'Cargo.toml': toml('0.1.2', '\n[profile.release]\nlto = "thin"\n') }), false);
  // A dependency's version in Cargo.lock.
  assert.equal(check(['Cargo.lock'], { 'Cargo.lock': lock('0.1.1', '1.0.1') }), false);
  // A file deleted, and an empty change.
  assert.equal(check(['Cargo.lock'], {}), false);
  assert.equal(check([], {}), false);
});

test('nothingToTest skips Markdown-only changes and release bumps, nothing else', () => {
  const [b, a] = sides({ 'Cargo.toml': toml('0.1.1'), 'Cargo.lock': lock('0.1.1') }, { 'Cargo.toml': toml('0.1.2'), 'Cargo.lock': lock('0.1.2') });
  assert.equal(nothingToTest(['README.md', 'docs/releasing.md', 'ui/src/preview/README.md'], b, a), true);
  assert.equal(nothingToTest(['CHANGELOG.md', 'Cargo.toml', 'Cargo.lock'], b, a), true);
  assert.equal(nothingToTest(['docs/releasing.md', 'Cargo.toml'], b, a), true);
  // Anything else runs CI: code, workflows, screenshots, a .md-looking name that isn't one.
  assert.equal(nothingToTest(['README.md', 'src-tauri/src/lib.rs'], b, a), false);
  assert.equal(nothingToTest(['.github/workflows/ci.yml'], b, a), false);
  assert.equal(nothingToTest(['docs/screenshots/dashboard-light.webp'], b, a), false);
  assert.equal(nothingToTest(['notes.md.txt'], b, a), false);
  assert.equal(nothingToTest([], b, a), false);
});
