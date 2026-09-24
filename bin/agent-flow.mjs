// CLI entry do subcommand `archify agent-flow`.
//
// Parse args → load MD → extract pipeline → generate IR workflow.json v2
// → write atomic → opcionalmente validate via `archify validate workflow`.
//
// Uso:
//   node bin/archify.mjs agent-flow --source <md> --out <json> [--quality standard|showcase]
//
// Exit codes (alinhados com flow.mjs):
//   0 sucesso (validate passou quando solicitado)
//   2 argumento invalido / fonte nao encontrada / pipeline nao encontrado
//   1 erro interno (write/validate falhou)
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  extractPipelineFromMd,
  extractFrontmatter,
  extractTitle,
  generateIr,
  writeAtomic,
} from './agent-flow/parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const archifyBin = path.resolve(__dirname, 'archify.mjs');

export const HELP_TEXT = `Usage:
  archify agent-flow --source <md> --out <json> [--quality standard|showcase] [--no-validate] [--json]

Options:
  --source <md>      Source MD (e.g. .agents/workflows/backend-feature.md). Required.
  --out <json>       Output path for generated workflow.json. Required.
  --quality <level>  standard | showcase (default: standard).
  --no-validate      Skip the post-write \`archify validate workflow\` step.
  --json             Emit machine-readable receipt.
  --help             Print this help.

Exit codes:
  0 success, 2 bad args / no pipeline found / source unreadable, 1 internal error.

Examples:
  archify agent-flow \\
    --source .agents/workflows/backend-feature.md \\
    --out docs/flows/agent-workflows/flow-backend-feature/flow-backend-feature.workflow.json
`;

const VALID_OPTION_KEYS = new Set([
  'help', 'h', 'json',
  'source', 'out', 'quality', 'no-validate',
]);

export function parseAgentFlowArgs(args) {
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
      // proximo token como valor se nao for flag
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
  // Reject unknown options
  for (const key of Object.keys(opts)) {
    if (key === '_') continue;
    if (!VALID_OPTION_KEYS.has(key)) {
      const err = new Error(`unknown option "--${key}"`);
      err.exitCode = 2;
      throw err;
    }
  }
  // Default validate to true
  if (opts.validate === undefined) opts.validate = true;
  return opts;
}

// Orquestrador do agent-flow: load MD → generate IR → write → validate.
export async function runAgentFlow({sourcePath, outPath, quality = 'standard', validate = true, archifyBin: cliBin = archifyBin, cwd} = {}) {
  if (!sourcePath) {
    const err = new Error('runAgentFlow: `sourcePath` is required');
    err.exitCode = 2;
    throw err;
  }
  if (!outPath) {
    const err = new Error('runAgentFlow: `outPath` is required');
    err.exitCode = 2;
    throw err;
  }
  if (quality && !['standard', 'showcase'].includes(quality)) {
    const err = new Error(`runAgentFlow: \`quality\` must be 'standard' or 'showcase' (got '${quality}')`);
    err.exitCode = 2;
    throw err;
  }
  // 1. Load MD
  let md;
  try {
    md = await fs.readFile(sourcePath, 'utf8');
  } catch (e) {
    const err = new Error(`cannot read source MD: ${sourcePath} (${e.message})`);
    err.exitCode = 2;
    throw err;
  }

  // 2. Extract metadata + pipeline
  const fm = extractFrontmatter(md);
  const flowId = fm.name || path.basename(sourcePath).replace(/\.md$/, '');
  const actors = extractPipelineFromMd(md);
  if (actors.length < 2) {
    const err = new Error(`no pipeline found in ${sourcePath} (need >=2 actors with '→' or ASCII box-art)`);
    err.exitCode = 2;
    throw err;
  }

  const title = extractTitle(md, flowId);
  const ir = generateIr({
    actors,
    title,
    // subject nao e' parte do schema v2 de workflow.json (additionalProperties:false em meta),
    // entao nao populamos — enriquecimento via visual_preset/showcase fica para tasks futuras.
    flowId,
  });
  // Override quality profile solicitado via CLI (default no generateIr: standard)
  ir.meta.quality_profile = quality;

  // 3. Write atomic (staging + rename)
  await writeAtomic(outPath, JSON.stringify(ir, null, 2));

  // 4. Validate (warning-only; nao falhamos o command quando validate falha)
  let validateReceipt = null;
  if (validate) {
    try {
      const stdout = execFileSync('node', [
        cliBin, 'validate', 'workflow', outPath, `--quality=${quality}`, '--json',
      ], {encoding: 'utf8', timeout: 30_000, ...(cwd ? {cwd} : {})});
      const parsed = JSON.parse(stdout);
      validateReceipt = {
        status: parsed.ok === true ? 'passed' : 'failed',
        ok: parsed.ok === true,
        summary: parsed.ok === true
          ? `${(parsed.checks || []).length} artifact checks passed`
          : (parsed.diagnostics?.[0]?.message || parsed.error || 'validate failed'),
      };
    } catch (e) {
      // Validate crashed (e.g. JSON malformed) — record failure but don't throw.
      validateReceipt = {status: 'failed', ok: false, summary: e.message};
    }
  }

  return {
    sourcePath,
    outPath,
    actors,
    nodesCount: ir.nodes.length,
    edgesCount: ir.edges.length,
    mainPath: ir.mainPath,
    quality,
    validate: validateReceipt,
    exitCode: 0,
  };
}

// Re-export parse utilities for tests e integracao.
export {
  extractPipelineFromMd,
  extractFrontmatter,
  extractTitle,
  generateIr,
  writeAtomic,
} from './agent-flow/parser.mjs';

// IIFE gate: so executa quando invocado diretamente (nao quando importado).
// Mesmo pattern usado em bin/flow/runner.mjs para evitar side effects no import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseAgentFlowArgs(process.argv.slice(2));
  if (opts._.length > 0) {
    console.error(`archify agent-flow: unexpected positional arguments: ${opts._.join(' ')}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (!opts.source) {
    console.error('archify agent-flow: --source is required');
    console.error(HELP_TEXT);
    process.exit(2);
  }
  if (!opts.out) {
    console.error('archify agent-flow: --out is required');
    console.error(HELP_TEXT);
    process.exit(2);
  }

  const quality = opts.quality || 'standard';
  if (!['standard', 'showcase'].includes(quality)) {
    console.error(`archify agent-flow: --quality must be 'standard' or 'showcase' (got '${quality}')`);
    process.exit(2);
  }

  const sourcePath = path.resolve(opts.source);
  const outPath = path.resolve(opts.out);

  runAgentFlow({sourcePath, outPath, quality, validate: opts.validate !== false})
    .then((receipt) => {
      if (opts.json) {
        console.log(JSON.stringify(receipt, null, 2));
      } else {
        console.log(`wrote ${receipt.outPath}`);
        console.log(`  actors: ${receipt.actors.length}`);
        console.log(`  nodes:  ${receipt.nodesCount}`);
        console.log(`  edges:  ${receipt.edgesCount}`);
        if (receipt.validate) {
          const badge = receipt.validate.ok ? 'passed' : `failed: ${receipt.validate.summary || ''}`;
          console.log(`  validate: ${badge}`);
        }
      }
      process.exit(receipt.exitCode || 0);
    })
    .catch((err) => {
      console.error(`archify agent-flow: ${err.message}`);
      process.exit(err.exitCode || 1);
    });
}

