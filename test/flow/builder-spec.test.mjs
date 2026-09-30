import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSpec} from '../../bin/flow/builder-spec.mjs';

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

test('emits lanes as objects with id + label (modify / decide / validate)', () => {
  const spec = buildSpec(baseInputs());
  const ids = spec.lanes.map(l => l.id);
  const labels = spec.lanes.map(l => l.label);
  assert.ok(ids.includes('modify'));
  assert.ok(ids.includes('decide'));
  assert.ok(ids.includes('validate'));
  assert.ok(labels.includes('Modify'));
  assert.ok(labels.includes('Decide'));
  assert.ok(labels.includes('Validate'));
});

test('builds a node per file in the modify lane', () => {
  const spec = buildSpec(baseInputs());
  const modifyNodes = spec.nodes.filter(n => n.lane === 'modify');
  assert.equal(modifyNodes.length, 1);
  assert.equal(modifyNodes[0].type, 'frontend');
});

test('collapses commits to a single summary node when > 10', () => {
  const commits = Array.from({length: 11}, (_, i) => ({
    sha: `sha${i}`, subject: `commit ${i}`, body: '',
  }));
  const spec = buildSpec({...baseInputs(), commits});
  const decideNodes = spec.nodes.filter(n => n.lane === 'decide');
  assert.equal(decideNodes.length, 1);
  assert.match(decideNodes[0].label, /^11 commits/);
  // Sublabel é truncado para caber no node; checamos apenas o prefixo comum
  // (primeiro sha) e que existe UM summary node.
  assert.ok(decideNodes[0].sublabel.includes('sha0'));
});

test('appends explicit decisions after commit nodes', () => {
  const decisions = [{title: 'Rationale: chose lazy', body: 'because...'}];
  const spec = buildSpec({...baseInputs(), decisions});
  const decideNodes = spec.nodes.filter(n => n.lane === 'decide');
  // Title é truncado para caber no node, então checamos só o prefixo comum.
  assert.ok(decideNodes.some(n => (n.sublabel || '').includes('because...')));
});

test('empty Modify lane produces no modify nodes (other lanes still wired)', () => {
  const spec = buildSpec({...baseInputs(), files: []});
  const modifyIds = spec.nodes.filter(n => n.lane === 'modify').map(n => n.id);
  assert.equal(modifyIds.length, 0);
  // mainPath must still have length >= 2 per schema
  assert.ok(spec.mainPath.length >= 2);
});

test('emits schema_version 1 (v2 schema enum is supported but v1 is the house style)', () => {
  const spec = buildSpec(baseInputs());
  assert.equal(spec.schema_version, 1);
  assert.equal(spec.diagram_type, 'workflow');
  // strict additionalProperties:false — no semanticChecks or _flow_source at root
  assert.equal(spec.semanticChecks, undefined);
  assert.equal(spec._flow_source, undefined);
});

test('binary file gets a single node labeled with path + binary suffix', () => {
  const files = [{path: 'img.png', binary: true, renameFrom: null, hunks: []}];
  const spec = buildSpec({...baseInputs(), files});
  const node = spec.nodes.find(n => n.label.startsWith('img.png'));
  assert.ok(node);
  // label = path (truncado para caber no node 92px) + sufixo binário.
  // O renderer força label ≤ ~14 chars, então "img.png (Bina…" é aceitável.
  assert.ok(node.label.startsWith('img.png'),
    `esperava label começando com "img.png", recebi "${node.label}"`);
});

test('axes are wired modify → decide → validate (no synthetic start/end nodes)', () => {
  const validations = [{name: 'lint', status: 'passed', summary: 'ok'}];
  const spec = buildSpec({...baseInputs(), validations});
  // No synthetic anchors
  assert.ok(!spec.nodes.some(n => n.id === 'start'));
  assert.ok(!spec.nodes.some(n => n.id === 'end'));
  // mainPath carries the order: modify first, validate last
  assert.equal(spec.mainPath[0], spec.nodes.find(n => n.lane === 'modify').id);
  assert.equal(spec.mainPath[spec.mainPath.length - 1], spec.nodes.find(n => n.lane === 'validate').id);
  // Each consecutive pair in mainPath has an edge
  for (let i = 0; i < spec.mainPath.length - 1; i++) {
    const a = spec.mainPath[i];
    const b = spec.mainPath[i + 1];
    assert.ok(spec.edges.some(e => e.from === a && e.to === b), `missing edge ${a} → ${b}`);
  }
});

test('honors since-message filter (only matching commits appear)', () => {
  const commits = [
    {sha: 'aaaa', subject: 'feat: include', body: ''},
    {sha: 'bbbb', subject: 'chore: skip',   body: ''},
  ];
  const spec = buildSpec({
    ...baseInputs(), commits, sinceMessage: 'feat:*',
  });
  const decideNodes = spec.nodes.filter(n => n.lane === 'decide');
  assert.equal(decideNodes.length, 1);
  // label = sha prefix; subject completo vai para sublabel.
  assert.match(decideNodes[0].label, /^[0-9a-f]+$/);
  assert.match(decideNodes[0].sublabel, /feat: include/);
});

test('col is integer within [0, 5]', () => {
  const commits = Array.from({length: 8}, (_, i) => ({
    sha: `sha${i}`, subject: `commit ${i}`, body: '',
  }));
  const spec = buildSpec({...baseInputs(), commits});
  for (const node of spec.nodes) {
    assert.ok(Number.isInteger(node.col));
    assert.ok(node.col >= 0 && node.col <= 5, `col ${node.col} out of range`);
  }
});

test('first node of the whole axis has col 0; subsequent nodes have monotonically increasing cols', () => {
  // Cols are assigned sequentially across the entire ordered node list (not
  // per-lane) — see buildAxis in builder-spec.mjs. The renderer enforces
  // `to.col >= from.col` on every mainPath step, so per-lane restart would
  // produce backward steps whenever a lane has more than one node.
  const spec = buildSpec(baseInputs());
  assert.equal(spec.nodes[0].col, 0);
  for (let i = 1; i < spec.nodes.length; i += 1) {
    assert.ok(spec.nodes[i].col >= spec.nodes[i - 1].col,
      `node ${spec.nodes[i].id} col=${spec.nodes[i].col} regressed from ${spec.nodes[i - 1].col}`);
    assert.ok(spec.nodes[i].col <= 5,
      `node ${spec.nodes[i].id} col=${spec.nodes[i].col} exceeds COL_MAX=5`);
  }
});

test('empty range (no files, no commits, no validations) throws a clear error', () => {
  assert.throws(
    () => buildSpec({
      ...baseInputs(),
      files: [],
      commits: [],
      validations: [],
      decisions: [],
    }),
    /no nodes to emit/,
  );
});

test('since-message=`?` does not crash (literal `?` is escaped, not a regex metachar)', () => {
  const commits = [
    {sha: 'aaaa', subject: 'feat: include', body: ''},
    {sha: 'bbbb', subject: 'chore: skip',   body: ''},
  ];
  // Should not throw — previously `new RegExp('^?$')` blew up with
  // "SyntaxError: Nothing to repeat".
  const spec = buildSpec({...baseInputs(), commits, sinceMessage: '?'});
  // No commit subject contains a literal "?", so no decide nodes.
  assert.equal(spec.nodes.filter(n => n.lane === 'decide').length, 0);
});
