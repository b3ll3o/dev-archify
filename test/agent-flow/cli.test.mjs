// Testes do CLI `archify agent-flow` (runAgentFlow orchestrator).
//
// Cobertura:
//   - runAgentFlow load MD + write IR + validate ok
//   - runAgentFlow error envelope para source inexistente (exit 2)
//   - runAgentFlow error envelope para MD sem pipeline (exit 2)
//   - runAgentFlow respeita --no-validate (skip validate step)
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {runAgentFlow} from '../../bin/agent-flow.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const archifyBin = path.join(repoRoot, 'bin', 'archify.mjs');
const baseRepo = path.resolve(repoRoot, '..');
const workflowsDir = path.join(baseRepo, '.agents/workflows');

test('runAgentFlow: backend-feature.md → write IR + validate ok=true', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-agent-flow-cli-'));
  const outPath = path.join(tmpDir, 'flow.workflow.json');
  try {
    const receipt = await runAgentFlow({
      sourcePath: path.join(workflowsDir, 'backend-feature.md'),
      outPath,
      quality: 'standard',
      archifyBin,
    });
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.actors.length, 4);
    assert.equal(receipt.nodesCount, 4);
    assert.equal(receipt.edgesCount, 3);
    assert.equal(receipt.validate.status, 'passed',
      `validate esperado passed, recebi ${JSON.stringify(receipt.validate)}`);
    // Arquivo escrito no disco
    const written = JSON.parse(await fs.readFile(outPath, 'utf8'));
    assert.equal(written.diagram_type, 'workflow');
    assert.equal(written.schema_version, 2);
    assert.deepEqual(written.mainPath, [
      'nestjs_specialist',
      'test_writer',
      'code_reviewer',
      'tdd_enforcer',
    ]);
    assert.equal(written.meta.quality_profile, 'standard');
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true});
  }
});

test('runAgentFlow: source inexistente → error envelope com exitCode 2', async () => {
  await assert.rejects(
    () => runAgentFlow({
      sourcePath: '/path/que/nao/existe.md',
      outPath: '/tmp/whatever.json',
      archifyBin,
    }),
    (err) => {
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /cannot read source MD/);
      return true;
    },
  );
});

test('runAgentFlow: MD sem pipeline (e.g. so heading) → exitCode 2', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-agent-flow-nopipe-'));
  const mdPath = path.join(tmpDir, 'empty.md');
  const outPath = path.join(tmpDir, 'out.json');
  await fs.writeFile(mdPath, '# Apenas heading\n\nsem pipeline\n', 'utf8');
  try {
    await assert.rejects(
      () => runAgentFlow({sourcePath: mdPath, outPath, archifyBin}),
      (err) => {
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /no pipeline found/);
        return true;
      },
    );
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true});
  }
});

test('runAgentFlow: --no-validate pula validate step', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-agent-flow-noval-'));
  const outPath = path.join(tmpDir, 'flow.workflow.json');
  try {
    const receipt = await runAgentFlow({
      sourcePath: path.join(workflowsDir, 'frontend-feature.md'),
      outPath,
      quality: 'standard',
      validate: false,
      archifyBin,
    });
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.validate, null,
      'com --no-validate, receipt.validate deve ser null');
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true});
  }
});

test('runAgentFlow: 8 MDs auto-generable → write + validate passed', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-agent-flow-batch-'));
  const mdFiles = (await fs.readdir(workflowsDir)).filter((f) => f.endsWith('.md')).sort();
  try {
    for (const f of mdFiles) {
      // archive-demand.md e' a unica fora do MVP (lista numerada); pula.
      if (f === 'archive-demand.md') continue;
      const outPath = path.join(tmpDir, `${f.replace(/\.md$/, '')}.workflow.json`);
      const receipt = await runAgentFlow({
        sourcePath: path.join(workflowsDir, f),
        outPath,
        quality: 'standard',
        archifyBin,
      });
      assert.equal(receipt.exitCode, 0, `${f}: exitCode esperado 0, recebi ${receipt.exitCode}`);
      assert.ok(receipt.validate.ok, `${f}: validate ok esperado, recebi ${JSON.stringify(receipt.validate)}`);
    }
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true});
  }
});

test('runAgentFlow: enrichment aplicado automaticamente (tier/mechanism/subject populados no IR)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-agent-flow-enrich-'));
  const outPath = path.join(tmpDir, 'flow.workflow.json');
  try {
    const receipt = await runAgentFlow({
      sourcePath: path.join(workflowsDir, 'backend-feature.md'),
      outPath,
      quality: 'standard',
      archifyBin,
    });
    assert.equal(receipt.exitCode, 0);
    assert.ok(receipt.enrichment, 'receipt.enrichment deveria estar populado');
    assert.equal(receipt.enrichment.tier, 'critical');
    assert.equal(receipt.enrichment.mechanism, 'auto');
    assert.match(receipt.enrichment.subject, /Backend NestJS/);
    // Arquivo escrito tem tier/mechanism/subject em meta
    const written = JSON.parse(await fs.readFile(outPath, 'utf8'));
    assert.equal(written.meta.tier, 'critical');
    assert.equal(written.meta.mechanism, 'auto');
    // Actor tags aplicados nos nodes
    assert.equal(written.nodes[0].sublabel, 'specialist'); // NESTJS-SPECIALIST
    assert.equal(written.nodes[0].tag, 'scope:backend');
    // View overview adicionada
    assert.ok(Array.isArray(written.meta.views));
    assert.ok(written.meta.views.some((v) => v.id === 'sequence-overview'));
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true});
  }
});

test('runAgentFlow: archive-demand.md → parser dedicado gera IR sequencial + enrichment', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-agent-flow-archive-'));
  const outPath = path.join(tmpDir, 'flow.workflow.json');
  try {
    const receipt = await runAgentFlow({
      sourcePath: path.join(workflowsDir, 'archive-demand.md'),
      outPath,
      quality: 'standard',
      archifyBin,
    });
    assert.equal(receipt.exitCode, 0, `exitCode esperado 0, recebi ${receipt.exitCode} (${JSON.stringify(receipt)})`);
    assert.equal(receipt.nodesCount, 6, `esperava 6 nodes, recebi ${receipt.nodesCount}`);
    assert.equal(receipt.edgesCount, 5);
    assert.ok(receipt.validate.ok, `validate esperado ok, recebi ${JSON.stringify(receipt.validate)}`);
    const written = JSON.parse(await fs.readFile(outPath, 'utf8'));
    assert.equal(written.lanes[0].id, 'archive');
    assert.equal(written.mainPath.length, 6);
    // Tambem enrichment catalog (archive-demand tem tier=nice)
    assert.equal(written.meta.tier, 'nice');
    assert.equal(written.meta.mechanism, 'auto');
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true});
  }
});

test('runAgentFlow: 9 MDs (incluindo archive-demand via parser dedicado) geram IR que valida', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-agent-flow-batch2-'));
  const mdFiles = (await fs.readdir(workflowsDir)).filter((f) => f.endsWith('.md')).sort();
  try {
    for (const f of mdFiles) {
      const outPath = path.join(tmpDir, `${f.replace(/\.md$/, '')}.workflow.json`);
      const receipt = await runAgentFlow({
        sourcePath: path.join(workflowsDir, f),
        outPath,
        quality: 'standard',
        archifyBin,
      });
      assert.equal(receipt.exitCode, 0, `${f}: exitCode esperado 0, recebi ${receipt.exitCode}`);
      assert.ok(receipt.validate.ok, `${f}: validate ok esperado, recebi ${JSON.stringify(receipt.validate)}`);
    }
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true});
  }
});
