// Parser de agent workflows (.agents/workflows/*.md) → IR workflow.json v2.
//
// Fontes suportadas:
//   - Pipeline ASCII dentro de code-fence ```text (ou ``` sem linguagem):
//       NESTJS-SPECIALIST → TEST-WRITER → CODE-REVIEWER → TDD-ENFORCER
//   - YAML frontmatter (entre `---` leading e `---` trailing)
//   - Trigger inline: `**Trigger:** "frase A", "frase B"`
//   - H1 como título (backticks removidos)
//
// Saída (IR workflow.json v2, schema canônico em schemas/workflow.schema.json):
//   {
//     schema_version: 2,
//     diagram_type: "workflow",
//     meta: { title, subject },
//     lanes: [{ id: "agent", label: "Agent Runtime" }],
//     nodes: [{ id, lane, col, type: "external", label }],
//     edges: [{ id, from, to, role: "main" }],
//     mainPath: [id...],
//     cards: [],
//     groups: [],
//     phases: [],
//   }
//
// MVP intencionalmente minimalista — visual_preset/showcase/subtitle/views/sublabels/tags
// são enriquecidos pelos autores humanos ou por futuras extensions. Este MVP cobre
// o subconjunto mínimo que passa `archify validate workflow --quality standard`.

const ARROW_RE = /\s*→\s*/u;
// Code-fence com linguagem opcional (text, yaml, etc) ou sem linguagem
const FENCE_RE = /```([a-zA-Z][\w-]*)?\n([\s\S]*?)\n```/g;
// Linguagens de data-serialization que NAO devem ser tratadas como pipeline,
// mesmo quando contiverem `→` (e.g. YAML handoffs em `.agents/workflows/*.md`
// que tem `state-aware-planning → analyze:`).
const DATA_LANGS = new Set(['yaml', 'yml', 'json', 'toml', 'ini', 'properties', 'env', 'sh', 'bash']);

// Converte um nome UPPER-CASE-HYPHEN para snake_case.
// Idempotente: se ja esta em snake_case, retorna como esta.
export function toNodeId(name) {
  if (!name) return '';
  return String(name).trim().toLowerCase().replaceAll('-', '_');
}

// Converte um nome UPPER-CASE-HYPHEN para kebab-case.
// Idempotente: ja kebab-case retorna igual.
export function toNodeLabel(name) {
  if (!name) return '';
  return String(name).trim().toLowerCase();
}

// Divide string de pipeline (com `→` U+2192) em array de actors preservando ordem.
// Requer pelo menos uma seta (string sem setas → []). Tolera espacos extras,
// linhas multiplas, e anotacoes em parenteses (e.g. "CI-DEFENSE-IN-DEPTH (skill)"
// → "CI-DEFENSE-IN-DEPTH"). Ignora linhas vazias.
export function parsePipeline(text) {
  if (!text) return [];
  const str = String(text);
  if (!str.includes('→')) return [];
  return str
    .split(/\r?\n/)
    .flatMap((line) => line.split(ARROW_RE))
    .map((s) => s.trim())
    // Strip annotation suffix em parenteses: "FOO (skill)" → "FOO"
    .map((s) => s.replace(/\s*\([^)]*\)\s*$/, '').trim())
    .filter((s) => s.length > 0);
}

// Extrai actors de um bloco ASCII box-art (linhas com `│ NAME │`).
// Usado como fallback quando o MD nao tem pipeline com `→` mas tem arte ASCII.
// Exemplo:
//   ┌────────────────┐
//   │   DOC-WRITER   │  descricao
//   └────────────────┘
//   extrai "DOC-WRITER" da segunda linha.
// Strip anotacao em parenteses (e.g. "CONTROLLER (humano)" → "CONTROLLER")
// para manter compatibilidade com o snake_case/id-pattern do schema.
function extractActorsFromBoxArt(body) {
  const out = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line.includes('│')) continue;
    // Primeiro segmento entre `│` da linha
    const m = line.match(/│\s*([^│]+?)\s*│/);
    if (!m) continue;
    const rawCell = m[1].trim();
    // Strip annotation suffix em parenteses
    const cell = rawCell.replace(/\s*\([^)]*\)\s*$/, '').trim();
    // Ignorar bordas vazias ou so com decorators
    if (!cell || cell.length < 2) continue;
    // Ignorar arte pura (so caracteres box-drawing ou `+`)
    if (/^[─│┌┐└┘├┤┬┴┼+\-=]+$/.test(cell)) continue;
    out.push(cell);
  }
  return out;
}

// Extrai YAML frontmatter do MD (bloco entre --- leading e --- trailing).
// Parser minimo (sem dependencia): suporta pares chave: valor simples e listas inline.
// Suficiente para os campos `name`, `description`, `type` usados nos workflows.
export function extractFrontmatter(md) {
  if (!md) return {};
  const m = String(md).match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const block = m[1];
  const out = {};
  for (const line of block.split('\n')) {
    const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    // Strip surrounding quotes (single ou double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// Extrai o trigger inline: `**Trigger:** "a", "b", "c"` (formato usado em
// `.agents/workflows/*.md` e `.agents/WORKFLOWS.md`).
export function extractTrigger(md) {
  if (!md) return [];
  const m = String(md).match(/\*\*Trigger:\*\*\s*(.+?)(?:\n|$)/);
  if (!m) return [];
  // Captura entre aspas; tolera aspas curvas tipograficas.
  const quotes = [];
  const re = /[“"']+([^”"']+)[”"']+/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) {
    quotes.push(mm[1].trim());
  }
  return quotes;
}

// Extrai o titulo do primeiro H1 (# ...) removendo backticks circumdantes.
// Fallback para frontmatter.name se nao houver H1.
export function extractTitle(md, fallback = '') {
  if (!md) return fallback;
  const m = String(md).match(/^#\s+(.+?)\s*$/m);
  if (!m) return fallback;
  return m[1].replaceAll('`', '').trim();
}

// Extrai o pipeline ASCII: primeiro code-fence ```text (ou ``` sem linguagem)
// que contenha um pipeline com `→`, ou como fallback um bloco com box-art (`│`).
// Retorna [] se nao houver nenhum dos dois formatos.
//
// Ordem de prioridade (primeiro fence nao-data com → vence):
//   1. Arrow pipeline (`A → B → C`) em fence `text`/vazio — formato preferido
//   2. ASCII box-art (`│ NAME │`) em qualquer fence — fallback
//
// Fences `yaml`/`json`/etc. sao IGNORADOS na busca de `→` porque seus `→` sao
// geralmente parte de handoffs (e.g. "state-aware-planning → analyze:"), nao
// do pipeline principal.
export function extractPipelineFromMd(md) {
  if (!md) return [];
  FENCE_RE.lastIndex = 0;
  let match;
  // Primeira passada: arrow pipelines em fences NAO-data (preferidos)
  while ((match = FENCE_RE.exec(String(md))) !== null) {
    const lang = (match[1] || '').toLowerCase();
    if (DATA_LANGS.has(lang)) continue;
    const body = match[2];
    if (body.includes('→')) {
      return parsePipeline(body);
    }
  }
  // Segunda passada: box-art em qualquer fence (fallback)
  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(String(md))) !== null) {
    const body = match[2];
    if (body.includes('│')) {
      const actors = extractActorsFromBoxArt(body);
      if (actors.length >= 2) return actors;
    }
  }
  return [];
}

// Gera IR workflow.json v2 a partir dos actors parseados.
//
//   generateIr({ actors: ['A-SPECIALIST', 'B-REVIEWER'], title, subject, flowId })
//
// Requisitos do schema v2:
//   - mainPath >= 2
//   - nodes >= 1
//   - edges >= 1 quando ha >= 2 nodes
//
// MVP: actors sao colocados na lane "agent" em colunas sequenciais (0..n-1),
// edges sao lineares conectando consecutive nodes com role=main.
export function generateIr({actors, title, subject, flowId}) {
  if (!Array.isArray(actors) || actors.length < 2) {
    throw new Error(`generateIr: at least 2 actors required (got ${actors?.length || 0}) for flow "${flowId || '?'}"`);
  }
  // Dedup por id, preservando ordem (evita nodes duplicados se frontmatter cita actors)
  const seen = new Set();
  const dedup = [];
  for (const a of actors) {
    const id = toNodeId(a);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    dedup.push(a);
  }
  if (dedup.length < 2) {
    throw new Error(`generateIr: at least 2 unique actors required for flow "${flowId || '?'}"`);
  }

  const nodes = dedup.map((actor, i) => ({
    id: toNodeId(actor),
    label: toNodeLabel(actor),
    lane: 'agent',
    col: i,
    type: 'external',
    width: 160,
  }));

  const edges = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    edges.push({
      id: `${nodes[i].id}-to-${nodes[i + 1].id}`,
      from: nodes[i].id,
      to: nodes[i + 1].id,
      role: 'main',
    });
  }

  return {
    schema_version: 2,
    diagram_type: 'workflow',
    meta: {
      title: title || flowId || 'Agent Workflow',
      animation: 'trace',
      visual_preset: 'signal-flow',
      quality_profile: 'standard',
    },
    lanes: [{id: 'agent', label: 'Agent Runtime'}],
    phases: [],
    groups: [],
    cards: [],
    nodes,
    edges,
    mainPath: nodes.map((n) => n.id),
  };
}

// Write atômico via staging+rename (mesmo pattern do runner.mjs flow).
import {writeFile, rename, mkdir, rm} from 'node:fs/promises';
import {dirname} from 'node:path';

export async function writeAtomic(targetPath, contents, {encoding = 'utf8'} = {}) {
  const dir = dirname(targetPath);
  await mkdir(dir, {recursive: true});
  const tmp = `${targetPath}.${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(tmp, contents, encoding);
    await rename(tmp, targetPath);
  } catch (e) {
    await rm(tmp, {force: true}).catch(() => {});
    throw e;
  }
}

// Re-export enrichment helpers (B30).
// Mantidos em parser.mjs para que tests/clients possam importar de um unico lugar.
export {
  parseCatalogRow,
  enrichIrFromCatalog,
  tagActor,
  mergeEnrichment,
  parseArchiveDemand,
} from './enrichment.mjs';
