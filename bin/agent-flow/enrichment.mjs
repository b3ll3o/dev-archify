// Enrichment do IR workflow.json v2 (B30 + B33).
//
// Fontes secundarias para enriquecer o IR minimalista gerado por `generateIr`:
//   - `docs/flows/README.md` (catalog): tier/mechanism/subject por flow_id
//   - `WORKFLOWS.md` (matriz): sequence nominal (ja disponivel via actors)
//
// APIs:
//   - parseCatalogRow(row)              → {flowId, tier, tierEmoji, mechanism, subject} | null
//   - enrichIrFromCatalog({catalogPath, flowId}) → {tier, mechanism, subject} | null
//   - tagActor(name)                    → {role, scope, sublabel, tag}
//   - mergeEnrichment(primary, enrichment) → primary IR com enrichment aplicado
//   - parseArchiveDemand(md, opts)      → IR sequencial (B30 bonus)
//
// Convensoes:
//   - primary vence em conflito (meta.title, etc.)
//   - actorTags sao aplicados em nodes por id (snake_case)
//   - views[] e adicionado ao final, nunca substitui
//   - mergeEnrichment aceita enrichment=null → retorna primary intacto
//   - tagActor: SPECIFIC_PATTERNS (B33) tem prioridade sobre ROLE/SCOPE genericos
import fs from 'node:fs/promises';

// Padrões especificos: actor conhecido → role+scope atomicos (B33).
// Matched ANTES dos ROLE/SCOPE patterns genericos; ordem = prioridade.
const SPECIFIC_PATTERNS = [
  {re: /^STATE-AWARE-PLANNING$/i, role: 'planner', scope: 'state'},
  {re: /^CI-DEFENSE-IN-DEPTH$/i, role: 'auditor', scope: 'ci'},
  {re: /^SECURITY-MODE$/i, role: 'auditor', scope: 'security'},
  {re: /^REFACTOR-MODE$/i, role: 'refactorer', scope: 'code'},
  {re: /^ARCHIVE-DEMAND$/i, role: 'archiver', scope: 'docs'},
  {re: /^TASK-MODE$/i, role: 'manager', scope: 'task'},
  {re: /^DOCS-MODE$/i, role: 'writer', scope: 'docs'},
  {re: /^REVIEW-MODE$/i, role: 'reviewer', scope: 'quality'},
  {re: /^EXPLORE-MODE$/i, role: 'explorer', scope: 'read'},
  {re: /^RELEASE-MODE$/i, role: 'manager', scope: 'release'},
  {re: /^RETROSPECTIVE-MODE$/i, role: 'capture', scope: 'learning'},
  {re: /^TEST-WRITER$/i, role: 'writer', scope: 'test'},
  {re: /^CODE-REVIEWER$/i, role: 'reviewer', scope: 'code'},
  {re: /^TDD-ENFORCER$/i, role: 'enforcer', scope: 'tdd'},
  {re: /^NESTJS-SPECIALIST$/i, role: 'specialist', scope: 'backend'},
  {re: /^NEXTJS-SPECIALIST$/i, role: 'specialist', scope: 'frontend'},
  {re: /^MONOREPO-SPECIALIST$/i, role: 'specialist', scope: 'monorepo'},
  {re: /^FRONTEND-SPECIALIST$/i, role: 'specialist', scope: 'frontend'},
  {re: /^AGENT-ARCHITECT$/i, role: 'planner', scope: 'architecture'},
];

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
  {re: /nextjs|next\.js|frontend/i, scope: 'frontend'},
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
//
// Resolucao:
//   1. SPECIFIC_PATTERNS: match exato (case-insensitive) define role+scope atomicamente.
//   2. ROLE_PATTERNS: deriva role do sufixo do nome.
//   3. SCOPE_PATTERNS: deriva scope de tokens do nome.
export function tagActor(name) {
  const upper = String(name || '').trim();
  if (!upper) return {role: 'agent', scope: 'generic', sublabel: undefined, tag: undefined};

  // 1. Match especifico (B33): 19 actors com role+scope pre-definidos.
  for (const {re, role: r, scope: s} of SPECIFIC_PATTERNS) {
    if (re.test(upper)) {
      return {
        role: r,
        scope: s,
        sublabel: r,
        tag: `scope:${s}`,
      };
    }
  }

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

// Slugify para ids: "Validar elegibilidade" → "validate_eligibilidade"
// Mantem apenas ASCII alfanumerico + underscores (pattern id do schema).
function slugifyStep(label, idx) {
  const normalized = String(label || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacriticos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || `step_${idx + 1}`;
}

// Parseia archive-demand.md: detecta H2 "Passo a passo" e mapeia lista
// numerada (1. 2. ...) para nodes sequenciais (B30 bonus parser).
//
// Formato esperado:
//   ## Passo a passo
//
//   1. **Validar elegibilidade** (convenção §1):
//      - sub-bullet
//   2. **Coletar metadados**:
//      ...
//
// Cada item vira um node (id=slug do titulo, label=titulo, sublabel=sub-bullets joined).
// Edges conectam consecutive nodes.
export function parseArchiveDemand(md, {flowId = 'archive-demand', title} = {}) {
  if (!md || typeof md !== 'string') return null;
  const lines = md.split('\n');

  // 1. Encontrar H2 "Passo a passo"
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+Passo a passo\s*$/i.test(lines[i])) {
      sectionStart = i + 1;
      break;
    }
  }
  if (sectionStart === -1) return null;

  // 2. Coleta items numerados (1. 2. ...) ate o proximo H2 ou EOF
  const items = [];
  let current = null;
  for (let i = sectionStart; i < lines.length; i += 1) {
    const line = lines[i];
    // Para no proximo H2 (mesmo nivel)
    if (/^##\s+/.test(line)) break;
    // Item numerado (1. 2. ...) no inicio da linha
    const m = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (m) {
      if (current) items.push(current);
      current = {title: m[2].trim(), subItems: []};
      continue;
    }
    // Sub-bullet pertencente ao item atual
    if (current && /^\s*-\s+/.test(line)) {
      const sub = line.replace(/^\s*-\s+/, '').trim();
      current.subItems.push(sub);
    }
    // Linha vazia ou qualquer outra coisa: ignorar (sub-bullets ja foram colados)
  }
  if (current) items.push(current);
  if (items.length < 2) return null;

  // 3. Mapear items para nodes
  const nodes = items.map((item, i) => {
    const cleanTitle = item.title
      .replace(/\s*\([^)]*\)\s*:?\s*$/, '') // remove "(convenção §1):" no final
      .replace(/[*_]+/g, '') // remove bold/italic markdown
      .replace(/:\s*$/, '') // remove trailing colon
      .trim();
    // Sublabel muito curto (apenas primeiro sub-bullet truncado) para caber
    // em node width padrao (160). Mantem info util sem violar layout constraint.
    const sublabel = item.subItems.length > 0
      ? item.subItems[0]
          .replace(/[`*_]+/g, '')
          .replace(/<[^>]+>/g, '')
          .slice(0, 36)
          .trim()
      : undefined;
    return {
      id: slugifyStep(cleanTitle, i),
      label: cleanTitle.length > 40 ? cleanTitle.slice(0, 37) + '...' : cleanTitle,
      lane: 'archive',
      col: i,
      type: 'external',
      sublabel,
      width: 160,
    };
  });

  // 4. Edges conectando consecutive
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
    title: title || 'Archive Demand Pipeline',
    nodes,
    edges,
    mainPath: nodes.map((n) => n.id),
  };
}
