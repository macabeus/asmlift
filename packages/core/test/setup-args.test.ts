// The `/setup-args` lift variation (rank.ts, frontend/ssa.ts narrowToSetupArgs) — the arity a
// prototype-less call gets when only the CALLING BLOCK's own setup counts. Pins: that the wider
// reading stays the default, that the narrower one is offered beside it, that neither an argument
// the block set up nor a declared arity is the variation's to drop, and that the narrowed lift carries
// the whole re-spelling cross rather than one fixed spelling of itself.
import { describe, expect, test } from 'vitest';

import { hasSetupArgsNarrowing } from '../src/frontend/ssa';
import { lift } from '../src/frontend/thumb';
import { decompile } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';
import { hasVariation, hasVariations } from '../src/variation-tokens';

const P = { f: { returnsVoid: true } };
const fn = (body: string) => `f:\n\tpush\t{lr}\n${body}\tpop\t{r0}\n\tbx\tlr\n`;
const cands = (body: string, pool = '') => enumerateCandidates('f', fn(body) + pool, ARMV4T_AGBCC, { prototypes: P });

// kleod's GameUpdate: a global read for the guard, and a call on the guarded path that sets up
// nothing of its own. Whether the source passed the guarded value is what the two arms disagree on.
const GUARDED_CALL = '\tldr\tr0, .Lp\n\tldrb\tr0, [r0]\n\tcmp\tr0, #0\n\tbne\t.L1\n\tbl\tbar\n.L1:\n';
const POOL = '.Lp:\n\t.word\t0x3000000\n';

describe('a guessed argument that survived from an earlier block', () => {
  test('is passed by default — compiled code really does leave one in place and branch to the call', () => {
    expect(decompile('f', fn(GUARDED_CALL) + POOL, ARMV4T_AGBCC, { prototypes: P }).source).toContain('bar(v0)');
  });

  test('…and is dropped by the `/setup-args` sibling, which is enumerated beside it', () => {
    const cs = cands(GUARDED_CALL, POOL);
    expect(cs.some((c) => c.source.includes('bar(v0)'))).toBe(true);
    expect(cs.some((c) => /bar\(\)/.test(c.source))).toBe(true);
    expect(cs.some((c) => hasVariation(c.variations, 'setup-args'))).toBe(true);
  });

  test('…and inert where the block set up a LATER argument register for the call', () => {
    // `bl __mulsf3; add r1, r4, #0; bl __addsf3` — the block's own `add r1` proves __addsf3 takes
    // arguments, so the product still in r0 is one of them. Calling that dead would be the variation
    // asserting the instruction two above the `bl` is dead code.
    const cs = cands('\tbl\t__mulsf3\n\tadd\tr1, r4, #0\n\tbl\t__addsf3\n');
    expect(cs.every((c) => c.source.includes('__addsf3(__mulsf3(), '))).toBe(true);
    expect(cs.some((c) => hasVariation(c.variations, 'setup-args'))).toBe(false);
  });

  test('the variation is inert where the calling block set every argument up itself', () => {
    // Nothing to disagree about: `mov r0,#1` is this block's own setup, so both readings are 1.
    const body = '\tmov\tr0, #1\n\tbl\tbar\n';
    expect(cands(body).every((c) => c.source.includes('bar(1)'))).toBe(true);
    expect(cands(body).some((c) => hasVariation(c.variations, 'setup-args'))).toBe(false);
    // …and the lift records nothing, so the variation does not re-lift at all. Asserted on the gate and
    // not on the candidate list: the enumeration dedups by SOURCE, so an identical narrowing would
    // vanish there whether or not anything ran.
    expect(hasSetupArgsNarrowing(lift('f', fn(body), ARMV4T_AGBCC, P))).toBe(false);
    expect(hasSetupArgsNarrowing(lift('f', fn(GUARDED_CALL) + POOL, ARMV4T_AGBCC, P))).toBe(true);
  });

  test('…and the narrowed lift carries the re-spelling cross, not one fixed spelling', () => {
    // A lift variation, not a respell variation: dropping an argument changes the IR every
    // structure variation then reads, so the structure variations have to run under it.
    // `kleod:ReadKeyInput` (retired 2026-09-13) matched on `/setup-args/derived-home`, a combination
    // of this variation and a structure variation run beneath it.
    const names = cands(GUARDED_CALL, POOL).map((c) => c.variations);
    expect(names).toContainEqual(['unsigned', 'setup-args']);
    expect(
      names.filter((v) => hasVariations(v.slice(0, 2), ['unsigned', 'setup-args']) && v.length > 2).length,
    ).toBeGreaterThan(0);
    // both kinds of ranked variation run under the narrowing — a respell of the tree
    // (`/livebase`, and its own `/volatile` output) and a structure variation (`/flip-join`)
    expect(names).toContainEqual(['unsigned', 'setup-args', 'livebase']);
    expect(names).toContainEqual(['unsigned', 'setup-args', 'flip-join']);
  });

  test('a DECLARED arity is not the variation’s to narrow', () => {
    // The headers already answered the question the variation exists to ask, so no sibling is offered
    // and the argument survives in every spelling.
    const cs = enumerateCandidates('f', fn(GUARDED_CALL) + POOL, ARMV4T_AGBCC, {
      prototypes: { ...P, bar: { params: 1 } },
    });
    expect(cs.every((c) => c.source.includes('bar(v0)'))).toBe(true);
    expect(cs.some((c) => hasVariation(c.variations, 'setup-args'))).toBe(false);
  });
});

describe('a frame address the narrower reading would cut', () => {
  // agbcc, no prototypes: `int s[2]; ... s[0] = a; s[1] = b; if (gv) g(a, b, s);` behind two early
  // returns that each call. g's block writes r0 and r2 (`mov r2, sp`), but r1 comes from an earlier
  // block, so the run this block set up stops at r1 and would take r2 with it: `g(a0)`, both stores
  // to s dead. The sibling must ask the lowering's frame-address question of what it cuts, as the
  // trim does, and keep g whole; the other calls' narrowings (`f2(a0, a1, a0)` to `f2()`) stand.
  const V1 =
    'v1:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr2, r0, #0\n\tcmp\tr2, #0\n\tbne\t.L3\n\tbl\tf\n' +
    '\tmov\tr0, #0x1\n\tb\t.L6\n.L3:\n\tcmp\tr1, #0\n\tbne\t.L4\n\tbl\tf2\n\tmov\tr0, #0x2\n\tb\t.L6\n' +
    '.L4:\n\tstr\tr2, [sp]\n\tstr\tr1, [sp, #0x4]\n\tldr\tr0, .L7\n\tldr\tr0, [r0]\n\tcmp\tr0, #0\n' +
    '\tbeq\t.L5\n\tadd\tr0, r2, #0\n\tmov\tr2, sp\n\tbl\tg\n.L5:\n\tmov\tr0, #0x0\n.L6:\n' +
    '\tadd\tsp, sp, #0x8\n\tpop\t{r1}\n\tbx\tr1\n.L7:\n\t.word\tgv\n';

  test('is kept in every candidate, the `/setup-args` ones included', () => {
    const cs = enumerateCandidates('v1', V1, ARMV4T_AGBCC);
    const narrowed = cs.filter((c) => hasVariation(c.variations, 'setup-args'));
    expect(narrowed.length).toBeGreaterThan(0);
    expect(narrowed.some((c) => /\bf2\(\)/.test(c.source))).toBe(true);
    expect(cs.every((c) => /\bg\(a0, a1, sp0\)/.test(c.source))).toBe(true);
  });
});

describe('a frame address an earlier block left in a register the narrower reading cuts', () => {
  // agbcc, no prototypes: `int s[3]; char t[16]; s[0] = a; s[1] = b; t[0] = a; t[1] = b; t[2] = 0;
  // if (a) g(b, s, t);`. The entry block leaves `&t` in r2 (`add r2, sp, #0xc`); g's block writes
  // only r0 and r1 (`mov r1, sp`). The frame audit sizes one object over s and t (`sp+0` escapes),
  // but the compiler formed an address at 12, so t is an object of its own, and nothing reads it but
  // g: cutting r2 as a dead leftover would lift `g(a1, sp0)` with the stores to t unread.
  const ESCAPE =
    'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x1c\n\tadd\tr3, r1, #0\n\tstr\tr0, [sp]\n\tstr\tr3, [sp, #0x4]\n' +
    '\tadd\tr2, sp, #0xc\n\tmov\tr1, #0x0\n\tstrb\tr0, [r2]\n\tstrb\tr3, [r2, #0x1]\n\tstrb\tr1, [r2, #0x2]\n' +
    '\tcmp\tr0, #0\n\tbeq\t.L3\n\tadd\tr0, r3, #0\n\tmov\tr1, sp\n\tbl\tg\n.L3:\n\tadd\tsp, sp, #0x1c\n\tpop\t{r0}\n\tbx\tr0\n';

  test('is kept in every candidate where the object has no other reader (one object behind an escape)', () => {
    const cs = enumerateCandidates('f', ESCAPE, ARMV4T_AGBCC);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((c) => /\bg\(a1, sp0, \(u32\)sp0 \+ 12, a1\)/.test(c.source))).toBe(true);
  });

  // `char s[4]; s[0] = a; s[1] = b; s[2] = 0; s[3] = 0; if (a) g(b, s);` — no escape: `&s` is the
  // entry block's store base, left in r1, and g's block writes only r0.
  test('is kept in every candidate where the object has no other reader (a store base)', () => {
    const base =
      'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr3, r1, #0\n\tmov\tr1, sp\n\tmov\tr2, #0x0\n' +
      '\tstrb\tr0, [r1]\n\tstrb\tr3, [r1, #0x1]\n\tstrb\tr2, [r1, #0x2]\n\tstrb\tr2, [r1, #0x3]\n\tcmp\tr0, #0\n' +
      '\tbeq\t.L3\n\tadd\tr0, r3, #0\n\tbl\tg\n.L3:\n\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n';
    const cs = enumerateCandidates('f', base, ARMV4T_AGBCC);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((c) => /\bg\(a1, sp0, 0, a1\)/.test(c.source))).toBe(true);
  });

  // `void f(int a, int b, int c, int n, int e) { char w[8]; w[0] = b; w[1] = 0; if (a) g(n, w, e); }`
  // — the call's block reads the fifth argument off the incoming stack (`ldr r2, [sp, #0x10]`), and
  // `&w` is the entry block's store base, left in r1.
  test('is kept in every candidate where the object has no other reader (beside an incoming stack argument)', () => {
    const stackArg =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r3, #0\n\tmov\tr2, sp\n\tmov\tr3, #0x0\n' +
      '\tstrb\tr1, [r2]\n\tmov\tr1, sp\n\tstrb\tr3, [r1, #0x1]\n\tcmp\tr0, #0\n\tbeq\t.L3\n\tadd\tr0, r4, #0\n' +
      '\tldr\tr2, [sp, #0x10]\n\tbl\tg\n.L3:\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
    const cs = enumerateCandidates('f', stackArg, ARMV4T_AGBCC);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((c) => /\bg\(a3, sp0, a4, 0\)/.test(c.source))).toBe(true);
  });

  // `void f(int a, int b, int *q, int n, int e) { char w[8]; w[0] = b; w[1] = 0; if (a) g(n, w, e);
  // else *q = w[0]; }` — as above, but w IS read elsewhere, so the lifted IR cannot tell `&w` in r1
  // from a dead store base. The function lifts only by reading an incoming stack argument outside
  // the entry block, and no `/setup-args` reading is offered there at all.
  test('is kept in every candidate beside an incoming stack argument even where the object is read elsewhere', () => {
    const readElsewhere = [
      'f:',
      '\tpush\t{r4, r5, lr}',
      '\tadd\tsp, sp, #-0x8',
      '\tadd\tr5, r2, #0',
      '\tadd\tr4, r3, #0',
      '\tmov\tr2, sp',
      '\tmov\tr3, #0x0',
      '\tstrb\tr1, [r2]',
      '\tmov\tr1, sp',
      '\tstrb\tr3, [r1, #0x1]',
      '\tcmp\tr0, #0',
      '\tbeq\t.L3',
      '\tadd\tr0, r4, #0',
      '\tldr\tr2, [sp, #0x14]',
      '\tbl\tg',
      '\tb\t.L4',
      '.L3:',
      '\tmov\tr0, sp',
      '\tldrb\tr0, [r0]',
      '\tstr\tr0, [r5]',
      '.L4:',
      '\tadd\tsp, sp, #0x8',
      '\tpop\t{r4, r5}',
      '\tpop\t{r0}',
      '\tbx\tr0',
      '',
    ].join('\n');
    const cs = enumerateCandidates('f', readElsewhere, ARMV4T_AGBCC);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.some((c) => hasVariation(c.variations, 'setup-args'))).toBe(false);
    expect(cs.every((c) => /\bg\(a3, sp0, a4, 0\)/.test(c.source))).toBe(true);
  });

  // `void f(int a, int b, int *q, int n) { char w[8]; char u[8]; u[0] = n; u[1] = b; w[0] = b;
  // w[1] = 0; if (a) g(n, w); else *q = u[1]; }` — the lift folds `add r4, sp, #0x8` into the
  // accesses through r4 (one `laddr` at 0, then offsets 8 and 9), so u starts where something is
  // accessed, not where an address is formed. The read of u[1] reads u, not the w the cut leaves.
  test('is kept in every candidate where the other object starts at an offset only an access names', () => {
    const folded = [
      'f:',
      '\tpush\t{r4, r5, r6, lr}',
      '\tadd\tsp, sp, #-0x10',
      '\tadd\tr6, r2, #0',
      '\tadd\tr5, r3, #0',
      '\tadd\tr4, sp, #0x8',
      '\tmov\tr3, #0x0',
      '\tstrb\tr5, [r4]',
      '\tstrb\tr1, [r4, #0x1]',
      '\tmov\tr2, sp',
      '\tstrb\tr1, [r2]',
      '\tmov\tr1, sp',
      '\tstrb\tr3, [r1, #0x1]',
      '\tcmp\tr0, #0',
      '\tbeq\t.L3',
      '\tadd\tr0, r5, #0',
      '\tbl\tg',
      '\tb\t.L4',
      '.L3:',
      '\tldrb\tr0, [r4, #0x1]',
      '\tstr\tr0, [r6]',
      '.L4:',
      '\tadd\tsp, sp, #0x10',
      '\tpop\t{r4, r5, r6}',
      '\tpop\t{r0}',
      '\tbx\tr0',
      '',
    ].join('\n');
    const cs = enumerateCandidates('f', folded, ARMV4T_AGBCC);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((c) => /\bg\(a3, sp0, sp0, 0\)/.test(c.source))).toBe(true);
  });

  // `int f(int a, int b, int c) { int s[3]; char t[16]; ...; if (a) g(b, s, t); return
  // ((char *)s)[c]; }` — the escape case above plus a read of s at a runtime index. An index stays
  // in the object its base addresses, so it reads s, not the t the cut leaves.
  test('is kept in every candidate where an indexed read of another object follows (one object behind an escape)', () => {
    const indexed = [
      'f:',
      '\tpush\t{r4, lr}',
      '\tadd\tsp, sp, #-0x1c',
      '\tadd\tr3, r1, #0',
      '\tadd\tr4, r2, #0',
      '\tstr\tr0, [sp]',
      '\tstr\tr3, [sp, #0x4]',
      '\tadd\tr2, sp, #0xc',
      '\tmov\tr1, #0x0',
      '\tstrb\tr0, [r2]',
      '\tstrb\tr3, [r2, #0x1]',
      '\tstrb\tr1, [r2, #0x2]',
      '\tcmp\tr0, #0',
      '\tbeq\t.L3',
      '\tadd\tr0, r3, #0',
      '\tmov\tr1, sp',
      '\tbl\tg',
      '.L3:',
      '\tmov\tr1, sp',
      '\tadd\tr0, r1, r4',
      '\tldrb\tr0, [r0]',
      '\tadd\tsp, sp, #0x1c',
      '\tpop\t{r4}',
      '\tpop\t{r1}',
      '\tbx\tr1',
      '',
    ].join('\n');
    const cs = enumerateCandidates('f', indexed, ARMV4T_AGBCC);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((c) => /\bg\(a1, sp0, \(u32\)sp0 \+ 12, a1\)/.test(c.source))).toBe(true);
  });

  // `void f(int a, int b) { int s[3]; char t[16]; s[0] = a; s[1] = b; t[0] = a; t[1] = b; t[2] = 0;
  // if (a) g(a, s, 0, X); }` — the escape case, where the leftover r2 is no frame address but the
  // `mov r2, #0` the entry block stored into t[2], reused as the third argument; X is 0 (rematerialized
  // as `mov r3, #0`) or s again (`mov r3, sp`, beside the passed `mov r1, sp` at the same offset). The
  // escape verdict read every argument register as handed over, so no `/setup-args` reading is offered.
  const reused = (r3: string): string =>
    [
      'f:',
      '\tpush\t{lr}',
      '\tadd\tsp, sp, #-0x1c',
      '\tadd\tr3, r0, #0',
      '\tstr\tr3, [sp]',
      '\tstr\tr1, [sp, #0x4]',
      '\tadd\tr0, sp, #0xc',
      '\tmov\tr2, #0x0',
      '\tstrb\tr3, [r0]',
      '\tstrb\tr1, [r0, #0x1]',
      '\tstrb\tr2, [r0, #0x2]',
      '\tcmp\tr3, #0',
      '\tbeq\t.L3',
      '\tadd\tr0, r3, #0',
      '\tmov\tr1, sp',
      `\tmov\tr3, ${r3}`,
      '\tbl\tg',
      '.L3:',
      '\tadd\tsp, sp, #0x1c',
      '\tpop\t{r0}',
      '\tbx\tr0',
      '',
    ].join('\n');
  test.each([
    ['#0x0', /\bg\(a0, sp0, 0, 0\)/],
    ['sp', /\bg\(a0, sp0, 0, sp0\)/],
  ])('is kept with every other argument where the escape verdict leaned on the call (mov r3, %s)', (r3, call) => {
    const cs = enumerateCandidates('f', reused(r3), ARMV4T_AGBCC);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.some((c) => hasVariation(c.variations, 'setup-args'))).toBe(false);
    expect(cs.every((c) => call.test(c.source))).toBe(true);
  });

  // CONTROL: an object something else reads is still the dead store base the narrower reading
  // guesses it may be (sa3 sub_805DADC: `mov r3, sp` as a store base, reloaded after the call), and
  // that reading is still offered beside the default.
  test('…while one whose object is read after the call is still cut by the `/setup-args` sibling', () => {
    const leftover =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr4, r0, #0\n\tmov\tr3, sp\n\tstrh\tr1, [r3]\n' +
      '\tmov\tr2, #0x2\n\tcmp\tr1, #0\n\tbeq\t.L2\n\tadd\tr0, r4, #0\n\tbl\tg\n.L2:\n\tmov\tr0, sp\n' +
      '\tldrh\tr0, [r0]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    const cs = enumerateCandidates('f', leftover, ARMV4T_AGBCC);
    expect(cs.some((c) => !hasVariation(c.variations, 'setup-args') && /\bg\(a0, a1, 2, &sp0\)/.test(c.source))).toBe(
      true,
    );
    expect(cs.some((c) => hasVariation(c.variations, 'setup-args') && /\bg\(a0\);/.test(c.source))).toBe(true);
  });
});
