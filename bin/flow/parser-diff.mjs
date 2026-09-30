import {execFileSync} from 'node:child_process';

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+?)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BINARY_MARK = /^Binary files/;
const RENAME_FROM = /^rename from (.+)$/;
const RENAME_TO = /^rename to (.+)$/;

function classifyLineKind(line, inBinary) {
  if (inBinary) return null;
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'del';
  return null;
}

export function parseDiffText(text) {
  if (!text || !text.trim()) return [];
  const lines = text.split('\n');
  const files = [];
  let current = null;
  let inBinary = false;
  let hunkActive = false;

  for (const line of lines) {
    const headerMatch = FILE_HEADER.exec(line);
    if (headerMatch) {
      if (current) files.push(current);
      current = {
        path: headerMatch[2],
        fromPath: headerMatch[1],
        binary: false,
        renameFrom: null,
        hunks: [],
      };
      inBinary = false;
      hunkActive = false;
      continue;
    }
    const renameFrom = RENAME_FROM.exec(line);
    if (current && renameFrom) { current.renameFrom = renameFrom[1]; continue; }
    const renameTo = RENAME_TO.exec(line);
    if (current && renameTo) { current.path = renameTo[1]; continue; }
    if (current && BINARY_MARK.test(line)) {
      current.binary = true;
      inBinary = true;
      continue;
    }
    const hunkMatch = HUNK_HEADER.exec(line);
    if (current && hunkMatch) {
      const startNew = parseInt(hunkMatch[3], 10);
      const lenNew = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;
      current.hunks.push({
        start: startNew,
        add: lenNew,
        del: parseInt(hunkMatch[2] || '1', 10),
        // lines[1] normalmente seria startNew + lenNew - 1, mas para
        // hunks deletados (lenNew=0) o clamp evita "L0--1" no sublabel
        // (regressao P0#1 — ver test/flow/parser-diff.test.mjs).
        lines: [startNew, Math.max(startNew, startNew + lenNew - 1)],
      });
      hunkActive = true;
      continue;
    }
    if (hunkActive && !inBinary) {
      const kind = classifyLineKind(line, false);
      if (kind === 'add') {
        // already counted in lenNew
      } else if (kind === 'del') {
        // counted in lenOld
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" - ignore
      } else if (line === '') {
        hunkActive = false; // blank line ends hunk in compact mode
      }
    }
  }
  if (current) files.push(current);
  return files;
}

export function parseDiffRange(range, {cwd, diffText} = {}) {
  // Se o caller (CLI pre-flight) ja capturou a saida de `git diff`, aceitamos
  // o texto direto para evitar invocar `git` duas vezes. Caso contrario, rodamos
  // `git diff` aqui com maxBuffer elevado (diffs grandes sao comuns em monorepos).
  const text = diffText !== undefined
    ? diffText
    : execFileSync('git', [
      'diff', '--unified=0', '--no-color', '--no-ext-diff', range,
    ], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 50 * 1024 * 1024,
      ...(cwd ? {cwd} : {}),
    });
  return parseDiffText(text);
}
