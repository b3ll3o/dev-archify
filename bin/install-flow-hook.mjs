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

// Gera o corpo do shim. O caller computa `hookUrl` (file:// URL do hook)
// e `archifyBinPath` (cmd completo para o binario archify em dev, ex:
// `node /abs/path/to/repo/bin/archify.mjs`). Embarcamos o archifyBinPath
// no shim para que o hook funcione em dev mode (sem install global).
// Apóstrofos no path sao escapados defensivamente para o shim permanecer
// um literal JS válido.
export function buildShim({hookUrl, archifyBinPath}) {
  // \\n e \\s viram \n e \s no output (escape de template literal).
  return `#!/usr/bin/env node
import {runHook} from '${hookUrl}';
let buf = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) buf += chunk;
const firstLine = (buf.split('\\n')[0] || '').trim();
const tokens = firstLine.split(/\\s+/);
const remoteRef = tokens[2] || '';
const r = await runHook({remote: 'origin', remoteRef, archifyBin: '${archifyBinPath.replace(/'/g, "\\'")}'});
process.exit(r.exitCode);
`;
}

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

// Valida que --target resolve dentro de `repoRoot` (sem escapar).
// Auto-detect (sem --target) e' seguro por construcao: escolhe entre
// `.git/hooks/pre-push` ou `.husky/pre-push` via `detectTarget`. O override
// manual, por outro lado, passa por `path.resolve` verbatim — sem essa
// validacao, `--target /etc/cron.d/evil` ou `--target ../../../tmp/x.sh`
// escreveriam um shim 0o755 executable fora do repo (P1#4 — defesa contra
// path-traversal em agent/CI que passa --target derivado de fonte externa).
// Aceita qualquer path dentro do repo (incluindo `.git/hooks/`, `.husky/`
// ou paths custom como `<tmp>/pre-push` em testes de dispatcher).
export function ensureTargetInsideRepo(targetPath, repoRoot) {
  const resolved = path.resolve(targetPath);
  const repoRootResolved = path.resolve(repoRoot);
  const inside =
    resolved === repoRootResolved ||
    resolved.startsWith(repoRootResolved + path.sep);
  if (!inside) {
    throw new Error(
      `--target must resolve inside the repo; got ${resolved}`,
    );
  }
  return resolved;
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
        ? (() => {
            // Defesa contra path-traversal: garante que --target esta
            // dentro do repo (P1#4) antes de montar o shim.
            const resolvedOverride = ensureTargetInsideRepo(
              path.resolve(repoRoot, targetOverride),
              repoRoot,
            );
            return {kind: 'override', path: resolvedOverride, root: repoRoot};
          })()
        : detected;
      // Import path precisa ser file:// URL (Node ESM nao aceita absolute path
      // estatico de forma confiavel em todas as versoes).
      const hookUrl = pathToFileURL(
        path.join(repoRoot, 'hooks/pre-push.flow.mjs'),
      ).href;
      // Em dev mode (sem `npm i -g .`), o shim precisa do path absoluto
      // para o bin/archify.mjs do repo. Bake-in no shim no install time.
      const archifyBinPath = `node ${path.join(repoRoot, 'bin/archify.mjs')}`;
      const shim = buildShim({hookUrl, archifyBinPath});
      await writeShim(target.path, shim, {force});
      console.log(`✓ installed archify flow hook at ${target.path} (${target.kind})`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  })();
}
