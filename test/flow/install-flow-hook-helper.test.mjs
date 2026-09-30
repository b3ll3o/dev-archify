// Unit tests do helper `ensureTargetInsideRepo` exportado por
// bin/install-flow-hook.mjs. Cobre os edge cases de containment sem
// spawn do CLI (mais rapido e isolado).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ensureTargetInsideRepo} from '../../bin/install-flow-hook.mjs';

const REPO = '/repo';

test('aceita path exatamente em .git', () => {
  assert.equal(ensureTargetInsideRepo('/repo/.git', REPO), '/repo/.git');
});

test('aceita path dentro de .git/hooks', () => {
  assert.equal(ensureTargetInsideRepo('/repo/.git/hooks/pre-push', REPO),
    '/repo/.git/hooks/pre-push');
});

test('aceita path dentro de .husky', () => {
  assert.equal(ensureTargetInsideRepo('/repo/.husky/pre-push', REPO),
    '/repo/.husky/pre-push');
});

test('rejeita path na raiz do repo (sem .git/.husky)', () => {
  // Path na raiz NAO esta dentro de .git nem .husky; allowlist recusa.
  assert.throws(
    () => ensureTargetInsideRepo('/repo', REPO),
    /--target must resolve.*repo/,
  );
});

test('rejeita path em outro subdir do repo (bin/, docs/, src/)', () => {
  // Allowlist e' rigida: apenas .git/ e .husky/.
  assert.throws(
    () => ensureTargetInsideRepo('/repo/bin/evil.sh', REPO),
    /--target must resolve.*repo/,
  );
});

test('rejeita path absoluto fora do repo', () => {
  assert.throws(
    () => ensureTargetInsideRepo('/etc/cron.d/evil', REPO),
    /--target must resolve.*repo/,
  );
});

test('rejeita path com .. que escapa do repo', () => {
  assert.throws(
    () => ensureTargetInsideRepo('/repo/.git/../../../tmp/evil', REPO),
    /--target must resolve.*repo/,
  );
});

test('rejeita path similar mas com prefixo distinto (.gits/)', () => {
  // Sem path.sep anchor, '/repo/.gits' casaria com '/repo/.git' prefixo.
  // Com anchor, '/repo/.gits' NAO e' prefixo de '/repo/.git/...'.
  assert.throws(
    () => ensureTargetInsideRepo('/repo/.gits/evil.sh', REPO),
    /--target must resolve.*repo/,
  );
});
