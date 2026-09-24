// Integração do orchestrator: parse diff + log + build spec + write JSON +
// write provenance sidecar + shell out para archify validate + archify deliver.
// Usa a fixture mini-repo (criada por test/flow/fixtures/mini-repo/bootstrap.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import wfSchema from '../../schemas/workflow.schema.json' with {type: 'json'};
import commonSchema from '../../schemas/common.schema.json' with {type: 'json'};
import {runFlow} from '../../bin/flow/runner.mjs';
import {ensureFixture} from './fixtures/mini-repo/bootstrap.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const archifyBin = path.join(repoRoot, 'bin', 'archify.mjs');

const ajv = new Ajv({strict: false, allErrors: true, allowUnionTypes: true});
ajv.addSchema(commonSchema, 'common.schema.json');
const validateWf = ajv.compile(wfSchema);

test('runFlow writes workflow.json + workflow.html + provenance sidecar and returns receipt', async () => {
  await ensureFixture();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-flow-runner-'));
  const outDir = path.join(tmpRoot, 'docs/flows');

  const fixtureDir = path.join(repoRoot, 'test/flow/fixtures/mini-repo');
  const range = 'main...feat';
  const receipt = await runFlow({
    range,
    out: outDir,
    quality: 'standard',
    archifyBin,
    cwd: fixtureDir,
  });

  // Receipt shape (no schemaVersion — provenance moved to sidecar).
  assert.equal(typeof receipt.jsonPath, 'string');
  assert.equal(typeof receipt.htmlPath, 'string');
  assert.equal(typeof receipt.sourcePath, 'string');
  assert.ok(receipt.validateReceipt);
  assert.equal(typeof receipt.range, 'string');
  assert.equal(typeof receipt.stamp, 'string');

  // Artifacts exist on disk.
  const jsonRaw = await fs.readFile(receipt.jsonPath, 'utf8');
  const html = await fs.readFile(receipt.htmlPath, 'utf8');
  const sourceRaw = await fs.readFile(receipt.sourcePath, 'utf8');

  const spec = JSON.parse(jsonRaw);
  assert.equal(spec.diagram_type, 'workflow');
  assert.ok(spec.nodes.length >= 2, 'deve ter pelo menos 1 modify + 1 decide');
  assert.ok(validateWf(spec), `spec não passa no schema: ${JSON.stringify(validateWf.errors)}`);

  assert.ok(html.startsWith('<') || html.includes('<svg'),
    'HTML deve ser não-vazio e iniciar com < ou conter <svg');

  const source = JSON.parse(sourceRaw);
  assert.ok(source.range);
  assert.ok(source.baseSha);
  assert.ok(source.generated_at);
  assert.match(source.generated_at, /T/); // ISO 8601

  await fs.rm(tmpRoot, {recursive: true, force: true});
});

test('runFlow returns validateReceipt.status = "passed" for the mini fixture', async () => {
  await ensureFixture();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-flow-runner-status-'));
  const outDir = path.join(tmpRoot, 'docs/flows');

  const fixtureDir = path.join(repoRoot, 'test/flow/fixtures/mini-repo');
  const range = 'main...feat';
  const receipt = await runFlow({
    range,
    out: outDir,
    quality: 'standard',
    archifyBin,
    cwd: fixtureDir,
  });

  assert.equal(receipt.validateReceipt.status, 'passed',
    `validate receipt esperado passed, recebido ${JSON.stringify(receipt.validateReceipt)}`);

  await fs.rm(tmpRoot, {recursive: true, force: true});
});

test('runFlow aceita sinceMessage e filtra commits', async () => {
  await ensureFixture();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-flow-runner-since-'));
  const outDir = path.join(tmpRoot, 'docs/flows');

  const fixtureDir = path.join(repoRoot, 'test/flow/fixtures/mini-repo');
  const range = 'main...feat';
  const receipt = await runFlow({
    range,
    out: outDir,
    quality: 'standard',
    archifyBin,
    sinceMessage: 'feat(users): add get(id) helper',
    cwd: fixtureDir,
  });

  const spec = JSON.parse(await fs.readFile(receipt.jsonPath, 'utf8'));
  const decideNodes = spec.nodes.filter(n => n.lane === 'decide');
  // Apenas o segundo commit deve casar — o primeiro (stub users endpoint) é filtrado.
  assert.equal(decideNodes.length, 1);
  // label = sha prefix (≤ 7 chars); sublabel = subject truncado.
  assert.match(decideNodes[0].label, /^[0-9a-f]{7}$/);
  // Sublabel é truncado para caber no node — checamos só o prefixo comum.
  assert.ok(
    (decideNodes[0].sublabel || '').startsWith('feat(users): add'),
    `esperava sublabel iniciando com "feat(users): add", recebi: ${decideNodes[0].sublabel}`,
  );

  await fs.rm(tmpRoot, {recursive: true, force: true});
});

test('runFlow nao deixa .tmp files apos sucesso', async () => {
  await ensureFixture();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-flow-runner-atomic-'));
  const outDir = path.join(tmpRoot, 'docs/flows');

  const fixtureDir = path.join(repoRoot, 'test/flow/fixtures/mini-repo');
  await runFlow({
    range: 'main...feat',
    out: outDir,
    quality: 'standard',
    archifyBin,
    cwd: fixtureDir,
  });

  const entries = await fs.readdir(outDir);
  const tmps = entries.filter((e) => e.startsWith('.archify-flow-') && e.endsWith('.tmp'));
  assert.equal(tmps.length, 0, `sem .tmp apos sucesso, achei: ${tmps.join(', ')}`);

  await fs.rm(tmpRoot, {recursive: true, force: true});
});

test('runFlow extrai baseSha correto para range 2-dot (main..feat)', async () => {
  await ensureFixture();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-flow-runner-2dot-'));
  const outDir = path.join(tmpRoot, 'docs/flows');

  const fixtureDir = path.join(repoRoot, 'test/flow/fixtures/mini-repo');
  // git diff aceita tanto A..B quanto A...B; ambos devem produzir baseSha='main'.
  const receipt = await runFlow({
    range: 'main..feat',
    out: outDir,
    quality: 'standard',
    archifyBin,
    cwd: fixtureDir,
  });

  const source = JSON.parse(await fs.readFile(receipt.sourcePath, 'utf8'));
  assert.equal(
    source.baseSha,
    'main',
    `baseSha deve ser 'main' para range 2-dot, recebi: "${source.baseSha}"`,
  );

  await fs.rm(tmpRoot, {recursive: true, force: true});
});
