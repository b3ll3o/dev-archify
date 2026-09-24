// Orchestrator do subcommand `archify flow`.
// Pipeline (sem dependências externas, apenas node builtins):
//   parseDiffRange(range) → parseCommits(range) → buildSpec(...) → write JSON
//   → write provenance sidecar → shell out archify validate → shell out archify deliver.
//
// O receipt retornado NÃO inclui schemaVersion (movido para o sidecar
// <out>/_flow_source.json — o schema raiz é strict: additionalProperties: false).
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {parseDiffRange} from './parser-diff.mjs';
import {buildSpec} from './builder-spec.mjs';

function parseCommits(range, {cwd} = {}) {
  const text = execFileSync('git', [
    'log', range, '--pretty=%h%n%s%n%b%n--END--',
  ], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 50 * 1024 * 1024,
    ...(cwd ? {cwd} : {}),
  });
  if (!text.trim()) return [];
  return text.split('--END--\n').filter(Boolean).map((block) => {
    const [sha, subject, ...rest] = block.split('\n');
    return {sha, subject, body: rest.join('\n').trim()};
  });
}

function loadMdDecisions(file) {
  // Cada `## Heading` (exatamente dois hashes seguidos de espaço) inicia
  // um nó de decisão; o body vai até o próximo `## ` ou EOF. Erros de
  // I/O são propagados. O lookahead negativo (?!#) impede match em
  // `### Subheading` (que tinha o mesmo formato sob o regex antigo).
  const text = fsSync.readFileSync(file, 'utf8');
  const decisions = [];
  const re = /^## (?!#)(.+)$/gm;
  const matches = [...text.matchAll(re)];
  for (let i = 0; i < matches.length; i += 1) {
    const title = matches[i][1];
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    decisions.push({title, body: text.slice(start, end).trim()});
  }
  return decisions;
}

async function loadValidations(file) {
  if (!file) return [];
  const text = await fs.readFile(file, 'utf8');
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : [data];
}

function shellArchify(archifyBin, subArgs, cwd) {
  // archifyBin é o caminho absoluto para bin/archify.mjs (sem `node`).
  // Executamos `node <archifyBin> <subArgs...>` para reaproveitar a
  // dispatch oficial — não duplicamos render/validate logic aqui.
  // Passamos cwd para casar com o cwd usado em parseDiffRange/parseCommits,
  // garantindo semantica consistente em todos os subprocessos.
  return execFileSync('node', [archifyBin, ...subArgs], {
    encoding: 'utf8',
    timeout: 30_000,
    ...(cwd ? {cwd} : {}),
  });
}

export async function runFlow(opts) {
  const {
    range, out, quality = 'standard',
    decisions: decisionsFile, validations: validationsFile,
    archifyBin, sinceMessage, cwd, diffText,
  } = opts;

  if (!range) throw new Error('runFlow: `range` is required');
  if (!out) throw new Error('runFlow: `out` is required');
  if (!archifyBin) throw new Error('runFlow: `archifyBin` is required');

  const stamp = new Date().toISOString();
  const files = parseDiffRange(range, {cwd, diffText});
  // Suporta tanto `base...HEAD` quanto `base .. HEAD` (espaços opcionais).
  const [baseSha] = range.split(/\.\.\.| \.\. /);
  const commits = parseCommits(range, {cwd});
  const decisions = decisionsFile ? loadMdDecisions(decisionsFile) : [];
  const validations = validationsFile ? await loadValidations(validationsFile) : [];

  // baseSha é apenas usado no sidecar de provenance — não vai para o workflow JSON
  // (schema é strict: additionalProperties: false em todos os níveis).
  const spec = buildSpec({range, files, commits, decisions, validations, sinceMessage});

  await fs.mkdir(out, {recursive: true});
  const jsonPath = path.join(out, 'workflow.json');
  await fs.writeFile(jsonPath, JSON.stringify(spec, null, 2), 'utf8');

  // Sidecar de provenance: nunca validado por archify validate.
  const sourcePath = path.join(out, '_flow_source.json');
  await fs.writeFile(sourcePath, JSON.stringify({
    range, baseSha, generated_at: stamp,
  }, null, 2), 'utf8');

  // Validação: warning-only (failure é stashed no receipt para o resto do pipeline
  // continuar). HTML é o deliverable real — falha de deliver é throw.
  let validateReceipt;
  try {
    const validateRaw = shellArchify(archifyBin, [
      'validate', 'workflow', jsonPath,
      `--quality=${quality}`, '--json',
    ], cwd);
    const parsed = JSON.parse(validateRaw);
    validateReceipt = {
      status: parsed.ok === true ? 'passed' : 'failed',
      ok: parsed.ok === true,
      checks: parsed.checks,
      composition: parsed.composition,
      summary: parsed.ok === true
        ? `${(parsed.checks || []).length} artifact checks passed`
        : (parsed.diagnostics?.[0]?.message || parsed.error || 'validate failed'),
    };
  } catch (e) {
    // validate falhou de forma catastrófica (e.g. processo crashado).
    validateReceipt = {status: 'failed', ok: false, summary: e.message};
  }

  const htmlPath = path.join(out, 'workflow.html');
  shellArchify(archifyBin, [
    'deliver', 'workflow', jsonPath, htmlPath,
    `--quality=${quality}`, '--json',
  ], cwd);

  return {
    jsonPath,
    htmlPath,
    sourcePath,
    validateReceipt,
    range,
    stamp,
  };
}
