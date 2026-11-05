// THE JOIN PAST EARLY RETURNS — `structure()`'s default, and the copies `copyReturnTails` keeps.
//
// The source shape is a chain of `if`s, each holding an early `return;` in one arm, then a tail
// written once (`synthetic:retchain`, `synthetic:retchain_xj`; sub_0800D188's tile-collision chain):
//
//     if (a > 1) { if (b == 1) { k(11); return; } k(12); } else { k(13); }
//     if (a > 2) { ... }
//     tail();
//
// Every such `if` reaches EXIT on one path without passing the next, so post-dominance gives it no
// join, and the copies (`copyReturnTails`) write everything below it into both arms: 2^n tails; the
// default reads the join past them and writes it once. The compilers lay
// the early returns out three ways, and each fixture flavor below is one of them:
//   - `own`: each early return keeps its own `ret`;
//   - `epilogue`: every early return and the tail branch to one epilogue `ret` (ido7.1, mwcc,
//     gcc2.7.2's shared exit), so the only `ret` the arms share is the tail's too;
//   - `crossjumped`: identical `k(x); return;` arms cross-jumped into one return tail taking `x`
//     (agbcc, gcc2.7.2), which `followEarlyReturns` lands on and so still copies;
//   - `branchyxj`: identical `if (a == 0) y(x); k(x); return;` arms cross-jumped into one return tail
//     that BRANCHES, which the code after the chain ends in too (agbcc, gcc2.7.2, gcc2.7.2kmc).
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { Fn } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import type { SFn } from '../src/l3/ast';
import { decompile, structureReturnTailReading } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import { structure } from '../src/structure/structure';
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

const emit = (fn: Fn, opts: { copyReturnTails?: boolean; followEarlyReturns?: boolean }) =>
  cBackend.emit(structure(fn, { returnsVoid: true, ...opts }));

describe('a chain of divergent `if`s with early returns', () => {
  for (const flavor of ['own', 'epilogue', 'crossjumped'] as const) {
    test(`${flavor}: the copies write the tail 2^n times, the default join writes it once`, () => {
      const fn = chain(4, flavor);
      expect(count(emit(fn, { copyReturnTails: true }), 'tail(')).toBe(16);
      const once = emit(fn, {});
      expect(count(once, 'tail(')).toBe(1);
      // every early return is still written, once each, and the tail ends in the last `return;`
      expect(count(once, 'k(')).toBe(4);
      expect(count(once, 'return;')).toBe(5);
      expect(count(once, 'k3(')).toBe(4);
    });
  }

  test('branchyxj: a cross-jumped return tail that branches is copied into each early return', () => {
    const fn = chain(4, 'branchyxj');
    expect(count(emit(fn, { copyReturnTails: true }), 'tail(')).toBe(16);
    const once = emit(fn, {});
    expect(count(once, 'tail(')).toBe(1);
    // the return tail, written in each of the 4 early returns and after the tail
    expect(count(once, 'y(')).toBe(5);
    expect(count(once, 'k(')).toBe(5);
    expect(count(once, 'return;')).toBe(5);
  });

  test('crossjumped: the shared-ret follow lands on the return tail and still copies', () => {
    const fn = chain(4, 'crossjumped');
    expect(count(emit(fn, { followEarlyReturns: true, copyReturnTails: true }), 'tail(')).toBeGreaterThan(1);
  });

  for (const flavor of ['own', 'epilogue'] as const) {
    test(`${flavor}: an early return holding an \`if\` of its own is no join`, () => {
      // the `x()` join inside the early return passes "never enters the code after it", since the
      // other arm reaches it only through the epilogue; it fails because that arm runs into the real
      // join, which both arms reach
      const fn = chain(3, flavor, true);
      expect(count(emit(fn, { copyReturnTails: true }), 'tail(')).toBe(8);
      const once = emit(fn, {});
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
    expect(count(emit(fn, { copyReturnTails: true }), 'tail(')).toBe(1);
    // only the last link's `T` is a return tail, a straight one
    expect(count(emit(fn, {}), 'tail(')).toBe(2);
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
    expect(emit(fn, { copyReturnTails: true })).toBe(emit(fn, {}));
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
    expect(count(emit(fn, { copyReturnTails: true }), 'tail(')).toBe(27);
    const once = emit(fn, {});
    expect(count(once, 'tail(')).toBe(1);
    expect(count(once, 'switch (')).toBe(3);
    expect(count(once, 'y(')).toBe(3);
  });

  test('a chain whose copies are past the copy budget lifts with the tail written once', () => {
    const src = emit(treeChain(8), {});
    expect(count(src, 'tail(')).toBe(1);
    expect(count(src, 'switch (')).toBe(8);
  });
});

describe('a chain of jump tables with a `case` that returns early', () => {
  for (const flavor of ['own', 'epilogue'] as const) {
    test(`${flavor}: the copies write the tail 3^n times, the default join writes it once`, () => {
      const fn = switchChain(3, flavor);
      expect(count(emit(fn, { copyReturnTails: true }), 'tail(')).toBe(27);
      const once = emit(fn, {});
      expect(count(once, 'tail(')).toBe(1);
      expect(count(once, 'switch (')).toBe(3);
      expect(count(once, 'k(')).toBe(3);
      expect(count(once, 'm(')).toBe(3);
    });

    test(`${flavor}: a chain whose copies are past the copy budget lifts with the tail written once`, () => {
      const src = emit(switchChain(8, flavor), {});
      expect(count(src, 'tail(')).toBe(1);
      expect(count(src, 'switch (')).toBe(8);
    });
  }

  test('the default reports the join it took for a jump table', () => {
    for (const flavor of ['own', 'epilogue'] as const) {
      let took = 0;
      structure(switchChain(1, flavor), { returnsVoid: true }, { onJoinPastReturns: () => took++ });
      expect(took).toBeGreaterThan(0);
    }
  });
});

describe('the copy budget', () => {
  test('a chain whose copies are past the budget lifts with the tail written once, and its copies decline', () => {
    // 2^12 tails: far past `COPY_BUDGET` region entries per block, so `structure()` stops the
    // copies and declines them; the default join never comes near it
    for (const flavor of ['own', 'epilogue', 'crossjumped', 'branchyxj'] as const) {
      const fn = chain(12, flavor);
      const src = emit(fn, {});
      expect(count(src, 'tail(')).toBe(1);
      expect(count(src, 'k3(')).toBe(12);
      expect(() => structure(fn, { returnsVoid: true, copyReturnTails: true })).toThrow(
        /cannot structure 'f': block #\d+ is written \d+ times, past the copy budget of \d+ region entries/,
      );
    }
  });

  test('the default reports the join it took, so rank.ts structures `/ret-copy` for it', () => {
    let took = 0;
    structure(chain(4, 'own'), { returnsVoid: true }, { onJoinPastReturns: () => took++ });
    expect(took).toBeGreaterThan(0);
    let copies = 0;
    structure(chain(4, 'own'), { returnsVoid: true, copyReturnTails: true }, { onJoinPastReturns: () => copies++ });
    expect(copies).toBe(0);
  });

  test('every candidate past the budget is the join: its copies and shared-tail passes are dropped', () => {
    // agbcc -O2 of twelve `if (gA > i) { if (gB == i) { k(9); if (gC) k(8); gT = 1; return; } k(); }
    // else k();` links, then `gOut = gOut + 1;` and the same return tail: the copies, and the
    // follow and sink that keep them, are past the budget
    const asm = readFileSync(joinPath(import.meta.dirname, 'corpus', 'agbcc-retbudget.s'), 'utf8');
    const cands = enumerateCandidates('retbudget', asm, ARMV4T_AGBCC, {
      prototypes: { retbudget: { params: 0, returnsVoid: true }, k: { params: 1, returnsVoid: true } },
    });
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => count(c.source, 'gOut = ') === 1)).toBe(true);
    const copied = cands.filter((c) =>
      ['ret-copy', 'shared-tail', 'shared-ret'].some((v) => hasVariation(c.variations, v)),
    );
    expect(copied.map((c) => joinVariations(c.variations))).toEqual([]);
  }, 90_000); // every copies setting structures to the budget before it declines

  test('a chain under the budget keeps its copies under `copyReturnTails`', () => {
    expect(count(emit(chain(4, 'own'), { copyReturnTails: true }), 'tail(')).toBe(16);
  });

  test('a chain the join cannot read declines with a structure refusal naming the copied block', () => {
    // both arms of every `if` return early into one return tail that branches, so no block is
    // where only the non-returning paths meet, and the copies stay exponential
    const fn = chain(12, 'tangled');
    expect(() => structure(fn, { returnsVoid: true })).toThrow(
      /cannot structure 'f': block #\d+ is written \d+ times, past the copy budget of \d+ region entries/,
    );
    const small = chain(3, 'tangled');
    expect(count(emit(small, {}), 'tail(')).toBe(8);
  });

  test('a join past the budget falls to the copies, which write a long tail once', () => {
    // `if (a == 1) leaf(); else if (a == 2) leaf(); ...` with every leaf falling into one straight
    // tail of `n` calls, the first and the last through `two()` first: the join meets at `two()`,
    // and every other leaf is an early return taking its own copy of the tail, n times n entries,
    // past the budget, where the copies write the tail once below the `if`s
    const n = 215;
    const lines = ['fn f {', '^bb0(%0: s32):', '  br ^bb1()'];
    const [two, tail] = [2 * n + 2, 2 * n + 3];
    let v = 1;
    for (let i = 1; i <= n; i++) {
      const [k, c] = [v++, v++];
      lines.push(`^bb${i}():`, `  %${k}: s32 = const {value=${i}}`, `  %${c}: u32 = icmp_eq %0, %${k}`);
      lines.push(`  cond_br %${c}, ^bb${n + i}(), ^bb${i < n ? i + 1 : 2 * n + 1}()`);
    }
    for (let i = 1; i <= n + 1; i++) {
      lines.push(`^bb${n + i}():`, `  %${v++}: s32 = call %0 {target="leaf"}`);
      lines.push(`  br ^bb${i === 1 || i === n + 1 ? two : tail}()`);
    }
    lines.push(`^bb${two}():`, `  %${v++}: s32 = call %0 {target="two"}`, `  br ^bb${tail}()`);
    for (let i = 0; i < n; i++) {
      lines.push(`^bb${tail + i}():`, `  %${v++}: s32 = call %0 {target="tl"}`);
      lines.push(i + 1 < n ? `  br ^bb${tail + i + 1}()` : '  ret');
    }
    const fn = parse([...lines, '}', ''].join('\n'));
    verify(fn);
    let joins = 0;
    const src = cBackend.emit(structure(fn, { returnsVoid: true }, { onJoinPastReturns: () => joins++ }));
    expect(count(src, 'tl(')).toBe(n);
    expect(count(src, 'two(')).toBe(2);
    expect(joins).toBe(0); // the join the copies replaced is not reported
  }, 60_000);
});

describe('a join that refuses falls to the copies', () => {
  // A `retchain` link ahead of a switch whose case leaves it from inside a nested switch: the join
  // past the link's early return reads the switch at its own end, where that case declines, so the
  // whole function is structured again reading the copies (case-goto.test.ts's `gn`).
  const IR = `fn gn2 {
^bb0(%0: s32, %1: s32):
  %k9: s32 = const {value=9}
  %c0: u32 = icmp_eq %1, %k9
  cond_br %c0, ^bbA(), ^bbC()
^bbA():
  %k8: s32 = const {value=8}
  %c8: u32 = icmp_eq %0, %k8
  cond_br %c8, ^bbR(), ^bbB()
^bbR():
  %ra: s32 = call %0 {target="A"}
  ret
^bbB():
  %rb: s32 = call %0 {target="B"}
  br ^bbM()
^bbC():
  %rc: s32 = call %0 {target="C"}
  br ^bbM()
^bbM():
  %rx: s32 = call %0 {target="X"}
  switch_br %0, ^bb10(), ^bb1(), ^bbL(), ^bb3(), ^bb2(), ^bb7() {cases=[0;1;2;3;5]}
^bb10():
  %r0: s32 = call %0 {target="a"}
  switch_br %1, ^bb11(), ^bb12(), ^bb13() {cases=[0;1]}
^bb11():
  %r11: s32 = call %0 {target="p"}
  br ^bb14()
^bb12():
  %r12: s32 = call %0 {target="q"}
  br ^bbL()
^bb13():
  %r13: s32 = call %0 {target="r"}
  br ^bb14()
^bb14():
  %r14: s32 = call %0 {target="w"}
  br ^bb7()
^bb1():
  %r1: s32 = call %0 {target="b"}
  %z1: s32 = const {value=0}
  %cc1: u32 = icmp_slt %1, %z1
  cond_br %cc1, ^bb7(), ^bbL()
^bb2():
  %r2: s32 = call %0 {target="c"}
  br ^bbL()
^bbL():
  %rL: s32 = call %0 {target="s"}
  br ^bb3()
^bb3():
  %r3: s32 = call %0 {target="t"}
  br ^bb7()
^bb7():
  ret
}`;

  test('the tree is the copies, and the hooks report no join past early returns', () => {
    let joins = 0;
    const src = cBackend.emit(structure(parse(IR), { returnsVoid: true }, { onJoinPastReturns: () => joins++ }));
    expect(src).toBe(cBackend.emit(structure(parse(IR), { returnsVoid: true, copyReturnTails: true })));
    expect(count(src, 'X(')).toBe(2);
    expect(joins).toBe(0);
  });
});

describe('the `/ret-copy` variation', () => {
  // agbcc -O2 of two links of `synthetic:retchain_xj`, then `m(gA); m(gB);`: the early returns
  // `k(11); gT = 1; return;` and `k(21); gT = 2; return;` cross-jump into one `bl k; str; b .L2`
  // tail, which the epilogue `.L2` follows, so the follow lands on it and `/ret-copy` and
  // `/shared-ret` both write the tail twice; the default writes it once
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

  test('is enumerated beside the join, and writes the tail into each early return', () => {
    const cands = enumerateCandidates('f', THUMB, ARMV4T_AGBCC, { prototypes: P });
    const copies = cands.filter((c) => hasVariation(c.variations, 'ret-copy'));
    expect(copies.length).toBeGreaterThan(0);
    const tail = (src: string) => count(src, 'm(');
    expect(copies.every((c) => tail(c.source) > 2)).toBe(true);
    const joined = cands.filter(
      (c) => !hasVariation(c.variations, 'ret-copy') && !hasVariation(c.variations, 'shared-ret'),
    );
    expect(joined.every((c) => tail(c.source) === 2 && count(c.source, 'return;') === 2)).toBe(true);
    expect(cands.some((c) => joinVariations(c.variations) === 'unsigned')).toBe(true);
    expect(cands.some((c) => joinVariations(c.variations) === 'unsigned/ret-copy')).toBe(true);
  });

  test('is not enumerated where no `if` lacks a join', () => {
    const plain =
      'f:\n\tpush\t{lr}\n\tcmp\tr0, #0x3\n\tble\t.L3\n\tbl\tB\n\tb\t.L5\n.L3:\n\tbl\tC\n.L5:\n' +
      '\tbl\tX\n\tpop\t{r0}\n\tbx\tr0\n';
    const cands = enumerateCandidates('f', plain, ARMV4T_AGBCC, {
      prototypes: { f: { params: 1, returnsVoid: true } },
    });
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.filter((c) => hasVariation(c.variations, 'ret-copy'))).toEqual([]);
  });
});

// A SWITCH WHOSE DEFAULT RETURNS EARLY has its CFG join at the epilogue, so its arms read at the join
// past early returns end in a `break` where the copies' arms run into one another. Each fixture below
// is one the copies DECLINE (thumb-switch.test.ts pins those refusals under `/ret-copy`): the falling
// arm hands its successor a value the switch edge hands it too, or reaches two siblings. At the join
// the arms meet at the code below the switch, so no arm falls into another and nothing is re-run.
describe('the switch shapes whose copies decline are read at the join', () => {
  const recompute = (dispatch: string, arm0: string) =>
    `f:\n\tpush\t{lr}\n${dispatch}\tcmp\tr1, #0x1\n\tbhi\t.Lend\n\tlsl\tr3, r1, #0x2\n\tldr\tr1, .Lp\n` +
    '\tadd\tr3, r3, r1\n\tldr\tr3, [r3]\n\tmov\tpc, r3\n.Lp:\n\t.word\t.Ltab\n.Ltab:\n\t.word\t.Lc0\n\t.word\t.Lc1\n' +
    `.Lc0:\n${arm0}.Lc1:\n\tadd\tr1, r2, #0\n\tbl\tside2\n.Lend:\n\tpop\t{r0}\n\tbx\tr0\n`;
  const SIDE2 = { prototypes: { side2: { params: 2, returns: 'void' }, f: { params: 2, returns: 'void' } } } as const;
  const lift = (asm: string, copyReturnTails = false) =>
    decompile('f', asm, ARMV4T_AGBCC, { ...SIDE2, copyReturnTails }).source;

  test('a falling arm that overwrites the register the next one reads: each arm sets it, then one call', () => {
    // `case 0:` computes `a0 + 1` and sets r0 = 9; `case 1:` takes r0 = a0 from the switch edge
    const asm = recompute('\tadd\tr2, r0, #0x1\n', '\tadd\tr2, r0, #0x1\n\tmov\tr0, #0x9\n');
    expect(() => lift(asm, true)).toThrow(/takes a value from the switch edge/);
    const src = lift(asm);
    expect(src).toMatch(/case 0:\s*v0 = 9;\s*break;\s*case 1:\s*v0 = a0;\s*break;\s*default:\s*return;\s*\}/);
    expect(count(src, 'side2(v0, a0 + 1);')).toBe(1);
  });

  test('a falling arm that stores to what the next one loaded: each arm keeps its own load', () => {
    const asm = recompute('\tldr\tr2, [r0]\n', '\tldr\tr2, [r0]\n\tmov\tr3, #0x9\n\tstr\tr3, [r0]\n');
    expect(() => lift(asm, true)).toThrow(/takes a value from the switch edge/);
    const src = lift(asm);
    expect(src).toMatch(/case 0:\s*v0 = \*a0;\s*\*a0 = 9;\s*break;\s*case 1:\s*v0 = \*a0;\s*break;/);
    expect(count(src, 'side2(a0, v0);')).toBe(1);
  });
});

// THE DEFAULT IS BOUNDED BY SIZE (pipeline.ts `structureReturnTailReading`): where the join past
// early returns spells the whole function LONGER than the return-tail copies, decompile() and the
// ranked default publish the copies, and rank.ts enumerates the join as `/ret-join`; where it is
// not longer (ties included), the join stands and the copies are `/ret-copy`. `structure()` itself
// still reads the join: the bound is on the emitted source, after the readability rewrites.
describe('the return-tail reading bounded by size', () => {
  // `if (a == 1) leaf(); else if (a == 2) leaf(); ... else leaf();` with every leaf falling into one
  // tail of `tailLen` calls, the first and the last through `two()` first (sa3 sub_809A808's shape):
  // the join meets at `two()`, and every other leaf is an early return taking its own copy of the tail
  function decisionTree(n: number, tailLen: number): Fn {
    const lines = ['fn f {', '^bb0(%0: s32):', '  br ^bb1()'];
    const [two, tail] = [2 * n + 2, 2 * n + 3];
    let v = 1;
    for (let i = 1; i <= n; i++) {
      const [k, c] = [v++, v++];
      lines.push(`^bb${i}():`, `  %${k}: s32 = const {value=${i}}`, `  %${c}: u32 = icmp_eq %0, %${k}`);
      lines.push(`  cond_br %${c}, ^bb${n + i}(), ^bb${i < n ? i + 1 : 2 * n + 1}()`);
    }
    for (let i = 1; i <= n + 1; i++) {
      lines.push(`^bb${n + i}():`, `  %${v++}: s32 = call %0 {target="leaf"}`);
      lines.push(`  br ^bb${i === 1 || i === n + 1 ? two : tail}()`);
    }
    lines.push(`^bb${two}():`, `  %${v++}: s32 = call %0 {target="two"}`, `  br ^bb${tail}()`);
    for (let i = 0; i < tailLen; i++) {
      lines.push(`^bb${tail + i}():`, `  %${v++}: s32 = call %0 {target="tl"}`);
      lines.push(i + 1 < tailLen ? `  br ^bb${tail + i + 1}()` : '  ret');
    }
    const fn = parse([...lines, '}', ''].join('\n'));
    verify(fn);
    return fn;
  }
  const OPTS = { returnsVoid: true } as const;
  const emitC = (t: SFn) => cBackend.emit(t);

  test('where the join is longer, the copies are published and the join is the unpublished reading', () => {
    const fn = decisionTree(3, 4);
    const join = emit(fn, {});
    const copies = emit(fn, { copyReturnTails: true });
    expect(count(join, 'tl(')).toBe(12); // structure() alone still reads the join
    expect(count(copies, 'tl(')).toBe(4);
    const read = structureReturnTailReading(fn, OPTS, emitC);
    expect(emitC(read.sfn)).toBe(copies);
    expect(read.unpublished?.reading).toBe('join');
    expect(read.unpublished && 'sfn' in read.unpublished ? emitC(read.unpublished.sfn) : '').toBe(join);
    // forced, the join stands and nothing is unpublished
    const forced = structureReturnTailReading(fn, { ...OPTS, joinPastReturns: true }, emitC);
    expect(emitC(forced.sfn)).toBe(join);
    expect(forced.unpublished).toBeUndefined();
  });

  test('where the join is shorter, it is published and the copies are the unpublished reading', () => {
    const fn = chain(4, 'own');
    const read = structureReturnTailReading(fn, OPTS, emitC);
    expect(count(emitC(read.sfn), 'tail(')).toBe(1);
    expect(read.unpublished?.reading).toBe('copies');
    expect(read.unpublished && 'sfn' in read.unpublished ? count(emitC(read.unpublished.sfn), 'tail(') : 0).toBe(16);
  });

  test('a tie, or a backend that cannot spell one reading, leaves the join standing', () => {
    const fn = decisionTree(3, 4);
    const join = emit(fn, {});
    expect(emitC(structureReturnTailReading(fn, OPTS, () => 'one line').sfn)).toBe(join);
    const refusing = (t: SFn) => {
      if (count(cBackend.emit(t), 'tl(') === 4) {
        throw new Error('cannot spell the copies');
      }
      return cBackend.emit(t);
    };
    expect(emitC(structureReturnTailReading(fn, OPTS, refusing).sfn)).toBe(join);
  });

  test('copies that decline leave the join standing, with their refusal as the unpublished reading', () => {
    const fn = chain(12, 'own'); // the copies are past the copy budget
    const read = structureReturnTailReading(fn, OPTS, emitC);
    expect(count(emitC(read.sfn), 'tail(')).toBe(1);
    expect(read.unpublished && 'error' in read.unpublished ? String(read.unpublished.error) : '').toMatch(
      /past the copy budget/,
    );
  });

  test('a structuring that never took the join is structured once, with nothing unpublished', () => {
    const fn = parse(
      [
        'fn f {',
        '^bb0(%0: s32):',
        '  %1: s32 = const {value=3}',
        '  %2: u32 = icmp_slt %1, %0',
        '  cond_br %2, ^bb1(), ^bb2()',
        '^bb1():',
        '  %3: s32 = call %0 {target="b"}',
        '  br ^bb3()',
        '^bb2():',
        '  %4: s32 = call %0 {target="c"}',
        '  br ^bb3()',
        '^bb3():',
        '  ret',
        '}',
        '',
      ].join('\n'),
    );
    expect(structureReturnTailReading(fn, OPTS, emitC).unpublished).toBeUndefined();
  });

  // The decision tree in agbcc's layout, hand-written: `if (a == 1) A(); else if (a == 2 || a == 3)
  // A(); else A();` where the first and the last arm cross-jump into one `bl B` before the tail
  // `X(); Y(); Z(); W();`, so the join writes that tail into the early return of the middle arm
  const TREE =
    'f:\n\tpush\t{lr}\n\tcmp\tr0, #0x1\n\tbne\t.L3\n\tbl\tA\n\tb\t.L8\n.L3:\n\tcmp\tr0, #0x2\n\tbeq\t.L9\n' +
    '\tcmp\tr0, #0x3\n\tbne\t.L7\n.L9:\n\tbl\tA\n\tb\t.L4\n.L7:\n\tbl\tA\n.L8:\n\tbl\tB\n.L4:\n' +
    '\tbl\tX\n\tbl\tY\n\tbl\tZ\n\tbl\tW\n\tpop\t{r0}\n\tbx\tr0\n';
  const V0 = { params: 0, returnsVoid: true } as const;
  const P = { f: { params: 1, returnsVoid: true }, A: V0, B: V0, X: V0, Y: V0, Z: V0, W: V0 };

  test('decompile() publishes the copies where the join is longer, and spells the join when forced', () => {
    const copies = decompile('f', TREE, ARMV4T_AGBCC, { prototypes: P }).source;
    expect(copies).toBe(decompile('f', TREE, ARMV4T_AGBCC, { prototypes: P, copyReturnTails: true }).source);
    expect(count(copies, 'W(')).toBe(1);
    const join = decompile('f', TREE, ARMV4T_AGBCC, { prototypes: P, joinPastReturns: true }).source;
    expect(count(join, 'W(')).toBe(2);
  });
});
