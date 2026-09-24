// CLI entry do subcommand `archify flow`.
// Parse args → pre-flight (diff não-vazio, --out dentro do repo) → runFlow → print receipt.
// Flag --strict eleva o exit code para 5 quando archify validate falhou.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
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
  rejectUnknownOptions(opts);
  if (opts._.length > 0) {
    console.error(`archify flow: unexpected positional arguments: ${opts._.join(' ')}`);
    process.exit(2);
  }
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
  // (independentemente de --out apontar para fora do repo). A saida de
  // `git diff` e' capturada aqui e propagada para runFlow (via diffText)
  // para que o runner nao precise executar `git diff` uma segunda vez.
  // Timeout de 10s evita que um range gigante trave o CLI; maxBuffer de
  // 50MB casa com parser-diff.mjs (diffs grandes sao comuns em monorepos).
  let diffText;
  try {
    diffText = execFileSync('git', [
      'diff', '--unified=0', '--no-color', '--no-ext-diff',
      opts['git-range'],
    ], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (e) {
    console.error(`archify flow: git diff failed for ${opts['git-range']}: ${e.message}`);
    process.exit(2);
  }
  if (!diffText.trim()) {
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
      diffText,
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

// P1#5 (path-traversal-via-symlink): `path.relative` nao resolve symlinks,
// entao um `docs/evil -> /etc` passa no guard textual mas fwrite segue o
// symlink e escreve fora do repo. Usamos realpathSync para resolver os
// caminhos ao comparar; se `out` nao existe ainda (caso comum --out e'
// criado), caminhamos ancestrais ate' o dir existente mais profundo.
function isInsideRepo(out, repoRoot) {
  if (out === repoRoot) return true;
  let realOut;
  let realRepo;
  try {
    realOut = fs.realpathSync(out);
  } catch {
    // out ainda nao existe: resolve o ancestor mais profundo que existe.
    let ancestor = out;
    while (path.dirname(ancestor) !== ancestor) {
      ancestor = path.dirname(ancestor);
      try {
        realOut = fs.realpathSync(ancestor);
        break;
      } catch {
        /* continua subindo */
      }
    }
    if (!realOut) realOut = out; // fallback textual
  }
  try {
    realRepo = fs.realpathSync(repoRoot);
  } catch {
    realRepo = repoRoot;
  }
  const rel = path.relative(realRepo, realOut);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Minimal flag parser: aceita --key=value e --key value. Replica o estilo dos
// outros subcommands (sem dependencias externas).
//
// Lista de chaves conhecidas (sem o prefixo `--`) — espelha o pattern usado
// em archify.mjs:commandBrands, que rejeita flags desconhecidas via fail().
const VALID_OPTION_KEYS = new Set([
  'help', 'h', 'json', 'strict',
  'git-range', 'out', 'since-message', 'decisions', 'validations', 'quality',
]);

function rejectUnknownOptions(opts) {
  for (const key of Object.keys(opts)) {
    if (key === '_') continue;
    if (!VALID_OPTION_KEYS.has(key)) {
      console.error(`Unknown flow option "--${key}".`);
      process.exit(2);
    }
  }
}
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
