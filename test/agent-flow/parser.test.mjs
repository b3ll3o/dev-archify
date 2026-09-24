// Testes do parser de agent workflows (.agents/workflows/*.md) -> IR workflow.json v2.
//
// Cobertura:
//   1. parsePipeline        (split por `→`)
//   2. toNodeId / toNodeLabel (snake_case + kebab-case)
//   3. extractPipelineFromMd (localiza bloco ```text com setas)
//   4. extractFrontmatter   (YAML frontmatter)
//   5. extractTrigger       (campo `**Trigger:** "..."`)
//   6. generateIr           (compila IR workflow.json v2 a partir de actors + opts)
//   7. end-to-end           (MD real -> IR -> archify validate --quality standard)
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
import {
  parsePipeline,
  toNodeId,
  toNodeLabel,
  extractPipelineFromMd,
  extractFrontmatter,
  extractTrigger,
  extractTitle,
  generateIr,
} from '../../bin/agent-flow/parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const archifyBin = path.join(repoRoot, 'bin', 'archify.mjs');
const baseRepo = path.resolve(repoRoot, '..');
const workflowsDir = path.join(baseRepo, '.agents/workflows');

const ajv = new Ajv({strict: false, allErrors: true, allowUnionTypes: true});
ajv.addSchema(commonSchema, 'common.schema.json');
const validateWf = ajv.compile(wfSchema);

test('parsePipeline divide string com setas Unicode → preservando ordem', () => {
  const actors = parsePipeline('NESTJS-SPECIALIST → TEST-WRITER → CODE-REVIEWER → TDD-ENFORCER');
  assert.deepEqual(actors, [
    'NESTJS-SPECIALIST',
    'TEST-WRITER',
    'CODE-REVIEWER',
    'TDD-ENFORCER',
  ]);
});

test('parsePipeline tolera espacos extras e setas alternativas', () => {
  // Strings hifenizadas compostas (e.g. CI-DEFENSE-IN-DEPTH) NAO devem quebrar
  // — o separador é `→` U+2192, nao hifens internos.
  const actors = parsePipeline('A  →  B →   C');
  assert.deepEqual(actors, ['A', 'B', 'C']);
});

test('parsePipeline retorna array vazio para string sem setas', () => {
  assert.deepEqual(parsePipeline(''), []);
  // String sem setas → [] (string com 1 actor sozinho nao constitui pipeline)
  assert.deepEqual(parsePipeline('only-one'), []);
});

test('parsePipeline strip anotacao em parenteses (e.g. "(skill)")', () => {
  const actors = parsePipeline('CI-DEFENSE-IN-DEPTH (skill) → CODE-REVIEWER');
  assert.deepEqual(actors, ['CI-DEFENSE-IN-DEPTH', 'CODE-REVIEWER']);
});

test('parsePipeline tolera anotacoes em ambas pontas', () => {
  const actors = parsePipeline('EXPLORER (coleta) → RETROSPECTIVE-CAPTURE (analisa) → DOC-WRITER (escreve)');
  assert.deepEqual(actors, ['EXPLORER', 'RETROSPECTIVE-CAPTURE', 'DOC-WRITER']);
});

test('toNodeId converte UPPER-CASE-HYPHEN para snake_case', () => {
  assert.equal(toNodeId('NESTJS-SPECIALIST'), 'nestjs_specialist');
  assert.equal(toNodeId('TEST-WRITER'), 'test_writer');
  assert.equal(toNodeId('CI-DEFENSE-IN-DEPTH'), 'ci_defense_in_depth');
  assert.equal(toNodeId('CODE-REVIEWER'), 'code_reviewer');
});

test('toNodeId e idempotente (lowercase snake_case passa direto)', () => {
  assert.equal(toNodeId('nestjs_specialist'), 'nestjs_specialist');
});

test('toNodeLabel converte UPPER-CASE-HYPHEN para kebab-case', () => {
  assert.equal(toNodeLabel('NESTJS-SPECIALIST'), 'nestjs-specialist');
  assert.equal(toNodeLabel('CODE-REVIEWER'), 'code-reviewer');
});

test('toNodeLabel eh idempotente para kebab-case ja em lowercase', () => {
  assert.equal(toNodeLabel('nextjs-specialist'), 'nextjs-specialist');
});

test('extractFrontmatter parseia bloco YAML entre --- leading e --- trailing', () => {
  const md = `---
name: backend-feature
description: Implementar endpoint
type: workflow
---

# Heading
`;
  const fm = extractFrontmatter(md);
  assert.equal(fm.name, 'backend-feature');
  assert.equal(fm.description, 'Implementar endpoint');
  assert.equal(fm.type, 'workflow');
});

test('extractFrontmatter retorna {} quando MD nao tem frontmatter', () => {
  const md = '# Sem frontmatter\n\ntexto';
  assert.deepEqual(extractFrontmatter(md), {});
});

test('extractTrigger parseia campo **Trigger:** quoted-comma-separated', () => {
  const md = `
**Trigger:** "criar endpoint X", "implementar módulo Y no NestJS", "adicionar CRUD de Z"

**Composição:** sequential (4 estágios)
`;
  const trigger = extractTrigger(md);
  assert.deepEqual(trigger, [
    'criar endpoint X',
    'implementar módulo Y no NestJS',
    'adicionar CRUD de Z',
  ]);
});

test('extractTrigger retorna array vazio quando ausente', () => {
  const md = '# Sem trigger\n';
  assert.deepEqual(extractTrigger(md), []);
});

test('extractTitle prefere H1 (backticks removidos), cai para frontmatter.name', () => {
  const md = '# `backend-feature` — Implementar Feature\n\nresto';
  assert.equal(extractTitle(md, 'fm-name-fallback'), 'backend-feature — Implementar Feature');
});

test('extractPipelineFromMd extrai o primeiro code-fence ```text com seta', () => {
  const md = `
Algum texto introdutorio.

\`\`\`text
NESTJS-SPECIALIST → TEST-WRITER → CODE-REVIEWER → TDD-ENFORCER
\`\`\`

Mais texto depois.
`;
  const actors = extractPipelineFromMd(md);
  assert.deepEqual(actors, [
    'NESTJS-SPECIALIST',
    'TEST-WRITER',
    'CODE-REVIEWER',
    'TDD-ENFORCER',
  ]);
});

test('extractPipelineFromMd aceita fence sem linguagem (``` vazio)', () => {
  const md = `
\`\`\`
MONOREPO-SPECIALIST → CODE-REVIEWER
\`\`\`
`;
  const actors = extractPipelineFromMd(md);
  assert.deepEqual(actors, ['MONOREPO-SPECIALIST', 'CODE-REVIEWER']);
});

test('extractPipelineFromMd retorna [] se nao encontrar pipeline ASCII', () => {
  const md = '# so heading\n\nsem pipeline\n';
  assert.deepEqual(extractPipelineFromMd(md), []);
});

test('extractPipelineFromMd cai no fallback box-art quando nao ha seta no fence', () => {
  const md = `
\`\`\`text
┌────────────────┐
│   DOC-WRITER   │  Atualiza 3 docs
└────────┬───────┘
         ▼
┌────────────────┐
│  CODE-REVIEWER │  Valida cross-refs
└────────────────┘
\`\`\`
`;
  const actors = extractPipelineFromMd(md);
  assert.deepEqual(actors, ['DOC-WRITER', 'CODE-REVIEWER']);
});

test('extractPipelineFromMd prefere pipeline com seta sobre box-art', () => {
  // Quando ha AMBOS no mesmo MD (raro), seta vence.
  const md = `
\`\`\`text
EXPLORER → RETROSPECTIVE
\`\`\`

\`\`\`text
┌──────────┐
│ DOC-WRITER │
└──────────┘
\`\`\`
`;
  const actors = extractPipelineFromMd(md);
  assert.deepEqual(actors, ['EXPLORER', 'RETROSPECTIVE']);
});

test('generateIr produz IR workflow.json v2 com lanes/nodes/edges/mainPath', () => {
  const actors = ['NESTJS-SPECIALIST', 'TEST-WRITER', 'CODE-REVIEWER', 'TDD-ENFORCER'];
  const ir = generateIr({
    actors,
    title: 'Backend Feature',
    subject: 'criar endpoint X',
    flowId: 'backend-feature',
  });
  assert.equal(ir.schema_version, 2);
  assert.equal(ir.diagram_type, 'workflow');
  assert.equal(ir.meta.title, 'Backend Feature');
  assert.equal(ir.lanes.length, 1);
  assert.equal(ir.lanes[0].id, 'agent');
  assert.equal(ir.nodes.length, 4);
  assert.equal(ir.edges.length, 3);
  assert.deepEqual(ir.mainPath, [
    'nestjs_specialist',
    'test_writer',
    'code_reviewer',
    'tdd_enforcer',
  ]);
  // Cada node recebe lane/phase/col consistente
  for (let i = 0; i < ir.nodes.length; i += 1) {
    assert.equal(ir.nodes[i].lane, 'agent');
    assert.equal(ir.nodes[i].col, i);
    assert.equal(ir.nodes[i].type, 'external'); // default MVP
  }
  // Edges sao main com role=main
  for (const edge of ir.edges) {
    assert.equal(edge.role, 'main');
  }
});

test('generateIr IR passa no Ajv (schema workflow v2)', () => {
  const ir = generateIr({
    actors: ['A-SPECIALIST', 'B-REVIEWER'],
    title: 'X',
    subject: 'qualquer',
    flowId: 'x',
  });
  const ok = validateWf(ir);
  assert.ok(ok, `IR nao passa schema: ${JSON.stringify(validateWf.errors)}`);
});

test('generateIr com actor unico emite erro claro (schema requer mainPath >=2)', () => {
  assert.throws(
    () => generateIr({
      actors: ['ONLY-ONE'],
      title: 'X',
      subject: 'qualquer',
      flowId: 'x',
    }),
    /at least 2 actors/i,
  );
});

test('E2E: backend-feature.md -> IR -> archify validate --quality standard passa ok=true', async () => {
  const mdPath = path.join(workflowsDir, 'backend-feature.md');
  const md = await fs.readFile(mdPath, 'utf8');
  const actors = extractPipelineFromMd(md);
  assert.equal(actors.length, 4, `esperava 4 actors, recebi ${actors.length}`);
  const ir = generateIr({
    actors,
    title: extractTitle(md, 'backend-feature'),
    subject: 'criar endpoint X',
    flowId: 'backend-feature',
  });
  // Schema-level sanity
  assert.ok(validateWf(ir), `IR nao passa schema: ${JSON.stringify(validateWf.errors)}`);

  // Write to tmp e validar via archify CLI
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-agent-flow-'));
  const jsonPath = path.join(tmp, 'flow-backend-feature.workflow.json');
  await fs.writeFile(jsonPath, JSON.stringify(ir, null, 2));

  let stdout;
  try {
    stdout = execFileSync('node', [
      archifyBin, 'validate', 'workflow', jsonPath, '--quality=standard', '--json',
    ], {encoding: 'utf8', cwd: baseRepo, timeout: 30_000});
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.ok, true, `validate falhou: ${JSON.stringify(receipt, null, 2)}`);
});

test('E2E: 8 agent-workflows MDs (arrow + box-art) geram IR estruturalmente valido', async () => {
  const mdFiles = (await fs.readdir(workflowsDir)).filter((f) => f.endsWith('.md')).sort();
  assert.equal(mdFiles.length, 9, `esperava 9 MDs no total, encontrei ${mdFiles.length}`);
  // 8 dos 9 MDs seguem o pattern `A → B → C` ou ASCII box-art (`│ NAME │`).
  // archive-demand.md usa formato diferente (lista numerada) — coberto pelo
  // parser dedicado em enrichment.mjs (commit 2). Este E2E cobre os 8 arrow/box-art.
  const generable = [];
  for (const f of mdFiles) {
    const md = await fs.readFile(path.join(workflowsDir, f), 'utf8');
    const actors = extractPipelineFromMd(md);
    if (actors.length >= 2) generable.push({file: f, actors});
  }
  assert.equal(generable.length, 8,
    `esperava 8 MDs auto-generable, encontrei ${generable.length}: ${generable.map(g => g.file).join(', ')}`);
  for (const {file, actors} of generable) {
    const md = await fs.readFile(path.join(workflowsDir, file), 'utf8');
    const flowId = file.replace(/\.md$/, '');
    const ir = generateIr({
      actors,
      title: extractTitle(md, flowId),
      subject: 'agent-workflow',
      flowId,
    });
    assert.equal(ir.diagram_type, 'workflow');
    assert.equal(ir.nodes.length, actors.length);
    assert.equal(ir.edges.length, actors.length - 1);
    assert.equal(ir.mainPath.length, actors.length);
    assert.ok(validateWf(ir), `${file}: IR nao passa schema: ${JSON.stringify(validateWf.errors)}`);
  }
});

test('archive-demand.md (lista numerada, sem fence com seta/box-art) usa parser dedicado em B30+', async () => {
  const md = await fs.readFile(path.join(workflowsDir, 'archive-demand.md'), 'utf8');
  // Confirmar que extractPipelineFromMd NAO consegue parsear archive-demand.md
  // (faltam fence com seta ou box-art). Parser dedicado parseArchiveDemand
  // (B30 commit 2) cobre este caso via lista numerada em "## Passo a passo".
  assert.deepEqual(extractPipelineFromMd(md), [],
    'archive-demand.md nao tem fence com pipeline ASCII; parser dedicado trata via lista numerada');
});
