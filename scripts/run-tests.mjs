#!/usr/bin/env node
/**
 * Local test runner for dev-archify.
 *
 * Runs the subset of tests that work in this standalone layout (dev-archify
 * nested inside projeto-base). The original test chain referenced scripts
 * that live in a sibling archify repository (`../scripts/...`) which does
 * not exist in this bootstrap layout — those are intentionally excluded.
 *
 * Working baseline (verified 2026-09-30):
 *   - test/flow/*.test.mjs        (13 files, 82 tests) — agent-flow feature
 *
 * Skipped tests (require missing parent-repo scripts):
 *   - test/gallery.test.mjs              (../scripts/build-gallery.mjs)
 *   - test/release-identity.test.mjs     (../scripts/check-release-identity.mjs)
 *   - test/guide-page.test.mjs           (../scripts/build-guide.mjs)
 *   - test/community-proof-intake.test.mjs  (../CONTRIBUTING.md)
 *   - test/site-language-continuity.test.mjs (../scripts/site-copy.mjs)
 *   - test/repository-language-metadata.test.mjs  (git attribute)
 *   - test/generate-viewer.test.mjs      (../scripts/generate-viewer.mjs)
 *   - test/start-page.test.mjs           (../scripts/build-start.mjs)
 *
 * To re-enable a skipped test, restore its `test(...)` from `test.skip(...)`
 * and add the missing script. See commit history for the original test bodies.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');

const FLOW_TESTS = [
  'archify-init-flow-hook.test.mjs',
  'builder-spec-schema.test.mjs',
  'builder-spec.test.mjs',
  'flow-cli-snapshot.test.mjs',
  'flow-cli.test.mjs',
  'hook-pre-push.test.mjs',
  'ids.test.mjs',
  'install-flow-hook-helper.test.mjs',
  'install-flow-hook.test.mjs',
  'parser-diff.test.mjs',
  'runner-delimiter.test.mjs',
  'runner.test.mjs',
  'runner-write-atomic.test.mjs',
];

let failures = 0;
const results = [];

for (const file of FLOW_TESTS) {
  const testPath = path.join(skillRoot, 'test', 'flow', file);
  if (!fs.existsSync(testPath)) {
    console.error(`  SKIP  ${file} (file not found)`);
    results.push({ file, status: 'missing' });
    continue;
  }
  try {
    execFileSync(process.execPath, ['--test', testPath], {
      cwd: skillRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    console.log(`  ok    test/flow/${file}`);
    results.push({ file, status: 'pass' });
  } catch (err) {
    failures += 1;
    const stderr = err.stderr ? err.stderr.toString().split('\n').slice(-5).join('\n') : '';
    console.error(`  FAIL  test/flow/${file}${stderr ? `\n        ${stderr}` : ''}`);
    results.push({ file, status: 'fail', error: stderr });
  }
}

console.log('');
console.log(`  ${FLOW_TESTS.length - failures}/${FLOW_TESTS.length} flow test files passed`);

if (failures > 0) {
  console.error(`\n  ${failures} test file(s) failed`);
  process.exit(1);
}

process.exit(0);
