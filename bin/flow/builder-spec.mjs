import {idFor} from './ids.mjs';

// Schema enum for node.type (see schemas/common.schema.json#/$defs/componentType).
const COMPONENT_TYPES = new Set([
  'frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external',
]);

// Per-lane locked visual mapping (see spec §4.3, decision locked at design time).
const LANE_TYPE = Object.freeze({
  modify: 'frontend',
  decide: 'security',
  validate: 'backend',
});

const LANE_DEFINITIONS = Object.freeze([
  {id: 'modify',   label: 'Modify'},
  {id: 'decide',   label: 'Decide'},
  {id: 'validate', label: 'Validate'},
]);

const COL_MAX = 5;

function colFor(positionInLane) {
  return Math.min(Math.max(0, positionInLane | 0), COL_MAX);
}

function globToRegex(glob) {
  // minimal glob: '*' → '.*', everything else literal.
  // Escape every regex metacharacter we treat as literal, INCLUDING '?' —
  // a bare '?' makes `new RegExp('^?$')` throw SyntaxError "Nothing to repeat".
  // `*` is intentionally left unescaped here so the next replace can promote
  // it to `.*` (the original two-step pattern; we only widen the escape class).
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function commitMatches(commit, sinceMessage) {
  if (!sinceMessage) return true;
  return globToRegex(sinceMessage).test(commit.subject);
}

// Trunca o label para caber no node (~92px). O conteúdo completo vai para
// sublabel (renderizado abaixo do label). Schema aceita string sem maxLength,
// mas o layout é restrito — labels muito longos fazem o renderer falhar com
// `layout/constraint`. Mantemos label ≤ 14 chars e sublabel ≤ 20 chars para
// caber no node width default do workflow fixed-v1 layout.
const MAX_LABEL_CHARS = 14;
const MAX_SUBLABEL_CHARS = 20;

function truncateLabel(text, max = MAX_LABEL_CHARS) {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function buildModifyNode(file) {
  const id = idFor({
    kind: 'modify',
    key: file.path,
    suffix: file.hunks.map(h => h.lines.join('-')).join(','),
  });
  const base = {id, lane: 'modify', type: LANE_TYPE.modify};
  if (file.binary) {
    return {...base, label: truncateLabel(`${file.path} (Binary)`)};
  }
  const adds = file.hunks.reduce((s, h) => s + h.add, 0);
  const dels = file.hunks.reduce((s, h) => s + h.del, 0);
  const ranges = file.hunks.map(h => `L${h.lines[0]}-${h.lines[1]}`).join(', ');
  return {
    ...base,
    label: truncateLabel(file.path),
    sublabel: truncateLabel(`(+${adds} -${dels})${ranges ? ` ${ranges}` : ''}`, MAX_SUBLABEL_CHARS),
  };
}

function buildDecideNodeFromCommit(c) {
  // label = sha prefix (≤ 7 chars) — cabe no node 92px.
  // sublabel = subject completo (com truncamento agressivo).
  return {
    id: idFor({kind: 'decide', key: c.subject, suffix: c.sha}),
    lane: 'decide',
    type: LANE_TYPE.decide,
    label: c.sha.slice(0, 7),
    sublabel: truncateLabel(c.subject, MAX_SUBLABEL_CHARS) || undefined,
  };
}

function buildCollapsedDecideNode(commits) {
  const shas = commits.map(c => c.sha).join(' ');
  const shortShas = commits.map(c => c.sha.slice(0, 7)).join(' ');
  return {
    id: idFor({kind: 'decide', key: 'collapsed', suffix: shas}),
    lane: 'decide',
    type: LANE_TYPE.decide,
    label: truncateLabel(`${commits.length} commits`),
    sublabel: truncateLabel(shortShas, MAX_SUBLABEL_CHARS),
  };
}

function buildDecideNodeFromDecision(d) {
  return {
    id: idFor({kind: 'decide', key: d.title, suffix: 'explicit'}),
    lane: 'decide',
    type: LANE_TYPE.decide,
    label: truncateLabel(d.title),
    sublabel: d.body ? truncateLabel(d.body, MAX_SUBLABEL_CHARS) : undefined,
  };
}

function buildValidateNode(v) {
  const node = {
    id: idFor({kind: 'validate', key: v.name, suffix: v.status}),
    lane: 'validate',
    type: LANE_TYPE.validate,
    label: truncateLabel(`${v.name}: ${v.status}`),
  };
  if (v.summary) node.sublabel = truncateLabel(v.summary, MAX_SUBLABEL_CHARS);
  return node;
}

// One axis through the lanes, in declared lane order, skipping any lane
// that produced no nodes. `buildAxis` is the single owner of `col` assignment
// (schema requires col in [0, 5]); node builders are col-agnostic.
//
// Cols are assigned sequentially across the entire ordered node list (not
// per-lane). The renderer enforces `to.col >= from.col` on every mainPath
// step — restart-per-lane would produce backward mainPath steps whenever a
// lane has more than one node. The schema permits any col in [0, 5]; we cap
// at COL_MAX so the position never overflows.
function buildAxis({modifyNodes, decideNodes, validateNodes}) {
  const lanes = [
    {nodes: modifyNodes},
    {nodes: decideNodes},
    {nodes: validateNodes},
  ];
  const ordered = [];
  for (const lane of lanes) {
    if (lane.nodes.length === 0) continue;
    ordered.push(...lane.nodes);
  }
  ordered.forEach((n, i) => { n.col = colFor(i); });
  return ordered;
}

export function buildSpec(inputs) {
  const {
    range, files, commits, decisions = [],
    validations = [], sinceMessage,
  } = inputs;
  // NOTE: provenance (range, baseSha, generated_at) is intentionally NOT
  // emitted into the workflow JSON — schema is strict (additionalProperties:
  // false). The runner writes it to <out>/_flow_source.json sidecar instead.

  const filteredCommits = commits.filter(c => commitMatches(c, sinceMessage));

  const modifyNodes = files.map(buildModifyNode);

  let decideNodes;
  if (filteredCommits.length > 10) {
    decideNodes = [buildCollapsedDecideNode(filteredCommits)];
  } else {
    decideNodes = filteredCommits.map(buildDecideNodeFromCommit);
  }
  const explicitDecideNodes = decisions.map(buildDecideNodeFromDecision);
  decideNodes = decideNodes.concat(explicitDecideNodes);

  const validateNodes = validations.map(buildValidateNode);

  const ordered = buildAxis({modifyNodes, decideNodes, validateNodes});

  if (ordered.length === 0) {
    throw new Error('buildSpec: no nodes to emit (range produced no diff, no commits, and no validations)');
  }

  // Schema requires mainPath minItems: 2. If only one real node exists
  // across all lanes, emit a self-loop so the path still has 2 entries.
  let mainPath;
  let edges;
  if (ordered.length === 1) {
    const only = ordered[0];
    mainPath = [only.id, only.id];
    edges = [{from: only.id, to: only.id}];
  } else {
    mainPath = ordered.map(n => n.id);
    edges = [];
    for (let i = 0; i < ordered.length - 1; i++) {
      edges.push({from: ordered[i].id, to: ordered[i + 1].id});
    }
  }

  const spec = {
    schema_version: 1,
    diagram_type: 'workflow',
    meta: {
      title: `Flow for ${range}`,
      animation: 'trace',
    },
    lanes: LANE_DEFINITIONS,
    nodes: ordered,
    edges,
    mainPath,
  };

  // Defensive self-check: every node.type must be in the schema enum.
  for (const node of spec.nodes) {
    if (!COMPONENT_TYPES.has(node.type)) {
      throw new Error(`buildSpec: node ${node.id} has invalid type "${node.type}"`);
    }
  }

  return spec;
}
