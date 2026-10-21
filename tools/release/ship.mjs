#!/usr/bin/env node
// One command for a whole release (docs/releasing.md, "Cutting a release"):
//
//   pnpm release                the next patch version after the newest v* tag (v0.1.3 → 0.1.4)
//   pnpm release minor|major    the next minor (0.2.0) or major (1.0.0) version instead
//   pnpm release 0.2.0          exactly this version
//   … --yes                     without asking
//   … --no-follow               stop once the tag is pushed (the Cut release workflow does this)
//
// Asks once, then does everything below.
//
// 1. Checks: no uncommitted changes to tracked files, gh signed in, the version is new, and the
//    CHANGELOG has entries under [Unreleased].
// 2. Branch release/<version> from origin/main: `release.mjs version` (Cargo.toml, Cargo.lock,
//    the dated CHANGELOG section), commit "Release <version>", push.
// 3. PR "Release <version>" (label skip-changelog), squash auto-merge once CI is green.
// 4. Waits for the merge, tags the merge commit v<version> and pushes the tag.
// 5. Follows the Release workflow and prints the release page.
//
// Safe to run again after a failure or Ctrl+C: steps already done (branch pushed, PR open,
// PR merged, tag pushed) are picked up where they are. Needs git and gh (`gh auth login`).

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { changelogSection, parseVersion, readVersion, setVersion } from './release.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = 'etiennedelange/gitr';
// How often to look at the PR; GitHub's API allows this easily.
const POLL_MS = 10_000;
// CI on a release PR takes about a minute (Rust is skipped); a merge that hasn't happened in an hour needs a look.
const MERGE_TIMEOUT_MS = 60 * 60_000;

/** -1, 0 or 1. Semver precedence, without build metadata (like SEMVER in release.mjs). */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = v.split(/-(.*)/s);
    return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  // A pre-release comes before its release.
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const BUMPS = ['patch', 'minor', 'major'];

/** The version after the newest `v*` tag in `tags` (or after `current` when there are none), like `npm version <bump>`:
 *  a pre-release is finished by the bump that reaches it (1.2.0-beta.1 → patch or minor → 1.2.0). */
export function nextVersion(tags, current, bump = 'patch') {
  const released = tags.filter((t) => /^v\d/.test(t)).map((t) => t.slice(1));
  const base = released.sort(compareVersions).at(-1) ?? current;
  const [core, pre] = base.split(/-(.*)/s);
  let [major, minor, patch] = core.split('.').map(Number);
  if (bump === 'major') {
    if (!(pre && minor === 0 && patch === 0)) [major, minor, patch] = [major + 1, 0, 0];
  } else if (bump === 'minor') {
    if (!(pre && patch === 0)) [minor, patch] = [minor + 1, 0];
  } else if (!pre) patch += 1;
  return `${major}.${minor}.${patch}`;
}

/** Why `version` can't be released after the `v*` tags in `tags`, or null if it can. */
export function versionProblem(version, tags) {
  const released = tags.filter((t) => /^v\d/.test(t)).map((t) => t.slice(1));
  if (released.includes(version)) return `v${version} is already tagged`;
  const newest = released.sort(compareVersions).at(-1);
  if (newest && compareVersions(version, newest) < 0) return `${version} is older than the newest tag, v${newest}`;
  return null;
}

/** Whether the CHANGELOG has anything under [Unreleased] (or already a [version] section). */
export function hasNotes(text, version) {
  const notes = (s) => !!s && /^\s*[-*] /m.test(s);
  return notes(changelogSection(text, version)) || notes(changelogSection(text, 'Unreleased'));
}

function fail(message) {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts }).trim();
const git = (...args) => run('git', args);
const gh = (...args) => run('gh', args);
/** Like `run`, but its output goes to the terminal (for commands that print progress). */
const show = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  return r.status === 0;
};
const step = (text) => console.log(`\n▸ ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The release PR for `branch`, open or merged, or null. */
function findPr(branch) {
  const prs = JSON.parse(gh('pr', 'list', '-R', REPO, '--head', branch, '--state', 'all', '--json', 'number,state,url,mergeCommit'));
  return prs.find((p) => p.state === 'MERGED') ?? prs.find((p) => p.state === 'OPEN') ?? null;
}

// Watching the Release run is only for the terminal; a workflow leaves it to its own run.
let follow = true;

async function main(argv) {
  const yes = argv.includes('--yes');
  follow = !argv.includes('--no-follow');
  const arg = argv.find((a) => !a.startsWith('--')) ?? 'patch';
  // The next version comes from the tags on origin, so a rerun after a stop picks the same one.
  if (BUMPS.includes(arg)) git('fetch', '--quiet', '--tags', 'origin');
  const version = BUMPS.includes(arg) ? nextVersion(git('tag', '--list', 'v*').split('\n').filter(Boolean), readVersion(), arg) : parseVersion(arg);
  const tag = `v${version}`;
  const branch = `release/${version}`;

  step('Checking');
  try {
    gh('auth', 'status');
  } catch {
    fail('gh is not signed in. Run `gh auth login` first.');
  }
  if (git('status', '--porcelain', '--untracked-files=no')) fail('there are uncommitted changes. Commit or stash them first.');
  git('fetch', '--quiet', '--tags', 'origin');
  if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) {
    console.log(`${tag} is already pushed; nothing to do but follow its Release run.`);
    return followRelease(tag);
  }
  let pr = findPr(branch);
  if (!pr) {
    const problem = versionProblem(version, git('tag', '--list', 'v*').split('\n').filter(Boolean));
    if (problem) fail(problem);
    const changelog = git('show', 'origin/main:CHANGELOG.md');
    if (!hasNotes(changelog, version)) fail('CHANGELOG.md has no entries under [Unreleased]; the release notes would be empty.');
  }
  console.log(`Version ${version} (now ${readVersion()} on this checkout); tag ${tag}; branch ${branch}.`);

  if (!yes && !pr) {
    console.log(
      `\nThis will commit "Release ${version}" on ${branch}, push it, open a PR that squash-merges itself when CI is green,` +
        `\nthen tag the merge commit ${tag} and push the tag, which publishes the GitHub Release.`,
    );
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Continue? [y/N] ');
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) fail('stopped; nothing was changed.');
  }

  if (!pr) {
    step(`Preparing ${branch}`);
    const remoteBranch = git('ls-remote', '--heads', 'origin', branch);
    if (remoteBranch) {
      // Pushed by an earlier run that stopped before the PR.
      git('switch', '--quiet', '-C', branch, `origin/${branch}`);
    } else {
      git('switch', '--quiet', '-C', branch, 'origin/main');
      setVersion(version);
      git('add', 'Cargo.toml', 'Cargo.lock', 'CHANGELOG.md');
      // Signs as configured (commit.gpgsign).
      if (!show('git', ['commit', '--quiet', '-m', `Release ${version}`])) fail('git commit failed (see above). Fix it and run this again.');
      git('push', '--quiet', '-u', 'origin', branch);
    }

    step('Opening the PR');
    const notes = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version) ?? '';
    gh(
      'pr', 'create', '-R', REPO, '--base', 'main', '--head', branch, '--title', `Release ${version}`, '--label', 'skip-changelog',
      '--body', `Dates the CHANGELOG's [Unreleased] entries as ${version}. After the merge, \`pnpm release\` tags it ${tag}.\n\n${notes}`,
    );
    pr = findPr(branch);
  }
  console.log(pr.url);

  if (pr.state !== 'MERGED') {
    // Squash is the only merge method; the head branch is deleted after the merge.
    gh('pr', 'merge', '-R', REPO, String(pr.number), '--squash', '--auto');
    step('Waiting for CI and the merge (Ctrl+C is safe; run the same command again to carry on)');
    const deadline = Date.now() + MERGE_TIMEOUT_MS;
    for (;;) {
      pr = findPr(branch) ?? fail(`the PR for ${branch} was closed without merging.`);
      if (pr.state === 'MERGED') break;
      // gh exits non-zero while checks are pending or failed, so read its output either way.
      const checks = spawnSync('gh', ['pr', 'checks', '-R', REPO, String(pr.number), '--json', 'name,bucket'], { cwd: root, encoding: 'utf8' });
      const failed = JSON.parse(checks.stdout.trim() || '[]').filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
      if (failed.length) fail(`CI failed (${failed.map((c) => c.name).join(', ')}): ${pr.url}\nFix it on ${branch}, then run this again.`);
      if (Date.now() > deadline) fail(`not merged after an hour: ${pr.url}`);
      process.stdout.write('.');
      await sleep(POLL_MS);
    }
    console.log(' merged.');
  }

  step(`Tagging ${tag}`);
  const commit = pr.mergeCommit?.oid ?? fail('GitHub reports no merge commit for the PR.');
  git('fetch', '--quiet', 'origin', 'main');
  if (spawnSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], { cwd: root }).status !== 0)
    fail(`the merge commit ${commit.slice(0, 7)} is not on main.`);
  console.log(git('log', '-1', '--format=%h %s', commit));
  git('tag', tag, commit);
  git('push', '--quiet', 'origin', tag);
  // Back to main, without the release branch (deleted on GitHub after the merge).
  git('switch', '--quiet', 'main');
  git('merge', '--quiet', '--ff-only', 'origin/main');
  git('branch', '-D', branch);

  await followRelease(tag);
}

async function followRelease(tag) {
  if (!follow) {
    console.log(`\n${tag} is pushed. The Release workflow builds and publishes it: https://github.com/${REPO}/actions/workflows/release.yml`);
    return;
  }
  step('Following the Release workflow');
  let id = '';
  for (let i = 0; i < 20 && !id; i++) {
    id = gh('run', 'list', '-R', REPO, '--workflow', 'release.yml', '--branch', tag, '--limit', '1', '--json', 'databaseId', '-q', '.[0].databaseId');
    if (!id) await sleep(3000);
  }
  if (!id) fail(`no Release run for ${tag} yet. See https://github.com/${REPO}/actions/workflows/release.yml`);
  if (!show('gh', ['run', 'watch', '-R', REPO, id, '--interval', '10', '--exit-status']))
    fail(`the Release run failed: https://github.com/${REPO}/actions/runs/${id}\nSee docs/releasing.md: rerun it, or fix the cause in a new patch version.`);
  console.log(`\nReleased: https://github.com/${REPO}/releases/tag/${tag}`);
}

const isMain = import.meta.main ?? (!!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url);
if (isMain) await main(process.argv.slice(2));
