// E2E do CLI: invoca `node bin/archify.mjs flow` real contra a mini-repo
// fixture. Usa `process.chdir` para dentro do fixture porque o CLI resolve
// o range contra o git dir atual.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {spawnSync, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import wfSchema from '../../schemas/workflow.schema.json' with {type: 'json'};
import commonSchema from '../../schemas/common.schema.json' with {type: 'json'};
import {ensureFixture} from './fixtures/mini-repo/bootstrap.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const archifyBin = path.join(repoRoot, 'bin', 'archify.mjs');
const fixtureDir = path.join(repoRoot, 'test/flow/fixtures/mini-repo');

const ajv = new Ajv({strict: false, allErrors: true, allowUnionTypes: true});
ajv.addSchema(commonSchema, 'common.schema.json');
const validateWf = ajv.compile(wfSchema);

async function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(prev); }
}

test('archify flow --git-range writes workflow.json + workflow.html + provenance', async () => {
  await ensureFixture();
  // O CLI exige --out dentro do repo. Quando chdiramos para o fixture,
  // o "repo" e' o proprio fixture. Criamos o tmp dentro dele.
  const tmpInRepo = path.join(fixtureDir, '.tmp-cli-' + Date.now());
  await fs.mkdir(tmpInRepo, {recursive: true});
  await withCwd(fixtureDir, () => {
    execFileSync('node', [
      archifyBin, 'flow',
      '--git-range=main...feat',
      `--out=${tmpInRepo}`,
      '--quality=standard',
    ], {encoding: 'utf8'});
  });

  const files = await fs.readdir(tmpInRepo);
  assert.ok(files.includes('workflow.json'), `esperava workflow.json em ${tmpInRepo}, achei: ${files}`);
  assert.ok(files.includes('workflow.html'), `esperava workflow.html em ${tmpInRepo}, achei: ${files}`);
  assert.ok(files.includes('_flow_source.json'), `esperava _flow_source.json em ${tmpInRepo}, achei: ${files}`);

  const spec = JSON.parse(await fs.readFile(path.join(tmpInRepo, 'workflow.json'), 'utf8'));
  assert.equal(spec.diagram_type, 'workflow');
  assert.ok(validateWf(spec), `spec não passa no schema: ${JSON.stringify(validateWf.errors)}`);

  const html = await fs.readFile(path.join(tmpInRepo, 'workflow.html'), 'utf8');
  assert.ok(html.startsWith('<') || html.includes('<svg'),
    'HTML deve iniciar com < ou conter <svg');

  const source = JSON.parse(await fs.readFile(path.join(tmpInRepo, '_flow_source.json'), 'utf8'));
  assert.equal(source.range, 'main...feat');
  assert.ok(source.baseSha);
  assert.match(source.generated_at, /T/);

  await fs.rm(tmpInRepo, {recursive: true, force: true});
});

test('archify flow --json imprime receipt com validateReceipt.status=passed', async () => {
  await ensureFixture();
  const tmpInRepo = path.join(fixtureDir, '.tmp-cli-json-' + Date.now());
  await fs.mkdir(tmpInRepo, {recursive: true});
  let stdout = '';
  await withCwd(fixtureDir, () => {
    stdout = execFileSync('node', [
      archifyBin, 'flow',
      '--git-range=main...feat',
      `--out=${tmpInRepo}`,
      '--quality=standard',
      '--json',
    ], {encoding: 'utf8'});
  });
  const receipt = JSON.parse(stdout);
  assert.equal(typeof receipt.jsonPath, 'string');
  assert.equal(typeof receipt.htmlPath, 'string');
  assert.equal(typeof receipt.sourcePath, 'string');
  assert.equal(receipt.validateReceipt.status, 'passed',
    `esperava passed, recebi ${JSON.stringify(receipt.validateReceipt)}`);

  await fs.rm(tmpInRepo, {recursive: true, force: true});
});

test('archify flow sai com código 2 quando o range não tem diff', async () => {
  await ensureFixture();
  const tmpInRepo = path.join(fixtureDir, '.tmp-cli-empty-' + Date.now());
  await fs.mkdir(tmpInRepo, {recursive: true});
  let exitCode = 0;
  try {
    await withCwd(fixtureDir, () => {
      execFileSync('node', [
        archifyBin, 'flow',
        '--git-range=main...main', // mesmo ref → sem diff
        `--out=${tmpInRepo}`,
        '--quality=standard',
      ], {encoding: 'utf8', stdio: 'pipe'});
    });
  } catch (e) {
    exitCode = e.status;
  }
  assert.equal(exitCode, 2);
  await fs.rm(tmpInRepo, {recursive: true, force: true});
});

test('archify flow sai com código 6 quando --out está fora do repo', async () => {
  await ensureFixture();
  const outside = path.join(os.tmpdir(), 'archify-flow-cli-outside-' + Date.now());
  let exitCode = 0;
  try {
    await withCwd(fixtureDir, () => {
      execFileSync('node', [
        archifyBin, 'flow',
        '--git-range=main...feat',
        `--out=${outside}`,
        '--quality=standard',
      ], {encoding: 'utf8', stdio: 'pipe'});
    });
  } catch (e) {
    exitCode = e.status;
  }
  assert.equal(exitCode, 6);
});

test('rejeita --out que aponta para symlink fora do repo (path-traversal defense)', async () => {
  // Setup: tmp repo com .git/, 2 commits, e symlink docs/evil -> /tmp.
  // 2 commits sao necessarios para que `git diff` produza output real e o
  // pre-flight do CLI nao saia com exit 2 antes de chegar no guard isInsideRepo.
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-flow-symlink-'));
  execFileSync('git', ['init', '-q', tmpRoot]);
  execFileSync('git', ['-C', tmpRoot, 'config', 'user.email', 'a@b.c']);
  execFileSync('git', ['-C', tmpRoot, 'config', 'user.name', 't']);
  await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'x');
  execFileSync('git', ['-C', tmpRoot, 'add', 'f.txt']);
  execFileSync('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'init']);
  await fs.writeFile(path.join(tmpRoot, 'g.txt'), 'y');
  execFileSync('git', ['-C', tmpRoot, 'add', 'g.txt']);
  execFileSync('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'second']);

  // Cria docs/evil -> /tmp (escapa do repo via symlink).
  await fs.mkdir(path.join(tmpRoot, 'docs'), {recursive: true});
  await fs.symlink(os.tmpdir(), path.join(tmpRoot, 'docs/evil'));

  // Tenta gerar flow com --out=docs/evil. Deve rejeitar e NAO escrever em /tmp.
  const binPath = path.join(repoRoot, 'bin', 'archify.mjs');
  const res = spawnSync('node', [
    binPath, 'flow',
    '--git-range=HEAD~1..HEAD',
    '--out=docs/evil',      // symlink para /tmp
    '--quality=standard',
  ], {cwd: tmpRoot, encoding: 'utf8'});

  assert.notEqual(res.status, 0,
    `CLI deve rejeitar symlink fora do repo; recebi status=${res.status}, stdout=${res.stdout}, stderr=${res.stderr}`);
  assert.match(
    res.stderr + res.stdout,
    /outside|inside the repository/i,
    `mensagem esperada sobre containment; recebi: status=${res.status}, stderr=${res.stderr}`,
  );

  // /tmp/workflow.json NAO deve existir.
  const tmpWorkflow = path.join(os.tmpdir(), 'workflow.json');
  assert.equal(
    await fs.stat(tmpWorkflow).then(() => true, () => false),
    false,
    `Nao deve ter escrito ${tmpWorkflow} via symlink escape`,
  );

  await fs.rm(tmpRoot, {recursive: true, force: true});
});

test('aceita --out em symlink que aponta para dir DENTRO do repo (compatibilidade)', async () => {
  // Setup: tmp repo com 2 commits e um symlink para um subdir dentro do repo.
  // Ex: user criou 'docs' como symlink para ~/docs-shared, mas o destino é
  // de fato um dir dentro do repo. O guard nao deve rejeitar esse caso.
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-flow-symlink-ok-'));
  execFileSync('git', ['init', '-q', tmpRoot]);
  execFileSync('git', ['-C', tmpRoot, 'config', 'user.email', 'a@b.c']);
  execFileSync('git', ['-C', tmpRoot, 'config', 'user.name', 't']);
  await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'x');
  execFileSync('git', ['-C', tmpRoot, 'add', 'f.txt']);
  execFileSync('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'init']);
  await fs.writeFile(path.join(tmpRoot, 'g.txt'), 'y');
  execFileSync('git', ['-C', tmpRoot, 'add', 'g.txt']);
  execFileSync('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'second']);

  // Cria o dir destino dentro do repo + symlink apontando para ele.
  const sharedDir = path.join(tmpRoot, 'shared');
  await fs.mkdir(sharedDir, {recursive: true});
  await fs.mkdir(path.join(tmpRoot, 'docs'), {recursive: true});
  await fs.symlink(path.join(tmpRoot, 'shared'), path.join(tmpRoot, 'docs/shared'));

  const binPath = path.join(repoRoot, 'bin', 'archify.mjs');
  const res = spawnSync('node', [
    binPath, 'flow',
    '--git-range=HEAD~1..HEAD',
    '--out=docs/shared',
    '--quality=standard',
  ], {cwd: tmpRoot, encoding: 'utf8'});

  // Deve passar (realpath do symlink cai dentro do repo).
  assert.equal(res.status, 0,
    `CLI nao deve rejeitar symlink que aponta dentro do repo; recebi status=${res.status}, stderr=${res.stderr}`);

  // Workflow.json deve ter sido escrito via symlink (em shared/workflow.json).
  assert.equal(
    await fs.stat(path.join(tmpRoot, 'shared/workflow.json')).then(() => true, () => false),
    true,
    'workflow.json deve ter sido escrito via symlink',
  );

  await fs.rm(tmpRoot, {recursive: true, force: true});
});
