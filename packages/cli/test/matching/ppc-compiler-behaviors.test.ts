// THE POWERPC COMPILER-BEHAVIOR PROBES, RE-RUN ON EVERY CODEWARRIOR BUILD.
//
// `PPC_MWCC` (target.ts) is the description asmlift decompiles CodeWarrior against, and four of its
// fields were earned by compiling a probe rather than assumed: `reloadsLocalReread: false`,
// `switchBoundCase: 'either'` and the `switchRequiresFrontLoadedTests: true` beside it, and
// the `spillSlotOrder: 'unknown'` that records a direction nobody could measure. Three builds now
// map to that one description, and a description is per COMPILER — so a build that read a field
// differently would be mis-keyed by construction, with no way to spell the difference.
//
// So each build re-runs every probe here, at the flags its own rows compile at, and the
// description is shared on that evidence rather than inherited because the binaries look alike.
//
// WHAT THE PROBES FOUND, and it is not what the question assumed: what moves these readings is the
// OPTIMISATION LEVEL, not the build. Every build agrees with the description at `-O4,p`; at
// `-O0,p` every build re-reads the local — the shipped `mwcc_242_81` included. That control is what
// makes the reading decidable: without it, running the probe only at Mario Party 4's `-O0,p` would
// have attributed a level's behavior to a new binary and given `mwcc_247_107` a description of its
// own for a difference it does not have.
//
// The builds do differ in one place, and it is not a field: at `-O0,p` `mwcc_233_163n` hands out
// one more callee-saved GPR than the other two and so spills one local where they spill two. That
// is less evidence for a direction, not a different direction, so it too leaves the description
// alone.
//
// The `-O0,p` readings are committed here and declared NOWHERE: `compilerBehaviors` is per
// description, with no slot for "at this profile instead", and the flags plan's D1 lets an override
// land only through a mechanism that does not exist yet. So they are a measurement waiting for a
// reader — and the first rows that will feel them are Mario Party 4's ten DOL picks.
import { PPC_MWCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { type MwccToolchainId, compilePpcTarget } from '@asmlift/toolchains';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { ppcDockerGate } from './docker-gate';

/** A compile in the container costs seconds; a probe pair costs several. */
const BUDGET = 300_000;

// The flags each build's rows compile at, in the same normal form `bench flags` derives and a row
// stores — Pikmin's and Mario Party 4's own `objdiff.json` unit flags, minus the include paths and
// defines a probe needs none of. `mwcc_242_81`'s are its canonical set, the flags its committed
// probes and every synthetic row already use.
const CANONICAL = TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags;
/** Pikmin, `GC/1.2.5n` — `-O4,p`, and the only `-lang=c++` tree in the three projects. The probe
 *  sources are C, and CodeWarrior reads them the same either way (both probes give the same
 *  reading with and without the word), but every Pikmin row compiles with it, so the set stays the
 *  set its rows use rather than one with the dialect quietly dropped. */
const PIKMIN = [
  ...['-proc', 'gekko', '-align', 'powerpc', '-enum', 'int', '-fp', 'hardware'],
  ...['-Cpp_exceptions', 'off', '-O4,p', '-inline', 'auto', '-RTTI', 'off'],
  ...['-fp_contract', 'off', '-str', 'reuse', '-RTTI', 'on', '-char', 'unsigned', '-lang=c++'],
];
/** Mario Party 4's DOL `Game` lib, `GC/2.6`. Its flags really do name two levels — `-O4,p` early
 *  and `-O0,p` late — and the later one is what the compiler acts on, so dropping the tail is this
 *  build's own words at the OTHER level rather than a set invented for the control. */
const MP4_DOL_O4 = [
  ...['-proc', 'gekko', '-align', 'powerpc', '-enum', 'int', '-fp', 'hardware'],
  ...['-Cpp_exceptions', 'off', '-O4,p', '-inline', 'auto', '-RTTI', 'off'],
  ...['-fp_contract', 'on', '-str', 'reuse'],
];
const MP4_DOL = [...MP4_DOL_O4, '-O0,p', '-char', 'unsigned', '-fp_contract', 'off'];

/** Every build at the level its own rows are compiled at, and every build at the other one. */
const AT_O4: [MwccToolchainId, readonly string[]][] = [
  ['mwcc_242_81', CANONICAL],
  ['mwcc_233_163n', PIKMIN],
  ['mwcc_247_107', [...MP4_DOL_O4, '-char', 'unsigned']],
];
const AT_O0: [MwccToolchainId, readonly string[]][] = [
  ['mwcc_242_81', MP4_DOL],
  ['mwcc_233_163n', MP4_DOL],
  ['mwcc_247_107', MP4_DOL],
];

// All three builds or none: what these probes compare is the builds against each other, and a run
// missing one would quietly compare two.
const HAVE = (['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'] as const).every((id) =>
  ppcDockerGate('ppc-behaviors', id),
);

// ── reloadsLocalReread ────────────────────────────────────────────────────────────────────
// The committed pair (shortcircuit-branch.test.ts): a local assigned from `p[1]` and used after an
// effect. A compiler that RELOADS costs a second `lbz` and makes analysis.ts's local the wrong
// spelling; one that holds the register does not, which is what the declaration says.
const X = 'extern void fnB(void);\n';
const pair = (arm: string) => `void f(u8 *p, u8 *q, s32 a){ if (a && (p[1] & 0x7f) == 0x7f) { ${arm} } }`;
const ARMS = [
  '{ u8 v = p[1]; p[2] = v; }',
  '{ u8 v = p[1]; q[0] = 5; p[2] = v; }',
  '{ u8 v = p[1]; fnB(); p[2] = v; }',
];
const LOAD = /\blbz\s+r\d+,\s*(0x)?1\(r\d+\)/;

const loadsOf = (mwcc: MwccToolchainId, flags: readonly string[], arm: string): number =>
  compilePpcTarget(mwcc, X + pair(arm), 'f', flags)
    .asm.split('\n')
    .filter((l) => LOAD.test(l)).length;

describe.runIf(HAVE)('a re-read local, on each CodeWarrior build', () => {
  test.each(AT_O4)(
    '%s at -O4,p loads p[1] once, for every spelling — the declaration, on its own evidence',
    (mwcc, flags) => {
      for (const arm of ARMS) {
        expect(loadsOf(mwcc, flags, arm), `${mwcc} ${arm}`).toBe(1);
      }
      expect(PPC_MWCC.compilerBehaviors.reloadsLocalReread).toBe(false);
    },
    BUDGET,
  );

  test(
    'at -O0,p EVERY build reloads it — the level moved, not the compiler',
    () => {
      // The shipped build is in this list on purpose. It is the control that decides whether the
      // second load belongs to `mwcc_247_107` (a new description) or to `-O0,p` (a profile nothing
      // can spell yet), and it reads the same as the two new ones.
      for (const [mwcc, flags] of AT_O0) {
        expect(loadsOf(mwcc, flags, ARMS[2]), mwcc).toBe(2);
      }
    },
    BUDGET,
  );
});

// ── spillSlotOrder ───────────────────────────────────────────────────────────────────────
// The committed probe (`corpus/probe-declrank.c` + its reversed twin): sixteen locals whose
// immediates name them, all live across a call. `PPC_MWCC` ships `'unknown'` as the ABSENCE of a
// measurement — CodeWarrior homed every one in a register — and that is a claim each build owes.
const CORPUS = join(import.meta.dirname, '../../../core/test/corpus');
const declRankProbe = (reversed: boolean): string =>
  readFileSync(join(CORPUS, reversed ? 'probe-declrank-rev.c' : 'probe-declrank.c'), 'utf8');

/** `<declaration rank> → <frame offset>`, by pairing each `addi rX,rY,<imm>` with the next
 *  `stw rX,off(r1)`: the allocator reuses a temp, so the pairing is by nearest following store. */
function declRank(asm: string, reversed: boolean): [number, number][] {
  const pending = new Map<string, number>();
  const rows: [number, number][] = [];
  for (const line of asm.split('\n')) {
    const def = /\baddi\s+(r\d+),r\d+,(-?\d+)/.exec(line);
    if (def !== null) {
      pending.set(def[1], Number(def[2]));
      continue;
    }
    const st = /\bstw\s+(r\d+),(-?\d+)\(r1\)/.exec(line);
    if (st !== null && pending.has(st[1])) {
      const k = pending.get(st[1])! / 17; // the k-th assignment, 1-based
      pending.delete(st[1]);
      rows.push([reversed ? 16 - k : k - 1, Number(st[2])]);
    }
  }
  return rows.sort((a, b) => a[0] - b[0]);
}

const rankRows = (mwcc: MwccToolchainId, flags: readonly string[], reversed: boolean): [number, number][] =>
  declRank(compilePpcTarget(mwcc, declRankProbe(reversed), 'probe', flags).asm, reversed);

describe.runIf(HAVE)('declaration rank, on each CodeWarrior build', () => {
  test.each(AT_O4)(
    '%s at -O4,p spills no named local at all — nothing to read a direction off',
    (mwcc, flags) => {
      expect(rankRows(mwcc, flags, false)).toEqual([]);
      expect(PPC_MWCC.compilerBehaviors.spillSlotOrder).toBe('unknown');
    },
    BUDGET,
  );

  test(
    'at -O0,p the builds spill at all — and how MANY is where they differ',
    () => {
      // THE ONE PLACE THE THREE BUILDS ARE NOT THE SAME COMPILER, and it is not a direction. At
      // `-O0,p` none of them keeps all sixteen: `mwcc_242_81` and `mwcc_247_107` stop handing out
      // callee-saved GPRs at r17 and spill the last two, while `mwcc_233_163n` goes on to r16 and
      // spills one. Fewer rows is LESS evidence, not a contradiction — and the two that show a
      // direction show the same one.
      //
      // The reversed twin is what makes either reading a fact about declaration RANK rather than
      // about the order of the assignments: it moves which variable sits at each offset and leaves
      // rank → offset alone.
      const descending: [number, number][] = [
        [14, 12],
        [15, 8],
      ];
      for (const mwcc of ['mwcc_242_81', 'mwcc_247_107'] as const) {
        const flags = AT_O0.find(([id]) => id === mwcc)![1];
        expect(rankRows(mwcc, flags, false), mwcc).toEqual(descending);
        expect(rankRows(mwcc, flags, true), `${mwcc} reversed`).toEqual(descending);
      }
      const pikminFlags = AT_O0.find(([id]) => id === 'mwcc_233_163n')![1];
      expect(rankRows('mwcc_233_163n', pikminFlags, false)).toEqual([[15, 12]]);
      expect(rankRows('mwcc_233_163n', pikminFlags, true)).toEqual([[15, 12]]);
      // …and none of the three contradicts what the description ships, at either level.
      expect(PPC_MWCC.compilerBehaviors.spillSlotOrder).toBe('unknown');
    },
    BUDGET,
  );
});

// ── switchBoundCase + switchRequiresFrontLoadedTests ──────────────────────────────────────
// The committed fixtures (`corpus/mwcc-sw{dispatch,ladder,relnest}.asm`, switch-arms.test.ts) are
// mwcc_242_81's at its canonical flags. Each build re-compiles all three here, at both levels:
// the `switch` must dispatch instruction for instruction as the committed fixture does, pinning
// `case 0` with the path-bound `bge-`, the equality ladder must carry no relational test, and the
// nested relational ladder must put a body between two tests (`switchRequiresFrontLoadedTests`). At
// `-O0,p` the arm bodies leave through a `b` to one shared `blr` instead of returning in place,
// which is why only the dispatch — everything above the first body — is compared, and Pikmin's
// `-lang=c++` mangles the symbol every branch target is printed against (`swpath__FiPi`), which is
// why the `<sym+off>` annotation is dropped and the target address kept.
const insns = (asm: string): string[] =>
  asm
    .split('\n')
    .map((l) =>
      /^\s+[0-9a-f]+:\t(.*)$/
        .exec(l)?.[1]
        ?.replace(/\s*<[^>]*>$/, '')
        .trim(),
    )
    .filter((l): l is string => !!l);
const dispatchOf = (ls: string[]): string[] =>
  ls.slice(
    0,
    ls.findIndex((l) => l.startsWith('lwz')),
  );
const swProbe = (name: string): string => readFileSync(join(CORPUS, `probe-mwcc-${name}.c`), 'utf8');
const RELATIONAL = /^b(ge|gt|le|lt)-?\s/;

describe.runIf(HAVE)('a path-bound switch case, on each CodeWarrior build', () => {
  const committed = dispatchOf(insns(readFileSync(join(CORPUS, 'mwcc-swdispatch.asm'), 'utf8')));

  test.each([
    ...AT_O4.map(([id, f]) => [id, '-O4,p', f] as const),
    ...AT_O0.map(([id, f]) => [id, '-O0,p', f] as const),
  ])(
    '%s at %s dispatches the switch as the committed fixture does, and neither ladder as a switch',
    (mwcc, _level, flags) => {
      expect(committed.filter((l) => RELATIONAL.test(l))).toHaveLength(2);
      expect(dispatchOf(insns(compilePpcTarget(mwcc, swProbe('swdispatch'), 'swpath', flags).asm))).toEqual(committed);
      const ladder = insns(compilePpcTarget(mwcc, swProbe('swladder'), 'swpath', flags).asm);
      expect(ladder.filter((l) => RELATIONAL.test(l))).toEqual([]);
      const nest = insns(compilePpcTarget(mwcc, swProbe('swrelnest'), 'swpath', flags).asm);
      const lastTest = nest.findLastIndex((l) => l.startsWith('cmpwi'));
      expect(lastTest).toBeGreaterThan(nest.findIndex((l) => l.startsWith('lwz')));
      expect(PPC_MWCC.compilerBehaviors.switchBoundCase).toBe('either');
      expect(PPC_MWCC.compilerBehaviors.switchRequiresFrontLoadedTests).toBe(true);
    },
    BUDGET,
  );
});
