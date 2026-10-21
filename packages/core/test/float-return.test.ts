// A callee declared to return a float on agbcc, which has no FPU: the float comes back as its bits
// in r0, and the candidate prints the call against its declaration, so the result held anywhere but
// a float is CONVERTED in C (`u.f = fget(); gB = u.b[0];` lifted as `gB = fget();` compiles to
// `bl fget; bl __fixsfsi`). The asm is agbcc's own, compiled at the canonical flags.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { ARMV4T_AGBCC } from '../src/target';

const FGET: Prototypes = { fget: { params: [], returns: 'float' } };
const lift = (name: string, body: string, prototypes: Prototypes) =>
  decompile(name, `${name}:\n${body}`, ARMV4T_AGBCC, { prototypes }).source;

// `gB = u.b[0]` and `gF2 = f` after `u.f = fget()` / `f = fget()`: a byte of the bits, and the bits
// stored whole. agbcc emits the same `strb`/`str` of r0 whatever the destination's type.
const STORE_BYTE =
  '\tpush\t{lr}\n\tbl\tfget\n\tldr\tr1, .L3\n\tstrb\tr0, [r1]\n\tpop\t{r0}\n\tbx\tr0\n.L3:\n\t.word\tgB\n';
const STORE_WORD =
  '\tpush\t{lr}\n\tbl\tfget\n\tldr\tr1, .L3\n\tstr\tr0, [r1]\n\tpop\t{r0}\n\tbx\tr0\n.L3:\n\t.word\tgF2\n';

describe('a declared float return on a target without an FPU', () => {
  test.each([
    ['a byte of its bits', STORE_BYTE],
    ['its bits stored whole', STORE_WORD],
  ])('read as %s declines', (_, body) => {
    expect(() => lift('f', body, { ...FGET, f: { params: [], returnsVoid: true } })).toThrow(
      "'fget' is declared to return float, which this target hands back as bits in a general register",
    );
  });

  // Undeclared, the same bytes are an integer callee's, and lift as one.
  test('an undeclared callee is read as a word', () => {
    expect(lift('f', STORE_BYTE, { f: { params: [], returnsVoid: true } })).toContain('gB = fget();');
  });

  // Returned, it is the float the function returns; converted by a helper, it is that conversion's
  // operand; unread, the call is a statement.
  test.each([
    ['returned', '\tpush\t{lr}\n\tbl\tfget\n\tpop\t{r1}\n\tbx\tr1\n', 'float', 'return fget();'],
    [
      'converted',
      '\tpush\t{r4, lr}\n\tldr\tr4, .L3\n\tbl\tfget\n\tbl\t__fixsfsi\n\tstr\tr0, [r4]\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n.L3:\n\t.word\tgS\n',
      undefined,
      'gS = (s32)fget();',
    ],
    ['unread', '\tpush\t{lr}\n\tbl\tfget\n\tbl\tg\n\tpop\t{r0}\n\tbx\tr0\n', undefined, 'fget();\n    g();'],
  ])('%s, it lifts as that float', (_, body, returns, line) => {
    const own = returns === undefined ? { returnsVoid: true } : { returns };
    const prototypes: Prototypes = { ...FGET, g: { params: [], returnsVoid: true }, f: { params: [], ...own } };
    expect(lift('f', body, prototypes)).toContain(line);
  });

  // A float handed to `ret` makes the function's return a float, so a second `ret` of an integer
  // word would be converted there: `return 5;` compiles to the bits of 5.0f where the asm hands
  // back the word 5. agbcc shares one epilogue, so only hand-written asm has two.
  test.each([
    ['a declared float return', 'fget', FGET],
    ['a kept helper', '__addsf3', {}],
  ])('%s returned beside an integer return declines', (_, callee, prototypes: Prototypes) => {
    const body =
      `\tpush\t{lr}\n\tcmp\tr2, #0\n\tbeq\t.L2\n\tbl\t${callee}\n\tpop\t{r1}\n\tbx\tr1\n` +
      '.L2:\n\tmov\tr0, #0x5\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => lift('f', body, prototypes)).toThrow('another return of this function hands back an integer word');
  });

  // A double is two words and the frontend reads one of them, which is not the value.
  test('a declared double read off one word declines', () => {
    expect(() =>
      lift('f', STORE_WORD.replace('fget', 'dget'), {
        dget: { params: [], returns: 'double' },
        f: { params: [], returnsVoid: true },
      }),
    ).toThrow("'dget' is declared to return double, which this target hands back as bits in a general register");
  });
});
