// AN UNDECLARED CALL THAT TAKES STACK ARGUMENTS, sized by its callee's body.
//
// agbcc stages arguments 5+ at [sp,#0] upward, and a call nothing declares declines there, because
// the code alone cannot say where its block ends (stack-args.test.ts). Where the callee's body is in
// the input, or handed in, its body says how many incoming stack words it loads, a lower bound:
// its lift where it lifts, its straight-line entry where it does not (frontend/callee-body.ts
// `CalleeStackWords`, frontend/thumb-entry.ts). A caller that stages exactly that many words on
// every path is then lifted at every argument register and those words (frontend/stackargs.ts,
// "THE CALLEE'S BODY"). The shapes are agbcc's own output: corpus/agbcc-entry-stack.s.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import type { CalleeBodies } from '../src/frontend/callee-body';
import { thumbEntryWordsFromText } from '../src/frontend/thumb-entry';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-entry-stack.s'), 'utf8');
/** One function of the probe, from its label to its `.size` line. */
const fn = (name: string): string => {
  const from = asm.indexOf(`\t.globl\t${name}\n`);
  const to = asm.indexOf(`.size\t ${name},`, from);
  return asm.slice(from, asm.indexOf('\n', to) + 1);
};
const src = (name: string, text: string, calleeBodies?: CalleeBodies, prototypes = {}) =>
  decompile(name, text, ARMV4T_AGBCC, { prototypes, calleeBodies }).source;
/** The decline a lift of `name` throws, or `lifted` where it lifts. */
const decline = (name: string, text: string, calleeBodies?: CalleeBodies, prototypes = {}): string => {
  try {
    src(name, text, calleeBodies, prototypes);
    return 'lifted';
  } catch (e) {
    return (e as Error).message;
  }
};

describe('the callee in the input sizes the call', () => {
  test('five words staged for a callee that loads five: a nine-argument call', () => {
    expect(src('call9', fn('nine') + fn('call9'))).toBe(
      'void call9(s32 *a0) {\n    nine(*a0, a0[1], a0[2], a0[3], a0[4], a0[5], a0[6], a0[7], a0[8]);\n}\n',
    );
  });

  test('…staged anew before the call on every iteration of a loop', () => {
    expect(src('loop9', fn('nine') + fn('loop9'))).toMatch(
      /while \(v0 > 0\) \{\n {8}nine\(\*v1, v1\[1\], v1\[2\], v1\[3\], v1\[4\], v1\[5\], v1\[6\], v1\[7\], v1\[8\]\);/,
    );
  });

  test('a call beside another the body bounds lifts too', () => {
    expect(src('calls5', fn('fifth') + fn('calls5'))).toMatch(/v0 = fifth\(1, 2, 3, a0, a1\);/);
  });

  test('a callee that loads its stack word only on one branch is sized by its lift, not its entry', () => {
    // br5 loads [sp,#4] after `bne`, past the straight-line entry, and lifts with five parameters
    expect(thumbEntryWordsFromText('br5', fn('br5'))).toBeUndefined();
    expect(src('call_br', fn('br5') + fn('call_br'))).toBe(
      'void call_br(s32 *a0) {\n    br5(*a0, a0[1], a0[2], a0[3], a0[4]);\n}\n',
    );
  });

  test('the whole probe as one input: the same answer', () => {
    expect(src('call9', asm)).toBe(src('call9', fn('nine') + fn('call9')));
  });
});

describe('where the body does not size the call, it keeps its decline', () => {
  test('without the callee in the input, nothing sizes the block', () => {
    expect(decline('call9', fn('call9'))).toMatch(/never reloaded and its lower slots are supplied/);
  });

  test('a caller staging more words than the callee loads (K&R) declines, naming both witnesses', () => {
    expect(decline('krmore', fn('kr') + fn('krmore'))).toMatch(
      /reaches `bl kr` unread with its lower slots supplied — it may be that call's outgoing stack argument \(its body loads 1 incoming stack word, \[sp,#0\], but the words staged for it are \[sp,#0\], \[sp,#4\]/,
    );
  });

  test('a caller staging nothing is lifted as before, at the registers it set', () => {
    expect(src('krfewer', fn('kr') + fn('krfewer'))).toBe('s32 krfewer(s32 a0) {\n    return kr(a0, 2, 3, 4);\n}\n');
  });

  test('a callee the input marks `.weak` is one another definition may replace', () => {
    expect(decline('call9', `\t.weak\tnine\n${fn('nine')}${fn('call9')}`)).toMatch(/lower slots are supplied/);
  });

  test('a declaration wins over the body: a stated arity is laid out as stated', () => {
    expect(decline('call9', fn('nine') + fn('call9'), undefined, { nine: { params: 4 } })).toMatch(
      /lower slots are supplied/,
    );
  });

  test('a callee declared to return a struct through memory takes a hidden word the entry cannot see', () => {
    expect(
      decline('call9', fn('nine') + fn('call9'), undefined, {
        nine: {
          returns: 'struct S',
          returnLayout: { kind: 'struct', members: ['a', 'b', 'c'].map((name) => ({ name, type: 'u32' })) },
        },
      }),
    ).toMatch(/returns struct S through a hidden pointer in r0/);
  });
});

describe('a body handed in from outside the input', () => {
  // nine's first halfwords, assembled (thumb-entry.test.ts)
  const NINE = [0xb5f0, 0x9d05, 0x9e06, 0x9f07, 0x4c07, 0x1940, 0x6020, 0x1989, 0x6061, 0x19d2, 0x60a2, 0x9808];
  const NINE_ALL = [...NINE, 0x181b, 0x60e3, 0x9809, 0x6120, 0xbcf0, 0xbc01, 0x4700];

  test('a Thumb body’s halfwords size the call as its text does', () => {
    expect(src('call9', fn('call9'), { nine: { kind: 'thumb', halfwords: NINE_ALL } })).toBe(
      src('call9', fn('nine') + fn('call9')),
    );
  });

  test('…and a prefix that stops short of the last load is a smaller bound, so it declines', () => {
    expect(decline('call9', fn('call9'), { nine: { kind: 'thumb', halfwords: NINE } })).toMatch(
      /its body loads 4 incoming stack words/,
    );
  });

  test('a listing body in the input format is read as the input is', () => {
    expect(src('call9', fn('call9'), { nine: { kind: 'listing', text: fn('nine') } })).toBe(
      src('call9', fn('nine') + fn('call9')),
    );
  });
});
