import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {detectTarget, writeShim} from '../../bin/install-flow-hook.mjs';

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
