// Snapshot test: congela o receipt do CLI para regressao visual em code review.
// Campos nao-determinísticos (stamp, generated_at, paths absolutos) sao
// mascarados antes da comparacao.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ensureFixture} from './fixtures/mini-repo/bootstrap.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const archifyBin = path.join(repoRoot, 'bin', 'archify.mjs');
const fixtureDir = path.join(repoRoot, 'test/flow/fixtures/mini-repo');
const snapshotPath = path.join(__dirname, 'snapshots', 'flow-cli-receipt.json');

async function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(prev); }
}

function mask(receipt) {
  return {
    ...receipt,
    stamp: '<DETERMINISTIC>',
    jsonPath: receipt.jsonPath.split('/').pop(),
    htmlPath: receipt.htmlPath.split('/').pop(),
    sourcePath: receipt.sourcePath.split('/').pop(),
    // validateReceipt pode carregar caminhos internos do archify que variam
    // por ambiente (cwd do renderer) — congelamos seu `summary` se presente.
    validateReceipt: receipt.validateReceipt
      ? {
          ...receipt.validateReceipt,
          summary: (receipt.validateReceipt.summary || '').replace(/[0-9]+/g, '#') || undefined,
        }
      : receipt.validateReceipt,
  };
}

test('flow receipt matches snapshot (masked for non-determinism)', async () => {
  await ensureFixture();
  const outDir = path.join(fixtureDir, '.snap-out-' + Date.now());
  await fs.mkdir(outDir, {recursive: true});

  let stdout = '';
  await withCwd(fixtureDir, () => {
    stdout = execFileSync('node', [
      archifyBin, 'flow',
      '--git-range=main...feat',
      `--out=${outDir}`,
      '--quality=standard',
      '--json',
    ], {encoding: 'utf8'});
  });
  await fs.rm(outDir, {recursive: true, force: true});

  const actual = JSON.parse(stdout);
  const expectedRaw = await fs.readFile(snapshotPath, 'utf8');
  const expected = JSON.parse(expectedRaw);

  assert.deepEqual(mask(actual), expected,
    'receipt divergiu do snapshot congelado — verifique se a mudanca e intencional e atualize o snapshot');
});
