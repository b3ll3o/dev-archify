// Unit tests do helper writeAtomic exportado de bin/flow/runner.mjs.
// Cobre o caminho de cleanup-on-failure (regression guard contra
// perda do cleanup em catch) e um smoke test do happy path.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {writeAtomic} from '../../bin/flow/runner.mjs';

test('writeAtomic cleanup staging e rethrow quando rename falha', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-write-atomic-fail-'));
  try {
    const target = path.join(tmpRoot, 'workflow.json');

    // Pre-popula o target com conteudo INTACTO; apos writeAtomic falha,
    // o target deve continuar com essa string original.
    await fs.writeFile(target, '{"original":true}');

    // Substitui o prototipo fs.rename para throw, e depois restaura.
    // Em Node ESM, monkey-patch direto em `fs` e' read-only; precisamos
    // mutar via prototype (fs e' uma re-exportacao do modulo nativo).
    const origRename = fs.rename;
    Object.defineProperty(fs, 'rename', {
      value: async () => {
        const e = new Error('mocked rename failure');
        e.code = 'EACCES';
        throw e;
      },
      writable: true,
      configurable: true,
    });
    let thrown = null;
    try {
      await writeAtomic(target, '{"new":true}');
    } catch (e) {
      thrown = e;
    } finally {
      Object.defineProperty(fs, 'rename', {
        value: origRename,
        writable: true,
        configurable: true,
      });
    }

    // Erro original rethrown sem mascarar (mesmo .code EACCES).
    assert.ok(thrown, 'writeAtomic deve ter lancado');
    assert.equal(thrown.code, 'EACCES',
      `esperava EACCES do rename mockado; recebi ${thrown.code}`);

    // Target intacto (pre-existente nao foi sobrescrito por staging falho).
    const targetBody = await fs.readFile(target, 'utf8');
    assert.equal(targetBody, '{"original":true}',
      `target deve estar intacto apos falha; achei: ${targetBody}`);

    // Nenhum staging orfao em tmpRoot.
    const entries = await fs.readdir(tmpRoot);
    const orphanTmps = entries.filter(
      (e) => e.startsWith('.archify-flow-') && e.endsWith('.tmp'),
    );
    assert.equal(orphanTmps.length, 0,
      `cleanup deve ter removido staging orfao; achei: ${orphanTmps.join(', ')}`);
  } finally {
    await fs.rm(tmpRoot, {recursive: true, force: true});
  }
});

test('writeAtomic sucesso deixa target intocado e staging limpo', async () => {
  // Smoke test basico do helper: target escrito, staging limpo.
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-write-atomic-ok-'));
  try {
    const target = path.join(tmpRoot, 'ok.json');
    await writeAtomic(target, '{"ok":true}');
    const body = await fs.readFile(target, 'utf8');
    assert.equal(body, '{"ok":true}');
    // Nenhum .archify-flow-*.tmp em tmpRoot.
    const entries = await fs.readdir(tmpRoot);
    const tmps = entries.filter((e) => e.startsWith('.archify-flow-') && e.endsWith('.tmp'));
    assert.equal(tmps.length, 0, `sem staging apos sucesso; achei: ${tmps.join(', ')}`);
    // Apenas 1 arquivo final (sem dotfile orfao).
    const allFiles = await fs.readdir(tmpRoot, {includeHidden: true});
    assert.equal(allFiles.length, 1,
      `esperava 1 arquivo final; achei: ${allFiles.join(', ')}`);
  } finally {
    await fs.rm(tmpRoot, {recursive: true, force: true});
  }
});