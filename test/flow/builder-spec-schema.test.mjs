// Real-schema integration test: every scenario from builder-spec.test.mjs
// is fed through buildSpec(...) and validated against the actual
// schemas/workflow.schema.json via Ajv. If the builder ever drifts out of
// schema, this test fails with the precise Ajv error.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// ajv/dist/2020 ships draft 2020-12 support, which workflow.schema.json
// requires (uses prefixItems). ajv (default) is draft-07 only.
import Ajv from 'ajv/dist/2020.js';

import wfSchema from '../../schemas/workflow.schema.json' with {type: 'json'};
import commonSchema from '../../schemas/common.schema.json' with {type: 'json'};
import {buildSpec} from '../../bin/flow/builder-spec.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// Ajv in strict: false + allErrors so we surface every violation rather than
// just the first one (schemas use additionalProperties: false heavily).
const ajv = new Ajv({strict: false, allErrors: true, allowUnionTypes: true});
ajv.addSchema(commonSchema, 'common.schema.json');
const validate = ajv.compile(wfSchema);

const baseInputs = () => ({
  range: 'origin/main...HEAD',
  files: [{
    path: 'src/x.ts', binary: false, renameFrom: null,
    hunks: [{start: 12, add: 5, del: 3, lines: [12, 16]}],
  }],
  commits: [{sha: 'abcdef', subject: 'feat: x', body: ''}],
  decisions: [],
  validations: [],
});

function assertValid(spec, label) {
  const ok = validate(spec);
  if (ok) return;
  const detail = (validate.errors || [])
    .map(e => `${e.instancePath || '<root>'} ${e.message} (${JSON.stringify(e.params)})`)
    .join('\n  ');
  assert.fail(`[${label}] spec fails workflow.schema.json validation:\n  ${detail}\n  spec: ${JSON.stringify(spec, null, 2)}`);
}

test('schema fixture is present and parseable', () => {
  const filePath = path.join(repoRoot, 'schemas', 'workflow.schema.json');
  assert.ok(fs.existsSync(filePath), `missing ${filePath}`);
  assert.equal(typeof wfSchema, 'object');
  assert.equal(wfSchema.title, 'Archify Workflow Diagram');
});

test('baseline scenario (1 file + 1 commit + 0 validations) is schema-valid', () => {
  const spec = buildSpec(baseInputs());
  assertValid(spec, 'baseline');
});

test('collapse scenario (>10 commits → 1 summary node) is schema-valid', () => {
  const commits = Array.from({length: 11}, (_, i) => ({
    sha: `sha${i}`, subject: `commit ${i}`, body: '',
  }));
  const spec = buildSpec({...baseInputs(), commits});
  assertValid(spec, 'collapse');
});

test('explicit decisions append scenario is schema-valid', () => {
  const decisions = [{title: 'Rationale: chose lazy', body: 'because...'}];
  const spec = buildSpec({...baseInputs(), decisions});
  assertValid(spec, 'explicit-decisions');
});

test('empty Modify lane scenario is schema-valid', () => {
  const spec = buildSpec({...baseInputs(), files: []});
  assertValid(spec, 'empty-modify');
});

test('binary file scenario is schema-valid', () => {
  const files = [{path: 'img.png', binary: true, renameFrom: null, hunks: []}];
  const spec = buildSpec({...baseInputs(), files});
  assertValid(spec, 'binary');
});

test('validation lane scenario (lint: passed) is schema-valid', () => {
  const validations = [{name: 'lint', status: 'passed', summary: 'ok'}];
  const spec = buildSpec({...baseInputs(), validations});
  assertValid(spec, 'lint-passed');
});

test('1-commit range with no files and no validations emits self-loop and mainPath of length 2', () => {
  const spec = buildSpec({
    ...baseInputs(),
    files: [],
    validations: [],
    commits: [{sha: 'cafe1234', subject: 'chore: tweak', body: ''}],
  });
  assertValid(spec, 'single-node');
  assert.equal(spec.mainPath.length, 2);
  assert.equal(spec.mainPath[0], spec.mainPath[1]);
  assert.equal(spec.edges.length, 1);
  assert.equal(spec.edges[0].from, spec.edges[0].to);
  assert.equal(spec.edges[0].from, spec.mainPath[0]);
});

test('explicit `?` glob does not crash and yields no Decide nodes', () => {
  // With sinceMessage='?', no commit subject matches the literal '?',
  // so zero Decide nodes should be produced and buildSpec must not throw.
  const commits = [
    {sha: 'aaaa', subject: 'feat: include', body: ''},
    {sha: 'bbbb', subject: 'chore: skip', body: ''},
  ];
  const spec = buildSpec({
    ...baseInputs(), commits, sinceMessage: '?',
  });
  assertValid(spec, 'question-glob');
  const decideNodes = spec.nodes.filter(n => n.lane === 'decide');
  assert.equal(decideNodes.length, 0);
});

test('schema_version is always 1 (no dual-mode)', () => {
  const spec = buildSpec(baseInputs());
  assert.equal(spec.schema_version, 1);
});

test('lanes are objects with id + label', () => {
  const spec = buildSpec(baseInputs());
  assert.ok(Array.isArray(spec.lanes));
  assert.ok(spec.lanes.length >= 1);
  for (const lane of spec.lanes) {
    assert.equal(typeof lane, 'object', `lane must be object, got ${typeof lane}`);
    assert.equal(typeof lane.id, 'string');
    assert.ok(lane.id.length > 0);
    assert.equal(typeof lane.label, 'string');
    assert.ok(lane.label.length > 0);
  }
});

test('node lane values are ids from spec.lanes', () => {
  const spec = buildSpec(baseInputs());
  const laneIds = new Set(spec.lanes.map(l => l.id));
  for (const node of spec.nodes) {
    assert.ok(laneIds.has(node.lane), `node ${node.id} lane="${node.lane}" not in lanes=[${[...laneIds].join(',')}]`);
  }
});

test('node types are from the schema enum (frontend|backend|database|cloud|security|messagebus|external)', () => {
  const allowed = new Set(['frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external']);
  const spec = buildSpec(baseInputs());
  for (const node of spec.nodes) {
    assert.ok(allowed.has(node.type), `node ${node.id} has invalid type "${node.type}"`);
  }
});

test('root object has no schema-disallowed extra properties (no _flow_source, no semanticChecks)', () => {
  const spec = buildSpec(baseInputs());
  assert.equal(Object.prototype.hasOwnProperty.call(spec, '_flow_source'), false, '_flow_source must not appear at root');
  assert.equal(Object.prototype.hasOwnProperty.call(spec, 'semanticChecks'), false, 'semanticChecks must not appear at root');
});

test('no synthetic start/terminal nodes exist', () => {
  const spec = buildSpec(baseInputs());
  for (const node of spec.nodes) {
    assert.notEqual(node.type, 'start', `start type is not in the schema enum`);
    assert.notEqual(node.type, 'terminal', `terminal type is not in the schema enum`);
    assert.notEqual(node.type, 'default', `default type is not in the schema enum`);
    assert.notEqual(node.id, 'start', `synthetic start anchor must be removed`);
    assert.notEqual(node.id, 'end', `synthetic end anchor must be removed`);
  }
});
