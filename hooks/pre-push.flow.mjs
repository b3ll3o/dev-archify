// Pre-push hook para subcommand `archify flow`.
// Chamado pelo git pre-push (via shim em .git/hooks/pre-push ou .husky/pre-push).
// Comportamento:
//   - Push para main/master -> noop (nao regenera fluxo em branch protegida)
//   - CLI executa com sucesso -> git add + commit do workflow gerado
//   - CLI falha (archify nao instalado, etc.) -> exit 0, nunca bloqueia push
import path from 'node:path';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

// Refs que NAO devem disparar regeneracao automatica do flow.
const SKIP_REFS = new Set(['refs/heads/main', 'refs/heads/master']);

// Converte uma linha de comando em argv, respeitando aspas duplas.
function tokenize(cmdline) {
  const m = cmdline.match(/(?:[^\s"]+|"[^"]*")+/g);
  return m ? m.map(s => s.replace(/^"(.*)"$/, '$1')) : [];
}

function defaultExecCli(cmdline) {
  const args = tokenize(cmdline);
  const bin = args.shift();
  execFileSync(bin, args, {encoding: 'utf8', stdio: 'inherit'});
}

function defaultExecGit(cmdline) {
  const args = ['-c', 'core.hooksPath=/dev/null', ...tokenize(cmdline)];
  execFileSync('git', args, {encoding: 'utf8', stdio: 'inherit'});
}

export async function runHook(opts = {}) {
  const {
    remote = 'origin',
    remoteRef = '',
    repoRoot = process.cwd(),
    // archifyBin é apenas o NOME do binário (sem path e sem `node`).
    // O package.json declara "bin": { "archify": "./bin/archify.mjs" },
    // então quando archify é instalado globalmente (`npm i -g .`), o nome
    // `archify` fica disponível no PATH e o cmd resultante vira
    // `archify flow --git-range=...` — substring que os testes validam.
    // Para uso em dev (sem install global), sobrescreva archifyBin com
    // `node <repo>/bin/archify.mjs` ao chamar runHook.
    archifyBin = 'archify',
    execCli = defaultExecCli,
    execGit = defaultExecGit,
    log = (m) => process.stderr.write(`[archify-flow] ${m}\n`),
  } = opts;

  // Branch protegida: nada a fazer.
  if (SKIP_REFS.has(remoteRef)) {
    return {exitCode: 0, action: 'noop'};
  }

  const range = `${remote}/main...HEAD`;
  try {
    await execCli(
      `${archifyBin} flow --git-range=${range} --out=${path.join(repoRoot, 'docs/flows')} --quality=standard`,
    );
    await execGit('add docs/flows/');
    await execGit('commit -m "chore(flow): regenera workflow [skip ci]"');
    return {exitCode: 0, action: 'flow-and-commit'};
  } catch (e) {
    // Nunca bloqueia o push. Loga em stderr e em .archify/flow.log (best-effort).
    log(`hook failed: ${e.message}`);
    await fs.appendFile(
      path.join(repoRoot, '.archify', 'flow.log'),
      `${new Date().toISOString()} ${e.message}\n`,
    ).catch(() => { /* .archify pode nao existir; ignora */ });
    return {exitCode: 0, action: 'flow-skipped'};
  }
}

// Entrada do shim: git pre-push envia linhas "<local_ref> <local_sha> <remote_ref> <remote_sha>"
// no stdin. O terceiro token e o remoteRef (refs/heads/<branch>).
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) buf += chunk;
    const firstLine = (buf.split('\n')[0] || '').trim();
    const tokens = firstLine.split(/\s+/);
    const remoteRef = tokens[2] || '';
    const r = await runHook({remote: 'origin', remoteRef});
    process.exit(r.exitCode);
  })();
}
