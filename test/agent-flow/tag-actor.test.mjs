// Testes de expansao da heuristica tagActor (B33).
//
// Cobertura: 17+ actors novos que aparecem em docs/flows/agent-workflows/
// mas que hoje caem em role=agent scope=generic ou em scope=quality (catch-all).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tagActor} from '../../bin/agent-flow/enrichment.mjs';

// Cada entrada: [actor-name, expected-role, expected-scope]
const ACTOR_CASES = [
  ['STATE-AWARE-PLANNING', 'planner', 'state'],
  ['CI-DEFENSE-IN-DEPTH', 'auditor', 'ci'],
  ['SECURITY-MODE', 'auditor', 'security'],
  ['REFACTOR-MODE', 'refactorer', 'code'],
  ['ARCHIVE-DEMAND', 'archiver', 'docs'],
  ['TASK-MODE', 'manager', 'task'],
  ['DOCS-MODE', 'writer', 'docs'],
  ['REVIEW-MODE', 'reviewer', 'quality'],
  ['EXPLORE-MODE', 'explorer', 'read'],
  ['RELEASE-MODE', 'manager', 'release'],
  ['RETROSPECTIVE-MODE', 'capture', 'learning'],
  ['TEST-WRITER', 'writer', 'test'],
  ['CODE-REVIEWER', 'reviewer', 'code'],
  ['TDD-ENFORCER', 'enforcer', 'tdd'],
  ['NESTJS-SPECIALIST', 'specialist', 'backend'],
  ['NEXTJS-SPECIALIST', 'specialist', 'frontend'],
  ['MONOREPO-SPECIALIST', 'specialist', 'monorepo'],
  ['FRONTEND-SPECIALIST', 'specialist', 'frontend'],
  ['AGENT-ARCHITECT', 'planner', 'architecture'],
];

for (const [actor, expectedRole, expectedScope] of ACTOR_CASES) {
  test(`tagActor(${actor}) → role=${expectedRole} scope=${expectedScope}`, () => {
    const tag = tagActor(actor);
    assert.equal(tag.role, expectedRole, `role mismatch for ${actor}: got ${tag.role}`);
    assert.equal(tag.scope, expectedScope, `scope mismatch for ${actor}: got ${tag.scope}`);
  });
}

// Casos extras: kebab-case/snake_case devem funcionar via tagActor (case-insensitive).
test('tagActor kebab-case preserva role/scope', () => {
  const tag = tagActor('nestjs-specialist');
  assert.equal(tag.role, 'specialist');
  assert.equal(tag.scope, 'backend');
});

test('tagActor snake_case preserva role/scope', () => {
  const tag = tagActor('nestjs_specialist');
  assert.equal(tag.role, 'specialist');
  assert.equal(tag.scope, 'backend');
});

// sublabel/tag coerentes com role/scope
test('tagActor retorna sublabel=role e tag=scope:<scope>', () => {
  const tag = tagActor('CI-DEFENSE-IN-DEPTH');
  assert.equal(tag.sublabel, 'auditor');
  assert.equal(tag.tag, 'scope:ci');
});

// Actor desconhecido continua caindo em fallback
test('tagActor retorna {role:agent, scope:generic} para actor totalmente novo', () => {
  const tag = tagActor('TOTALLY-NEW-AGENT');
  assert.equal(tag.role, 'agent');
  assert.equal(tag.scope, 'generic');
});

// Vazio
test('tagActor retorna {role:agent, scope:generic} para entrada vazia', () => {
  const tag = tagActor('');
  assert.equal(tag.role, 'agent');
  assert.equal(tag.scope, 'generic');
});