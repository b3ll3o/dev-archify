// Enrichment do IR workflow.json v2 (B30).
//
// Fontes secundarias para enriquecer o IR minimalista gerado por `generateIr`:
//   - `docs/flows/README.md` (catalog): tier/mechanism/subject por flow_id
//   - `WORKFLOWS.md` (matriz): sequence nominal (ja disponivel via actors)
//
// APIs (commit 1):
//   - parseCatalogRow(row)              → {flowId, tier, tierEmoji, mechanism, subject} | null
//   - enrichIrFromCatalog({catalogPath, flowId}) → {tier, mechanism, subject} | null
//   - tagActor(name)                    → {role, scope, sublabel, tag}
//   - mergeEnrichment(primary, enrichment) → primary IR com enrichment aplicado
//
// Convensoes:
//   - primary vence em conflito (meta.title, etc.)
//   - actorTags sao aplicados em nodes por id (snake_case)
//   - views[] e adicionado ao final, nunca substitui
//   - mergeEnrichment aceita enrichment=null → retorna primary intacto
import fs from 'node:fs/promises';

// Sufixos que mapeiam para role.
// Ordem importa: suffixes mais longos primeiro (specialist antes de -ist etc).
const ROLE_PATTERNS = [
  {re: /specialist$/i, role: 'specialist'},
  {re: /reviewer$/i, role: 'reviewer'},
  {re: /writer$/i, role: 'writer'},
  {re: /enforcer$/i, role: 'enforcer'},
  {re: /auditor$/i, role: 'auditor'},
  {re: /router$/i, role: 'router'},
  {re: /capture$/i, role: 'capture'},
  {re: /manager$/i, role: 'manager'},
  {re: /planner$/i, role: 'planner'},
  {re: /archiver$/i, role: 'archiver'},
  {re: /refactorer$/i, role: 'refactorer'},
  {re: /orchestrator$/i, role: 'orchestrator'},
  {re: /explorer$/i, role: 'explorer'},
];

// Prefixos que mapeiam para scope.
const SCOPE_PATTERNS = [
  {re: /nestjs/i, scope: 'backend'},
  {re: /nextjs|next\.js/i, scope: 'frontend'},
  {re: /monorepo/i, scope: 'monorepo'},
  {re: /state-aware|state_aware/i, scope: 'state'},
  {re: /archive/i, scope: 'archive'},
  {re: /docker/i, scope: 'infra'},
  {re: /ci-/i, scope: 'ci'},
  {re: /tdd/i, scope: 'quality'},
  {re: /test/i, scope: 'quality'},
  {re: /doc/i, scope: 'docs'},
  {re: /task/i, scope: 'task'},
  {re: /security/i, scope: 'security'},
  {re: /code/i, scope: 'quality'},
];

const TIER_EMOJI_MAP = {
  '🔴': 'critical',
  '🟡': 'important',
  '🟢': 'nice',
};

// Deriva {role, scope, sublabel, tag} do nome do actor (UPPER-CASE-HYPHEN).
// Idempotente: lowercase kebab/snake_case funciona.
export function tagActor(name) {
  const upper = String(name || '').trim();
  if (!upper) return {role: 'agent', scope: 'generic', sublabel: undefined, tag: undefined};

  let role = null;
  for (const {re, role: r} of ROLE_PATTERNS) {
    if (re.test(upper)) {
      role = r;
      break;
    }
  }
  if (!role) role = 'agent';

  let scope = null;
  for (const {re, scope: s} of SCOPE_PATTERNS) {
    if (re.test(upper)) {
      scope = s;
      break;
    }
  }
  if (!scope) scope = 'generic';

  return {
    role,
    scope,
    sublabel: role,
    tag: `scope:${scope}`,
  };
}

// Parseia uma linha do catalog docs/flows/README.md.
// Formato esperado:
//   | `flow-id` | 🔴 critical | auto | workflow | subject... |
// Retorna {flowId, tier, tierEmoji, mechanism, subject} ou null se nao bater.
export function parseCatalogRow(row) {
  if (!row || typeof row !== 'string') return null;
  // Captura: flow-id entre backticks, tier (emoji + name), mechanism, subject (resto)
  const m = row.match(/^\|\s*`([^`]+)`\s*\|\s*(🔴|🟡|🟢)\s+(\w+)\s*\|\s*(\w+)\s*\|\s*(\w+)\s*\|\s*(.+?)\s*\|\s*$/);
  if (!m) return null;
  const [, flowId, emoji, tierName, mechanism, , subject] = m;
  // Valida que o tierName bate com o emoji (sanity check)
  if (TIER_EMOJI_MAP[emoji] !== tierName) return null;
  if (!['auto', 'hand'].includes(mechanism)) return null;
  return {
    flowId,
    tier: tierName,
    tierEmoji: emoji,
    mechanism,
    subject: subject.trim(),
  };
}

// Le o catalog e retorna enrichment para o flowId.
// Lanca erro com envelope se catalog nao pode ser lido.
// Retorna null se flowId nao esta no catalog.
export async function enrichIrFromCatalog({catalogPath, flowId} = {}) {
  if (!catalogPath) {
    const err = new Error('enrichIrFromCatalog: `catalogPath` is required');
    err.exitCode = 2;
    throw err;
  }
  if (!flowId) {
    const err = new Error('enrichIrFromCatalog: `flowId` is required');
    err.exitCode = 2;
    throw err;
  }
  let md;
  try {
    md = await fs.readFile(catalogPath, 'utf8');
  } catch (e) {
    const err = new Error(`cannot read catalog: ${catalogPath} (${e.message})`);
    err.exitCode = 2;
    throw err;
  }
  for (const rawLine of md.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    if (line.includes('Flow ID')) continue; // pula header
    const parsed = parseCatalogRow(line);
    if (parsed && parsed.flowId === flowId) {
      return {
        tier: parsed.tier,
        mechanism: parsed.mechanism,
        subject: parsed.subject,
      };
    }
  }
  return null;
}

// Combina IR primario com enrichment.
// Primary vence em conflito (sobrescreve campos ja presentes em meta).
// Enrichment adiciona:
//   - meta.tier / meta.mechanism / meta.subject (se nao presentes)
//   - meta.views[] (concat, sem duplicar por id)
//   - nodes[].sublabel / nodes[].tag (via actorTags[id])
export function mergeEnrichment(primary, enrichment) {
  if (!primary) {
    const err = new Error('mergeEnrichment: `primary` is required');
    err.exitCode = 2;
    throw err;
  }
  if (!enrichment) return primary;

  const out = JSON.parse(JSON.stringify(primary)); // deep clone para nao mutar input

  // 1. meta fields (primary vence)
  if (!out.meta) out.meta = {};
  if (enrichment.tier && !out.meta.tier) out.meta.tier = enrichment.tier;
  if (enrichment.mechanism && !out.meta.mechanism) out.meta.mechanism = enrichment.mechanism;
  if (enrichment.subject && !out.meta.subject) out.meta.subject = enrichment.subject;

  // 2. actorTags em nodes
  if (enrichment.actorTags && Array.isArray(out.nodes)) {
    for (const node of out.nodes) {
      const tag = enrichment.actorTags[node.id];
      if (!tag) continue;
      // Primary vence: so aplica se o node NAO ja tiver sublabel/tag
      if (!node.sublabel && tag.sublabel) node.sublabel = tag.sublabel;
      if (!node.tag && tag.tag) node.tag = tag.tag;
    }
  }

  // 3. views[]: concat sem duplicar por id (primary views primeiro)
  if (Array.isArray(enrichment.views) && enrichment.views.length > 0) {
    if (!Array.isArray(out.meta.views)) out.meta.views = [];
    const existingIds = new Set(out.meta.views.map((v) => v.id));
    for (const v of enrichment.views) {
      if (!existingIds.has(v.id)) {
        out.meta.views.push(v);
        existingIds.add(v.id);
      }
    }
  }

  return out;
}
