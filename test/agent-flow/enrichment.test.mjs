// Testes do enrichment IR (B30 — commit 1: tier/mechanism/subject; commit 2: archive-demand).
//
// Cobertura:
//   1. parseCatalogRow        (extrai tier/mechanism/subject de linha do catalog docs/flows/README.md)
//   2. enrichIrFromCatalog    (lookup por flow_id → {tier, mechanism, subject})
//   3. tagActor               (deriva role/scope do nome do actor)
//   4. mergeEnrichment        (combina IR primario com enrichment, primary vence)
//   5. parseArchiveDemand     (parser dedicado para lista numerada em archive-demand.md)
//   6. E2E: backend-feature.md + catalog → IR enriquecido
//   7. E2E: archive-demand.md → IR sequencial
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import wfSchema from '../../schemas/workflow.schema.json' with {type: 'json'};
import commonSchema from '../../schemas/common.schema.json' with {type: 'json'};
import {
  parseCatalogRow,
  enrichIrFromCatalog,
  tagActor,
  mergeEnrichment,
  parseArchiveDemand,
  extractPipelineFromMd,
  extractFrontmatter,
  extractTitle,
  generateIr,
} from '../../bin/agent-flow/parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const archifyBin = path.join(repoRoot, 'bin', 'archify.mjs');
const baseRepo = path.resolve(repoRoot, '..');
const workflowsDir = path.join(baseRepo, '.agents/workflows');
const catalogPath = path.join(baseRepo, 'docs/flows/README.md');

const ajv = new Ajv({strict: false, allErrors: true, allowUnionTypes: true});
ajv.addSchema(commonSchema, 'common.schema.json');
const validateWf = ajv.compile(wfSchema);

// 1. parseCatalogRow

test('parseCatalogRow extrai tier/mechanism/subject de linha do catalog', () => {
  const row = '| `flow-backend-feature` | 🔴 critical | auto | workflow | backend-feature — Implementar Feature no Backend NestJS |';
  const parsed = parseCatalogRow(row);
  assert.equal(parsed.flowId, 'flow-backend-feature');
  assert.equal(parsed.tier, 'critical');
  assert.equal(parsed.tierEmoji, '🔴');
  assert.equal(parsed.mechanism, 'auto');
  assert.equal(parsed.subject, 'backend-feature — Implementar Feature no Backend NestJS');
});

test('parseCatalogRow lida com tier 🟡/🟢 e mechanism hand', () => {
  const row = '| `flow-archive-demand` | 🟢 nice | hand | workflow | archive-demand — Arquivar Demanda Implementada |';
  const parsed = parseCatalogRow(row);
  assert.equal(parsed.tier, 'nice');
  assert.equal(parsed.tierEmoji, '🟢');
  assert.equal(parsed.mechanism, 'hand');
});

test('parseCatalogRow retorna null para linha que nao tem flow-id formatado', () => {
  assert.equal(parseCatalogRow('| Header | x | y | z | w |'), null);
  assert.equal(parseCatalogRow(''), null);
  assert.equal(parseCatalogRow('texto sem pipe'), null);
});

// 2. enrichIrFromCatalog

test('enrichIrFromCatalog retorna enrichment para flow-backend-feature', async () => {
  const enrichment = await enrichIrFromCatalog({catalogPath, flowId: 'flow-backend-feature'});
  assert.ok(enrichment, `esperava enrichment, recebi null`);
  assert.equal(enrichment.tier, 'critical');
  assert.equal(enrichment.mechanism, 'auto');
  assert.match(enrichment.subject, /Backend NestJS/);
});

test('enrichIrFromCatalog retorna null para flowId ausente do catalog', async () => {
  const enrichment = await enrichIrFromCatalog({catalogPath, flowId: 'flow-inexistente-xyz'});
  assert.equal(enrichment, null);
});

test('enrichIrFromCatalog lanca erro se catalogPath nao existe', async () => {
  await assert.rejects(
    () => enrichIrFromCatalog({catalogPath: '/tmp/catalog-nao-existe.md', flowId: 'x'}),
    /cannot read catalog/,
  );
});

// 3. tagActor

test('tagActor deriva role=specialist e scope=backend de NESTJS-SPECIALIST', () => {
  const tag = tagActor('NESTJS-SPECIALIST');
  assert.equal(tag.role, 'specialist');
  assert.equal(tag.scope, 'backend');
});

test('tagActor deriva role=specialist e scope=frontend de NEXTJS-SPECIALIST', () => {
  const tag = tagActor('NEXTJS-SPECIALIST');
  assert.equal(tag.role, 'specialist');
  assert.equal(tag.scope, 'frontend');
});

test('tagActor deriva role=reviewer e scope=quality de CODE-REVIEWER', () => {
  const tag = tagActor('CODE-REVIEWER');
  assert.equal(tag.role, 'reviewer');
  assert.equal(tag.scope, 'quality');
});

test('tagActor deriva role=enforcer e scope=quality de TDD-ENFORCER', () => {
  const tag = tagActor('TDD-ENFORCER');
  assert.equal(tag.role, 'enforcer');
  assert.equal(tag.scope, 'quality');
});

test('tagActor deriva role=writer e scope=docs de DOC-WRITER', () => {
  const tag = tagActor('DOC-WRITER');
  assert.equal(tag.role, 'writer');
  assert.equal(tag.scope, 'docs');
});

test('tagActor deriva role=manager e scope=task de TASK-MANAGER', () => {
  const tag = tagActor('TASK-MANAGER');
  assert.equal(tag.role, 'manager');
  assert.equal(tag.scope, 'task');
});

test('tagActor retorna {role:agent, scope:generic} para actor sem sufixo conhecido', () => {
  const tag = tagActor('UNKNOWN-AGENT');
  assert.equal(tag.role, 'agent');
  assert.equal(tag.scope, 'generic');
});

// 4. mergeEnrichment

test('mergeEnrichment combina primary com enrichment (primary vence em conflito)', () => {
  const primary = {
    meta: {title: 'Original Title', subtitle: 'Original Subtitle'},
    nodes: [{id: 'a', label: 'A', lane: 'agent', col: 0, type: 'external'}],
  };
  const enrichment = {
    tier: 'critical',
    mechanism: 'auto',
    subject: 'Enriched Subject',
    actorTags: {a: {role: 'specialist', scope: 'backend', sublabel: 'spec', tag: 'scope:backend'}},
    views: [{id: 'overview', label: 'Overview', focus: ['a'], note: 'all'}],
  };
  const merged = mergeEnrichment(primary, enrichment);
  // Primary vence em conflito de meta.title
  assert.equal(merged.meta.title, 'Original Title');
  assert.equal(merged.meta.subtitle, 'Original Subtitle');
  // Enrichment adiciona tier/mechanism/subject
  assert.equal(merged.meta.tier, 'critical');
  assert.equal(merged.meta.mechanism, 'auto');
  assert.equal(merged.meta.subject, 'Enriched Subject');
  // Node a recebe tag do enrichment
  assert.equal(merged.nodes[0].sublabel, 'spec');
  assert.equal(merged.nodes[0].tag, 'scope:backend');
  // Views do enrichment
  assert.equal(merged.meta.views[0].id, 'overview');
});

test('mergeEnrichment sem enrichment deixa primary intocado', () => {
  const primary = {
    meta: {title: 'X'},
    nodes: [{id: 'a', label: 'A', lane: 'agent', col: 0, type: 'external'}],
  };
  const merged = mergeEnrichment(primary, null);
  assert.equal(merged.meta.title, 'X');
  assert.equal(merged.nodes[0].label, 'A');
});

test('mergeEnrichment sem actorTags deixa nodes originais (sublabel/tag undefined)', () => {
  const primary = {
    meta: {title: 'X'},
    nodes: [{id: 'a', label: 'A', lane: 'agent', col: 0, type: 'external'}],
  };
  const enrichment = {tier: 'nice', mechanism: 'auto', subject: 'Y'};
  const merged = mergeEnrichment(primary, enrichment);
  assert.equal(merged.meta.tier, 'nice');
  assert.equal(merged.nodes[0].sublabel, undefined);
  assert.equal(merged.nodes[0].tag, undefined);
});

// 5. E2E: pipeline MD + catalog → IR enriquecido

test('E2E: backend-feature.md + catalog → IR com tier/mechanism/subject/views/tags', async () => {
  const md = await fs.readFile(path.join(workflowsDir, 'backend-feature.md'), 'utf8');
  const actors = extractPipelineFromMd(md);
  assert.equal(actors.length, 4);

  const ir = generateIr({
    actors,
    title: extractTitle(md, 'backend-feature'),
    flowId: 'backend-feature',
  });
  assert.ok(validateWf(ir), `IR pre-enrichment nao passa schema: ${JSON.stringify(validateWf.errors)}`);

  // Enrichment
  const enrichment = await enrichIrFromCatalog({catalogPath, flowId: 'flow-backend-feature'});
  assert.ok(enrichment, 'catalog deve ter flow-backend-feature');
  const enriched = mergeEnrichment(ir, {
    ...enrichment,
    actorTags: Object.fromEntries(
      ir.nodes.map((n) => {
        const originalActor = actors.find((a) => a.toLowerCase().replaceAll('-', '_') === n.id);
        return [n.id, tagActor(originalActor)];
      }),
    ),
    views: [{
      id: 'sequence-overview',
      label: 'Sequence Overview',
      focus: ir.nodes.map((n) => n.id),
      note: `Sequência nominal: ${actors.join(' → ')}`,
    }],
  });
  assert.ok(validateWf(enriched), `IR enriquecido nao passa schema: ${JSON.stringify(validateWf.errors)}`);

  // Campos enriquecidos
  assert.equal(enriched.meta.tier, 'critical');
  assert.equal(enriched.meta.mechanism, 'auto');
  assert.match(enriched.meta.subject, /Backend NestJS/);
  // Tags em nodes
  assert.equal(enriched.nodes[0].sublabel, 'specialist'); // NESTJS-SPECIALIST
  assert.equal(enriched.nodes[0].tag, 'scope:backend');
  // View alternativa
  assert.equal(enriched.meta.views.length, 1);
  assert.equal(enriched.meta.views[0].id, 'sequence-overview');
  assert.deepEqual(enriched.meta.views[0].focus, [
    'nestjs_specialist',
    'test_writer',
    'code_reviewer',
    'tdd_enforcer',
  ]);

  // Validar via CLI
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-enrich-e2e-'));
  const jsonPath = path.join(tmp, 'flow.workflow.json');
  await fs.writeFile(jsonPath, JSON.stringify(enriched, null, 2));
  let stdout;
  try {
    stdout = (await import('node:child_process')).execFileSync('node', [
      archifyBin, 'validate', 'workflow', jsonPath, '--quality=standard', '--json',
    ], {encoding: 'utf8', cwd: baseRepo, timeout: 30_000});
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.ok, true, `validate falhou: ${JSON.stringify(receipt, null, 2)}`);
});

// 6. parseArchiveDemand (bonus B30)

test('parseArchiveDemand extrai 6 passos sequenciais do archive-demand.md', async () => {
  const md = await fs.readFile(path.join(workflowsDir, 'archive-demand.md'), 'utf8');
  const result = parseArchiveDemand(md, {flowId: 'archive-demand'});
  assert.equal(result.nodes.length, 6, `esperava 6 nodes, recebi ${result.nodes.length}`);
  // Cada node tem id/lane/col/type=external/label (step title)
  for (let i = 0; i < result.nodes.length; i += 1) {
    const n = result.nodes[i];
    assert.equal(n.lane, 'archive');
    assert.equal(n.col, i);
    assert.equal(n.type, 'external');
    assert.ok(n.id, `node ${i} deve ter id`);
    assert.ok(n.label, `node ${i} deve ter label`);
  }
  // Edges conectam consecutive nodes
  assert.equal(result.edges.length, 5);
  // mainPath contem todos os ids em ordem
  assert.equal(result.mainPath.length, 6);
  // 1o step e "Validar elegibilidade" (strip bold)
  assert.match(result.nodes[0].label, /Validar elegibilidade/);
});

test('parseArchiveDemand gera IR que passa no schema workflow v2', async () => {
  const md = await fs.readFile(path.join(workflowsDir, 'archive-demand.md'), 'utf8');
  const result = parseArchiveDemand(md, {flowId: 'archive-demand', title: 'Archive Demand'});
  // Wrap em IR completo
  const ir = {
    schema_version: 2,
    diagram_type: 'workflow',
    meta: {
      title: result.title,
      animation: 'trace',
      visual_preset: 'signal-flow',
      quality_profile: 'standard',
    },
    lanes: [{id: 'archive', label: 'Archive Pipeline'}],
    phases: [],
    groups: [],
    cards: [],
    nodes: result.nodes,
    edges: result.edges,
    mainPath: result.mainPath,
  };
  assert.ok(validateWf(ir), `IR nao passa schema: ${JSON.stringify(validateWf.errors)}`);
});

test('parseArchiveDemand retorna null para MD sem secao "Passo a passo"', () => {
  const md = '# Sem lista numerada\n\nso texto\n';
  assert.equal(parseArchiveDemand(md, {flowId: 'x'}), null);
});

// 7. E2E: archive-demand.md via parser dedicado → IR sequencial

test('E2E: archive-demand.md → IR sequencial (6 nodes, 5 edges) + enrichment catalog', async () => {
  const md = await fs.readFile(path.join(workflowsDir, 'archive-demand.md'), 'utf8');
  const parsed = parseArchiveDemand(md, {flowId: 'archive-demand', title: 'Archive Demand'});
  assert.ok(parsed);
  const ir = {
    schema_version: 2,
    diagram_type: 'workflow',
    meta: {
      title: parsed.title,
      animation: 'trace',
      visual_preset: 'signal-flow',
      quality_profile: 'standard',
    },
    lanes: [{id: 'archive', label: 'Archive Pipeline'}],
    phases: [],
    groups: [],
    cards: [],
    nodes: parsed.nodes,
    edges: parsed.edges,
    mainPath: parsed.mainPath,
  };
  // Tambem enrichment catalog (archive-demand tem tier=nice no catalog)
  const enrichment = await enrichIrFromCatalog({catalogPath, flowId: 'flow-archive-demand'});
  if (enrichment) {
    // Sem actorTags (archive-demand nao tem actors formais)
    const merged = mergeEnrichment(ir, enrichment);
    assert.equal(merged.meta.tier, 'nice');
    assert.equal(merged.meta.mechanism, 'auto');
    assert.match(merged.meta.subject, /Demanda/);
    // Validar via CLI
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-enrich-archive-'));
    const jsonPath = path.join(tmp, 'flow.workflow.json');
    await fs.writeFile(jsonPath, JSON.stringify(merged, null, 2));
    try {
      const stdout = (await import('node:child_process')).execFileSync('node', [
        archifyBin, 'validate', 'workflow', jsonPath, '--quality=standard', '--json',
      ], {encoding: 'utf8', cwd: baseRepo, timeout: 30_000});
      const receipt = JSON.parse(stdout);
      assert.equal(receipt.ok, true, `validate falhou: ${JSON.stringify(receipt, null, 2)}`);
    } finally {
      await fs.rm(tmp, {recursive: true, force: true});
    }
  }
});
