import {test} from 'node:test';
import assert from 'node:assert/strict';
import {idFor} from '../../bin/flow/ids.mjs';

test('returns prefix + 6-char hash', () => {
  const id = idFor({kind: 'modify', key: 'src/foo.ts'});
  assert.match(id, /^m_[a-z0-9]{6}$/);
});

test('is deterministic for same input', () => {
  const a = idFor({kind: 'modify', key: 'src/foo.ts', suffix: '12-22'});
  const b = idFor({kind: 'modify', key: 'src/foo.ts', suffix: '12-22'});
  assert.equal(a, b);
});

test('different suffix yields different id', () => {
  const a = idFor({kind: 'modify', key: 'src/foo.ts', suffix: '12-22'});
  const b = idFor({kind: 'modify', key: 'src/foo.ts', suffix: '23-33'});
  assert.notEqual(a, b);
});

test('different kind yields different prefix', () => {
  const a = idFor({kind: 'modify', key: 'abc'});
  const b = idFor({kind: 'decide', key: 'abc'});
  assert.equal(a.slice(0, 2), 'm_');
  assert.equal(b.slice(0, 2), 'd_');
});

test('two commits with same subject produce different ids (sha disambiguates)', () => {
  const a = idFor({kind: 'decide', key: 'feat: add x', suffix: 'a1b2c3'});
  const b = idFor({kind: 'decide', key: 'feat: add x', suffix: 'd4e5f6'});
  assert.notEqual(a, b);
});
