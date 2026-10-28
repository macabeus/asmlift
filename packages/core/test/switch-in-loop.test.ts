// A jump table in a loop body, one of whose arms `return`s — where the function's single epilogue
// (every `return` merged into one, as agbcc and IDO do when the code after the loop returns early
// too, and mwcc always does) is the only block every path from the dispatch reaches. Post-dominance
// then puts the switch's end PAST the loop, the loop's own latch is left a sibling, and every
// `break` read as a fall-through into it. The switch's end inside a loop body is the body's own join
// (`loopJoin`), as it is for an `if` there.
//
// The `*-swloopret*` fixtures are the benchmark's own `synthetic:sw_loopret` objects (and mwcc's
// `sw_loopret_ctl`, which has no post-loop return but still one epilogue), as `pnpm bench repro`
// fed them to asmlift: the `.s`/objdump text and, off agbcc, its `objdump -s -r -t` dump. The
// other fixtures are compiled from the source written above each test.
//
//   for (i = 0; i <= n; i++) {
//       switch (gE[i].id) {
//       case 5: if (gE[i].x == a) { k(a); return; } gOut = 1; break;
//       case 6: if (gE[i].x > a) gOut = 2; break;
//       case 8: if (gE[i].x < a) gOut = 3; break;
//       case 9: gOut = 4; break;
//       case 11: if (gE[i].x != a) gOut = 5; break;
//       case 12: k(i); break;
//       }
//   }
//   if (gOut == a) { k(7); return; }      // absent from sw_loopret_ctl
//   gOut = 9;
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

import { parseAsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { TOOLCHAIN_TARGETS } from '../src/target';

const corpus = (f: string) => readFileSync(new URL(`corpus/${f}`, import.meta.url), 'utf8');
const protos = (sym: string) => ({ [sym]: { returnsVoid: true }, k: { params: 1, returnsVoid: true } });
const lift = (sym: string, tc: keyof typeof TOOLCHAIN_TARGETS, asm: string, dump?: string) =>
  decompile(sym, corpus(asm), TOOLCHAIN_TARGETS[tc].description, {
    prototypes: protos(sym),
    ...(dump !== undefined ? { asmData: parseAsmData(corpus(dump), corpus(dump), corpus(dump), true) } : {}),
  }).source;

/** The text of the one `switch` statement, from its keyword to its closing brace. */
const switchOf = (out: string): string => {
  const at = out.indexOf('switch (');
  expect(at).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = out.indexOf('{', at); i < out.length; i++) {
    depth += out[i] === '{' ? 1 : out[i] === '}' ? -1 : 0;
    if (depth === 0) {
      return out.slice(at, i + 1);
    }
  }
  throw new Error('unbalanced switch');
};

/** Everything a case label opens, up to the next label or the switch's end. */
const armOf = (sw: string, label: string): string => {
  const at = sw.indexOf(`${label}:`);
  expect(at).toBeGreaterThanOrEqual(0);
  const rest = sw.slice(at + label.length + 1);
  const next = rest.search(/\n\s*(case -?\d+|default):/);
  return next < 0 ? rest.replace(/\s*\}$/, '') : rest.slice(0, next);
};

const cells = [
  { name: 'agbcc', sym: 'sw_loopret', tc: 'agbcc', asm: 'agbcc-swloopret.s', postLoopReturn: true },
  {
    name: 'ido7.1',
    sym: 'sw_loopret',
    tc: 'ido7.1',
    asm: 'ido71-swloopret.asm',
    dump: 'ido71-swloopret.txt',
    postLoopReturn: true,
  },
  {
    name: 'mwcc_242_81',
    sym: 'sw_loopret',
    tc: 'mwcc_242_81',
    asm: 'mwcc242-swloopret.asm',
    dump: 'mwcc242-swloopret.txt',
    postLoopReturn: true,
  },
  {
    name: 'mwcc_242_81 (no post-loop return)',
    sym: 'sw_loopret_ctl',
    tc: 'mwcc_242_81',
    asm: 'mwcc242-swloopretctl.asm',
    dump: 'mwcc242-swloopretctl.txt',
    postLoopReturn: false,
  },
] as const;

test.each(cells)('$name: an in-loop switch whose CFG merge is the epilogue ends at the loop body', (c) => {
  const out = lift(c.sym, c.tc, c.asm, 'dump' in c ? c.dump : undefined);
  const sw = switchOf(out);
  // inside the loop: the loop opens before the switch, and the switch closes before the loop does
  const loopAt = out.search(/\b(do|for \(.*\)|while \(.*\)) \{/);
  expect(loopAt).toBeGreaterThanOrEqual(0);
  expect(loopAt).toBeLessThan(out.indexOf(sw));
  // `case 5:` (the scrutinee is rebased by 5, so label 0) keeps its own `k(a); return;`, and is
  // the ONLY `return` in the function: none was merged into a `break`, and none was invented.
  const ret = armOf(sw, 'case 0');
  expect(ret).toMatch(/k\(a0\);\s*return;/);
  expect(ret).toMatch(/gOut = 1;/);
  expect([...out.matchAll(/\breturn\b/g)]).toHaveLength(1);
  // every other arm, and both holes (7 and 10, labels 2 and 5), is a `break` — nothing falls, no
  // `default:` (the source wrote none: holes and out-of-range values go round the loop), and no
  // `continue` path was dropped or spelled.
  for (const label of ['case 1', 'case 3', 'case 4', 'case 6', 'case 7', 'case 5']) {
    expect(armOf(sw, label).trimEnd()).toMatch(/break;$/);
  }
  expect(sw).toMatch(/case 2:\s*case 5:\s*break;/);
  expect(armOf(sw, 'case 0').trimEnd()).toMatch(/break;$/);
  expect(sw).not.toContain('default:');
  expect(out).not.toContain('continue');
  expect(armOf(sw, 'case 7')).toMatch(/k\(v\d+\);/);
  // the code after the loop stays after it, outside the switch
  expect(sw).not.toContain('gOut = 9');
  expect(out.indexOf('gOut = 9')).toBeGreaterThan(out.indexOf(sw) + sw.length);
  if (c.postLoopReturn) {
    expect(sw).not.toContain('k(7)');
    expect(out.indexOf('k(7)')).toBeGreaterThan(out.indexOf(sw) + sw.length);
    // `if (gOut == a) { k(7); return; } gOut = 9;` — the `return` is the end of the function, so
    // the two exclusive paths are the same program as `if (…) k(7); else gOut = 9;`
    expect(out).toMatch(/if \((gOut == a0|a0 == gOut)\) \{\s*k\(7\);\s*\} else \{\s*gOut = 9;\s*\}/);
  } else {
    expect(out).not.toContain('k(7)');
  }
});

test('gcc 2.7.2: the latch increment reorg spread into the arms lifts at the loop body join', () => {
  // reorg fills two arms' delay slots with the latch's `i++`, so they jump to the test block while
  // the rest go to a separate `i++` block (the default and both holes): two `ret`s and no CFG
  // merge, so the switch takes the body's own join (the test block) and the arms that reach it
  // through the `i++` block take that block back as a copy. Each arm ends `i + 1` and breaks.
  const out = lift('sw_loopret', 'gcc2.7.2', 'gcc272-swloopret.asm', 'gcc272-swloopret.txt');
  const sw = switchOf(out);
  expect(armOf(sw, 'case 0')).toMatch(/k\(a0\);\s*return;/);
  expect([...out.matchAll(/\breturn\b/g)]).toHaveLength(1);
  for (const label of ['case 1', 'case 3', 'case 4', 'case 6', 'case 7']) {
    expect(armOf(sw, label)).toMatch(/v\d+ = v\d+ \+ 1;\s*break;\s*$/);
  }
  expect(sw).toMatch(/case 2:\s*case 5:\s*v\d+ = v\d+ \+ 1;\s*break;/);
  expect(out).not.toContain('continue');
  expect(sw).not.toContain('k(7)');
  expect(out.indexOf('k(7)')).toBeGreaterThan(out.indexOf(sw) + sw.length);
});

test('agbcc: the loop body join is offered to the copies, for arm tails a cross-jump merged', () => {
  // The same loop, with arm tails agbcc cross-jumped (`case 1: g(1); h(a);` and `case 2: g(3);
  // h(a);` share `g(r0)` and run on into `case 3: h(a);`), and the post-loop early return that
  // makes the epilogue the switch's CFG merge:
  //
  //   for (i = 0; i <= n; i++)
  //       switch (gId[i]) {
  //       case 0: if (a == i) { k(a); return; } gOut = 1; break;
  //       case 1: g(1); h(a); gOut = 7; break;
  //       case 2: g(3); h(a); gOut = 7; break;
  //       case 3: h(a); gOut = 7; break;
  //       case 4: gOut = 4; break;
  //       case 5: k(i); break;
  //       }
  //   if (gOut == a) { k(7); return; }
  //   gOut = 9;
  //
  // Read as written, two arms fall into `case 3:` at the body's join too; only the copies spell it.
  const out = decompile('b1', corpus('agbcc-swloopcopies.s'), TOOLCHAIN_TARGETS.agbcc.description, {
    prototypes: {
      b1: { returnsVoid: true },
      k: { params: 1, returnsVoid: true },
      g: { params: 1, returnsVoid: true },
      h: { params: 1, returnsVoid: true },
    },
  }).source;
  const sw = switchOf(out);
  expect(armOf(sw, 'case 0')).toMatch(/k\(a0\);\s*return;/);
  // one entrant takes the shared tail back as a copy and breaks; the other falls into `case 3:`
  expect(armOf(sw, 'case 1')).toMatch(/g\(v\d+\);\s*h\(a0\);\s*gOut = 7;\s*break;\s*$/);
  expect(armOf(sw, 'case 2')).toMatch(/g\(v\d+\);\s*$/);
  expect(armOf(sw, 'case 3')).toMatch(/h\(a0\);\s*gOut = 7;\s*break;/);
  for (const label of ['case 4', 'case 5']) {
    expect(armOf(sw, label).trimEnd()).toMatch(/break;$/);
  }
  expect(sw).not.toContain('default:');
  expect(out).not.toContain('continue');
  expect([...out.matchAll(/\breturn\b/g)]).toHaveLength(1);
  expect(sw).not.toContain('k(7)');
});

test('ido7.1: a switch nested in an arm of an in-loop switch stays loud where its merge only returns reach', () => {
  // The inner switch's own `case 4:` returns, so its CFG merge is the epilogue past the loop too,
  // which only `return`s reach. Its arms SPELL there (tail copies and `continue`), so the loop
  // clamp is never asked, and it writes the epilogue's `return;` after itself where no path
  // reaches it: the reachability contract declines the function. No static test tells that from
  // the published reading whose arm spells an early `return` as `break;` to the same `return;`,
  // so it stays loud, never wrong C.
  //
  //   i = -1;
  //   while (1) {
  //       i++;
  //       if (i > n) break;
  //       if (gV[i] != 1) {
  //           switch (gId[i]) {
  //           case 0: gOut = 20;
  //           case 1: k(i); break;
  //           case 4: switch (gV[i] & 7) {
  //                   case 0: if (gV[i] < a) gOut = 20; break;
  //                   case 4: if (gV[i] == 24) return; break;
  //                   case 6: if (gV[i] < a) gOut = 26; break;
  //                   case 7: gOut = 27;
  //                   default: gOut -= 1; break;
  //                   }
  //                   k(55); break;
  //           case 5: if (gV[i] == 25) return; break;
  //           case 7: while (gV[i] > 27) { gV[i]--; k(27); } break;
  //           }
  //           gOut += 2;
  //       }
  //   }
  //   if (gOut == a) { k(7); return; }
  //   gOut = 9;
  expect(() => lift('q242', 'ido7.1', 'ido71-swloopnested.asm', 'ido71-swloopnested.txt')).toThrow(
    /structuring emitted 1 statement\(s\) no path reaches/,
  );
});

// An arm whose early `return` goes into the epilogue past the loop ESCAPES the switch's region at
// the body's join (the switch does not dominate that epilogue). An escape that only returns ends
// its path where it sits, as a `ret` in the arm does, so it does not stop the arm falling into a
// sibling, or taking a cross-jumped sibling back as copies.
test.each([
  { name: 'agbcc', tc: 'agbcc', asm: 'agbcc-swloopcont.s', dump: undefined },
  { name: 'mwcc_242_81', tc: 'mwcc_242_81', asm: 'mwcc242-swloopcont.asm', dump: 'mwcc242-swloopcont.txt' },
] as const)('$name: a returning arm beside a `continue` arm and code after the switch', (c) => {
  //   for (i = 0; i <= n; i++) {
  //       switch (gId[i]) {
  //       case 0: if (gV[i] == a) { k(a); return; } gOut = 1; break;
  //       case 1: gOut = 2; break;
  //       case 3: k(i); break;
  //       case 4: gOut = 4; break;
  //       case 5: k(5); break;
  //       case 6: k(6); continue;
  //       }
  //       gV[i] += 1;
  //   }
  //   if (gOut == a) { k(7); return; }
  //   gOut = 9;
  const out = lift('d1', c.tc, c.asm, c.dump);
  const sw = switchOf(out);
  expect(armOf(sw, 'case 0')).toMatch(/k\(a0\);\s*return;/);
  expect(armOf(sw, 'case 0')).toMatch(/gOut = 1;/);
  expect([...out.matchAll(/\breturn\b/g)]).toHaveLength(1);
  // the `continue` arm skips the `gV[i] += 1` every other path runs
  expect(armOf(sw, 'case 6')).toMatch(/k\(6\);/);
  expect(armOf(sw, 'case 6')).not.toMatch(/\+ 1;/);
  for (const label of ['case 0', 'case 3', 'case 4', 'case 5']) {
    expect(armOf(sw, label)).toMatch(/\+ 1;/);
  }
  expect(sw).not.toContain('k(7)');
  expect(out.indexOf('k(7)')).toBeGreaterThan(out.indexOf(sw) + sw.length);
});

test('agbcc: a returning arm falls through into the next case', () => {
  //   for (i = 0; i <= n; i++) {
  //       switch (gId[i]) {
  //       case 0: if (gV[i] == a) { k(a); return; } gOut = 1;
  //       case 1: gOut += 2; break;
  //       case 2: k(2);
  //       case 3: k(i); break;
  //       case 4: gOut = 4; break;
  //       case 5: k(5); break;
  //       }
  //   }
  //   if (gOut == a) { k(7); return; }
  //   gOut = 9;
  const out = lift('ft3', 'agbcc', 'agbcc-swloopfall.s');
  const sw = switchOf(out);
  expect(armOf(sw, 'case 0')).toMatch(/k\(a0\);\s*return;/);
  expect(sw).toMatch(/gOut = 1;\s*case 1:\s*gOut = gOut \+ 2;\s*break;/);
  expect(sw).toMatch(/k\(2\);\s*case 3:\s*k\(v\d+\);\s*break;/);
  expect([...out.matchAll(/\breturn\b/g)]).toHaveLength(1);
  expect(sw).not.toContain('default:');
  expect(out.indexOf('k(7)')).toBeGreaterThan(out.indexOf(sw) + sw.length);
});

test('agbcc: an arm falls through beside a returning tail a guard outside any loop shares', () => {
  // No loop. agbcc cross-jumps the guard's `k(7); return;` and the arm's into one tail the switch
  // does not dominate, so the arm escapes to it; the escape only returns, so the arm still falls
  // into `case 1`. The rule belongs to the arm, not to the loop clamp.
  //
  //   if (n < 0) { k(7); return; }
  //   switch (gId[a]) {
  //   case 0: if (gV[a] == n) { k(7); return; } gOut = 1;
  //   case 1: gOut += 2; break;
  //   case 2: k(2); break;
  //   case 3: k(3); break;
  //   case 4: gOut = 4; break;
  //   case 5: k(5); break;
  //   }
  //   gV[0] = 5;
  const out = lift('ha', 'agbcc', 'agbcc-swnoloopfall.s');
  const sw = switchOf(out);
  expect(armOf(sw, 'case 0')).toMatch(/k\(7\);\s*return;/);
  expect(sw).toMatch(/gOut = 1;\s*case 1:\s*gOut = gOut \+ 2;\s*break;/);
  expect(sw).not.toContain('default:');
  expect(out.indexOf('= 5;', out.indexOf(sw) + sw.length)).toBeGreaterThan(0);
});

test('agbcc: a comparison-tree arm falling through beside a `goto` past the loop declines to if-recovery', () => {
  // A sparse switch is a comparison tree (Regime A), which has if-recovery to fall back on. Its
  // `case 5` falls into `case 9` and escapes to `out:`, past the loop's exit. Committing to the
  // `switch` there fails the whole function at emission ("leaves its switch for a loop exit"), so
  // such an arm stays unstructurable in Regime A and the tree is spelled as `if`s.
  //
  //   for (i = 0; i <= n; i++) {
  //       switch (gId[i]) {
  //       case 5: if (gV[7] == 1) goto out; s += 2;
  //       case 9: k(29); return t + 29;
  //       case 40: if (gV[6] == 0) goto out; s += 2;
  //       case 2000: k(2020);
  //       }
  //       s += 1;
  //   }
  //   gOut = s;
  //   out: k(t); k(s); return t;
  const out = decompile('q35', corpus('agbcc-swtreeescape.s'), TOOLCHAIN_TARGETS.agbcc.description, {
    prototypes: { q35: { params: 2 }, k: { params: 1, returnsVoid: true } },
  }).source;
  expect(out).not.toContain('switch (');
  expect(out).toMatch(/k\(29\);\s*return a0 \+ 29;/);
  expect(out).toContain('gOut = ');
});

test('ido7.1: an escape that runs round an irreducible cycle does not count as only returning', () => {
  // `case 0`'s `goto out` reaches a `while` entered in its middle (`goto mid`), a cycle whose
  // back edge targets no dominator. One of the escape's paths runs round it, so the escape does
  // not only return and the arm cannot fall through beside it: the arms do not linearize, loud.
  //
  //   for (i = 0; i <= n; i++) {
  //       switch (gId[i]) {
  //       case 0: if (gV[i] == a) goto out; gOut = 1;
  //       case 1: gOut += 2; break;
  //       case 2: k(2);
  //       case 3: k(i); break;
  //       case 4: gOut = 4; break;
  //       case 5: k(5); break;
  //       }
  //   }
  //   i = 0;
  //   out: if (a > 2) goto mid;
  //   while (i < 7) { k(i); mid: i++; gOut += i; }
  expect(() => lift('ib', 'ido7.1', 'ido71-swloopirreducible.asm', 'ido71-swloopirreducible.txt')).toThrow(
    /the jump table's case arms do not linearize/,
  );
});
