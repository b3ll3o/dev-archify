// Testes do subcommand `archify flow enrich <json>` (B32).
//
// Cobertura:
//   1. CLI exit 0 e adiciona meta.tier/mechanism/subject quando catalog encontra flowId
//   2. CLI stdout mode: --source X sem --out escreve JSON enriquecido em stdout
//   3. CLI graceful degradation: --catalog inexistente → ainda aplica actorTags e sai 0
//   4. CLI E2E: enrich de doc real passa `archify validate workflow`
//   5. Argumentos invalidos: --source ausente → exit 2
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const archifyBin = path.join(repoRoot, 'bin', 'archify.mjs');
const baseRepo = path.resolve(repoRoot, '..');
const catalogPath = path.join(baseRepo, 'docs/flows/README.md');
const realWorkflowPath = path.join(
  baseRepo, 'docs/flows/agent-workflows/flow-backend-feature/flow-backend-feature.workflow.json',
);

function runArchify(args, {cwd = baseRepo, env = {}} = {}) {
  try {
    const stdout = execFileSync('node', [archifyBin, ...args], {
      encoding: 'utf8',
      cwd,
      env: {...process.env, ...env},
      timeout: 60_000,
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

// Helper: copy a workflow to tmp and strip enrichment fields so each test starts from a clean IR.
async function writeBareWorkflow(outPath, flowId, type = 'workflow') {
  const wf = {
    schema_version: 2,
    diagram_type: type,
    meta: {
      title: `Test ${flowId}`,
      animation: 'trace',
      visual_preset: 'signal-flow',
      quality_profile: 'standard',
    },
    lanes: [{id: 'agent', label: 'Agent Runtime'}],
    phases: [],
    groups: [],
    cards: [],
    nodes: [
      {id: 'nestjs_specialist', lane: 'agent', col: 0, type: 'backend', label: 'nestjs-specialist', width: 160},
      {id: 'test_writer', lane: 'agent', col: 1, type: 'security', label: 'test-writer', width: 160},
      {id: 'code_reviewer', lane: 'agent', col: 2, type: 'security', label: 'code-reviewer', width: 160},
      {id: 'tdd_enforcer', lane: 'agent', col: 3, type: 'security', label: 'tdd-enforcer', width: 160},
    ],
    edges: [],
    mainPath: ['nestjs_specialist', 'test_writer', 'code_reviewer', 'tdd_enforcer'],
  };
  await fs.writeFile(outPath, JSON.stringify(wf, null, 2));
}

// 1. CLI exit 0 e adiciona meta.tier/mechanism/subject
test('enrich CLI: aplica tier/mechanism/subject via catalog', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-enrich-'));
  const sourcePath = path.join(tmp, 'flow.workflow.json');
  const outPath = path.join(tmp, 'enriched.workflow.json');
  await writeBareWorkflow(sourcePath, 'flow-backend-feature');

  try {
    const result = runArchify([
      'enrich',
      '--source', sourcePath,
      '--out', outPath,
      '--catalog', catalogPath,
    ]);
    assert.equal(result.status, 0, `enrich falhou: ${result.stderr}`);

    const enriched = JSON.parse(await fs.readFile(outPath, 'utf8'));
    assert.equal(enriched.meta.tier, 'critical');
    assert.equal(enriched.meta.mechanism, 'auto');
    assert.match(enriched.meta.subject, /Backend NestJS/);
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
});

// 2. Stdout mode
test('enrich CLI: sem --out escreve JSON em stdout', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-enrich-'));
  const sourcePath = path.join(tmp, 'flow.workflow.json');
  await writeBareWorkflow(sourcePath, 'flow-backend-feature');

  try {
    const result = runArchify([
      'enrich',
      '--source', sourcePath,
      '--catalog', catalogPath,
    ]);
    assert.equal(result.status, 0, `enrich falhou: ${result.stderr}`);
    const enriched = JSON.parse(result.stdout);
    assert.equal(enriched.meta.tier, 'critical');
    assert.equal(enriched.meta.mechanism, 'auto');
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
});

// 3. Graceful catalog missing → ainda enriquece nodes via tagActor
test('enrich CLI: catalog ausente faz graceful degradation (exit 0, actorTags aplicados)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-enrich-'));
  const sourcePath = path.join(tmp, 'flow.workflow.json');
  const outPath = path.join(tmp, 'enriched.workflow.json');
  await writeBareWorkflow(sourcePath, 'flow-backend-feature');

  try {
    const result = runArchify([
      'enrich',
      '--source', sourcePath,
      '--out', outPath,
      '--catalog', '/tmp/catalog-inexistente-xyz.md',
    ]);
    assert.equal(result.status, 0, `enrich deveria passar mesmo sem catalog: ${result.stderr}`);

    const enriched = JSON.parse(await fs.readFile(outPath, 'utf8'));
    // tier/mechanism/subject ficam undefined (catalog ausente)
    assert.equal(enriched.meta.tier, undefined);
    // actorTags aplicados em nodes
    assert.equal(enriched.nodes[0].sublabel, 'specialist');
    assert.equal(enriched.nodes[0].tag, 'scope:backend');
    assert.equal(enriched.nodes[1].sublabel, 'writer');
    assert.equal(enriched.nodes[1].tag, 'scope:test');
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
});

// 4. E2E: enrich doc real + validate
test('enrich CLI E2E: docs/flows/.../flow-backend-feature.workflow.json + validate', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-enrich-'));
  const outPath = path.join(tmp, 'enriched.workflow.json');
  try {
    const result = runArchify([
      'enrich',
      '--source', realWorkflowPath,
      '--out', outPath,
      '--catalog', catalogPath,
      '--quality', 'standard',
    ]);
    assert.equal(result.status, 0, `enrich falhou: ${result.stderr}`);

    // Validate o JSON enriquecido
    const validate = runArchify([
      'validate', 'workflow', outPath,
      '--quality', 'standard', '--json',
    ]);
    assert.equal(validate.status, 0, `validate falhou: ${validate.stderr}`);
    const receipt = JSON.parse(validate.stdout);
    assert.equal(receipt.ok, true, `validate nao retornou ok: ${JSON.stringify(receipt)}`);

    // Conteudo enriquecido
    const enriched = JSON.parse(await fs.readFile(outPath, 'utf8'));
    assert.equal(enriched.meta.tier, 'critical');
    assert.equal(enriched.meta.mechanism, 'auto');
    assert.match(enriched.meta.subject, /Backend NestJS/);
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
});

// 5. Argumentos invalidos
test('enrich CLI: --source ausente → exit 2', () => {
  const result = runArchify(['enrich']);
  assert.notEqual(result.status, 0, 'enrich sem --source deve falhar');
  assert.ok(/--source/i.test(result.stderr), `stderr deve mencionar --source: ${result.stderr}`);
});

test('enrich CLI: --source arquivo inexistente → exit 2', async () => {
  const result = runArchify([
    'enrich',
    '--source', '/tmp/workflow-inexistente-xyz.json',
    '--catalog', catalogPath,
  ]);
  assert.notEqual(result.status, 0);
});

// 6. tagActor expansion aplicado em nodes
test('enrich CLI: actor ids kebab-case recebem tagActor enrichment', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-enrich-'));
  const sourcePath = path.join(tmp, 'flow.workflow.json');
  const outPath = path.join(tmp, 'enriched.workflow.json');
  // Bare workflow com 4 actors cobertos pela B33
  const wf = {
    schema_version: 2,
    diagram_type: 'workflow',
    meta: {
      title: 'Test',
      animation: 'trace',
      visual_preset: 'signal-flow',
      quality_profile: 'standard',
    },
    lanes: [{id: 'agent', label: 'Agent'}],
    phases: [],
    groups: [],
    cards: [],
    nodes: [
      {id: 'ci_defense_in_depth', lane: 'agent', col: 0, type: 'security', label: 'ci-defense-in-depth', width: 160},
      {id: 'agent_architect', lane: 'agent', col: 1, type: 'security', label: 'agent-architect', width: 160},
    ],
    edges: [],
    mainPath: ['ci_defense_in_depth', 'agent_architect'],
  };
  await fs.writeFile(sourcePath, JSON.stringify(wf, null, 2));

  try {
    const result = runArchify([
      'enrich',
      '--source', sourcePath,
      '--out', outPath,
      '--catalog', '/tmp/catalog-inexistente-xyz.md', // skip catalog, testar tags
    ]);
    assert.equal(result.status, 0, `enrich falhou: ${result.stderr}`);
    const enriched = JSON.parse(await fs.readFile(outPath, 'utf8'));
    assert.equal(enriched.nodes[0].sublabel, 'auditor');
    assert.equal(enriched.nodes[0].tag, 'scope:ci');
    assert.equal(enriched.nodes[1].sublabel, 'planner');
    assert.equal(enriched.nodes[1].tag, 'scope:architecture');
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
});