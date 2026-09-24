import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {detectTarget, writeShim, buildShim} from '../../bin/install-flow-hook.mjs';

// Repo path real (usado pelos testes que spawnam o CLI `bin/archify.mjs`).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot_actual = path.resolve(__dirname, '..', '..');

test('detectTarget returns husky when .husky/_/ exists', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-install-'));
  await fs.mkdir(path.join(tmp, '.husky/_'), {recursive: true});
  const r = await detectTarget(tmp);
  assert.equal(r.kind, 'husky');
  assert.equal(r.path, path.join(tmp, '.husky/pre-push'));
  await fs.rm(tmp, {recursive: true, force: true});
});

test('detectTarget returns plain when .git exists and no husky', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-install-'));
  await fs.mkdir(path.join(tmp, '.git'), {recursive: true});
  const r = await detectTarget(tmp);
  assert.equal(r.kind, 'plain');
  assert.equal(r.path, path.join(tmp, '.git/hooks/pre-push'));
  await fs.rm(tmp, {recursive: true, force: true});
});

test('detectTarget throws when no .git', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-install-'));
  await assert.rejects(() => detectTarget(tmp));
  await fs.rm(tmp, {recursive: true, force: true});
});

test('writeShim refuses to overwrite without --force', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-install-'));
  const target = path.join(tmp, 'pre-push');
  await fs.writeFile(target, 'existing content');
  await assert.rejects(() => writeShim(target, 'new', {force: false}));
  await writeShim(target, 'new', {force: true});
  const got = await fs.readFile(target, 'utf8');
  assert.equal(got, 'new');
  await fs.rm(tmp, {recursive: true, force: true});
});

test('writeShim writes Husky-style shim', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-install-'));
  const target = path.join(tmp, 'pre-push');
  await writeShim(target, 'echo archify', {force: false});
  const got = await fs.readFile(target, 'utf8');
  assert.equal(got, 'echo archify');
  await fs.rm(tmp, {recursive: true, force: true});
});

test('buildShim embeds absolute archifyBin path for dev mode', () => {
  // Garante que o shim gerado chama runHook com archifyBin absoluto,
  // permitindo que o hook funcione em dev (sem `npm i -g .`).
  const archifyBinPath = 'node /home/leo/dev/repo/bin/archify.mjs';
  const body = buildShim({
    hookUrl: 'file:///home/leo/dev/repo/hooks/pre-push.flow.mjs',
    archifyBinPath,
  });
  assert.match(
    body,
    new RegExp(
      `runHook\\(\\{remote: 'origin', remoteRef, archifyBin: '${archifyBinPath}'\\}\\)`,
    ),
    `shim deve embutir archifyBin absoluto; got:\n${body}`,
  );
});

test('rejeita --target fora do repoRoot (path-traversal defense)', async () => {
  // Tenta instalar hook em /etc/cron.d/evil (path arbitrario absoluto fora
  // do repo). O installer deve rejeitar com mensagem clara ANTES de qualquer
  // writeFile (shim 0o755 executable em local arbitrario).
  const repoRoot = path.join(os.tmpdir(), `archify-flow-target-evil-${process.pid}`);
  await fs.mkdir(repoRoot, {recursive: true});
  // detectTarget so roda ate' `.git/` existir; sem isso o installer
  // aborta com "no .git or .husky" antes de chegar na validacao de --target.
  await fs.mkdir(path.join(repoRoot, '.git'), {recursive: true});

  const binPath = path.join(repoRoot_actual, 'bin', 'archify.mjs');
  const res = spawnSync('node', [
    binPath, 'init-flow-hook',
    '--target', '/etc/cron.d/evil',
  ], {cwd: repoRoot, encoding: 'utf8'});

  assert.notEqual(res.status, 0,
    `CLI deve rejeitar --target fora do repo; recebi status=${res.status}, stderr=${res.stderr}`);
  assert.match(
    res.stderr + res.stdout,
    /--target|outside|inside the repo/i,
    `mensagem esperada; recebi status=${res.status}, stderr=${res.stderr}`,
  );

  // /etc/cron.d/evil NAO deve ter sido criado (writeFile nao deve ter rodado).
  assert.equal(
    await fs.stat('/etc/cron.d/evil').then(() => true, () => false),
    false,
    'Nao deve ter criado /etc/cron.d/evil',
  );

  await fs.rm(repoRoot, {recursive: true, force: true});
});

test('tambem rejeita --target com .. que escapa via traversal', async () => {
  // `--target ../../../tmp/evil.sh` resolve para fora do repo via `..`
  // (mesmo com cwd dentro do repo, `..` permite escapar de `.git/`).
  const repoRoot = path.join(os.tmpdir(), `archify-flow-target-dotdot-${process.pid}`);
  await fs.mkdir(repoRoot, {recursive: true});
  await fs.mkdir(path.join(repoRoot, '.git'), {recursive: true});

  // evilPath propositalmente em /tmp (sibling do repoRoot, fora de .git/).
  // Construimos o arg com 3 `..` para garantir escape explicito via
  // path-traversal (nao apenas path relativo).
  const evilPath = path.join(os.tmpdir(), `evil-${process.pid}.sh`);
  const targetArg = '../../../tmp/' + path.basename(evilPath);
  // Sanity check: o arg deve de fato resolver para evilPath quando aplicado
  // a partir de repoRoot (senao o teste nao estaria cobrindo o write target).
  assert.equal(path.resolve(repoRoot, targetArg), evilPath,
    `arg ${targetArg} deve resolver para ${evilPath} saindo de ${repoRoot}`);

  const binPath = path.join(repoRoot_actual, 'bin', 'archify.mjs');
  const res = spawnSync('node', [
    binPath, 'init-flow-hook',
    '--target', targetArg,
  ], {cwd: repoRoot, encoding: 'utf8'});

  assert.notEqual(res.status, 0,
    `CLI deve rejeitar --target escapando via ..; recebi status=${res.status}, stderr=${res.stderr}`);
  assert.match(
    res.stderr + res.stdout,
    /--target|outside|inside the repo/i,
    `mensagem esperada; recebi status=${res.status}, stderr=${res.stderr}`,
  );
  assert.equal(
    await fs.stat(evilPath).then(() => true, () => false),
    false,
    `Nao deve ter escrito ${evilPath}`,
  );

  await fs.rm(repoRoot, {recursive: true, force: true});
  await fs.rm(evilPath, {force: true});
});
