// Fixture determinística para os testes E2E do subcommand `archify flow`.
// Cria um mini repo git dentro de test/flow/fixtures/mini-repo/ se ainda não
// tiver um `.git`. O conteúdo versionado é apenas os arquivos-fonte e
// .gitignore; o `.git/` em si é ignorado (ver test/flow/fixtures/mini-repo/.gitignore).
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;

async function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {encoding: 'utf8', cwd: root, ...opts});
}

export async function ensureFixture() {
  const exists = await fs.stat(path.join(root, '.git')).then(() => true).catch(() => false);
  if (exists) return;

  await sh('git', ['init', '-b', 'main']);
  await sh('git', ['config', 'user.email', 'archify-test@example.com']);
  await sh('git', ['config', 'user.name', 'archify-test']);
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n');
  await fs.writeFile(path.join(root, 'README.md'), '# Fixture\n');
  await sh('git', ['add', '.']);
  await sh('git', ['commit', '-m', 'initial: fixture seed']);

  // Branch de feature com dois commits
  await sh('git', ['checkout', '-b', 'feat']);
  await fs.mkdir(path.join(root, 'src'), {recursive: true});
  await fs.writeFile(path.join(root, 'src/users.ts'),
    'export function users() { return []; }\n');
  await fs.mkdir(path.join(root, 'docs'), {recursive: true});
  await fs.writeFile(path.join(root, 'docs/changelog.md'),
    '# Changelog\n\n- initial\n');
  await sh('git', ['add', '.']);
  await sh('git', ['commit', '-m', 'feat(users): stub users endpoint']);

  await fs.writeFile(path.join(root, 'src/users.ts'),
    'export function users() { return [{id: 1}]; }\nexport function get(id) { return {id}; }\n');
  await fs.writeFile(path.join(root, 'docs/changelog.md'),
    '# Changelog\n\n- initial\n- add get(id)\n');
  await sh('git', ['add', '.']);
  await sh('git', ['commit', '-m', 'feat(users): add get(id) helper']);

  await sh('git', ['checkout', 'main']);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureFixture().catch((e) => { console.error(e); process.exit(1); });
}
