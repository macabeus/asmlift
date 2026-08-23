// FLIP-JOIN GATE: which functions still owe the `/flip-join` enumeration. The joined-if sense is
// the layout's by default, so the axis is enumerated only where the polarity the structurer reads
// could have been moved out from under it — a short-circuit fold choosing the orientation, or a
// branch-range trampoline on the fall-through edge (structure/joinsense.ts). Everywhere else the
// flipped spelling is pruned, which is what makes the gate a claim rather than a saving.
// Toolchain-free.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { lift } from '../src/frontend/thumb';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { raiseRecovered, structureChecked } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import { hasAmbiguousJoinedSense } from '../src/structure/joinsense';
import { ARMV4T_AGBCC, structureOptionsFor } from '../src/target';

const P = { f: { returnsVoid: true } };
const wrap = (body: string) => `f:\n\tpush\t{lr}\n${body}\tpop\t{r1}\n\tbx\tlr\n`;
const labels = (body: string) =>
  enumerateCandidates('f', wrap(body), ARMV4T_AGBCC, { prototypes: P }).map((c) => c.label);

// A two-armed joined `if` with nothing between the asm's branch and the structurer's reading of
// it: one `cmp`, a short conditional, both arms storing, reconverging on the tail.
const PLAIN =
  '\tcmp\tr0, #0\n\tbeq\t.L2\n\tmov\tr2, #1\n\tstr\tr2, [r1]\n\tb\t.L3\n' +
  '.L2:\n\tmov\tr2, #2\n\tstr\tr2, [r1]\n.L3:\n\tmov\tr0, #0\n';
// The same shape guarded by `a && b` — two tests sharing the else block, which the fold rewrites
// into one `cond_br` over a connective whose orientation IT chose.
const FOLDED =
  '\tcmp\tr0, #0\n\tbeq\t.L2\n\tcmp\tr1, #0\n\tbeq\t.L2\n\tmov\tr3, #1\n\tstr\tr3, [r2]\n\tb\t.L3\n' +
  '.L2:\n\tmov\tr3, #2\n\tstr\tr3, [r2]\n.L3:\n\tmov\tr0, #0\n';
// The same shape as PLAIN, past a Thumb conditional branch's ±256-byte reach: agbcc inverts the
// test and leaves the real branch on a relay behind it, so `taken` is now the THEN arm.
const TRAMPOLINE =
  '\tcmp\tr0, #0\n\tbne\t.LCB0\n\tb\t.L2\n.LCB0:\n\tmov\tr2, #1\n\tstr\tr2, [r1]\n\tb\t.L3\n' +
  '.L2:\n\tmov\tr2, #2\n\tstr\tr2, [r1]\n.L3:\n\tmov\tr0, #0\n';

describe('FLIP-JOIN GATE: the axis is enumerated only where the sense is still ambiguous', () => {
  test('a plain joined if emits ONE sense — and the pruned one was a distinct spelling', () => {
    expect(labels(PLAIN).some((l) => l.includes('/flip-join'))).toBe(false);
    // Not the dedup doing the work: structuring the same fn both ways gives two different sources,
    // so what the gate removed is a candidate the differ could have picked.
    const fn = lift('f', wrap(PLAIN), ARMV4T_AGBCC, P);
    raiseRecovered(fn, ARMV4T_AGBCC);
    const spell = (negateJoinedBranchSense: boolean) =>
      cBackend.emit(structureChecked(fn, { ...structureOptionsFor(ARMV4T_AGBCC, true), negateJoinedBranchSense }));
    expect(spell(true)).not.toBe(spell(false));
  });

  test('a FOLDED short-circuit keeps it — the fold picked the orientation, not the compiler', () => {
    expect(labels(FOLDED).some((l) => l.includes('/flip-join'))).toBe(true);
  });

  test('an EMPTY fall-through keeps it — the branch that reached its target was the inverted one', () => {
    expect(labels(TRAMPOLINE).some((l) => l.includes('/flip-join'))).toBe(true);
  });

  test('…and a rotated loop wears the same shape, where no source `if` exists to be faithful to', () => {
    // agbcc's `for` → `do…while` rotation guards the body with a zero-trip test whose fall edge is
    // the preheader, and the preheader's copies fold away into the loop's own values.
    // `synthetic:fib`, verbatim from agbcc -O2, is that row.
    const ROTATED =
      'fib:\n\tpush\t{lr}\n\tmov\tr3, #0x0\n\tmov\tr2, #0x1\n\tcmp\tr3, r0\n\tbge\t.L4\t@cond_branch\n' +
      '\tadd\tr1, r0, #0\n.L6:\n\tadd\tr0, r3, r2\n\tadd\tr3, r2, #0\n\tadd\tr2, r0, #0\n' +
      '\tsub\tr1, r1, #0x1\n\tcmp\tr1, #0\n\tbne\t.L6\t@cond_branch\n' +
      '.L4:\n\tadd\tr0, r3, #0\n\tpop\t{r1}\n\tbx\tr1\n';
    const cs = enumerateCandidates('fib', ROTATED, ARMV4T_AGBCC, {});
    expect(cs.some((c) => c.label.includes('/flip-join'))).toBe(true);
  });
});

// The gate reads the IR directly, so the three readings are pinned on the IR too — the trampoline
// arm has no benchmark row behind it (no corpus function reaches Thumb's range on a fold-free if),
// and a mechanism with no row is exactly the one a corpus sweep cannot re-derive.
const IR = (entry: string, rest: string) => parse(`fn f {\n^bb0(%0: s32, %1: s32*):\n${entry}${rest}}\n`);
const ARMS = `^bb1():
  %8: s32 = const {value=1}
  store %1, %8 {off=0, width=4}
  br ^bb3()
^bb2():
  %9: s32 = const {value=2}
  store %1, %9 {off=0, width=4}
  br ^bb3()
^bb3():
  ret %0
`;

describe('FLIP-JOIN GATE: hasAmbiguousJoinedSense reads the two mechanisms off the IR', () => {
  test('a bare comparison feeding the branch is NOT ambiguous', () => {
    const fn = IR('  %2: s32 = const {value=0}\n  %3: u32 = icmp_sgt %0, %2\n  cond_br %3, ^bb1(), ^bb2()\n', ARMS);
    verify(fn);
    expect(hasAmbiguousJoinedSense(fn)).toBe(false);
  });

  test('a folded connective IS — either half of the fold', () => {
    for (const connective of ['logic_and', 'logic_or']) {
      const fn = IR(
        `  %2: s32 = const {value=0}\n  %3: u32 = icmp_sgt %0, %2\n  %4: u32 = icmp_slt %0, %2\n` +
          `  %5: u32 = ${connective} %3, %4\n  cond_br %5, ^bb1(), ^bb2()\n`,
        ARMS,
      );
      verify(fn);
      expect(hasAmbiguousJoinedSense(fn)).toBe(true);
    }
  });

  test('an empty block on the FALL edge IS — and on the taken edge is not the shape', () => {
    // `relayed` is the arm reached through the lone `br`; the other keeps its direct edge.
    const relay = (taken: string, fall: string, relayed: string) =>
      IR(
        `  %2: s32 = const {value=0}\n  %3: u32 = icmp_sgt %0, %2\n  cond_br %3, ^${taken}(), ^${fall}()\n`,
        `^bb4():\n  br ^${relayed}()\n${ARMS}`,
      );
    const onFall = relay('bb1', 'bb4', 'bb2');
    verify(onFall);
    expect(hasAmbiguousJoinedSense(onFall)).toBe(true);
    // The inverted branch is the one that still REACHES, so a relay can only ever sit on the edge
    // the unconditional branch took over — never on the conditional's own target.
    const onTaken = relay('bb4', 'bb2', 'bb1');
    verify(onTaken);
    expect(hasAmbiguousJoinedSense(onTaken)).toBe(false);
  });
});
