// E2E do dispatcher `archify init-flow-hook`: garante que o subcommand
// prometido pela SKILL.md (linha 75) delega corretamente para
// bin/install-flow-hook.mjs, preservando exit code.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const archifyBin = path.join(repoRoot, 'bin', 'archify.mjs');

test('archify init-flow-hook --target <path> --force escreve o shim', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-dispatcher-'));
  // .git/ e' necessario para detectTarget passar (P1#4 exige que o installer
  // valide o override so' depois de detectar layout).
  await fs.mkdir(path.join(tmp, '.git'), {recursive: true});
  const target = path.join(tmp, 'pre-push');
  try {
    execFileSync(
      process.execPath,
      [archifyBin, 'init-flow-hook', '--target', target, '--force'],
      {encoding: 'utf8', stdio: 'pipe', cwd: tmp},
    );
    // O shim deve existir e conter runHook com archifyBin absoluto.
    const stat = await fs.stat(target);
    assert.ok(stat.isFile(), `shim não foi criado em ${target}`);
    const body = await fs.readFile(target, 'utf8');
    assert.match(body, /runHook\(/, 'shim deve invocar runHook');
    assert.match(body, /archifyBin:/, 'shim deve embutir archifyBin');
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
});

test('archify init-flow-hook preserva exit code do installer (hook existente sem --force)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-dispatcher-'));
  await fs.mkdir(path.join(tmp, '.git'), {recursive: true});
  const target = path.join(tmp, 'pre-push');
  try {
    // Pre-popula o hook para forçar o installer a falhar com exit 1.
    await fs.writeFile(target, 'pre-existing content');
    let exitCode = null;
    let stderr = '';
    try {
      execFileSync(
        process.execPath,
        [archifyBin, 'init-flow-hook', '--target', target],
        {encoding: 'utf8', stdio: 'pipe', cwd: tmp},
      );
    } catch (e) {
      exitCode = e.status;
      stderr = e.stderr || '';
    }
    assert.equal(exitCode, 1, `esperava exit 1 propagado, recebi ${exitCode}; stderr=${stderr}`);
    assert.match(stderr, /--force/, 'stderr deve mencionar --force');
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
});

test('archify init-flow-hook delega args desconhecidos ao installer', async () => {
  // Args extras são responsabilidade do installer; o dispatcher
  // deve apenas propagar e sair com o código do installer.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-dispatcher-'));
  await fs.mkdir(path.join(tmp, '.git'), {recursive: true});
  try {
    let exitCode = null;
    try {
      execFileSync(
        process.execPath,
        [archifyBin, 'init-flow-hook', '--target', path.join(tmp, 'no-parent', 'pre-push')],
        {encoding: 'utf8', stdio: 'pipe', cwd: tmp},
      );
    } catch (e) {
      exitCode = e.status;
    }
    // O installer falha (exit != 0) pois o diretório-pai não existe;
    // o importante é que o dispatcher não absorveu o erro silenciosamente.
    assert.notEqual(exitCode, 0, `esperava exit != 0 propagado, recebi ${exitCode}`);
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
});
