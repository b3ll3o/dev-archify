// Installer do shim de pre-push para o subcommand `archify flow`.
// Detecta automaticamente o layout de hooks (Husky ou git plain) e gera
// um shim que delega para `hooks/pre-push.flow.mjs` via import ESM.
//
// Uso:
//   node bin/install-flow-hook.mjs [--force] [--target <path>]
//
//   --force   sobrescreve hook pre-existente
//   --target  caminho custom para o hook (default: auto-detect husky/plain)
//
// Exit codes:
//   0 = sucesso
//   1 = erro (no .git/.husky, hook ja existe sem --force, etc.)
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const HUSKY_HOOK_DIR = '.husky';

export async function detectTarget(root) {
  const huskyDir = path.join(root, HUSKY_HOOK_DIR);
  const huskyInner = path.join(root, '.husky/_');
  const gitDir = path.join(root, '.git');

  // Husky tem precedencia: a presença de `.husky/` (mesmo sem `_/`)
  // indica que o projeto usa Husky para gerenciar hooks.
  if (await exists(huskyInner) || await exists(huskyDir)) {
    return {kind: 'husky', path: path.join(root, '.husky/pre-push'), root};
  }
  // Fallback: qualquer `.git/` indica repo git plain; assumimos que
  // `.git/hooks/` existe (git init sempre cria) e escrevemos la.
  if (await exists(gitDir)) {
    return {kind: 'plain', path: path.join(root, '.git/hooks/pre-push'), root};
  }
  throw new Error(`no .git or .husky found under ${root}; cannot install flow hook`);
}

export async function writeShim(targetPath, body, {force = false} = {}) {
  // Guard: nunca sobrescreve sem flag explicita.
  if (!force && await exists(targetPath)) {
    throw new Error(`hook already exists at ${targetPath}; pass --force to overwrite`);
  }
  await fs.mkdir(path.dirname(targetPath), {recursive: true});
  // Mode 0o755: git precisa do bit de execucao para invocar o hook.
  await fs.writeFile(targetPath, body, {encoding: 'utf8', mode: 0o755});
}

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

// CLI entry: detecta layout, gera shim, escreve no path apropriado.
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const targetIdx = args.indexOf('--target');
    const targetOverride = targetIdx > -1 ? args[targetIdx + 1] : null;
    const repoRoot = process.cwd();
    try {
      const detected = await detectTarget(repoRoot);
      const target = targetOverride
        ? {kind: 'override', path: path.resolve(repoRoot, targetOverride), root: repoRoot}
        : detected;
      // Import path precisa ser file:// URL (Node ESM nao aceita absolute path
      // estatico de forma confiavel em todas as versoes).
      const hookUrl = pathToFileURL(
        path.join(repoRoot, 'hooks/pre-push.flow.mjs'),
      ).href;
      // Shim body: shebang + dynamic stdin parse + delega para runHook.
      // \\n e \\s viram \n e \s no output (escape de template literal).
      const shim = `#!/usr/bin/env node
import {runHook} from '${hookUrl}';
let buf = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) buf += chunk;
const firstLine = (buf.split('\\n')[0] || '').trim();
const tokens = firstLine.split(/\\s+/);
const remoteRef = tokens[2] || '';
const r = await runHook({remote: 'origin', remoteRef});
process.exit(r.exitCode);
`;
      await writeShim(target.path, shim, {force});
      console.log(`✓ installed archify flow hook at ${target.path} (${target.kind})`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  })();
}
