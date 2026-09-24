import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseDiffText} from '../../bin/flow/parser-diff.mjs';

test('parses a single file with one hunk (additions and deletions)', () => {
  const text = [
    'diff --git a/src/x.ts b/src/x.ts',
    'index 0000000..1111111 100644',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -10,3 +12,5 @@',
    ' context line',
  ].join('\n');
  const result = parseDiffText(text);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'src/x.ts');
  assert.equal(result[0].hunks.length, 1);
  assert.equal(result[0].hunks[0].add, 5);
  assert.equal(result[0].hunks[0].del, 3);
  assert.deepEqual(result[0].hunks[0].lines, [12, 16]);
});

test('parses a binary file', () => {
  const text = [
    'diff --git a/img.png b/img.png',
    'index 0000000..1111111',
    'Binary files /dev/null and b/img.png differ',
  ].join('\n');
  const result = parseDiffText(text);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'img.png');
  assert.equal(result[0].binary, true);
});

test('parses a rename', () => {
  const text = [
    'diff --git a/old.ts b/new.ts',
    'similarity index 100%',
    'rename from old.ts',
    'rename to new.ts',
  ].join('\n');
  const result = parseDiffText(text);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'new.ts');
  assert.equal(result[0].renameFrom, 'old.ts');
});

test('parses multiple files in order', () => {
  const text = [
    'diff --git a/a.ts b/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/b.ts b/b.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
  const result = parseDiffText(text);
  assert.equal(result.length, 2);
  assert.equal(result[0].path, 'a.ts');
  assert.equal(result[1].path, 'b.ts');
});

test('handles add-only file', () => {
  const text = [
    'diff --git a/new.ts b/new.ts',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1,3 @@',
    '+line one',
  ].join('\n');
  const result = parseDiffText(text);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'new.ts');
  assert.equal(result[0].hunks[0].add, 3);
  assert.equal(result[0].hunks[0].del, 0);
});

test('handles delete-only file', () => {
  const text = [
    'diff --git a/old.ts b/old.ts',
    'deleted file mode 100644',
    'index 1111111..0000000',
    '--- a/old.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-gone',
  ].join('\n');
  const result = parseDiffText(text);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'old.ts');
  assert.equal(result[0].hunks[0].add, 0);
  assert.equal(result[0].hunks[0].del, 3);
  // P0#1: lines nao podem ser negativas para @@ -1,3 +0,0 @@.
  // Antes do fix, lines era [0, -1]; com o clamp fica [0, 0].
  assert.ok(
    result[0].hunks[0].lines[1] >= result[0].hunks[0].lines[0],
    `lines devem satisfazer lines[1] >= lines[0]; recebi ${JSON.stringify(result[0].hunks[0].lines)}`,
  );
});

test('returns empty array for empty input', () => {
  assert.deepEqual(parseDiffText(''), []);
});
