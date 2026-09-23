import {createHash} from 'node:crypto';

const KIND_PREFIX = {modify: 'm_', decide: 'd_', validate: 'v_'};

export function idFor({kind, key, suffix = ''}) {
  const prefix = KIND_PREFIX[kind] || `${kind.slice(0, 1)}_`;
  const h = createHash('sha1');
  h.update(`${kind}|${key}|${suffix}`);
  return `${prefix}${h.digest('hex').slice(0, 6)}`;
}
