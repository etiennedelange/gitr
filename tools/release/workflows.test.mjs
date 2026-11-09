// pnpm test:tools (node --test)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The Copilot SDK's build script downloads a Copilot CLI from GitHub's release CDN, which answered
// HTTP 504 for hours and failed every Rust build, CI and release alike. Gitr never uses that
// download (it starts the user's own `copilot` through an explicit path), so every workflow that
// compiles the app must skip it.
for (const file of ['ci.yml', 'release.yml', 'release-cache.yml']) {
  test(`${file} skips the Copilot CLI download`, () => {
    const yml = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert.match(yml, /^\s+COPILOT_SKIP_CLI_DOWNLOAD: '1'$/m);
  });
}
