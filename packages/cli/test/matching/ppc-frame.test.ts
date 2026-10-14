// PPC FRAME OBJECTS AND INCOMING STACK ARGUMENTS, ON THE TWO BUILDS THE SYNTHETIC TIER DOES NOT RUN.
//
// A captured local lifts as an object in mwcc's local area (frontend/ppc.ts `measurePpcFrame`,
// `compilerBehaviors.linkageLocalArea`), a word kept in a function that makes no call is a dead
// local, and argument word k >= 8 is read at entry r1 + 8 + 4(k - 8) as `@sarg<k>`. The synthetic
// tier carries these on mwcc_242_81 (`escarr`, `subslot`, `framelist`, `deadloc`, `in9e`, `in9`);
// mwcc_247_107 and mwcc_233_163n have no synthetic rows, so each case is compiled here at the flags
// that build's rows use, lifted, recompiled with the same build and scored.
import { decompile } from '@asmlift/core/pipeline';
import type { Prototypes } from '@asmlift/core/proto';
import { targetFor } from '@asmlift/core/target';
import { type MwccToolchainId, compilePpcTarget, scoreCPpc } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { ppcDockerGate } from './docker-gate';

/** A compile in the container costs seconds; a case is two of them. */
const BUDGET = 300_000;

const BASE = ['-proc', 'gekko', '-align', 'powerpc', '-enum', 'int', '-fp', 'hardware', '-Cpp_exceptions', 'off'];
/** Mario Party 4's DOL unit flags as its rows store them: `-O4,p` early and `-O0,p` late, and the
 *  later level is the one the compiler acts on. */
const MP4_DOL = [
  ...BASE,
  ...['-O4,p', '-inline', 'auto', '-pragma', 'cats off', '-RTTI', 'off', '-fp_contract', 'on', '-str', 'reuse'],
  ...['-O0,p', '-char', 'unsigned', '-fp_contract', 'off', '-lang=c'],
];
/** Pikmin's unit flags as its rows store them (`-O4,p`), in C: a C body the lift can name. */
const PIKMIN_C = [
  ...BASE,
  ...['-O4,p', '-inline', 'auto', '-pragma', 'cats off', '-RTTI', 'off', '-fp_contract', 'off', '-str', 'reuse'],
  ...['-RTTI', 'on', '-char', 'unsigned', '-lang=c'],
];

interface Case {
  sym: string;
  c: string;
  prototypes: Prototypes;
  /** what the target object must show for the case to be about this capability */
  shape: RegExp;
  expect: string;
}

const IN9E: Case = {
  sym: 'in9e',
  c: 's32 in9e(s32 a, s32 b, s32 c, s32 d, s32 e, s32 f, s32 g, s32 h, s32 i){ return e + i; }',
  prototypes: {},
  shape: /\blwz\s+r\d+,(8|48)\(r1\)/,
  expect:
    's32 in9e(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5, s32 a6, s32 a7, s32 a8) {\n    return a4 + a8;\n}\n',
};
const IN10: Case = {
  sym: 'in10',
  c: 's32 in10(s32 a, s32 b, s32 c, s32 d, s32 e, s32 f, s32 g, s32 h, s32 i, s32 j){ return i - j; }',
  prototypes: {},
  shape: /\blwz\s+r\d+,(12|52)\(r1\)/,
  expect:
    's32 in10(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5, s32 a6, s32 a7, s32 a8, s32 a9) {\n' +
    '    return a8 - a9;\n}\n',
};
const ESCBUF: Case = {
  sym: 'escbuf',
  c: 'void rd(u8 *p); s32 escbuf(void){ u8 b[8]; rd(b); return b[1]; }',
  prototypes: { rd: { params: ['u8 *'], returnsVoid: true } },
  shape: /\baddi\s+r3,r1,8\b/,
  expect: 's32 escbuf(void) {\n    u8 sp8[8];\n    rd((u8 *)sp8);\n    return ((u8 *)sp8)[1];\n}\n',
};

const CASES: [MwccToolchainId, string, readonly string[], Case[]][] = [
  [
    'mwcc_247_107',
    'Mario Party 4 DOL flags',
    MP4_DOL,
    [
      IN9E,
      IN10,
      ESCBUF,
      {
        // an array handed over beside a ninth argument: the incoming word and the local area at once
        sym: 'in9arr',
        c:
          'void fill(s32 *p); s32 in9arr(s32 a, s32 b, s32 c, s32 d, s32 e, s32 f, s32 g, s32 h, s32 i)' +
          '{ s32 arr[2]; fill(arr); return arr[1] + i; }',
        prototypes: { fill: { params: ['s32 *'], returnsVoid: true } },
        shape: /\baddi\s+r3,r1,8\b/,
        expect:
          's32 in9arr(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5, s32 a6, s32 a7, s32 a8) {\n' +
          '    u8 sp8[8];\n    fill((s32 *)sp8);\n    return ((s32 *)sp8)[1] + a8;\n}\n',
      },
      {
        // fn_1_3994's shape: a local written in a loop and never read, in a function with no call
        sym: 'deadloc',
        c: 'void deadloc(s32 **p){ s32 *v; s32 **q = p; while (q) { v = *(s32 **)q; q = (s32 **)q[2]; } }',
        prototypes: { deadloc: { params: ['s32 **'], returnsVoid: true } },
        shape: /\bstw\s+r0,8\(r1\)/,
        expect:
          'void deadloc(s32 *a0) {\n    s32 *v0;\n    u32 sp8;\n    for (v0 = a0; v0 != 0; v0 = (s32 *)v0[2]) {\n' +
          '        sp8 = *v0;\n    }\n}\n',
      },
    ],
  ],
  [
    'mwcc_233_163n',
    "Pikmin's -O4,p",
    PIKMIN_C,
    [
      IN9E,
      IN10,
      ESCBUF,
      {
        sym: 'escarr',
        c: 'void fill(s32 *p); s32 escarr(void){ s32 a[4]; fill(a); return a[0] + a[3]; }',
        prototypes: { fill: { params: ['s32 *'], returnsVoid: true } },
        shape: /\baddi\s+r3,r1,8\b/,
        expect:
          's32 escarr(void) {\n    u8 sp8[16];\n    s32 *p0;\n    p0 = (s32 *)sp8;\n    fill((s32 *)sp8);\n' +
          '    return *p0 + p0[3];\n}\n',
      },
    ],
  ],
];

describe('frame objects and incoming stack arguments, lifted and recompiled on each build', () => {
  for (const [mwcc, label, flags, cases] of CASES) {
    for (const k of cases) {
      test.runIf(ppcDockerGate('ppc-frame', mwcc))(
        `${mwcc} at ${label}: ${k.sym}`,
        () => {
          const { obj, asm } = compilePpcTarget(mwcc, k.c, k.sym, flags);
          expect(asm).toMatch(k.shape);
          const r = decompile(k.sym, asm, targetFor(mwcc, flags).target, { prototypes: k.prototypes });
          expect(r.source).toBe(k.expect);
          const s = scoreCPpc(mwcc, r.source, k.sym, obj, flags);
          expect(s.score, JSON.stringify(s)).toBe(0);
          expect(s.match).toBe(true);
        },
        BUDGET,
      );
    }
  }
});

// TWO SHAPES THAT DO NOT MATCH, pinned on the builds the synthetic tier does not run, beside
// `synthetic:{homecall,tbval}:mwcc_242_81`. Mario Party 4's -O0,p homes a parameter at r1+8, below
// the array its callee is handed, and reloads it after the call: the reload proves the word a
// local's (`compilerBehaviors.localsAboveOutgoingArea`), so the function lifts — to the home as a
// word of the frame object, which is right and does not recompile to the same frame. A struct a
// header spells through a typedef, passed by value, is the address of a frame copy, and declines.
const BEYOND: [MwccToolchainId, readonly string[]][] = [
  ['mwcc_247_107', MP4_DOL],
  ['mwcc_233_163n', PIKMIN_C],
];
describe('a homed parameter beside a captured local lifts, and a typedef-spelled by-value struct declines', () => {
  const homecall = 'void fill(s32 *p);\ns32 homecall(s32 q){ s32 a[2]; fill(a); return a[0] + q; }';
  const tbval =
    'typedef struct { s32 x, y; } B_t;\ns32 tbT(s32 k, B_t b);\n' +
    's32 tbval(B_t *p){ B_t b; b = *p; return tbT(p->x, b); }';
  test.runIf(ppcDockerGate('ppc-frame', 'mwcc_247_107'))(
    'mwcc_247_107 at Mario Party 4 DOL flags: homecall',
    () => {
      const { obj, asm } = compilePpcTarget('mwcc_247_107', homecall, 'homecall', MP4_DOL);
      expect(asm).toMatch(/\bstw\s+r3,8\(r1\)/);
      const r = decompile('homecall', asm, targetFor('mwcc_247_107', MP4_DOL).target, {
        prototypes: { fill: { params: ['s32 *'], returnsVoid: true } },
      });
      expect(r.source).toBe(
        's32 homecall(s32 a0) {\n    u8 sp8[24];\n    *(s32 *)sp8 = a0;\n    fill((s32 *)((u32)sp8 + 4));\n' +
          '    return ((s32 *)sp8)[1] + *(s32 *)sp8;\n}\n',
      );
      const s = scoreCPpc('mwcc_247_107', r.source, 'homecall', obj, MP4_DOL);
      expect(s.score, JSON.stringify(s)).toBeGreaterThan(0);
    },
    BUDGET,
  );
  for (const [mwcc, flags] of BEYOND) {
    test.runIf(ppcDockerGate('ppc-frame', mwcc))(
      `${mwcc}: tbval`,
      () => {
        const { asm } = compilePpcTarget(mwcc, tbval, 'tbval', flags);
        expect(asm).toMatch(/\baddi\s+r\d+,r1,\d+\b/);
        expect(() =>
          decompile('tbval', asm, targetFor(mwcc, flags).target, { prototypes: { tbT: { params: ['s32', 'B_t'] } } }),
        ).toThrow(/takes its parameter 2 as 'B_t', which no word holds: a struct or union passed by value/);
      },
      BUDGET,
    );
  }
});
