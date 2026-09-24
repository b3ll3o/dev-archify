import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {runHook} from '../../hooks/pre-push.flow.mjs';

async function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(prev); }
}

test('hook no-ops on push to main', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-hook-'));
  await withCwd(tmp, async () => {
    const r = await runHook({
      remote: 'origin',
      remoteRef: 'refs/heads/main',
      execCli: async () => { throw new Error('should not be called'); },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.action, 'noop');
  });
  await fs.rm(tmp, {recursive: true, force: true});
});

test('hook invokes CLI for feature branch', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-hook-'));
  await withCwd(tmp, async () => {
    let called = false;
    const r = await runHook({
      remote: 'origin',
      remoteRef: 'refs/heads/feat',
      execCli: async (cmd) => {
        called = true;
        assert.match(cmd, /archify flow/);
        assert.match(cmd, /--git-range=origin\/main\.\.\.HEAD/);
        return {status: 0};
      },
      execGit: async (cmd) => { /* swallow */ },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.action, 'flow-and-commit');
    assert.equal(called, true);
  });
  await fs.rm(tmp, {recursive: true, force: true});
});

test('hook exits 0 (never blocks) on CLI failure', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archify-hook-'));
  await withCwd(tmp, async () => {
    const r = await runHook({
      remote: 'origin',
      remoteRef: 'refs/heads/feat',
      execCli: async () => { throw new Error('archify not installed'); },
      execGit: async () => {},
      log: () => {},
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.action, 'flow-skipped');
  });
  await fs.rm(tmp, {recursive: true, force: true});
});
