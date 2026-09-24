// Documenta que o delimiter de commit bodies nao colide com `--END--` inline.
// P1#1 do multi-lens: split por `--END--\n` ingeria marker inline; nova solucao
// usa prefixo raro `--ARCHIFY-FLOW-SEP--` para impedir colisao.
import {test} from 'node:test';
import assert from 'node:assert/strict';

const MARKER = '--ARCHIFY-FLOW-SEP--';

// Pluralidade de bodies reais que poderiam (acidentalmente) conter o marker.
// O prefixo `ARCHIFY-FLOW-SEP--` foi escolhido para ser distinto; este test
// garante que em nenhum dos patterns comuns de changelog/docs isso colide.
const SAMPLE_BODIES = [
  '--END-- termina meu changelog\nproxima linha',
  'Body simples sem nada incomum aqui',
  'Co-authored-by: Alice <alice@example.com>',
  'Refs: ARCHIFY-123, ARCHIFY-FLOW-OLD',
  'Breaking: renomeei --ARCHIVE-- para outro nome', // similar mas distinto
  'Multi-line\nbody\ncom --END--\nno meio', // cenaria P1#1 original
  'Trailing marker   \n  ', // whitespace variavel
];

test('marker `--ARCHIFY-FLOW-SEP--` nao colide com bodies reais', () => {
  for (const body of SAMPLE_BODIES) {
    assert.equal(
      body.includes(MARKER),
      false,
      `body nao deve conter marker literal: ${JSON.stringify(body)}`,
    );
  }
});

test('split pelo novo delimiter preserva body que termina em --END--', () => {
  // Simula o output de `git log` com um commit cujo body termina com `--END--\n`.
  // O split por `--ARCHIFY-FLOW-SEP--\n` deve isolar APENAS o marker, sem
  // fragmentar o commit.
  const fakeLogBlock = [
    'abc1234',
    'subject',
    'this commit ends with --END--',
    'still in same body',
    '--ARCHIFY-FLOW-SEP--', // marker real do runner
  ].join('\n') + '\n';
  const parts = fakeLogBlock.split(`${MARKER}\n`).filter(Boolean);
  assert.equal(parts.length, 1);
  // O split nao deve ter cortado o `--END--` inline; body deve estar inteiro.
  assert.ok(parts[0].includes('this commit ends with --END--'));
  assert.ok(parts[0].includes('still in same body'));
});
