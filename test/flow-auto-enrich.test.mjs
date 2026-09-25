// Testes do auto-enrichment do subcommand `archify agent-flow` (B35 Task 3).
//
// Cobertura:
//   1. Quando catalog AUSENTE, agent-flow ainda aplica tagActor enrichment (sublabel/tag em nodes)
//   2. Quando catalog AUSENTE mas actors reconheciveis, IR sai com actorTags mesmo sem meta.tier
//   3. Quando catalog PRESENTE e flowId bate, ambos tier+actorTags aplicados (regressao)
//
// Motivacao (NICE from B34 retro): JSON novo gerado via `archify agent-flow`
// deve sair enriquecido SEM precisar do step manual `archify enrich`. Hoje
// a tagActor enrichment so é aplicada quando catalog lookup sucede; queremos
// que tagActor (que nao depende do catalog) seja sempre aplicada.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const archifyBin = path.join(repoRoot, 'bin', 'archify.mjs');
const baseRepo = path.resolve(repoRoot, '..');

function runArchify(args, {cwd = baseRepo, env = {}} = {}) {
  try {
    const stdout = execFileSync('node', [archifyBin, ...args], {
      encoding: 'utf8', cwd, env: {...process.env, ...env}, timeout: 60_000,
    });
    return {status: 0, stdout, stderr: ''};
  } catch (e) {
    return {
      status: e.status ?? 1,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : (e.message || ''),
    };
  }
}

async function writeMdWithBackendPipeline(outPath) {
  const md = `# backend-feature

> Test fixture.

**Trigger:** "test backend"

\`\`\`text
NESTJS-SPECIALIST → TEST-WRITER → CODE-REVIEWER → TDD-ENFORCER
\`\`\`
`;
  await fs.writeFile(outPath, md);
}

// 1. Catalog PRESENTE mas flowId NAO bate — agent-flow ainda aplica tagActor
// (Equivalente a "catalog ausente" do ponto de vista do lookup de flowId.
// agent-flow hardcoda o catalog path, entao simulamos "no catalog match"
// usando um MD com flowId nao catalogado.)
test('agent-flow: catalog sem match de flowId ainda aplica tagActor (sublabel/tag em nodes)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-autoenrich-'));
  const mdPath = path.join(tmp, 'pipeline-inexistente-no-catalog.md');
  const jsonPath = path.join(tmp, 'pipeline-inexistente-no-catalog.workflow.json');
  // MD com nome que NAO bate com nenhum flowId do catalog
  const md = `# pipeline-inexistente-no-catalog

> Test fixture (deliberadamente fora do catalog para forcar graceful degradation).

**Trigger:** "test pipeline"

\`\`\`text
NESTJS-SPECIALIST → TEST-WRITER → CODE-REVIEWER
\`\`\`
`;
  await fs.writeFile(mdPath, md);

  try {
    const result = runArchify([
      'agent-flow',
      '--source', mdPath,
      '--out', jsonPath,
      '--quality', 'standard',
    ], {cwd: baseRepo});
    assert.equal(result.status, 0, `agent-flow falhou: ${result.stderr}`);

    const ir = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    // Sem match no catalog → meta.tier permanece undefined
    assert.equal(ir.meta.tier, undefined, 'sem catalog match, meta.tier deve ser undefined');

    // Mas tagActor enrichment DEVE ser aplicado nos nodes (nao depende do catalog)
    const nestjsNode = ir.nodes.find((n) => n.id === 'nestjs_specialist');
    assert.ok(nestjsNode, 'nestjs_specialist node deve existir');
    assert.equal(nestjsNode.sublabel, 'specialist', `sublabel esperado 'specialist', recebi '${nestjsNode.sublabel}'`);
    assert.equal(nestjsNode.tag, 'scope:backend', `tag esperado 'scope:backend', recebi '${nestjsNode.tag}'`);

    const writerNode = ir.nodes.find((n) => n.id === 'test_writer');
    assert.equal(writerNode.sublabel, 'writer');
    assert.equal(writerNode.tag, 'scope:test');
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
});

// 2. Catalog PRESENTE e flowId bate — ambos tier + actorTags (regressao)
test('agent-flow: catalog presente + flowId match aplica tier E actorTags', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-autoenrich-'));
  const mdPath = path.join(tmp, 'backend-feature.md');
  const jsonPath = path.join(tmp, 'backend-feature.workflow.json');
  await writeMdWithBackendPipeline(mdPath);

  try {
    const result = runArchify([
      'agent-flow',
      '--source', mdPath,
      '--out', jsonPath,
      '--quality', 'standard',
    ], {cwd: baseRepo});
    assert.equal(result.status, 0, `agent-flow falhou: ${result.stderr}`);

    const ir = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    // tier E actorTags ambos aplicados
    assert.equal(ir.meta.tier, 'critical');
    assert.equal(ir.meta.mechanism, 'auto');
    const nestjsNode = ir.nodes.find((n) => n.id === 'nestjs_specialist');
    assert.equal(nestjsNode.sublabel, 'specialist');
    assert.equal(nestjsNode.tag, 'scope:backend');
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
});