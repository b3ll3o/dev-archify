// CLI orchestrator do subcommand `archify flow enrich <json>` (B32).
//
// Carrega JSON (workflow/sequence/dataflow/architecture/lifecycle), aplica
// `enrichIrFromCatalog` (catalog → meta.tier/mechanism/subject) e, para
// workflows, aplica tagActor em cada node (id → actor name → role/scope).
//
// Uso:
//   node bin/archify.mjs enrich --source <workflow.json> [--out <enriched.json>]
//                              [--catalog <docs/flows/README.md>]
//                              [--quality standard|showcase]
//
// Exit codes:
//   0 sucesso (enriquecimento aplicado ou parcial com warning)
//   2 argumento invalido / source nao encontrado
//   1 erro interno
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {enrichIrFromCatalog, mergeEnrichment, tagActor} from './enrichment.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const archifyBin = path.resolve(__dirname, '..', 'archify.mjs');
const baseRepoRoot = path.resolve(__dirname, '..', '..', '..');

const HELP_TEXT = `Usage:
  archify flow enrich --source <json> [--out <json>]
                       [--catalog <docs/flows/README.md>]
                       [--quality standard|showcase]
                       [--no-validate] [--json]

Options:
  --source <json>      Source JSON (workflow/sequence/dataflow/architecture/lifecycle). Required.
  --out <json>         Output path. If omitted, writes JSON to stdout.
  --catalog <md>       Catalog Markdown (default: docs/flows/README.md).
  --quality <level>    standard | showcase (default: standard).
  --no-validate        Skip the post-write \`archify validate\` step.
  --json               Emit machine-readable receipt on stderr.
  --help               Print this help.

Exit codes:
  0 success, 2 bad args / source missing, 1 internal error.
`;

// Tipos que aceitam enrich (catalog + actor tags so em workflow).
const ENRICHABLE_TYPES = new Set(['workflow', 'sequence', 'dataflow', 'architecture', 'lifecycle']);

export function parseEnrichArgs(args) {
  const opts = {_: []};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }
    if (a === '--json') {
      opts.json = true;
      continue;
    }
    if (a === '--no-validate') {
      opts.validate = false;
      continue;
    }
    if (a.startsWith('--') && a.includes('=')) {
      const key = a.slice(2, a.indexOf('='));
      opts[key] = a.slice(a.indexOf('=') + 1);
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        opts[key] = next;
        i += 1;
      } else {
        opts[key] = true;
      }
      continue;
    }
    opts._.push(a);
  }
  // Defaults
  if (opts.validate === undefined) opts.validate = true;
  return opts;
}

// Converte snake_case id → UPPER-CASE-HYPHEN para tagActor.
// "nestjs_specialist" → "NESTJS-SPECIALIST"
// Idempotente: ja em UPPER-CASE-HYPHEN passa direto.
function idToActorName(id) {
  return String(id || '').toUpperCase().replaceAll('_', '-');
}

// Detecta flowId via meta.flow_id, meta.subject, meta.title ou filename.
// Ordem de prioridade: meta explicito > flow-<id> em title/subject > filename.
function detectFlowId(parsed, sourcePath) {
  if (parsed?.meta?.flow_id) return String(parsed.meta.flow_id);
  // Tenta achar `flow-<id>` no title ou subject
  const text = [parsed?.meta?.title, parsed?.meta?.subject].filter(Boolean).join(' ');
  if (text) {
    const m = text.match(/flow-[a-z0-9-]+/i);
    if (m) return m[0].toLowerCase();
  }
  // Fallback: filename sem extensao(s)
  // Strip sufixos como .workflow.json, .sequence.json, etc.
  const base = path.basename(sourcePath)
    .replace(/(\.(workflow|sequence|dataflow|architecture|lifecycle))?\.json$/, '')
    .replace(/^\.+|\.+$/g, '');
  if (base) return base;
  return null;
}

// Aplica tagActor em cada node do IR (workflows only).
function tagNodes(ir) {
  if (!Array.isArray(ir?.nodes)) return {};
  const actorTags = {};
  for (const node of ir.nodes) {
    if (!node?.id) continue;
    const actor = idToActorName(node.id);
    actorTags[node.id] = tagActor(actor);
  }
  return actorTags;
}

export async function runEnrichCommand({
  sourcePath,
  outPath,
  catalogPath,
  quality = 'standard',
  validate = true,
  archifyBin: cliBin = archifyBin,
  cwd,
} = {}) {
  if (!sourcePath) {
    const err = new Error('runEnrichCommand: `sourcePath` is required');
    err.exitCode = 2;
    throw err;
  }
  if (quality && !['standard', 'showcase'].includes(quality)) {
    const err = new Error(`runEnrichCommand: \`quality\` must be 'standard' or 'showcase' (got '${quality}')`);
    err.exitCode = 2;
    throw err;
  }

  // 1. Load + parse JSON
  let raw;
  try {
    raw = await fs.readFile(sourcePath, 'utf8');
  } catch (e) {
    const err = new Error(`cannot read source JSON: ${sourcePath} (${e.message})`);
    err.exitCode = 2;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`cannot parse source JSON: ${sourcePath} (${e.message})`);
    err.exitCode = 2;
    throw err;
  }

  const diagramType = parsed?.diagram_type || 'workflow';
  if (!ENRICHABLE_TYPES.has(diagramType)) {
    const err = new Error(`unsupported diagram_type "${diagramType}" (expected one of: ${[...ENRICHABLE_TYPES].join(', ')})`);
    err.exitCode = 2;
    throw err;
  }

  // 2. Detect flowId
  const detectedFlowId = detectFlowId(parsed, sourcePath);
  // Catalog pode ter rows com:
  //   - prefixo `flow-<id>` (agent-workflows) OU sem prefixo (http-api-*,
  //     ci-*, telemetry.*, web-app-*, fs-*, df-*)
  //   - sufixo de tipo explicito (e.g. `telemetry.frontend.browser.sdk.init.dataflow`)
  //     OU sem sufixo (e.g. `flow-archive-demand`)
  // Tentar todas as combinacoes para nao quebrar enrichment retroativo
  // dos 78 flows (B34): primeira forma literal, depois prefixo `flow-` se
  // nao comecar com `flow-`, depois sufixo `.${diagramType}`.
  const candidates = [];
  if (detectedFlowId) {
    candidates.push(detectedFlowId);
    if (!detectedFlowId.startsWith('flow-')) {
      candidates.push(`flow-${detectedFlowId}`);
    }
    if (!detectedFlowId.endsWith(`.${diagramType}`)) {
      candidates.push(`${detectedFlowId}.${diagramType}`);
    }
  }

  // 3. Catalog enrichment (B30): pode falhar gracefully
  let catalogEnrichment = null;
  let catalogWarning = null;
  let catalogFlowId = null;
  if (candidates.length > 0) {
    const finalCatalog = catalogPath || path.join(baseRepoRoot, 'docs/flows/README.md');
    for (const cand of candidates) {
      try {
        const res = await enrichIrFromCatalog({catalogPath: finalCatalog, flowId: cand});
        if (res) {
          catalogEnrichment = res;
          catalogFlowId = cand;
          break;
        }
      } catch (e) {
        catalogWarning = e.message;
      }
    }
  }

  // 4. Workflows only: tagActor nos nodes
  const actorTags = diagramType === 'workflow' ? tagNodes(parsed) : {};

  // 5. Merge enrichment (primary vence em conflito)
  const enrichment = {
    ...(catalogEnrichment || {}),
    actorTags,
  };
  let enriched = mergeEnrichment(parsed, Object.keys(enrichment).length > 0 ? enrichment : null);

  // Override quality_profile se solicitado
  if (enriched.meta) enriched.meta.quality_profile = quality;

  // 6. Output: --out ou stdout
  const outputText = JSON.stringify(enriched, null, 2);
  let wroteFile = false;
  if (outPath) {
    await fs.mkdir(path.dirname(outPath), {recursive: true});
    await fs.writeFile(outPath, outputText);
    wroteFile = true;
  }
  // Quando --out ausente, retorna `stdoutJson` no receipt; o dispatcher
  // escreve em stdout APOS chamar o orchestrator (evita JSON + log pollution).

  // 7. Validate (warning-only via shellArchify validate)
  let validateReceipt = null;
  if (validate && outPath) {
    try {
      const stdout = execFileSync('node', [
        cliBin, 'validate', diagramType, outPath, `--quality=${quality}`, '--json',
      ], {encoding: 'utf8', timeout: 30_000, ...(cwd ? {cwd} : {})});
      const v = JSON.parse(stdout);
      validateReceipt = {
        status: v.ok === true ? 'passed' : 'failed',
        ok: v.ok === true,
        summary: v.ok === true
          ? `${(v.checks || []).length} artifact checks passed`
          : (v.diagnostics?.[0]?.message || v.error || 'validate failed'),
      };
    } catch (e) {
      validateReceipt = {status: 'failed', ok: false, summary: e.message};
    }
  }

  return {
    sourcePath,
    outPath: outPath || null,
    wroteFile,
    diagramType,
    flowId: catalogFlowId,
    enrichment: {
      catalogApplied: catalogEnrichment !== null,
      catalogWarning,
      tier: enriched.meta?.tier || null,
      mechanism: enriched.meta?.mechanism || null,
      subject: enriched.meta?.subject || null,
      actorTagsApplied: Object.keys(actorTags).length,
    },
    quality,
    validate: validateReceipt,
    exitCode: 0,
    ...(outPath ? {} : {stdoutJson: outputText}),
  };
}

// IIFE gate: so executa quando invocado via `node bin/agent-flow/enrich-cli.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseEnrichArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (opts._.length > 0) {
    console.error(`enrich: unexpected positional arguments: ${opts._.join(' ')}`);
    process.exit(2);
  }
  if (!opts.source) {
    console.error('enrich: --source is required');
    console.error(HELP_TEXT);
    process.exit(2);
  }
  const sourcePath = path.resolve(opts.source);
  const outPath = opts.out ? path.resolve(opts.out) : null;
  const catalogPath = opts.catalog ? path.resolve(opts.catalog) : null;
  const quality = opts.quality || 'standard';

  runEnrichCommand({sourcePath, outPath, catalogPath, quality, validate: opts.validate !== false})
    .then((receipt) => {
      if (opts.json) {
        process.stderr.write(`${JSON.stringify(receipt, null, 2)}\n`);
      } else {
        const target = receipt.outPath || 'stdout';
        console.log(`enriched ${receipt.diagramType} ${receipt.sourcePath} → ${target}`);
        console.log(`  flowId: ${receipt.flowId || '(unknown)'}`);
        console.log(`  enrichment: tier=${receipt.enrichment.tier || '-'} mechanism=${receipt.enrichment.mechanism || '-'} actorTags=${receipt.enrichment.actorTagsApplied}`);
        if (receipt.enrichment.catalogWarning) {
          console.log(`  catalogWarning: ${receipt.enrichment.catalogWarning}`);
        }
        if (receipt.validate) {
          const badge = receipt.validate.ok ? 'passed' : `failed: ${receipt.validate.summary || ''}`;
          console.log(`  validate: ${badge}`);
        }
      }
      process.exit(receipt.exitCode || 0);
    })
    .catch((err) => {
      console.error(`enrich: ${err.message}`);
      process.exit(err.exitCode || 1);
    });
}