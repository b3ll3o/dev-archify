// CLI entry do subcommand `archify flow`.
// Parse args → pre-flight (diff não-vazio, --out dentro do repo) → runFlow → print receipt.
// Flag --strict eleva o exit code para 5 quando archify validate falhou.
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runFlow} from './flow/runner.mjs';

// `archifyBin` e' resolvido a partir do diretorio deste script (independente
// de process.cwd(), para que o subcommand funcione quando invocado via
// `node bin/archify.mjs flow` a partir de outro diretorio).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const archifyBin = path.resolve(__dirname, 'archify.mjs');

const HELP_TEXT = `Usage:
  archify flow --git-range <range> [--out <dir>] [options]

Options:
  --git-range <range>       Range to diff (e.g. origin/main...HEAD). Required.
  --out <dir>               Output directory (default: docs/flows/).
  --since-message <glob>    Only include commits whose subject matches the glob.
  --decisions <md-file>     Markdown file with ## decisions appended to Decide lane.
  --validations <json-file> JSON array of {name,status,summary} nodes appended to Validate lane.
  --quality <level>         standard | showcase (default: standard).
  --strict                  Exit 5 if archify validate did not pass.
  --json                    Emit machine-readable receipt.
  --help                    Print this help.

Exit codes:
  0 success, 2 no diff, 5 --strict trip, 6 --out outside repo.
`;

export async function runCLI(args) {
  const opts = parseArgs(args);
  if (opts.help) {
    console.log(HELP_TEXT);
    return undefined;
  }

  if (!opts['git-range']) {
    console.error('archify flow: --git-range is required');
    console.error(HELP_TEXT);
    process.exit(2);
  }

  const repoRoot = process.cwd();

  // Pre-flight: range deve ter ao menos um arquivo modificado. Esta checagem
  // vem antes da validação de --out para que ranges vazios sempre retornem 2
  // (independentemente de --out apontar para fora do repo).
  let diffProbe;
  try {
    diffProbe = execFileSync('git', [
      'diff', '--unified=0', '--no-color', '--no-ext-diff',
      opts['git-range'],
    ], {encoding: 'utf8'});
  } catch (e) {
    console.error(`archify flow: git diff failed for ${opts['git-range']}: ${e.message}`);
    process.exit(2);
  }
  if (!diffProbe.trim()) {
    console.error(`archify flow: no changes detected in ${opts['git-range']}`);
    process.exit(2);
  }

  const out = path.resolve(repoRoot, opts.out || 'docs/flows');
  if (!isInsideRepo(out, repoRoot)) {
    console.error(`--out must be inside the repository: ${out}`);
    process.exit(6);
  }

  let receipt;
  try {
    receipt = await runFlow({
      range: opts['git-range'],
      out,
      quality: opts.quality || 'standard',
      decisions: opts.decisions,
      validations: opts.validations,
      sinceMessage: opts['since-message'],
      archifyBin,
      cwd: repoRoot,
    });
  } catch (e) {
    console.error(`archify flow: pipeline failed: ${e.message}`);
    process.exit(1);
  }

  if (opts.strict && receipt.validateReceipt.status !== 'passed') {
    console.error(`--strict: archify validate did not pass (${receipt.validateReceipt.status})`);
    process.exit(5);
  }

  if (opts.json) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    const validateBadge = receipt.validateReceipt.status === 'passed'
      ? 'validated: passed'
      : `validated: ${receipt.validateReceipt.status} (${receipt.validateReceipt.summary || ''})`;
    console.log(`✓ wrote ${receipt.jsonPath}`);
    console.log(`✓ wrote ${receipt.htmlPath}`);
    console.log(`✓ wrote ${receipt.sourcePath}`);
    console.log(`  ${validateBadge}`);
  }
  return receipt;
}

function isInsideRepo(out, repoRoot) {
  if (out === repoRoot) return true;
  const rel = path.relative(repoRoot, out);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Minimal flag parser: aceita --key=value e --key value. Replica o estilo dos
// outros subcommands (sem dependencias externas).
function parseArgs(args) {
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
    if (a === '--strict') {
      opts.strict = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i += 1;
      } else {
        opts[key] = true;
      }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

// CLI entry (chamado por bin/archify.mjs via dynamic import)
if (import.meta.url === `file://${process.argv[1]}`) {
  runCLI(process.argv.slice(2)).catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
