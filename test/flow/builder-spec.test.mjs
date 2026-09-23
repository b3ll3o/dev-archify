import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSpec} from '../../bin/flow/builder-spec.mjs';

const baseInputs = () => ({
  range: 'origin/main...HEAD',
  baseSha: 'base1234',
  files: [{
    path: 'src/x.ts', binary: false, renameFrom: null,
    hunks: [{start: 12, add: 5, del: 3, lines: [12, 16]}],
  }],
  commits: [{sha: 'abcdef', subject: 'feat: x', body: ''}],
  decisions: [],
  validations: [],
  schemaVersion: 2,
});

test('builds spec with start, modify, decide, end', () => {
  const spec = buildSpec(baseInputs());
  const lanes = spec.nodes.map(n => n.lane).filter(Boolean);
  assert.ok(lanes.includes('Modify'));
  assert.ok(lanes.includes('Decide'));
  const ids = spec.nodes.map(n => n.id);
  assert.ok(ids.includes('start'));
  assert.ok(ids.includes('end'));
});

test('collapses commits to summary node when > 10', () => {
  const commits = Array.from({length: 11}, (_, i) => ({
    sha: `sha${i}`, subject: `commit ${i}`, body: '',
  }));
  const spec = buildSpec({...baseInputs(), commits});
  const decideNodes = spec.nodes.filter(n => n.lane === 'Decide');
  assert.equal(decideNodes.length, 1);
  assert.match(decideNodes[0].label, /^11 commits/);
  assert.ok(decideNodes[0].description.includes('sha0'));
  assert.ok(decideNodes[0].description.includes('sha10'));
});

test('appends explicit decisions after commit nodes', () => {
  const decisions = [{title: 'Rationale: chose lazy', body: 'because...'}];
  const spec = buildSpec({...baseInputs(), decisions});
  const decideNodes = spec.nodes.filter(n => n.lane === 'Decide');
  assert.ok(decideNodes.some(n => n.label.includes('chose lazy')));
});

test('skips empty Modify lane when no files', () => {
  const spec = buildSpec({...baseInputs(), files: []});
  const ids = spec.nodes.filter(n => n.lane === 'Modify').map(n => n.id);
  assert.equal(ids.length, 0);
  // still has start and end
  assert.ok(spec.nodes.some(n => n.id === 'start'));
  assert.ok(spec.nodes.some(n => n.id === 'end'));
});

test('emits schema_version 2 by default', () => {
  const spec = buildSpec(baseInputs());
  assert.equal(spec.schema_version, 2);
  assert.equal(spec.diagram_type, 'workflow');
  assert.ok(Array.isArray(spec.semanticChecks.allowedRoots));
  assert.ok(spec.semanticChecks.allowedRoots.includes('start'));
});

test('emits schema_version 1 when --schema=1', () => {
  const spec = buildSpec({...baseInputs(), schemaVersion: 1});
  assert.equal(spec.schema_version, 1);
  // semanticChecks is v2-only
  assert.equal(spec.semanticChecks, undefined);
});

test('binary file gets a single Binary label', () => {
  const files = [{path: 'img.png', binary: true, renameFrom: null, hunks: []}];
  const spec = buildSpec({...baseInputs(), files});
  const node = spec.nodes.find(n => n.label.startsWith('img.png'));
  assert.ok(node);
  assert.match(node.label, /Binary changes/);
});

test('validates axes are wired start → modify → decide → validate → end', () => {
  const validations = [{name: 'lint', status: 'passed', summary: 'ok'}];
  const spec = buildSpec({...baseInputs(), validations});
  assert.ok(spec.edges.some(e => e.from === 'start'));
  assert.ok(spec.edges.some(e => e.to === 'end'));
  assert.deepEqual(spec.mainPath[0], 'start');
  assert.equal(spec.mainPath[spec.mainPath.length - 1], 'end');
});

test('honors since-message filter (only matching commits appear)', () => {
  const commits = [
    {sha: 'aaaa', subject: 'feat: include', body: ''},
    {sha: 'bbbb', subject: 'chore: skip',   body: ''},
  ];
  const spec = buildSpec({
    ...baseInputs(), commits, sinceMessage: 'feat:*',
  });
  const decideNodes = spec.nodes.filter(n => n.lane === 'Decide');
  assert.equal(decideNodes.length, 1);
  assert.match(decideNodes[0].label, /feat: include/);
});
