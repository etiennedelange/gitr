// pnpm test:tools (node --test)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// With the SDK's `runtime` feature, its build script downloads a Copilot CLI from GitHub's release
// CDN on every clean build (CI, releases), and that download failed whenever the CDN answered 504.
// Gitr never uses the download: it starts the user's own `copilot` through an explicit path.
// `local-runtime` is the SDK's feature for an application that supplies its own CLI: it can start
// the process, and the build script downloads nothing.
test('gitr-ai asks the Copilot SDK for local-runtime, not runtime', () => {
  const toml = readFileSync(new URL('../../crates/gitr-ai/Cargo.toml', import.meta.url), 'utf8');
  const sdk = toml.match(/^github-copilot-sdk\s*=\s*\{[^}]*\}/gm);
  assert.ok(sdk?.length, 'gitr-ai depends on github-copilot-sdk');
  for (const dep of sdk) {
    assert.match(dep, /features\s*=\s*\["local-runtime"\]/);
    assert.match(dep, /default-features\s*=\s*false/);
  }
});
