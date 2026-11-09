// A RETURN OF THE VALUE A BRANCH TESTED, left unfolded where cse folds only the fall-through arm.
//
// One probe pair, `corpus/probe-rettail-pg-{copies,join}.c`, compiled by
// scripts/regen-rettail-probes.ts at every toolchain's canonical flags: `return gB` after `gB` is
// tested against 0, written as the `else` of `gB != 0` with the tail in both arms (`-copies`), and
// as the then arm of `gB == 0` before the tail written once (`-join`). The shape of Mario Party 3's
// `func_8010BD28_472F98_mgmode`.
//   1. which compilers fold the tested constant into a return on the branch's taken edge
//      (target.ts `foldsBranchConstantOnTakenEdge`), read from the objects themselves, and how the
//      flags set it (`targetFor`);
//   2. structure/unfolded-branch-constant.ts reads the mark at the site the join took, and the plain
//      default publishes the copies there, on a target whose cse leaves the taken edge unfolded.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { parseAsmData } from '../src/frontend/asmdata';
import { frontendFor } from '../src/frontend/registry';
import { decompile, raiseRecovered } from '../src/pipeline';
import { type JoinPastReturnsSite, structure } from '../src/structure/structure';
import { unfoldedBranchConstant } from '../src/structure/unfolded-branch-constant';
import { TOOLCHAIN_TARGETS, structureOptionsFor, targetFor } from '../src/target';

const CORPUS = join(import.meta.dirname, 'corpus');
const fixture = (file: string) => readFileSync(join(CORPUS, file), 'utf8');

/** The instruction lines of a committed disassembly, without its provenance header. */
const instructions = (file: string): string[] =>
  fixture(file)
    .split('\n')
    .filter((l) => /^\s+[0-9a-f]+:\s+[a-z]/.test(l))
    .map((l) =>
      l
        .replace(/^\s+[0-9a-f]+:\s+/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );

/** The delay slot of the `beqz` on `gB`, the branch to the early return. */
const returnSlot = (file: string): string => {
  const ins = instructions(file);
  const at = ins.findIndex((l, i) => l.startsWith('beqz ') && ins[i - 1]?.startsWith('lhu '));
  expect(at).toBeGreaterThan(0);
  return ins[at + 1];
};

const GCC_LANES = [
  { tc: 'gcc2.7.2', slug: 'gcc272', copies: 'nop' },
  { tc: 'gcc2.7.2kmc', slug: 'gcc272kmc', copies: 'move v0,zero' },
] as const;

describe('which compilers fold a branch-proven constant on the taken edge (`foldsBranchConstantOnTakenEdge`)', () => {
  test.each(GCC_LANES)('$tc: the declaration at canonical flags is what its own `pg` pair compiles to', (lane) => {
    expect(returnSlot(`${lane.slug}-rettail-pg-copies.asm`)).toBe(lane.copies);
    // the join's return is its branch's fall-through in the compiler's own jump, and folds
    expect(returnSlot(`${lane.slug}-rettail-pg-join.asm`)).toBe('move v0,zero');
    const { target } = targetFor(lane.tc, TOOLCHAIN_TARGETS[lane.tc].canonicalFlags);
    expect(target.compilerBehaviors.foldsBranchConstantOnTakenEdge).toBe(lane.copies !== 'nop');
  });

  // Only a jump cse follows records its taken edge (target.ts `cseFollowsJumpsUnder`): -O2 and
  // -fcse-follow-jumps follow, -fno-cse-follow-jumps does not, and -fcse-skip-blocks records nothing.
  // The probe pair compiled at each of these (gcc2.7.2), the copies' delay slot: `nop` where false.
  test('gcc 2.x: the taken edge folds only where cse follows jumps, by level or by the switch', () => {
    const at = (flags: string[]) =>
      targetFor('gcc2.7.2', flags).target.compilerBehaviors.foldsBranchConstantOnTakenEdge;
    expect(at(['-O1'])).toBe(false);
    expect(at(['-O'])).toBe(false);
    expect(at(['-O2'])).toBe(true);
    expect(at(['-O3'])).toBe(true);
    expect(at(['-Os'])).toBe(true);
    expect(at(['-O1', '-fcse-follow-jumps'])).toBe(true);
    expect(at(['-O1', '-fcse-skip-blocks'])).toBe(false);
    expect(at(['-O1', '-fcse-follow-jumps', '-fno-cse-follow-jumps'])).toBe(false);
    expect(at(['-O2', '-fno-cse-skip-blocks'])).toBe(true);
    expect(at(['-O2', '-fno-cse-follow-jumps'])).toBe(false);
    expect(at(['-O2', '-fno-cse-follow-jumps', '-fno-cse-skip-blocks'])).toBe(false);
    expect(at(['-O0'])).toBe(true);
  });

  test('absent where no probe says either: agbcc, ido7.1 and mwcc, at any level', () => {
    for (const [tc, flags] of [
      ['agbcc', ['-O1']],
      ['agbcc', ['-O2']],
      ['ido7.1', ['-O1']],
      ['mwcc_242_81', ['-O1']],
    ] as const) {
      expect(targetFor(tc, flags).target.compilerBehaviors.foldsBranchConstantOnTakenEdge).toBeUndefined();
    }
  });
});

const PROTOS = { f: { params: 1 }, w: { params: 2, returnsVoid: true }, v: { params: 1, returnsVoid: true } } as const;

const input = (slug: string, p: 'copies' | 'join') => {
  const dump = fixture(`${slug}-rettail-pg-${p}.txt`);
  return { asm: fixture(`${slug}-rettail-pg-${p}.asm`), asmData: parseAsmData(dump, dump, dump, true) };
};

describe('the unfolded return, read at each site the join was taken (structure/unfolded-branch-constant.ts)', () => {
  const marks = (lane: (typeof GCC_LANES)[number], p: 'copies' | 'join', kind?: JoinPastReturnsSite['kind']) => {
    const { target } = targetFor(lane.tc, TOOLCHAIN_TARGETS[lane.tc].canonicalFlags);
    const { asm, asmData } = input(lane.slug, p);
    const fn = frontendFor(target).lift('f', asm, target, PROTOS, asmData);
    raiseRecovered(fn, target, {}, PROTOS.f);
    const sites: JoinPastReturnsSite[] = [];
    structure(fn, structureOptionsFor(target, false), { onJoinPastReturns: (site) => sites.push(site) });
    return sites.map((site) => unfoldedBranchConstant(fn, kind === undefined ? site : { ...site, kind }));
  };

  test('gcc2.7.2 (-O1): the copies leave `gB` returned as loaded, and the site shows it', () => {
    expect(marks(GCC_LANES[0], 'copies')).toEqual([true]);
  });

  // a case arm is a jump target whatever the source wrote, so the same return read at a switch's
  // site says nothing (gcc2.7.2 -O1 keeps `move v0,a0` in a `case 0: return x;` jump's slot under
  // the join too)
  test.each(['tree', 'switch'] as const)('gcc2.7.2 (-O1): the same return at a `%s` site is no mark', (kind) => {
    expect(marks(GCC_LANES[0], 'copies', kind)).toEqual([false]);
  });

  // folded on the taken edge too, the copies' `else` returns 0 and the structuring takes no join
  test('gcc2.7.2kmc (-O2): the copies fold `gB` to 0 as the join does, and are no site', () => {
    expect(marks(GCC_LANES[1], 'copies')).toEqual([]);
  });

  // the join's early return returns the folded constant, so its structuring takes no join at all
  test.each(GCC_LANES)('$tc: the join-written source is no site', (lane) => {
    expect(marks(lane, 'join')).toEqual([]);
  });
});

// MIPS_GCC defaults to the copies outright (it leaves out target.ts `joinPastReturnsByDefault`), so
// the mark is read on the description with the join declared the default, where it decides
describe('the join default publishes the copies where the return was left unfolded', () => {
  const read = (lane: (typeof GCC_LANES)[number], p: 'copies' | 'join', o: object = {}) => {
    const { target: shipped } = targetFor(lane.tc, TOOLCHAIN_TARGETS[lane.tc].canonicalFlags);
    const target = {
      ...shipped,
      compilerBehaviors: { ...shipped.compilerBehaviors, joinPastReturnsByDefault: true },
    };
    return decompile('f', input(lane.slug, p).asm, target, { prototypes: PROTOS, ...input(lane.slug, p), ...o }).source;
  };

  test('gcc2.7.2 (-O1) `pg` copies: the default is the copies, though the join is shorter', () => {
    const lane = GCC_LANES[0];
    const copies = read(lane, 'copies', { copyReturnTails: true });
    const join = read(lane, 'copies', { joinPastReturns: true });
    expect(join.split('\n').length).toBeLessThan(copies.split('\n').length);
    expect(read(lane, 'copies')).toBe(copies);
  });

  // the same source at -O2 folds either way, and both readings are one
  test('gcc2.7.2kmc (-O2) `pg` copies: no site, so the readings agree', () => {
    const lane = GCC_LANES[1];
    expect(read(lane, 'copies')).toBe(read(lane, 'copies', { joinPastReturns: true }));
  });

  test.each(GCC_LANES)('$tc `pg` join: the default is the join', (lane) => {
    expect(read(lane, 'join')).toBe(read(lane, 'join', { joinPastReturns: true }));
  });
});
