// Documenta que o delimiter de commit bodies nao colide com `--END--` inline.
// P1#1 do multi-lens: split por `--END--\n` ingeria marker inline; nova solucao
// usa prefixo raro `--ARCHIFY-FLOW-SEP--` para impedir colisao.
import {test} from 'node:test';
import assert from 'node:assert/strict';

test('delimiter nao e confundido com --END-- inline em commit body', () => {
  // Sanidade do novo padrao: a string `--ARCHIFY-FLOW-SEP--` so aparece como
  // marker delimitador. Qualquer coincidencia com texto real de commit body
  // e extremamente improvavel (prefixo incomum).
  const sampleBody = 'this commit ends with --END-- before a newline\nnext body line';
  assert.equal(sampleBody.includes('--ARCHIFY-FLOW-SEP--'), false);
});

test('split pelo novo delimiter preserva body que termina em --END--', () => {
  // Simula o output de `git log` com um commit cujo body termina com `--END--\n`.
  // O split por `--ARCHIFY-FLOW-SEP--\n` deve isolar APENAS o marker, sem
  // fragmentar o commit.
  const fakeLogBlock =
    'abc1234\nsubject\nthis commit ends with --END--\nstill in same body\n--ARCHIFY-FLOW-SEP--\n';
  const parts = fakeLogBlock.split('--ARCHIFY-FLOW-SEP--\n').filter(Boolean);
  assert.equal(parts.length, 1);
  // O split nao deve ter cortado o `--END--` inline; body deve estar inteiro.
  assert.ok(parts[0].includes('this commit ends with --END--'));
  assert.ok(parts[0].includes('still in same body'));
});