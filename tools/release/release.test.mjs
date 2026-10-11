// pnpm test:tools (node --test)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changelogSection, updaterManifest } from './release.mjs';

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
