import {idFor} from './ids.mjs';

function globToRegex(glob) {
  // minimal glob: '*' → '.*'
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function commitMatches(commit, sinceMessage) {
  if (!sinceMessage) return true;
  return globToRegex(sinceMessage).test(commit.subject);
}

function buildModifyNode(file) {
  const id = idFor({kind: 'modify', key: file.path, suffix: file.hunks.map(h => h.lines.join('-')).join(',')});
  if (file.binary) {
    return {id, lane: 'Modify', type: 'default', label: `${file.path} (Binary changes)`};
  }
  const adds = file.hunks.reduce((s, h) => s + h.add, 0);
  const dels = file.hunks.reduce((s, h) => s + h.del, 0);
  const ranges = file.hunks.map(h => `lines ${h.lines[0]}-${h.lines[1]}`).join(', ');
  return {
    id,
    lane: 'Modify',
    type: 'default',
    label: `${file.path} (+${adds} -${dels})`,
    description: ranges ? `hunks at ${ranges}` : '',
  };
}

function buildDecideNodeFromCommit(c) {
  return {
    id: idFor({kind: 'decide', key: c.subject, suffix: c.sha}),
    lane: 'Decide',
    type: 'default',
    label: `${c.sha.slice(0, 7)} ${c.subject}`,
    description: c.body || '',
  };
}

function buildCollapsedDecideNode(commits) {
  const shas = commits.map(c => c.sha).join(' ');
  return {
    id: idFor({kind: 'decide', key: 'collapsed', suffix: shas}),
    lane: 'Decide',
    type: 'default',
    label: `${commits.length} commits`,
    description: `${commits[0].subject} … ${commits[commits.length - 1].subject} (${commits.map(c => c.sha.slice(0, 7)).join(' ')})`,
  };
}

function buildDecideNodeFromDecision(d) {
  return {
    id: idFor({kind: 'decide', key: d.title, suffix: 'explicit'}),
    lane: 'Decide',
    type: 'default',
    label: d.title,
    description: d.body,
  };
}

function buildValidateNode(v) {
  return {
    id: idFor({kind: 'validate', key: v.name, suffix: v.status}),
    lane: 'Validate',
    type: 'default',
    label: `${v.name}: ${v.status}`,
    description: v.summary || '',
  };
}

function chainEdges(nodes) {
  const edges = [];
  let prev = 'start';
  for (const n of nodes) {
    if (n.id === 'start' || n.id === 'end') continue;
    edges.push({from: prev, to: n.id});
    prev = n.id;
  }
  edges.push({from: prev, to: 'end'});
  return edges;
}

export function buildSpec(inputs) {
  const {
    range, baseSha, files, commits, decisions = [],
    validations = [], schemaVersion = 2, sinceMessage,
  } = inputs;

  const filteredCommits = commits.filter(c => commitMatches(c, sinceMessage));

  const modifyNodes = files
    .filter(f => !f.binary || files.length === 1)
    .map(buildModifyNode)
    .concat(files.filter(f => f.binary && files.length !== 1).map(f => buildModifyNode(f)));

  let decideNodes;
  if (filteredCommits.length > 10) {
    decideNodes = [buildCollapsedDecideNode(filteredCommits)];
  } else {
    decideNodes = filteredCommits.map(buildDecideNodeFromCommit);
  }
  const explicitDecideNodes = decisions.map(buildDecideNodeFromDecision);
  decideNodes = decideNodes.concat(explicitDecideNodes);

  const validateNodes = validations.map(buildValidateNode);

  const ordered = [
    ...modifyNodes,
    ...decideNodes,
    ...validateNodes,
  ];

  const nodes = [{id: 'start', type: 'start', label: 'start'}, ...ordered, {id: 'end', type: 'terminal', label: 'end'}];

  const edges = chainEdges(ordered);
  const mainPath = ['start', ...ordered.map(n => n.id), 'end'];

  const meta = {
    title: `Flow for ${range}`,
    animation: 'trace',
  };

  const spec = {
    schema_version: schemaVersion,
    diagram_type: 'workflow',
    meta,
    lanes: ['Modify', 'Decide', 'Validate'],
    nodes,
    edges,
    mainPath,
  };

  if (schemaVersion >= 2) {
    spec.semanticChecks = {
      allowedRoots: ['start'],
      allowedTerminals: ['end'],
    };
    spec._flow_source = {range, baseSha, generated_at: 'will-be-stamped-by-runner'};
  }

  return spec;
}
