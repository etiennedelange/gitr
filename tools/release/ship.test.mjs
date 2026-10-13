// pnpm test:tools (node --test)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, hasNotes, nextVersion, versionProblem } from './ship.mjs';

test('compareVersions follows semver precedence', () => {
  const ordered = ['0.1.0', '0.1.1', '0.2.0-alpha', '0.2.0-alpha.1', '0.2.0-alpha.beta', '0.2.0-beta.2', '0.2.0-beta.11', '0.2.0', '0.10.0', '1.0.0'];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(compareVersions(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.equal(compareVersions(ordered[i + 1], ordered[i]), 1, `${ordered[i + 1]} > ${ordered[i]}`);
  }
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('versionProblem refuses a tagged or older version', () => {
  const tags = ['v0.1.0', 'v0.2.0', 'not-a-version'];
  assert.equal(versionProblem('0.2.1', tags), null);
  assert.equal(versionProblem('0.3.0-beta.1', tags), null);
  assert.equal(versionProblem('0.2.0', tags), 'v0.2.0 is already tagged');
  assert.equal(versionProblem('0.1.5', tags), '0.1.5 is older than the newest tag, v0.2.0');
  assert.equal(versionProblem('0.1.0', []), null);
});

test('hasNotes needs entries under [Unreleased] or the version', () => {
  const empty = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-11\n\n### Added\n- Old\n';
  assert.equal(hasNotes(empty, '0.1.1'), false);
  assert.equal(hasNotes(empty.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n- A fix\n'), '0.1.1'), true);
  // An earlier run already dated the section.
  assert.equal(hasNotes('## [Unreleased]\n\n## [0.1.1] - 2026-10-12\n\n- A fix\n', '0.1.1'), true);
  // Headings alone are not notes.
  assert.equal(hasNotes('## [Unreleased]\n\n### Added\n\n## [0.1.0]\n- Old\n', '0.1.1'), false);
});

test('nextVersion bumps the newest tag, not the checkout', () => {
  // v0.1.3 was tagged but its release reverted, so Cargo.toml still says 0.1.2.
  const tags = ['v0.1.0', 'v0.1.3', 'v0.1.2', 'not-a-version'];
  assert.equal(nextVersion(tags, '0.1.2'), '0.1.4');
  assert.equal(nextVersion(tags, '0.1.2', 'minor'), '0.2.0');
  assert.equal(nextVersion(tags, '0.1.2', 'major'), '1.0.0');
  assert.equal(nextVersion([], '0.1.0'), '0.1.1');
  // Every result is releasable after those tags.
  for (const bump of ['patch', 'minor', 'major']) assert.equal(versionProblem(nextVersion(tags, '0.1.2', bump), tags), null);
});

test('nextVersion finishes a pre-release', () => {
  assert.equal(nextVersion(['v1.2.0-beta.1'], '1.2.0-beta.1'), '1.2.0');
  assert.equal(nextVersion(['v1.2.0-beta.1'], '1.2.0-beta.1', 'minor'), '1.2.0');
  assert.equal(nextVersion(['v1.2.0-beta.1'], '1.2.0-beta.1', 'major'), '2.0.0');
  assert.equal(nextVersion(['v2.0.0-rc.1'], '2.0.0-rc.1', 'major'), '2.0.0');
  assert.equal(nextVersion(['v1.2.3-rc.1'], '1.2.3-rc.1', 'minor'), '1.3.0');
});
