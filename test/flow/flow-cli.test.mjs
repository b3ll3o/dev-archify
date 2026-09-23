// E2E do CLI: invoca `node bin/archify.mjs flow` real contra a mini-repo
// fixture. Usa `process.chdir` para dentro do fixture porque o CLI resolve
// o range contra o git dir atual.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import wfSchema from '../../schemas/workflow.schema.json' with {type: 'json'};
import commonSchema from '../../schemas/common.schema.json' with {type: 'json'};
import {ensureFixture} from './fixtures/mini-repo/bootstrap.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const archifyBin = path.join(repoRoot, 'bin', 'archify.mjs');
const fixtureDir = path.join(repoRoot, 'test/flow/fixtures/mini-repo');

const ajv = new Ajv({strict: false, allErrors: true, allowUnionTypes: true});
ajv.addSchema(commonSchema, 'common.schema.json');
const validateWf = ajv.compile(wfSchema);

async function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(prev); }
}

test('archify flow --git-range writes workflow.json + workflow.html + provenance', async () => {
  await ensureFixture();
  // O CLI exige --out dentro do repo. Quando chdiramos para o fixture,
  // o "repo" e' o proprio fixture. Criamos o tmp dentro dele.
  const tmpInRepo = path.join(fixtureDir, '.tmp-cli-' + Date.now());
  await fs.mkdir(tmpInRepo, {recursive: true});
  await withCwd(fixtureDir, () => {
    execFileSync('node', [
      archifyBin, 'flow',
      '--git-range=main...feat',
      `--out=${tmpInRepo}`,
      '--quality=standard',
    ], {encoding: 'utf8'});
  });

  const files = await fs.readdir(tmpInRepo);
  assert.ok(files.includes('workflow.json'), `esperava workflow.json em ${tmpInRepo}, achei: ${files}`);
  assert.ok(files.includes('workflow.html'), `esperava workflow.html em ${tmpInRepo}, achei: ${files}`);
  assert.ok(files.includes('_flow_source.json'), `esperava _flow_source.json em ${tmpInRepo}, achei: ${files}`);

  const spec = JSON.parse(await fs.readFile(path.join(tmpInRepo, 'workflow.json'), 'utf8'));
  assert.equal(spec.diagram_type, 'workflow');
  assert.ok(validateWf(spec), `spec não passa no schema: ${JSON.stringify(validateWf.errors)}`);

  const html = await fs.readFile(path.join(tmpInRepo, 'workflow.html'), 'utf8');
  assert.ok(html.startsWith('<') || html.includes('<svg'),
    'HTML deve iniciar com < ou conter <svg');

  const source = JSON.parse(await fs.readFile(path.join(tmpInRepo, '_flow_source.json'), 'utf8'));
  assert.equal(source.range, 'main...feat');
  assert.ok(source.baseSha);
  assert.match(source.generated_at, /T/);

  await fs.rm(tmpInRepo, {recursive: true, force: true});
});

test('archify flow --json imprime receipt com validateReceipt.status=passed', async () => {
  await ensureFixture();
  const tmpInRepo = path.join(fixtureDir, '.tmp-cli-json-' + Date.now());
  await fs.mkdir(tmpInRepo, {recursive: true});
  let stdout = '';
  await withCwd(fixtureDir, () => {
    stdout = execFileSync('node', [
      archifyBin, 'flow',
      '--git-range=main...feat',
      `--out=${tmpInRepo}`,
      '--quality=standard',
      '--json',
    ], {encoding: 'utf8'});
  });
  const receipt = JSON.parse(stdout);
  assert.equal(typeof receipt.jsonPath, 'string');
  assert.equal(typeof receipt.htmlPath, 'string');
  assert.equal(typeof receipt.sourcePath, 'string');
  assert.equal(receipt.validateReceipt.status, 'passed',
    `esperava passed, recebi ${JSON.stringify(receipt.validateReceipt)}`);

  await fs.rm(tmpInRepo, {recursive: true, force: true});
});

test('archify flow sai com código 2 quando o range não tem diff', async () => {
  await ensureFixture();
  const tmpInRepo = path.join(fixtureDir, '.tmp-cli-empty-' + Date.now());
  await fs.mkdir(tmpInRepo, {recursive: true});
  let exitCode = 0;
  try {
    await withCwd(fixtureDir, () => {
      execFileSync('node', [
        archifyBin, 'flow',
        '--git-range=main...main', // mesmo ref → sem diff
        `--out=${tmpInRepo}`,
        '--quality=standard',
      ], {encoding: 'utf8', stdio: 'pipe'});
    });
  } catch (e) {
    exitCode = e.status;
  }
  assert.equal(exitCode, 2);
  await fs.rm(tmpInRepo, {recursive: true, force: true});
});

test('archify flow sai com código 6 quando --out está fora do repo', async () => {
  await ensureFixture();
  const outside = path.join(os.tmpdir(), 'archify-flow-cli-outside-' + Date.now());
  let exitCode = 0;
  try {
    await withCwd(fixtureDir, () => {
      execFileSync('node', [
        archifyBin, 'flow',
        '--git-range=main...feat',
        `--out=${outside}`,
        '--quality=standard',
      ], {encoding: 'utf8', stdio: 'pipe'});
    });
  } catch (e) {
    exitCode = e.status;
  }
  assert.equal(exitCode, 6);
});
