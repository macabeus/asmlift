// THE JOIN PAST EARLY RETURNS — `structure()`'s `joinPastReturns`.
//
// The source shape is a chain of `if`s, each holding an early `return;` in one arm, then a tail
// written once (`synthetic:retchain`, `synthetic:retchain_xj`; sub_0800D188's tile-collision chain):
//
//     if (a > 1) { if (b == 1) { k(11); return; } k(12); } else { k(13); }
//     if (a > 2) { ... }
//     tail();
//
// Every such `if` reaches EXIT on one path without passing the next, so post-dominance gives it no
// join, and the default writes everything below it into both arms: 2^n tails. The compilers lay
// the early returns out three ways, and each fixture flavor below is one of them:
//   - `own`: each early return keeps its own `ret`;
//   - `epilogue`: every early return and the tail branch to one epilogue `ret` (ido7.1, mwcc,
//     gcc2.7.2's shared exit), so the only `ret` the arms share is the tail's too;
//   - `crossjumped`: identical `k(x); return;` arms cross-jumped into one return tail taking `x`
//     (agbcc, gcc2.7.2), which `followEarlyReturns` lands on and so still copies;
//   - `branchyxj`: identical `if (a == 0) y(x); k(x); return;` arms cross-jumped into one return tail
//     that BRANCHES, which the code after the chain ends in too (agbcc, gcc2.7.2, gcc2.7.2kmc).
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { Fn } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { enumerateCandidates } from '../src/rank';
import { hasJoinPastReturns, structure } from '../src/structure/structure';
import { ARMV4T_AGBCC } from '../src/target';
import { hasVariation, joinVariations } from '../src/variation-tokens';
import { count } from './helpers';

type Flavor = 'own' | 'epilogue' | 'crossjumped' | 'branchyxj' | 'tangled';

/** `n` chained divergent `if`s, then a tail calling `tail`. With `innerIf`, each early return
 *  holds an `if` of its own before returning (`if (b == i) { if (a == 0) x(); k(i); return; }`). */
function chain(n: number, flavor: Flavor, innerIf = false): Fn {
  let v = 2;
  let blk = 1;
  const val = () => `%${v++}`;
  const lines: string[] = ['fn f {', '^bb0(%0: s32, %1: s32):'];
  const heads = Array.from({ length: n + 1 }, () => blk++);
  const epi = blk++;
  const shared = blk++;
  lines.push(`  br ^bb${heads[0]}()`);
  const ret = (x: string): string[] =>
    flavor === 'own'
      ? [`  %${v++}: s32 = call ${x} {target="k"}`, '  ret']
      : flavor === 'epilogue'
        ? [`  %${v++}: s32 = call ${x} {target="k"}`, `  br ^bb${epi}()`]
        : [`  br ^bb${shared}(${x})`];
  const branchy = blk++;
  const branchyRet = blk++;
  for (let i = 0; i < n; i++) {
    const [t, r, k, e, x, xr] = [blk++, blk++, blk++, blk++, blk++, blk++];
    const c = val();
    const cmp = val();
    lines.push(`^bb${heads[i]}():`, `  ${c}: s32 = const {value=${i + 1}}`);
    lines.push(`  ${cmp}: u32 = icmp_slt ${c}, %0`, `  cond_br ${cmp}, ^bb${t}(), ^bb${e}()`);
    const eq = val();
    lines.push(`^bb${t}():`, `  ${eq}: u32 = icmp_eq %1, ${c}`, `  cond_br ${eq}, ^bb${r}(), ^bb${k}()`);
    if (innerIf) {
      const z = val();
      const zc = val();
      lines.push(`^bb${r}():`, `  ${z}: s32 = const {value=0}`, `  ${zc}: u32 = icmp_eq %0, ${z}`);
      lines.push(`  cond_br ${zc}, ^bb${x}(), ^bb${xr}()`);
      lines.push(`^bb${x}():`, `  %${v++}: s32 = call ${z} {target="x"}`, `  br ^bb${xr}()`);
      lines.push(`^bb${xr}():`, ...ret(c));
    } else {
      lines.push(`^bb${r}():`, ...ret(c));
    }
    lines.push(`^bb${k}():`, `  %${v++}: s32 = call ${c} {target="k2"}`, `  br ^bb${heads[i + 1]}()`);
    if (flavor === 'tangled') {
      // the else arm returns early too, into the same return tail as the then arm, which branches
      const e2 = blk++;
      const ne = val();
      lines.push(`^bb${e}():`, `  ${ne}: u32 = icmp_ne %1, ${c}`, `  cond_br ${ne}, ^bb${e2}(), ^bb${r}()`);
      lines.push(`^bb${e2}():`, `  %${v++}: s32 = call ${c} {target="k3"}`, `  br ^bb${heads[i + 1]}()`);
    } else {
      lines.push(`^bb${e}():`, `  %${v++}: s32 = call ${c} {target="k3"}`, `  br ^bb${heads[i + 1]}()`);
    }
  }
  lines.push(`^bb${heads[n]}():`, `  %${v++}: s32 = call %0 {target="tail"}`);
  lines.push(
    ...(flavor === 'epilogue' ? [`  br ^bb${epi}()`] : flavor === 'branchyxj' ? [`  br ^bb${shared}(%0)`] : ['  ret']),
  );
  if (flavor === 'epilogue') {
    lines.push(`^bb${epi}():`, '  ret');
  }
  if (flavor === 'tangled' || flavor === 'branchyxj') {
    const p = val();
    const z = val();
    const zc = val();
    lines.push(`^bb${shared}(${p}: s32):`, `  ${z}: s32 = const {value=0}`, `  ${zc}: u32 = icmp_eq %0, ${z}`);
    lines.push(`  cond_br ${zc}, ^bb${branchy}(), ^bb${branchyRet}()`);
    lines.push(`^bb${branchy}():`, `  %${v++}: s32 = call ${p} {target="y"}`, `  br ^bb${branchyRet}()`);
    lines.push(`^bb${branchyRet}():`, `  %${v++}: s32 = call ${p} {target="k"}`, '  ret');
  }
  if (flavor === 'crossjumped') {
    const p = val();
    lines.push(`^bb${shared}(${p}: s32):`, `  %${v++}: s32 = call ${p} {target="k"}`, '  ret');
  }
  lines.push('}', '');
  const fn = parse(lines.join('\n'));
  verify(fn);
  return fn;
}

const emit = (fn: Fn, opts: { joinPastReturns?: boolean; followEarlyReturns?: boolean }) =>
  cBackend.emit(structure(fn, { returnsVoid: true, ...opts }));

describe('a chain of divergent `if`s with early returns', () => {
  for (const flavor of ['own', 'epilogue', 'crossjumped'] as const) {
    test(`${flavor}: the default writes the tail 2^n times, the join writes it once`, () => {
      const fn = chain(4, flavor);
      expect(count(emit(fn, {}), 'tail(')).toBe(16);
      const once = emit(fn, { joinPastReturns: true });
      expect(count(once, 'tail(')).toBe(1);
      // every early return is still written, once each, and the tail ends in the last `return;`
      expect(count(once, 'k(')).toBe(4);
      expect(count(once, 'return;')).toBe(5);
      expect(count(once, 'k3(')).toBe(4);
    });
  }

  test('branchyxj: a cross-jumped return tail that branches is copied into each early return', () => {
    const fn = chain(4, 'branchyxj');
    expect(count(emit(fn, {}), 'tail(')).toBe(16);
    const once = emit(fn, { joinPastReturns: true });
    expect(count(once, 'tail(')).toBe(1);
    // the return tail, written in each of the 4 early returns and after the tail
    expect(count(once, 'y(')).toBe(5);
    expect(count(once, 'k(')).toBe(5);
    expect(count(once, 'return;')).toBe(5);
  });

  test('crossjumped: the shared-ret follow lands on the return tail and still copies', () => {
    const fn = chain(4, 'crossjumped');
    expect(count(emit(fn, { followEarlyReturns: true }), 'tail(')).toBeGreaterThan(1);
  });

  for (const flavor of ['own', 'epilogue'] as const) {
    test(`${flavor}: an early return holding an \`if\` of its own is no join`, () => {
      // the `x()` join inside the early return passes "never enters the code after it", since the
      // other arm reaches it only through the epilogue; it fails because that arm runs into the real
      // join, which both arms reach
      const fn = chain(3, flavor, true);
      expect(count(emit(fn, {}), 'tail(')).toBe(8);
      const once = emit(fn, { joinPastReturns: true });
      expect(count(once, 'tail(')).toBe(1);
      expect(count(once, 'x(')).toBe(3);
    });
  }

  test('a return tail holding a join past returns of its own is not copied', () => {
    // `if (a > i) { if (b == i) goto T; k2(i); } k3(i); T:` per link, then `tail()`: each `T` is
    // acyclic and ends in the `ret`, but holds the next link, whose join past returns is its
    // `k3`, so copying it into the `goto` arm would copy that link's copy in its turn
    let v = 2;
    const n = 8;
    const lines = ['fn g {', '^bb0(%0: s32, %1: s32):', '  br ^bb1()'];
    for (let i = 0; i < n; i++) {
      const [h, t, a, k3, next] = [1 + 4 * i, 2 + 4 * i, 3 + 4 * i, 4 + 4 * i, 5 + 4 * i];
      const [c, x, y] = [`%${v++}`, `%${v++}`, `%${v++}`];
      lines.push(`^bb${h}():`, `  ${c}: s32 = const {value=${i + 1}}`, `  ${x}: u32 = icmp_slt ${c}, %0`);
      lines.push(`  cond_br ${x}, ^bb${t}(), ^bb${k3}()`);
      lines.push(`^bb${t}():`, `  ${y}: u32 = icmp_eq %1, ${c}`, `  cond_br ${y}, ^bb${next}(), ^bb${a}()`);
      lines.push(`^bb${a}():`, `  %${v++}: s32 = call ${c} {target="k2"}`, `  br ^bb${k3}()`);
      lines.push(`^bb${k3}():`, `  %${v++}: s32 = call ${c} {target="k3"}`, `  br ^bb${next}()`);
    }
    lines.push(`^bb${1 + 4 * n}():`, `  %${v++}: s32 = call %0 {target="tail"}`, '  ret', '}', '');
    const fn = parse(lines.join('\n'));
    verify(fn);
    expect(count(emit(fn, {}), 'tail(')).toBe(1);
    // only the last link's `T` is a return tail, a straight one
    expect(count(emit(fn, { joinPastReturns: true }), 'tail(')).toBe(2);
  });

  test('an `if` that already has a join is unchanged', () => {
    const fn = parse(`fn g {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_slt %2, %0
  cond_br %3, ^bb1(), ^bb2()
^bb1():
  %4: s32 = call %0 {target="k"}
  br ^bb3()
^bb2():
  %5: s32 = call %1 {target="k"}
  br ^bb3()
^bb3():
  %6: s32 = call %0 {target="tail"}
  ret
}
`);
    verify(fn);
    expect(emit(fn, { joinPastReturns: true })).toBe(emit(fn, {}));
  });
});

/** `n` chained jump tables over `%0 + i`, each with a `case 0:` that returns early (to its own `ret`,
 *  or to one epilogue), two cases and a default that run on to the next, then a tail. */
function switchChain(n: number, flavor: 'own' | 'epilogue'): Fn {
  let v = 1;
  let blk = 1;
  const lines: string[] = ['fn s {', '^bb0(%0: s32):'];
  const heads = Array.from({ length: n + 1 }, () => blk++);
  const epi = blk++;
  lines.push(`  br ^bb${heads[0]}()`);
  for (let i = 0; i < n; i++) {
    const [r, c1, c2, d] = [blk++, blk++, blk++, blk++];
    const [c, x] = [`%${v++}`, `%${v++}`];
    lines.push(`^bb${heads[i]}():`, `  ${c}: s32 = const {value=${i + 1}}`, `  ${x}: s32 = add %0, ${c}`);
    lines.push(`  switch_br ${x}, ^bb${r}(), ^bb${c1}(), ^bb${c2}(), ^bb${d}() {cases=[0;1;2]}`);
    lines.push(`^bb${r}():`, `  %${v++}: s32 = call ${c} {target="k"}`);
    lines.push(flavor === 'own' ? '  ret' : `  br ^bb${epi}()`);
    for (const [blkN, callee] of [
      [c1, 'k2'],
      [c2, 'k3'],
      [d, 'm'],
    ] as const) {
      lines.push(`^bb${blkN}():`, `  %${v++}: s32 = call ${c} {target="${callee}"}`, `  br ^bb${heads[i + 1]}()`);
    }
  }
  lines.push(`^bb${heads[n]}():`, `  %${v++}: s32 = call %0 {target="tail"}`);
  lines.push(flavor === 'own' ? '  ret' : `  br ^bb${epi}()`);
  if (flavor === 'epilogue') {
    lines.push(`^bb${epi}():`, '  ret');
  }
  lines.push('}', '');
  const fn = parse(lines.join('\n'));
  verify(fn);
  return fn;
}

/** `n` chained comparison trees over `%0 + i` (`case 0:` returns early through an `if` of its own,
 *  `case 1:`, `case 2:` and a default run on to the next), then a tail — a switch Regime A
 *  recovers, as ido7.1 and mwcc compile a small `switch`. */
function treeChain(n: number): Fn {
  let v = 1;
  let blk = 1;
  const lines: string[] = ['fn t {', '^bb0(%0: s32):', '  br ^bb1()'];
  const heads = Array.from({ length: n + 1 }, () => blk++);
  for (let i = 0; i < n; i++) {
    const [t1, t2, r, ry, rr, c1, c2, d] = Array.from({ length: 8 }, () => blk++);
    const [c, x, z, e0, one, e1, two, e2, g] = Array.from({ length: 9 }, () => `%${v++}`);
    lines.push(`^bb${heads[i]}():`, `  ${c}: s32 = const {value=${i + 1}}`, `  ${x}: s32 = add %0, ${c}`);
    lines.push(`  ${z}: s32 = const {value=0}`, `  ${e0}: u32 = icmp_eq ${x}, ${z}`);
    lines.push(`  cond_br ${e0}, ^bb${r}(), ^bb${t1}()`);
    lines.push(`^bb${t1}():`, `  ${one}: s32 = const {value=1}`, `  ${e1}: u32 = icmp_eq ${x}, ${one}`);
    lines.push(`  cond_br ${e1}, ^bb${c1}(), ^bb${t2}()`);
    lines.push(`^bb${t2}():`, `  ${two}: s32 = const {value=2}`, `  ${e2}: u32 = icmp_eq ${x}, ${two}`);
    lines.push(`  cond_br ${e2}, ^bb${c2}(), ^bb${d}()`);
    const z2 = `%${v++}`;
    lines.push(`^bb${r}():`, `  %${v++}: s32 = call ${c} {target="k"}`, `  ${z2}: s32 = const {value=0}`);
    lines.push(`  ${g}: u32 = icmp_eq %0, ${z2}`);
    lines.push(`  cond_br ${g}, ^bb${ry}(), ^bb${rr}()`);
    lines.push(`^bb${ry}():`, `  %${v++}: s32 = call ${c} {target="y"}`, `  br ^bb${rr}()`);
    lines.push(`^bb${rr}():`, '  ret');
    for (const [blkN, callee] of [
      [c1, 'k2'],
      [c2, 'k3'],
      [d, 'm'],
    ] as const) {
      lines.push(`^bb${blkN}():`, `  %${v++}: s32 = call ${c} {target="${callee}"}`, `  br ^bb${heads[i + 1]}()`);
    }
  }
  lines.push(`^bb${heads[n]}():`, `  %${v++}: s32 = call %0 {target="tail"}`, '  ret', '}', '');
  const fn = parse(lines.join('\n'));
  verify(fn);
  return fn;
}

describe('a chain of comparison-tree switches with a `case` that returns early', () => {
  test('the join writes the tail once, and the trees stay switches', () => {
    const fn = treeChain(3);
    expect(count(emit(fn, {}), 'tail(')).toBe(27);
    const once = emit(fn, { joinPastReturns: true });
    expect(count(once, 'tail(')).toBe(1);
    expect(count(once, 'switch (')).toBe(3);
    expect(count(once, 'y(')).toBe(3);
  });

  test('past the copy budget it lifts with the tail written once', () => {
    const src = emit(treeChain(8), {});
    expect(count(src, 'tail(')).toBe(1);
    expect(count(src, 'switch (')).toBe(8);
  });
});

describe('a chain of jump tables with a `case` that returns early', () => {
  for (const flavor of ['own', 'epilogue'] as const) {
    test(`${flavor}: the default writes the tail 3^n times, the join writes it once`, () => {
      const fn = switchChain(3, flavor);
      expect(count(emit(fn, {}), 'tail(')).toBe(27);
      const once = emit(fn, { joinPastReturns: true });
      expect(count(once, 'tail(')).toBe(1);
      expect(count(once, 'switch (')).toBe(3);
      expect(count(once, 'k(')).toBe(3);
      expect(count(once, 'm(')).toBe(3);
    });

    test(`${flavor}: past the copy budget it lifts with the tail written once`, () => {
      const src = emit(switchChain(8, flavor), {});
      expect(count(src, 'tail(')).toBe(1);
      expect(count(src, 'switch (')).toBe(8);
    });
  }

  test('the gate answers for a jump table', () => {
    expect(hasJoinPastReturns(switchChain(1, 'own'))).toBe(true);
    expect(hasJoinPastReturns(switchChain(1, 'epilogue'))).toBe(true);
  });
});

describe('the copy budget', () => {
  test('a chain past the budget lifts with the tail written once, with nothing asked', () => {
    // 2^12 tails: far past `COPY_BUDGET` region entries per block, so `structure()` stops the
    // default and reruns it with `joinPastReturns`
    for (const flavor of ['own', 'epilogue', 'crossjumped', 'branchyxj'] as const) {
      const fn = chain(12, flavor);
      const src = emit(fn, {});
      expect(count(src, 'tail(')).toBe(1);
      expect(count(src, 'k3(')).toBe(12);
      expect(src).toBe(emit(fn, { joinPastReturns: true }));
    }
  });

  test('the rerun reports the reading it took, so rank.ts names its tree `/ret-join`', () => {
    let over = 0;
    structure(chain(12, 'own'), { returnsVoid: true }, { onJoinPastReturns: () => over++ });
    expect(over).toBeGreaterThan(0);
    let under = 0;
    structure(chain(4, 'own'), { returnsVoid: true }, { onJoinPastReturns: () => under++ });
    expect(under).toBe(0);
  });

  test('a chain under the budget keeps the default copies', () => {
    expect(count(emit(chain(4, 'own'), {}), 'tail(')).toBe(16);
  });

  test('a chain the join cannot read declines with a structure refusal naming the copied block', () => {
    // both arms of every `if` return early into one return tail that branches, so no block is
    // where only the non-returning paths meet, and the copies stay exponential
    const fn = chain(12, 'tangled');
    expect(() => structure(fn, { returnsVoid: true })).toThrow(
      /cannot structure 'f': block #\d+ is written \d+ times, past the copy budget of \d+ region entries/,
    );
    const small = chain(3, 'tangled');
    expect(count(emit(small, { joinPastReturns: true }), 'tail(')).toBe(8);
  });
});

describe('the `/ret-join` variation', () => {
  // agbcc -O2 of two links of `synthetic:retchain_xj`, then `m(gA); m(gB);`: the early returns
  // `k(11); gT = 1; return;` and `k(21); gT = 2; return;` cross-jump into one `bl k; str; b .L2`
  // tail, which the epilogue `.L2` follows, so the follow lands on it and the default and
  // `/shared-ret` both write the tail twice
  const THUMB =
    'f:\n\tpush\t{r4, lr}\n\tldr\tr0, .L10\n\tldr\tr0, [r0]\n\tcmp\tr0, #0x1\n\tble\t.L3\n' +
    '\tldr\tr0, .L10+0x4\n\tldr\tr4, [r0]\n\tcmp\tr4, #0x1\n\tbne\t.L4\n\tmov\tr0, #0xb\n' +
    '\tb\t.L9\n.L11:\n\t.align\t2, 0\n.L10:\n\t.word\tgA\n\t.word\tgB\n.L4:\n' +
    '\tmov\tr0, #0xc\n\tbl\tk\n\tb\t.L5\n.L3:\n\tmov\tr0, #0xd\n\tbl\tk\n.L5:\n' +
    '\tldr\tr0, .L12\n\tldr\tr0, [r0]\n\tcmp\tr0, #0x2\n\tble\t.L6\n\tldr\tr0, .L12+0x4\n' +
    '\tldr\tr4, [r0]\n\tcmp\tr4, #0x2\n\tbne\t.L7\n\tmov\tr0, #0x15\n.L9:\n\tbl\tk\n' +
    '\tldr\tr0, .L12+0x8\n\tstr\tr4, [r0]\n\tb\t.L2\n.L13:\n\t.align\t2, 0\n.L12:\n' +
    '\t.word\tgA\n\t.word\tgB\n\t.word\tgT\n.L7:\n\tmov\tr0, #0x16\n\tbl\tk\n\tb\t.L8\n.L6:\n' +
    '\tmov\tr0, #0x17\n\tbl\tk\n.L8:\n\tldr\tr0, .L14\n\tldr\tr0, [r0]\n\tbl\tm\n' +
    '\tldr\tr0, .L14+0x4\n\tldr\tr0, [r0]\n\tbl\tm\n.L2:\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n' +
    '.L15:\n\t.align\t2, 0\n.L14:\n\t.word\tgA\n\t.word\tgB\n\n';
  const P = {
    f: { params: 0, returnsVoid: true },
    k: { params: 1, returnsVoid: true },
    m: { params: 1, returnsVoid: true },
  };

  test('is enumerated beside the copies, and writes the tail once', () => {
    const cands = enumerateCandidates('f', THUMB, ARMV4T_AGBCC, { prototypes: P });
    const join = cands.filter((c) => hasVariation(c.variations, 'ret-join'));
    expect(join.length).toBeGreaterThan(0);
    const tail = (src: string) => count(src, 'm(');
    expect(join.every((c) => tail(c.source) === 2 && count(c.source, 'return;') === 2)).toBe(true);
    expect(cands.filter((c) => !hasVariation(c.variations, 'ret-join')).every((c) => tail(c.source) > 2)).toBe(true);
    expect(cands.some((c) => joinVariations(c.variations) === 'unsigned')).toBe(true);
  });

  test('is not enumerated where no `if` lacks a join', () => {
    const plain =
      'f:\n\tpush\t{lr}\n\tcmp\tr0, #0x3\n\tble\t.L3\n\tbl\tB\n\tb\t.L5\n.L3:\n\tbl\tC\n.L5:\n' +
      '\tbl\tX\n\tpop\t{r0}\n\tbx\tr0\n';
    const cands = enumerateCandidates('f', plain, ARMV4T_AGBCC, {
      prototypes: { f: { params: 1, returnsVoid: true } },
    });
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.filter((c) => hasVariation(c.variations, 'ret-join'))).toEqual([]);
  });

  test('the gate answers for the chain fixtures', () => {
    expect(hasJoinPastReturns(chain(2, 'own'))).toBe(true);
    expect(hasJoinPastReturns(chain(2, 'epilogue'))).toBe(true);
    expect(hasJoinPastReturns(chain(2, 'crossjumped'))).toBe(true);
  });
});
