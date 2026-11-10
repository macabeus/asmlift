// Thumb frontend: `cmn` as a compare against the negation.
import { describe, expect, test } from 'vitest';

import { dc } from './helpers';

// `cmn rA, rB` IS `cmp rA, -rB` FOR EVERY FLAG BUT ONE. agbcc's `cmnsi` (thumb.md:823-827) is
// `(compare rA (neg rB))`: combine folds the `neg` of `a == -b`, `a <= -b` and `a + b == 0` into
// the compare. N and Z come from the same 32-bit result either way, V differs only at
// rB == INT_MIN (where a signed C `-b` is undefined), and C differs at rB == 0: the carry out of
// a + 0 is clear, while `cmp a, #0` sets it. So the equality and signed branches read it as the
// compare, and the unsigned ones refuse — agbcc folds unsigned `a < -b` into `cmn; bcs` anyway,
// which is its miscompile at b == 0, and no C spelling both reproduces that and means it.
describe('`cmn` is a compare against the negation, for every branch but the carry ones', () => {
  const TAIL = '\tmov\tr0, #0\n\tbx\tlr\n.Ltrue:\n\tmov\tr0, #1\n\tbx\tlr\n';
  const ifOf = (src: string) =>
    src
      .split('\n')
      .find((l) => l.trim().startsWith('if ('))
      ?.trim();

  test('the equality and signed branches read it as `cmp rA, -rB`', () => {
    // The fall-through arm leads, so the sense inverts: `bne .Ltrue` structures as `==`.
    expect(ifOf(dc('f', `\tcmn\tr0, r1\n\tbne\t.Ltrue\n${TAIL}`).source)).toBe('if (a0 == -a1) {');
    expect(ifOf(dc('f', `\tcmn\tr0, r1\n\tbeq\t.Ltrue\n${TAIL}`).source)).toBe('if (a0 != -a1) {');
    expect(ifOf(dc('f', `\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}`).source)).toBe('if (a0 <= -a1) {');
    expect(ifOf(dc('f', `\tcmn\tr0, r1\n\tble\t.Ltrue\n${TAIL}`).source)).toBe('if (a0 > -a1) {');
    expect(ifOf(dc('f', `\tcmn\tr0, r1\n\tblt\t.Ltrue\n${TAIL}`).source)).toBe('if (a0 >= -a1) {');
    expect(ifOf(dc('f', `\tcmn\tr0, r1\n\tbge\t.Ltrue\n${TAIL}`).source)).toBe('if (a0 < -a1) {');
  });

  test('a `cmn` replaces the compare before it, as a `cmp` would', () => {
    expect(ifOf(dc('f', `\tcmp\tr0, r1\n\tcmn\tr2, r3\n\tbge\t.Ltrue\n${TAIL}`).source)).toBe('if (a2 < -a3) {');
    // …and arithmetic after it retires it, as it retires a `cmp`.
    expect(() => dc('gone', `\tcmn\tr0, r1\n\tadd\tr2, r2, #1\n\tbge\t.Ltrue\n${TAIL}`)).toThrow(
      "the flags it tests were written by 'add' in 'gone', over the compare that reached it",
    );
  });

  test('a carry branch refuses with its own sentence, here and across an edge', () => {
    const sentence = (br: string) =>
      `conditional branch '${br}' tests the carry of a 'cmn', and the carry out of a + b is not a >=u -b`;
    for (const br of ['bcs', 'bhs', 'bcc', 'blo', 'bhi', 'bls']) {
      expect(() => dc('f', `\tcmn\tr0, r1\n\t${br}\t.Ltrue\n${TAIL}`)).toThrow(sentence(br));
    }
    // The tag travels with the compare `inheritFlags` carries, or the far side would fold it.
    expect(() => dc('f', `\tcmn\tr0, r1\n\tb\t.L2\n.L2:\n\tbcs\t.Ltrue\n${TAIL}`)).toThrow(sentence('bcs'));
    expect(ifOf(dc('f', `\tcmn\tr0, r1\n\tb\t.L2\n.L2:\n\tbgt\t.Ltrue\n${TAIL}`).source)).toBe('if (a0 <= -a1) {');
    // A `cmp` carried the same way keeps its unsigned branch: the refusal is the `cmn`'s alone.
    expect(ifOf(dc('f', `\tcmp\tr0, r1\n\tb\t.L2\n.L2:\n\tbcs\t.Ltrue\n${TAIL}`).source)).toBe('if (a0 < a1) {');
  });

  test('the negation is a SIGNED one, never `(s32)-` over an unsigned word', () => {
    // r1 is unsigned here (the `bhi` types it), and spans 0x80000000. There `cmn` compares a0
    // against +2^31, so `bgt` is never taken, while `a0 <= (s32)-a1` reads `-a1` as INT_MIN and
    // is false for every a0 but INT_MIN: wrong C. `-(s32)a1` is undefined at that one input and
    // exact at every other.
    const src = dc('f', `\tcmp\tr1, r2\n\tbhi\t.Ltrue\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}`).source;
    expect(src).toContain('a0 <= -(s32)a1');
    expect(src).not.toContain('(s32)-');
    // …and only a SIGNED branch needs it: `beq`/`bne` read the wrapped sum, which the plain
    // wrapping negation spells (undefined only for an `s32` operand at INT_MIN, as any `neg` is).
    expect(dc('f', `\tcmp\tr1, r2\n\tbhi\t.Ltrue\n\tcmn\tr0, r1\n\tbne\t.Ltrue\n${TAIL}`).source).not.toContain(
      '-(s32)',
    );
    // A shift by a register is unsigned however the value under it is typed.
    expect(ifOf(dc('f', `\tlsr\tr1, r1, r2\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}`).source)).toBe(
      'if (a0 <= -(s32)((u32)a1 >> a2)) {',
    );
    // A halfword promotes to a signed int on its own: no cast (cmn_field's `-gMag`).
    expect(ifOf(dc('f', `\tldrh\tr1, [r1]\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}`).source)).toBe('if (a0 <= -*a1) {');
    // So do a literal that fits an int and a signed sum: one rule (`renderedIntSignedness`) with
    // the signed compare's own operand pin.
    expect(ifOf(dc('f', `\tmov\tr1, #5\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}`).source)).toBe('if (a0 <= -5) {');
    expect(ifOf(dc('f', `\tadd\tr1, r1, r2\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}`).source)).toBe(
      'if (a0 <= -(a1 + a2)) {',
    );
    // A plain `neg` WRAPS on the machine, so `(s32)-` is its exact spelling and stays.
    expect(
      dc('f', `\tneg\tr1, r1\n\tcmp\tr1, r2\n\tbhi\t.Ltrue\n\tcmp\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}`).source,
    ).not.toContain('-(s32)');
  });

  test('a signed branch over the CONSTANT INT_MIN refuses: its one undefined input is every input', () => {
    // a0 + (-2^31) is never > 0, so `bgt` is never taken; `a0 <= -(s32)0x80000000` folds the
    // negation back to INT_MIN and is false for every a0 but INT_MIN. agbcc folds the negation of
    // a constant, so only hand-written asm reaches it — as a pool word or as a shifted `mov`.
    const gap = 'the mathematical negation of the constant 0x80000000 has no int spelling';
    expect(() => dc('f', `\tldr\tr1, .Lk\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}.Lk: .word 0x80000000\n`)).toThrow(gap);
    expect(() => dc('f', `\tmov\tr1, #1\n\tlsl\tr1, r1, #31\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}`)).toThrow(gap);
    // …across the edge between the `cmn` and its branch too: the negation is minted where it is read.
    expect(() =>
      dc('f', `\tmov\tr1, #128\n\tlsl\tr1, r1, #24\n\tcmn\tr0, r1\n\tb\t.L2\n.L2:\n\tbgt\t.Ltrue\n${TAIL}`),
    ).toThrow(gap);
    // One past it negates to INT_MAX, which an int spells.
    expect(ifOf(dc('f', `\tldr\tr1, .Lk\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}.Lk: .word 0x80000001\n`).source)).toBe(
      'if (a0 <= -(s32)2147483649) {',
    );
    // `beq`/`bne` read the wrapped sum, which the wrapping negation of the same constant spells.
    expect(() => dc('f', `\tmov\tr1, #1\n\tlsl\tr1, r1, #31\n\tcmn\tr0, r1\n\tbne\t.Ltrue\n${TAIL}`)).not.toThrow();
  });

  test('"always INT_MIN" is what a compiler can fold, not which opcodes built it', () => {
    // Each of these holds 0x80000000 on every call, and agbcc recompiles the lifted C of each to
    // `cmp r0, INT_MIN; ble`: true for every a0 but INT_MIN, where the machine never branches.
    const gap = 'the mathematical negation of the constant 0x80000000 has no int spelling';
    const top = '\tmov\tr1, #1\n\tlsl\tr1, r1, #31\n';
    const bodies = [
      `\tldr\tr1, .Lk\n\tsub\tr1, r1, #1\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}.Lk: .word 0x80000001\n`,
      `${top}\tadd\tr1, #0\n\tcmn\tr0, r1\n\tble\t.Ltrue\n${TAIL}`,
      `${top}\tmov\tr2, #0\n\torr\tr1, r2\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tmov\tr2, #0\n\teor\tr1, r2\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}`,
      // An annihilated variable: a1 & 0 is 0 whatever a1 is.
      `\tmov\tr2, #0\n\tand\tr1, r2\n\tmov\tr2, #1\n\tlsl\tr2, r2, #31\n\torr\tr1, r2\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}`,
      // A block param both arms of a diamond set to the pool word.
      `\tcmp\tr2, #0\n\tbeq\t.La\n\tldr\tr1, .Lk\n\tb\t.Lj\n.La:\n\tldr\tr1, .Lk\n.Lj:\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n${TAIL}.Lk: .word 0x80000000\n`,
      // A reload of a store nothing can have overwritten: agbcc forwards the store, through a
      // pointer, a global (one pool word or two), or across an edge that is the only way in.
      `${top}\tstr\tr1, [r3]\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tldr\tr3, .Lg\n\tstr\tr1, [r3, #4]\n\tldr\tr2, [r3, #4]\n\tcmn\tr0, r2\n\tble\t.Ltrue\n${TAIL}.Lg: .word gX\n`,
      `${top}\tldr\tr3, .Lg\n\tstr\tr1, [r3]\n\tldr\tr3, .Lh\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tble\t.Ltrue\n${TAIL}.Lg: .word gX\n.Lh: .word gX\n`,
      `${top}\tstr\tr1, [r3]\n\tb\t.L2\n.L2:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      // …however the address is spelled: a base held in another register, an addend in the pool word.
      `${top}\tstr\tr1, [r3, #4]\n\tadd\tr2, r3, #4\n\tldr\tr2, [r2]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tldr\tr2, .Lh\n\tstr\tr1, [r2]\n\tldr\tr3, .Lg\n\tldr\tr2, [r3, #4]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}.Lg: .word gX\n.Lh: .word gX+4\n`,
      // …and over every path in: both arms of a diamond store it (one value, or two), or a store
      // before a loop that writes nothing reaches the reload in its header.
      `${top}\tcmp\tr2, #0\n\tbeq\t.La\n\tstr\tr1, [r3]\n\tb\t.Lj\n.La:\n\tstr\tr1, [r3]\n.Lj:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tcmp\tr2, #0\n\tbeq\t.La\n\tstr\tr1, [r3]\n\tb\t.Lj\n.La:\n\tmov\tr4, #1\n\tlsl\tr4, r4, #31\n\tstr\tr4, [r3]\n.Lj:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tstr\tr1, [r3]\n\tmov\tr4, #0\n.Ll:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n\tadd\tr4, #1\n\tcmp\tr4, #9\n\tbne\t.Ll\n${TAIL}`,
      // …and round a loop that stores the reload back: directly, through a second reload, across
      // two cells that swap, or in agbcc's rotated layout. The memory is a loop-carried param.
      `${top}\tstr\tr1, [r3]\n\tmov\tr4, #0\n.Ll:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n\tstr\tr2, [r3]\n\tadd\tr4, #1\n\tcmp\tr4, #9\n\tbne\t.Ll\n${TAIL}`,
      `${top}\tstr\tr1, [r3]\n\tmov\tr4, #0\n.Ll:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n\tldr\tr5, [r3]\n\tstr\tr5, [r3]\n\tadd\tr4, #1\n\tcmp\tr4, #9\n\tbne\t.Ll\n${TAIL}`,
      `${top}\tstr\tr1, [r3]\n\tstr\tr1, [r3, #4]\n\tmov\tr4, #0\n.Ll:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n\tldr\tr5, [r3, #4]\n\tstr\tr5, [r3]\n\tldr\tr5, [r3]\n\tstr\tr5, [r3, #4]\n\tadd\tr4, #1\n\tcmp\tr4, #9\n\tbne\t.Ll\n${TAIL}`,
      `${top}\tstr\tr1, [r3]\n\tmov\tr4, #0\n\tb\t.Lt\n.Lb:\n\tstr\tr2, [r3]\n\tadd\tr4, #1\n.Lt:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n\tcmp\tr4, #9\n\tble\t.Lb\n${TAIL}`,
      // A reload every path reaches only past a write that may land on its cell, when which word
      // that left cannot be said: a register-indexed address (the array pass's `astore`/`aload`
      // too), one sum spelled in two orders, narrow stores that compose the word, or a store
      // through another pointer — which, whenever the two pointers differ, leaves INT_MIN.
      `${top}\tstr\tr1, [r3, r4]\n\tldr\tr2, [r3, r4]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tlsl\tr4, r4, #2\n\tstr\tr1, [r3, r4]\n\tldr\tr2, [r3, r4]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tadd\tr5, r3, r4\n\tstr\tr1, [r5]\n\tadd\tr6, r4, r3\n\tldr\tr2, [r6]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tstr\tr1, [r3]\n\tmov\tr4, #0\n\tstrb\tr4, [r3]\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `\tmov\tr1, #128\n\tlsl\tr1, r1, #8\n\tstrh\tr1, [r3, #2]\n\tmov\tr1, #0\n\tstrh\tr1, [r3]\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tstr\tr1, [r3]\n\tstr\tr0, [r2]\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      // A block nothing reaches is no path in, whatever it falls into: neither the way in that
      // wrote nothing nor an edge that empties the forwarded memory.
      `${top}\tstr\tr1, [r3]\n\tstr\tr1, [r5]\n\tb\t.Lq\n.Ldead:\n\tmov\tr4, #0\n.Lq:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tstr\tr1, [r3]\n\tb\t.Lq\n.Ldead:\n\tmov\tr4, #0\n.Lq:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tstr\tr1, [r3]\n\tmov\tr4, #0\n.Lh:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n\tadd\tr4, #1\n\tcmp\tr4, #9\n\tbne\t.Lh\n\tmov\tr0, #0\n\tbx\tlr\n\tb\t.Lh\n.Ltrue:\n\tmov\tr0, #1\n\tbx\tlr\n`,
      // A loop-invariant INT_MIN OR'd with `q & a0`, q a second invariant that is always 0 — in
      // either order the loop reads the two registers.
      ...[
        '\tmov\tr5, r1\n\tmov\tr3, r2\n\tand\tr3, r0\n\torr\tr5, r3\n\tmov\tr1, r5\n\torr\tr2, r2\n',
        '\torr\tr2, r2\n\tmov\tr5, r1\n\tmov\tr3, r2\n\tand\tr3, r0\n\torr\tr5, r3\n\tmov\tr1, r5\n',
      ].map(
        (body) =>
          `\tldr\tr1, .Lk\n\tmov\tr2, #0\n\tmov\tr4, #0\n.Ll:\n${body}\tcmn\tr0, r1\n\tbgt\t.Ltrue\n\tadd\tr4, #1\n\tcmp\tr4, #9\n\tbne\t.Ll\n${TAIL}.Lk: .word 0x80000000\n`,
      ),
    ];
    // r4-r6 are callee-saved, so a body that uses them saves them
    const saving = (body: string) =>
      `\tpush\t{r4, r5, r6}\n${body.replaceAll('\tbx\tlr\n', '\tpop\t{r4, r5, r6}\n\tbx\tlr\n')}`;
    for (const body of bodies) {
      expect(() => dc('f', saving(body))).toThrow(gap);
    }
    // A reload of a store of 5 lifts.
    expect(
      ifOf(dc('f', `\tmov\tr1, #5\n\tstr\tr1, [r3]\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`).source),
    ).toBe('if (a0 <= -*a3) {');
    // A store on one arm only, another word on the other arm, a different cell, or a loop body
    // that writes the cell: INT_MIN on some paths only, which lifts.
    for (const body of [
      `${top}\tcmp\tr2, #0\n\tbeq\t.Lj\n\tstr\tr1, [r3]\n.Lj:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tmov\tr4, #5\n\tcmp\tr2, #0\n\tbeq\t.La\n\tstr\tr1, [r3]\n\tb\t.Lj\n.La:\n\tstr\tr4, [r3]\n.Lj:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tstr\tr1, [r3, #4]\n\tadd\tr2, r3, #8\n\tldr\tr2, [r2]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}`,
      `${top}\tstr\tr1, [r3]\n\tmov\tr4, #0\n.Ll:\n\tldr\tr2, [r3]\n\tcmn\tr0, r2\n\tbgt\t.Ltrue\n\tstr\tr4, [r3]\n\tadd\tr4, #1\n\tcmp\tr4, #9\n\tbne\t.Ll\n${TAIL}`,
    ]) {
      expect(dc('f', saving(body)).source).toContain('<= -');
    }
    // A loop counter that starts at a constant varies, and lifts.
    expect(
      dc('f', `\tmov\tr1, #0\n.Ll:\n\tcmn\tr0, r1\n\tbgt\t.Ltrue\n\tadd\tr1, #1\n\tcmp\tr1, #9\n\tbne\t.Ll\n${TAIL}`)
        .source,
    ).toContain('a0 <= -v0');
  });

  test('a reload narrower than a word is never INT_MIN, whatever the write before it left', () => {
    // cmn_store's shape (`p->x -= 8; if (p->x <= -gMag)`, u16 gMag): the `strh` through p may land
    // on gMag, so the reload reads a word the evaluator cannot compute — but a zero- or
    // sign-extended halfword or byte is never 0x80000000, so the negation has an int spelling.
    const gap = 'the mathematical negation of the constant 0x80000000 has no int spelling';
    const store = (load: string, br = 'bgt') =>
      `\tldr\tr2, .Lg\n\tstrh\tr1, [r3]\n${load}\tcmn\tr0, r2\n\t${br}\t.Ltrue\n${TAIL}.Lg: .word gMag\n`;
    for (const load of [
      '\tldrh\tr2, [r2]\n',
      '\tldrb\tr2, [r2]\n',
      '\tmov\tr4, #0\n\tldrsh\tr2, [r2, r4]\n',
      '\tmov\tr4, #0\n\tldrsb\tr2, [r2, r4]\n',
    ]) {
      expect(dc('f', store(load)).source).toContain('<= -');
    }
    // The same reload as a whole word may be what the store left there: it still refuses.
    expect(() => dc('f', store('\tldr\tr2, [r2]\n'))).toThrow(gap);
    // A halfword shifted back up to the sign bit is INT_MIN at 0x8000: [0, 0xffff0000] holds it.
    expect(() => dc('f', store('\tldrh\tr2, [r2]\n\tlsl\tr2, r2, #16\n'))).toThrow(gap);
    // Merged by a param (agbcc's `m = c ? gA : gD`, a halfword in one arm, a byte in the other), the
    // bound is the union of the arms'; one whole-word arm leaves the refusal.
    const merged = (left: string, right: string) =>
      `\tldr\tr2, .Lg\n\tstrh\tr1, [r3]\n\tcmp\tr4, #0\n\tbeq\t.Lb\n${left}\tb\t.Lj\n.Lb:\n${right}.Lj:\n` +
      `\tcmn\tr0, r2\n\tbgt\t.Ltrue\n${TAIL}.Lg: .word gMag\n`;
    expect(dc('f', merged('\tldrh\tr2, [r2]\n', '\tldrb\tr2, [r2, #4]\n')).source).toContain('<= -');
    expect(() => dc('f', merged('\tldrh\tr2, [r2]\n', '\tldr\tr2, [r2, #4]\n'))).toThrow(gap);
    // A negative constant arm (agbcc's `v = c ? -2 : gB`) beside a byte reload unions as integers,
    // [-2, 255], not as the word 0xfffffffe beside [0, 255], which would span INT_MIN.
    expect(dc('f', merged('\tmov\tr2, #2\n\tneg\tr2, r2\n', '\tldrb\tr2, [r2, #4]\n')).source).toContain('<= -');
    expect(() => dc('f', merged('\tmov\tr2, #2\n\tneg\tr2, r2\n', '\tldr\tr2, [r2, #4]\n'))).toThrow(gap);
    // A carry branch refuses for its own reason, bound or no bound.
    expect(() => dc('f', store('\tldrh\tr2, [r2]\n', 'bcs'))).toThrow(
      "conditional branch 'bcs' tests the carry of a 'cmn', and the carry out of a + b is not a >=u -b",
    );
  });

  test('switch recovery never reads a guard against the mathematical negation of INT_MIN as a bound', () => {
    // `bgt .Lhi` is never taken (a0 - 2^31 is never > 0), so this always returns 0. Folding the
    // `neg_s` as a wrapping negation would make the guard `a0 > INT_MIN`, true for every case, and
    // the lift a `switch` returning 10 for a0 == 1.
    const arms =
      '\tbgt\t.Lhi\n\tb\t.Ldef\n.Lhi:\n\tcmp\tr0, #1\n\tbeq\t.L1\n\tcmp\tr0, #2\n\tbeq\t.L2\n\tcmp\tr0, #3\n\tbeq\t.L3\n' +
      '\tb\t.Ldef\n.L1:\n\tmov\tr0, #10\n\tbx\tlr\n.L2:\n\tmov\tr0, #20\n\tbx\tlr\n.L3:\n\tmov\tr0, #30\n\tbx\tlr\n' +
      '.Ldef:\n\tmov\tr0, #0\n\tbx\tlr\n';
    expect(() => dc('f', `\tldr\tr1, .Lk\n\tcmn\tr0, r1\n${arms}.Lk: .word 0x80000000\n`)).toThrow(
      'the mathematical negation of the constant 0x80000000 has no int spelling',
    );
    // Against any other constant the guard is the bound it reads as: a0 > -5 holds for every case.
    expect(dc('f', `\tmov\tr1, #5\n\tcmn\tr0, r1\n${arms}`).source).toContain('switch (a0) {');
  });

  test('a `cmn` the parser hands a non-register operand takes the flags unmodelled', () => {
    // Thumb-1 has no such encoding, but the playground's text reaches the decoder unassembled.
    expect(() => dc('f', `\tcmn\tr0, #5\n\tbgt\t.Ltrue\n${TAIL}`)).toThrow(
      "the flags it tests were written by 'cmn' in 'f', and only a register 'cmn' is modelled",
    );
  });
});
