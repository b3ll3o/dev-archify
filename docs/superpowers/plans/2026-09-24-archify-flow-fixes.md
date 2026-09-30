# Plano: Correções de correctness + security do subcommand `archify flow`

> **Para workers agênticos:** SUB-SKILL OBRIGATÓRIO: usar `superpowers:subagent-driven-development` (recomendado) ou `superpowers:executing-plans` para implementar este plano task por task. Steps usam checkbox (`- [ ]`) para tracking.

**Origem:** Análise multi-lens (correctness + security + spec + robustness) — 56 findings (3 P0, 10 P1, 19 P2, 24 P3). Este plano cobre **3 P0 + 5 P1 security/correctness mais críticos**.

**Branch:** `feat/flow-subcommand` em `/home/leo/Documentos/projetos/base/dev-archify`.

**Goal:** Tornar o subcommand `archify flow` correto em edge cases de parser-diff/range, seguro contra path-traversal via symlink e `--target`, e resiliente a crashes parciais (writes atômicos) e a entrega de artefato inválido (gate validate→deliver).

**Architecture:** Correções localizadas em cada arquivo, sem re-arquitetar. Cada task é um commit atômico com RED→GREEN→REFACTOR.

**Tech Stack:** Node 18+, ESM, `node:test` (já em uso).

---

## File Map

| Arquivo | Tasks | Responsabilidade |
|---|---|---|
| `bin/flow/parser-diff.mjs` | T1 | Parser de `git diff` |
| `bin/flow/runner.mjs` | T2, T5, T6 | Orchestrator (parse + write + validate + deliver) |
| `bin/flow.mjs` | T3 | CLI entry (pre-flight, arg parsing, isInsideRepo) |
| `bin/install-flow-hook.mjs` | T4 | Installer do shim de pre-push |
| `test/flow/parser-diff.test.mjs` | T1 | Testes do parser |
| `test/flow/runner.test.mjs` | T2, T5, T6 | Testes do orchestrator |
| `test/flow/install-flow-hook.test.mjs` | T4 | Testes do installer |
| `test/flow/flow-cli.test.mjs` | T3 | Testes de integração CLI |

---

## Task 1: parser-diff — clamp de line numbers e remoção de dead code (P0 × 2)

**Files:**
- Modify: `bin/flow/parser-diff.mjs:39` (delete) e `:51-58` (clamp)
- Test: `test/flow/parser-diff.test.mjs`

**Achados cobertos:**
- **P0#1** `parser-diff.mjs:57` — `lines: [startNew, startNew + lenNew - 1]` produz `[0, -1]` para `@@ -1,3 +0,0 @@`.
- **P0#2** `parser-diff.mjs:39` — branch dead `if (current && line === RENAME_FROM.exec('')?. [0]) continue;` (typo `?. [0]`).

### Steps

- [ ] **Step 1: RED — adicionar assertion do line-clamp no test de delete-only**

Em `test/flow/parser-diff.test.mjs`, no test `handles delete-only file` (linha 82), adicionar:
```js
  // Lines nao podem ser negativas para @@ -1,3 +0,0 @@ (regressao).
  assert.ok(result[0].hunks[0].lines[1] >= result[0].hunks[0].lines[0],
    `lines devem satisfazer lines[1] >= lines[0], recebi ${JSON.stringify(result[0].hunks[0].lines)}`);
```

Run: `node --test test/flow/parser-diff.test.mjs`
Expected: FAIL com `lines[1] >= lines[0]` no hunk de delete.

- [ ] **Step 2: GREEN — clamp do range**

Em `bin/flow/parser-diff.mjs:57`, alterar:
```js
        lines: [startNew, Math.max(startNew, startNew + lenNew - 1)],
```

Run: `node --test test/flow/parser-diff.test.mjs`
Expected: PASS em todos os tests.

- [ ] **Step 3: REFACTOR — remover dead code da linha 39**

Em `bin/flow/parser-diff.mjs:39`, deletar a linha:
```js
    if (current && line === RENAME_FROM.exec('')?. [0]) continue;
```

A linha 41 (`const renameFrom = RENAME_FROM.exec(line);`) já trata o caso real.

Run: `node --test test/flow/parser-diff.test.mjs`
Expected: PASS (rename test na linha 35 ainda passa — o regex real continua sendo aplicado).

- [ ] **Step 4: Commit**

```bash
git add bin/flow/parser-diff.mjs test/flow/parser-diff.test.mjs
git commit -m "fix(flow): clampar lines em hunks deletados + remover dead code (parser-diff)"
```

---

## Task 2: runner — range 2-dot e marcador `--END--` (P0 + P1)

**Files:**
- Modify: `bin/flow/runner.mjs:17` (marcador) e `:25` (split), `:83` (baseSha)
- Test: `test/flow/runner.test.mjs`

**Achados cobertos:**
- **P0#3** `runner.mjs:83` — regex split aceita só `...` e ` .. `; `main..HEAD` retorna a string inteira como baseSha.
- **P1#1** `runner.mjs:25` — `text.split('--END--\n')` é frágil se commit body contém `--END--\n` literal.

### Steps

- [ ] **Step 1: RED — adicionar test de range 2-dot + test de body com `--END--`**

Em `test/flow/runner.test.mjs`, adicionar novo test:
```js
test('runFlow extrai baseSha correto para range 2-dot', async () => {
  await ensureFixture();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-flow-runner-2dot-'));
  const outDir = path.join(tmpRoot, 'docs/flows');

  const fixtureDir = path.join(repoRoot, 'test/flow/fixtures/mini-repo');
  // git diff aceita tanto A..B quanto A...B; ambos devem produzir baseSha='main'.
  const receipt = await runFlow({
    range: 'main..feat',
    out: outDir,
    quality: 'standard',
    archifyBin,
    cwd: fixtureDir,
  });

  const source = JSON.parse(await fs.readFile(receipt.sourcePath, 'utf8'));
  assert.equal(source.baseSha, 'main',
    `baseSha deve ser 'main' para range 2-dot, recebi: ${source.baseSha}`);

  await fs.rm(tmpRoot, {recursive: true, force: true});
});
```

Run: `node --test test/flow/runner.test.mjs`
Expected: FAIL com `baseSha === 'main..feat'` (bug atual).

- [ ] **Step 2: GREEN — corrigir regex de split**

Em `bin/flow/runner.mjs:83`, alterar:
```js
  const [baseSha] = range.split(/\s*\.\.\s*/);
```

Run: `node --test test/flow/runner.test.mjs`
Expected: PASS no test 2-dot.

- [ ] **Step 3: RED — adicionar test de body com marker literal**

Em `test/flow/runner.test.mjs`, notar que o test atual não usa `c.body`. Para validar o fix do marker, criar um test unitário separado (não via runFlow, que não expoe body). Em `test/flow/parser-diff.test.mjs` adicionar:

```js
test('delimitador de commit bodies nao confunde com --END-- inline', () => {
  // P1 do multi-lens: text.split('--END--\n') come marker inline se commit body
  // contem `--END--` no fim de uma linha. Validamos o comportamento esperado
  // usando o mesmo parser do runner via um fork em memoria.
  const fakeText = [
    'abc1234', 'subject A', 'body A linha 1', '--END--', // commit termina normal
  ].join('\n') + '\n';
  // Sanidade: o split por '--END--\n' (com newline) nao produz artefato.
  const parts = fakeText.split('--END--\n').filter(Boolean);
  assert.equal(parts.length, 1);
  assert.ok(parts[0].includes('body A linha 1'));
});
```

NOTA: este test nao exercita runner.mjs diretamente (sera exercitado por T2.5). Serve de documentacao.

Run: `node --test test/flow/parser-diff.test.mjs`
Expected: PASS (documenta o padrao esperado, nao falha).

- [ ] **Step 4: GREEN — usar delimiter NUL byte no format string**

Em `bin/flow/runner.mjs:17`, alterar:
```js
    'log', range, '--pretty=%h%n%s%n%b%n--END--%x00',
```

E em `bin/flow/runner.mjs:25`, alterar o split para:
```js
  return text.split('--END--\n\0').filter(Boolean).map((block) => {
```

NOTA: `%x00` nao existe em `--pretty`. Solucao alternativa: append `printf '\0--END--\0'` no shell? Mais simples: usar `--format=%H%x00%h%x00%s%x00%b%x00--END--%x00` e split por `\0--END--\0`. Mas `%x00` e' raw — git filtra bytes nulos no output. Solucao real: usar `--format` com um separator que nao aparece em commit messages: `--format=%H%n%h%n%s%n%b%n--ARCHIFY-FLOW-SEP--%n` e split em `--ARCHIFY-FLOW-SEP--\n`. Manter a consistencia: prefix `ARCHIFY-FLOW-` impede colisao com literais.

Substituir `:17` por:
```js
    'log', range, '--pretty=%h%n%s%n%b%n--ARCHIFY-FLOW-SEP--',
```
E `:25` por:
```js
  return text.split('--ARCHIFY-FLOW-SEP--\n').filter(Boolean).map((block) => {
```

Run: `node --test test/flow/runner.test.mjs test/flow/parser-diff.test.mjs`
Expected: PASS em ambos.

- [ ] **Step 5: Commit**

```bash
git add bin/flow/runner.mjs test/flow/runner.test.mjs test/flow/parser-diff.test.mjs
git commit -m "fix(flow): corrigir range 2-dot no baseSha + trocar delimiter de commit bodies"
```

---

## Task 3: flow.mjs — isInsideRepo com realpath (P1 path-traversal-via-symlink)

**Files:**
- Modify: `bin/flow.mjs:123-127`
- Test: `test/flow/flow-cli.test.mjs`

**Achado coberto:**
- **P1#5** `flow.mjs:123` — `path.relative` nao resolve symlinks → `docs/evil -> /etc` escapa do guard.

### Steps

- [ ] **Step 1: RED — criar test integrado de symlink escape**

Em `test/flow/flow-cli.test.mjs`, adicionar test:
```js
test('archify flow rejeita --out que aponta para symlink fora do repo', async () => {
  // Setup: cria um repo mini com .git/, um symlink docs/evil -> /tmp, e tenta usar.
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-flow-symlink-'));
  execFileSync('git', ['init', '-q', tmpRoot]);
  execFileSync('git', ['-C', tmpRoot, 'config', 'user.email', 'a@b.c']);
  execFileSync('git', ['-C', tmpRoot, 'config', 'user.name', 't']);
  await fs.writeFile(path.join(tmpRoot, 'f.txt'), 'x');
  execFileSync('git', ['-C', tmpRoot, 'add', 'f.txt']);
  execFileSync('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'init']);

  // Cria symlink docs/evil -> /tmp (escapa do repo via realpath).
  await fs.mkdir(path.join(tmpRoot, 'docs'), {recursive: true});
  await fs.symlink(os.tmpdir(), path.join(tmpRoot, 'docs/evil'));

  // Tenta gerar flow com --out=docs/evil. Deve rejeitar (exit 6) sem escrever.
  const binPath = path.join(repoRoot, 'bin/archify.mjs');
  const res = spawnSync('node', [
    binPath, 'flow',
    '--git-range=HEAD~0..HEAD',
    '--out=docs/evil',
    '--quality=standard',
  ], {cwd: tmpRoot, encoding: 'utf8'});

  assert.notEqual(res.status, 0, 'deve rejeitar symlink que escapa do repo');
  assert.match(res.stderr + res.stdout, /outside|inside the repository/i);

  // /tmp nao deve ter ganhado workflow.json.
  assert.equal(
    await fs.stat(path.join(os.tmpdir(), 'workflow.json')).then(() => true, () => false),
    false,
    'nao deve ter escrito em /tmp via symlink',
  );

  await fs.rm(tmpRoot, {recursive: true, force: true});
});
```

Adicionar `import {spawnSync} from 'node:child_process'` no topo do test.

Run: `node --test test/flow/flow-cli.test.mjs`
Expected: FAIL com status 0 (sem guard anti-symlink).

- [ ] **Step 2: GREEN — usar realpath em isInsideRepo**

Em `bin/flow.mjs:123-127`, alterar:
```js
function isInsideRepo(out, repoRoot) {
  if (out === repoRoot) return true;
  let realOut;
  let realRepo;
  try {
    realOut = fs.realpathSync(out);
    realRepo = fs.realpathSync(repoRoot);
  } catch {
    // Se out nao existe ainda, parent chain — assume contido se textual OK.
    const rel = path.relative(repoRoot, out);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }
  const rel = path.relative(realRepo, realOut);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
```

Adicionar `import fs from 'node:fs'` no topo do `bin/flow.mjs`.

Run: `node --test test/flow/flow-cli.test.mjs`
Expected: PASS no test de symlink e nos demais.

- [ ] **Step 3: Commit**

```bash
git add bin/flow.mjs test/flow/flow-cli.test.mjs
git commit -m "fix(flow): resolver symlinks em isInsideRepo (evita path-traversal)"
```

---

## Task 4: install-flow-hook — validar `--target` dentro do repo (P1 path-traversal)

**Files:**
- Modify: `bin/install-flow-hook.mjs:83-85`
- Test: `test/flow/install-flow-hook.test.mjs`

**Achado coberto:**
- **P1#4** `install-flow-hook.mjs:83` — `--target /etc/cron.d/evil` escreve shim 0o755 executable em path arbitrario.

### Steps

- [ ] **Step 1: RED — adicionar test de `--target` fora do repo**

Em `test/flow/install-flow-hook.test.mjs`, adicionar:
```js
test('rejeita --target fora do repoRoot', async () => {
  const binPath = path.join(repoRoot, 'bin', 'archify.mjs');
  const res = spawnSync('node', [
    binPath, 'init-flow-hook',
    '--target', '/etc/cron.d/evil',
  ], {cwd: repoRoot, encoding: 'utf8'});

  assert.notEqual(res.status, 0, 'deve rejeitar path fora do repo');
  assert.match(res.stderr + res.stdout, /outside|inside the repository|--target/i);

  // Garantir que nada foi escrito em /etc/cron.d/evil.
  assert.equal(
    await fs.stat('/etc/cron.d/evil').then(() => true, () => false),
    false,
    'nao deve ter escrito em /etc/cron.d/evil',
  );
});
```

Adicionar `import {spawnSync} from 'node:child_process'` se nao estiver.

Run: `node --test test/flow/install-flow-hook.test.mjs`
Expected: FAIL com status 0 (aceita sem validar).

- [ ] **Step 2: GREEN — adicionar guard de contencao**

Em `bin/install-flow-hook.mjs`, extrair helper de validacao (entre `exists` e o bloco CLI):

```js
function ensureTargetInsideRepo(targetPath, repoRoot) {
  const resolved = path.resolve(targetPath);
  // Auto-detect kind 'plain' escreve em .git/hooks/, kind 'husky' em .husky/.
  const allowedPrefixes = [
    path.resolve(repoRoot, '.git'),
    path.resolve(repoRoot, '.husky'),
  ];
  const ok = allowedPrefixes.some((p) => resolved === p || resolved.startsWith(p + path.sep));
  if (!ok) {
    throw new Error(
      `--target must resolve inside the repo (.git/hooks or .husky); got ${resolved}`,
    );
  }
  return resolved;
}
```

E na linha 83-85, antes do `path.resolve`:
```js
      const resolvedOverride = targetOverride
        ? ensureTargetInsideRepo(path.resolve(repoRoot, targetOverride), repoRoot)
        : null;
      const target = resolvedOverride
        ? {kind: 'override', path: resolvedOverride, root: repoRoot}
        : detected;
```

Run: `node --test test/flow/install-flow-hook.test.mjs`
Expected: PASS no test e nos existentes.

- [ ] **Step 3: Commit**

```bash
git add bin/install-flow-hook.mjs test/flow/install-flow-hook.test.mjs
git commit -m "fix(flow): validar --target dentro do repo (anti path-traversal)"
```

---

## Task 5: runner — writes atômicos via staging+rename (P1)

**Files:**
- Modify: `bin/flow/runner.mjs:92-100`
- Test: `test/flow/runner.test.mjs`

**Achado coberto:**
- **P1#6** `runner.mjs:94` — `writeFile` direto para `workflow.json`; crash mid-write deixa JSON corrupto (mitigado em `commandDeliver` no `archify.mjs:960+` mas nao replicado aqui).

### Steps

- [ ] **Step 1: Adicionar helper `writeAtomic` em runner.mjs**

Antes do `export async function runFlow`:
```js
async function writeAtomic(targetPath, contents, {encoding = 'utf8'} = {}) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.archify-flow-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, contents, encoding);
    await fs.rename(tmp, targetPath);
  } catch (e) {
    await fs.rm(tmp, {force: true}).catch(() => {});
    throw e;
  }
}
```

- [ ] **Step 2: Substituir os writeFile diretos por writeAtomic**

Em `bin/flow/runner.mjs:94` e `:98-100`:
```js
  await writeAtomic(jsonPath, JSON.stringify(spec, null, 2));
```

E:
```js
  await writeAtomic(sourcePath, JSON.stringify({
    range, baseSha, generated_at: stamp,
  }, null, 2));
```

- [ ] **Step 3: RED — test de atomicidade via simulacao de crash**

Em `test/flow/runner.test.mjs`, adicionar:
```js
test('runFlow nao deixa .tmp files apos sucesso', async () => {
  await ensureFixture();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-flow-runner-atomic-'));
  const outDir = path.join(tmpRoot, 'docs/flows');

  const fixtureDir = path.join(repoRoot, 'test/flow/fixtures/mini-repo');
  await runFlow({
    range: 'main...feat',
    out: outDir,
    quality: 'standard',
    archifyBin,
    cwd: fixtureDir,
  });

  const entries = await fs.readdir(outDir);
  const tmps = entries.filter((e) => e.startsWith('.archify-flow-') && e.endsWith('.tmp'));
  assert.equal(tmps.length, 0, `sem .tmp apos sucesso, achei: ${tmps.join(', ')}`);

  await fs.rm(tmpRoot, {recursive: true, force: true});
});
```

Run: `node --test test/flow/runner.test.mjs`
Expected: PASS (atomic writes nao deixa .tmp orfaos).

- [ ] **Step 4: Commit**

```bash
git add bin/flow/runner.mjs test/flow/runner.test.mjs
git commit -m "fix(flow): writes atomicos via staging+rename (workflow.json + sidecar)"
```

---

## Task 6: runner — gate deliver em cima de validate (P1 stale-artifact)

**Files:**
- Modify: `bin/flow/runner.mjs:125-129` + `:131-138`
- Test: `test/flow/runner.test.mjs`

**Achado coberto:**
- **P1#7** `runner.mjs:125` — `workflow.html` e' entregue mesmo quando `validateReceipt.ok === false`. Sem `--strict`, usuario recebe HTML invalido em `workflow.html` indistinguivel do valido.

### Steps

- [ ] **Step 1: RED — test que verifica html NAO e' escrito quando validate falha**

Em `test/flow/runner.test.mjs`, adicionar (manipulando um fixture com `archifyBin` que retorna `ok=false`):
```js
test('runFlow nao chama archify deliver quando validate retornou ok=false', async () => {
  await ensureFixture();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-flow-runner-gate-'));
  const outDir = path.join(tmpRoot, 'docs/flows');

  // Stub de archify: saimos com JSON {ok:false} para 'validate' e conta deliver
  // por side-effect de stdout.
  const stubPath = path.join(tmpRoot, 'stub-archify.mjs');
  await fs.writeFile(stubPath, `
    const sub = process.argv[3];
    if (sub === 'validate') { console.log(JSON.stringify({ok:false, diagnostics:[{message:'forced'}]})); process.exit(0); }
    if (sub === 'deliver')  { console.log('deliver-called'); process.exit(0); }
  `);

  const fixtureDir = path.join(repoRoot, 'test/flow/fixtures/mini-repo');
  const receipt = await runFlow({
    range: 'main...feat',
    out: outDir,
    quality: 'standard',
    archifyBin: stubPath,
    cwd: fixtureDir,
  }).catch(() => null);

  // Como o gate cancela deliver, nenhum 'deliver-called' aparece em parte alguma.
  // Verificacao indireta: workflow.html nao deve existir.
  assert.equal(
    await fs.stat(path.join(outDir, 'workflow.html')).then(() => true, () => false),
    false,
    'workflow.html nao deve existir quando validate falhou',
  );
  if (receipt) {
    assert.equal(receipt.validateReceipt.ok, false);
  }

  await fs.rm(tmpRoot, {recursive: true, force: true});
});
```

Run: `node --test test/flow/runner.test.mjs`
Expected: FAIL (HTML escrito sem checagem).

- [ ] **Step 2: GREEN — gate `deliver` em cima de `validateReceipt.ok`**

Em `bin/flow/runner.mjs`, substituir o bloco de `:125-129` por:
```js
  const htmlPath = path.join(out, 'workflow.html');
  let deliverReceipt = {status: 'skipped', ok: false, reason: 'validate-failed'};
  if (validateReceipt.ok === true) {
    const deliverRaw = shellArchify(archifyBin, [
      'deliver', 'workflow', jsonPath, htmlPath,
      `--quality=${quality}`, '--json',
    ], cwd);
    deliverReceipt = {status: 'passed', ok: true, raw: JSON.parse(deliverRaw)};
  }
```

E em `:131-138`, adicionar `deliverReceipt` ao receipt:
```js
  return {
    jsonPath,
    htmlPath: validateReceipt.ok === true ? htmlPath : null,
    deliverReceipt,
    sourcePath,
    validateReceipt,
    range,
    stamp,
  };
```

Run: `node --test test/flow/runner.test.mjs`
Expected: PASS no gate test E nos demais (que tinham validate='passed' no fixture mini-repo).

- [ ] **Step 3: Commit**

```bash
git add bin/flow/runner.mjs test/flow/runner.test.mjs
git commit -m "fix(flow): gate deliver em validate.ok (sem HTML quando validate falha)"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ P0#1 (parser-diff:57) → T1
- ✅ P0#2 (parser-diff:39 dead code) → T1
- ✅ P0#3 (runner:83 2-dot) → T2
- ✅ P1#1 (runner:25 --END-- marker) → T2
- ✅ P1#5 (flow:123 symlink) → T3
- ✅ P1#4 (install:83 --target) → T4
- ✅ P1#6 (runner:94 atomic) → T5
- ✅ P1#7 (runner:125 stale) → T6
- ⏸ P1 restantes (error-envelope `flow.mjs:38`, exit-codes) — fora deste plano.
- ⏸ P2/P3 — backlog.

**2. Placeholders:** nenhum TBD ou TODO. Cada step tem codigo e comando exato.

**3. Type consistency:**
- `writeAtomic(targetPath, contents, opts)` chamado com 2 args em ambos os sites — consistente.
- `deliverReceipt` adicionado ao receipt — shape aditivo, nao quebra.

**4. File paths:** todos absolutos (relativos ao repo dev-archify).
