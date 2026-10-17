// `loadedWordBound` (frontend/stackargs.ts) applies the contrapositive of a universal agbcc fact: the
// caller never loads a word of its outgoing area, so a word it loads is a local. The committed
// probe (`scripts/regen-outgoing-area-probes.ts`) is what that universal rests on — the callee may
// assign to the word, the caller re-stages an argument before every call rather than trust it to
// survive, and no call inside an argument makes it load one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { MIPS_FRAME_LOAD } from '../src/frontend/mips';
import { PPC_FRAME_LOAD } from '../src/frontend/ppc';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-restage.s'), 'utf8');

const body = (fn: string, end: string): string[] => {
  const lines = asm.split('\n').map((l) => l.trim());
  return lines.slice(lines.indexOf(`${fn}:`), lines.indexOf(`${end}:`));
};

test('the caller re-stages an unchanged argument before every call', () => {
  const twice = body('twice', '.Lfe1');
  const calls = twice.flatMap((l, i) => (l === 'bl\tfive' ? [i] : []));
  expect(calls).toHaveLength(2);
  // r5 holds `x * y` from before the first call to after the second, and is written once
  expect(twice.filter((l) => /^\S+\tr5, /.test(l))).toEqual([
    'mov\tr5, r0',
    'mul\tr5, r5, r1',
    'str\tr5, [sp]',
    'str\tr5, [sp]',
  ]);
  let from = 0;
  for (const at of calls) {
    expect(twice.slice(from, at)).toContain('str\tr5, [sp]');
    from = at + 1;
  }
  expect(twice.slice(from).some((l) => /\[sp\]/.test(l))).toBe(false);
});

test("the callee assigns to its incoming stack parameter, which is the caller's outgoing word", () => {
  const owns = body('owns', '.Lfe2');
  // one word pushed, so [sp,#4] is argument 5 — the caller's [sp,#0]
  expect(owns.slice(1, 5)).toEqual(['push\t{lr}', 'ldr\tr1, [sp, #0x4]', 'add\tr1, r1, r0', 'str\tr1, [sp, #0x4]']);
});

test('declared, both calls take the re-staged word as argument 5; undeclared, they decline', () => {
  const twice = asm.slice(asm.indexOf('twice:'), asm.indexOf('.Lfe1:'));
  expect(decompile('twice', twice, ARMV4T_AGBCC, { prototypes: { five: { params: 5 } } }).source).toBe(
    's32 twice(s32 a0, s32 a1) {\n    s32 v0;\n    v0 = five(1, 2, 3, 4, a0 * a1);\n' +
      '    return v0 + five(1, 2, 3, 4, a0 * a1);\n}\n',
  );
  // no word is loaded after a call, so no survivor bounds the area, and the undeclared calls decline
  expect(() => decompile('twice', twice, ARMV4T_AGBCC)).toThrow(/is never reloaded .* outgoing stack argument/);
});

// THE UNIVERSAL ITSELF: no load of the outgoing area, anywhere. agbcc's source says why
// (thumb.h:628 sets ACCUMULATE_OUTGOING_ARGS; calls.c:642 compiles save_fixed_argument_area only
// under REG_PARM_STACK_SPACE, which thumb.h never defines; calls.c:1599-1610 precomputes every
// argument that contains a call; and store_one_arg, calls.c:3420-3470, saves an argument word
// only when a nested call overlaps it, which that precompute rules out). These are the shapes that
// would read the area if anything did: libcalls in arguments 5 and 6 (`libcalls`), a five-argument
// call nested in a six-argument one (`nested`), a conditional call in an argument (`cond`), and
// spilled locals live across six-argument calls (`spills`, the positive control: its loads exist
// and all land above the area).
test('no function loads a word of its outgoing area, whatever its arguments call', () => {
  const words: Record<string, number> = { five: 1, six: 2, use: 0, pick: 0, __divsi3: 0, __modsi3: 0 };
  const fns = [...asm.matchAll(/^(\w+):$/gm)].map((m) => m[1]);
  expect(fns).toEqual(['twice', 'owns', 'libcalls', 'nested', 'cond', 'spills']);
  const loadsAbove: Record<string, number[]> = {};
  for (const fn of fns) {
    const lines = asm
      .slice(asm.indexOf(`${fn}:`))
      .split('\n')
      .map((l) => l.trim());
    const text = lines.slice(
      0,
      lines.findIndex((l) => l.startsWith('.size')),
    );
    const area = Math.max(0, ...text.flatMap((l) => (l.startsWith('bl\t') ? [4 * words[l.slice(3)]] : [])));
    const loads = text.flatMap((l) => {
      const m = /^ldr\t\w+, \[sp(?:, #(0x[0-9a-f]+))?\]$/.exec(l);
      return m ? [m[1] === undefined ? 0 : Number(m[1])] : [];
    });
    expect(text.filter((l) => /^ld\w*\t.*\bsp\b/.test(l))).toHaveLength(loads.length);
    expect(
      loads.filter((o) => o < area),
      fn,
    ).toEqual([]);
    loadsAbove[fn] = loads;
  }
  expect(loadsAbove.spills.length).toBeGreaterThan(0);
});

// THE SAME UNIVERSAL ON THE O32 AND mwcc COMPILERS, FROM A START OFFSET. `corpus/probe-outgoing-area.c`
// compiled at every level the rows use and at -O0 (`scripts/regen-outgoing-area-o32-mwcc-probes.ts`). The
// area is the frame bottom: on O32 the a0..a3 home `[0,16)` and the stack words from 16(sp), on
// PowerPC the callee's parameter area from 8(r1). Its extent per function is the widest call the
// declarations make, written out below in argument words: O32 counts every word (a double or a
// long long on an even word, a by-value aggregate in its words, a struct return's hidden pointer
// first), PowerPC only the words past r10 (a double travels in an FPR, an aggregate by a pointer).
const AREA: Record<string, { o32: number; ppc: number }> = {
  nested: { o32: 6, ppc: 0 }, // six(…, five(…), …)
  cond: { o32: 6, ppc: 0 },
  libdiv: { o32: 6, ppc: 0 }, // six; __divdi3/__moddi3 take 4
  nested2: { o32: 6, ppc: 0 },
  bystruct: { o32: 9, ppc: 0 }, // takes(int x4, struct S5)
  dbl: { o32: 6, ppc: 0 }, // dsix(double, double, int, int)
  pnest: { o32: 10, ppc: 2 }, // ten(…, nine(…), ten(…))
  pcond: { o32: 10, ppc: 2 },
  spills: { o32: 6, ppc: 0 },
  pspills: { o32: 10, ppc: 2 },
  c1: { o32: 6, ppc: 0 }, // ps(int, struct S5)
  c2: { o32: 6, ppc: 0 },
  c3: { o32: 7, ppc: 0 }, // ps2(int, struct S5, int)
  c4: { o32: 6, ppc: 0 }, // ps3(int, int, struct S3, int)
  c5: { o32: 6, ppc: 0 }, // dd(int, double @2, int, int)
  c6: { o32: 8, ppc: 0 }, // vf(x, 1.0 @2, pick, z, dpick @6)
  c7: { o32: 6, ppc: 0 },
  d1: { o32: 6, ppc: 0 },
  d2: { o32: 7, ppc: 0 },
  d3: { o32: 5, ppc: 0 }, // pc7(int, int, struct C7 = 2 words, int)
  d4: { o32: 5, ppc: 0 },
  d5: { o32: 5, ppc: 0 }, // pc11(int, struct C11 = 3 words, int)
  d6: { o32: 7, ppc: 0 },
  dstk: { o32: 6, ppc: 0 }, // fd(int x4, double @4)
  llstk: { o32: 7, ppc: 0 }, // fll(int x4, long long @4, int)
  llten: { o32: 11, ppc: 3 }, // tenll(int x8, long long, int)
  big1: { o32: 11, ppc: 0 }, // pb(int, struct S10)
  big2: { o32: 11, ppc: 0 },
  st5: { o32: 8, ppc: 0 }, // pb5(int x3, struct S5)
  sret1: { o32: 10, ppc: 2 }, // ten
  sret2: { o32: 8, ppc: 0 },
  sret3: { o32: 10, ppc: 2 },
  vbody: { o32: 10, ppc: 2 }, // vten(int x8, va_list, int)
  vcall: { o32: 14, ppc: 3 }, // vf(x, 1..8, 2.5 @10, pick, y)
  krs: { o32: 14, ppc: 2 }, // kr(int x8, struct S5, int), unprototyped
  krf: { o32: 9, ppc: 0 }, // kr(x, (double)f @2, x, (double)f @6, pick)
  j1: { o32: 10, ppc: 2 },
  j2: { o32: 10, ppc: 2 },
  j3: { o32: 18, ppc: 0 }, // pbig(int, struct S16, int)
  j4: { o32: 14, ppc: 2 }, // tenS(int x8, struct S5, int)
  j5: { o32: 14, ppc: 2 },
};

// The loads are the PRODUCTION lists the frontends' loaded-word bounds scan, not copies of them; a
// load mnemonic missing from one is caught by the classification test below, which asks every
// memory mnemonic the probes compiled to be one of these or a store.
const MIPS_LOAD = MIPS_FRAME_LOAD;
const PPC_LOAD = PPC_FRAME_LOAD;
const MIPS_STORE = /^(sb|sh|sw|swl|swr|sd|sdl|sdr|sc|swc1|sdc1)$/;
const PPC_STORE = /^(stb|sth|stw|stmw|stbu|sthu|stwu|stfs|stfd|stfsu|stfdu|stfiwx|psq_st|psq_stu)$/;
const width = (mnemonic: string, dest: string): number =>
  mnemonic === 'lmw'
    ? 4 * (32 - Number(dest.slice(1)))
    : /^(ld|ldl|ldr|ldc1|lfd|lfdu|psq_l|psq_lu)$/.test(mnemonic)
      ? 8
      : 4;

/** Every frame byte range each function of a fixture loads, through the stack pointer or a register
 *  holding a copy of it (`move s8,sp`, `addiu t9,sp,K`, `addi r3,r1,K`) until that register is
 *  written again — so a frame pointer at -O0 is read as the frame it points into. */
const frameLoads = (fixture: string): Map<string, { at: number; end: number; text: string }[]> => {
  const text = readFileSync(join(import.meta.dirname, 'corpus', fixture), 'utf8');
  const ppc = text.includes('elf32-powerpc');
  const sp = ppc ? 'r1' : 'sp';
  const out = new Map<string, { at: number; end: number; text: string }[]>();
  for (const part of text.split(/^[0-9a-f]+ </m).slice(1)) {
    const name = part.slice(0, part.indexOf('>'));
    const copies = new Map<string, number>([[sp, 0]]);
    const loads: { at: number; end: number; text: string }[] = [];
    for (const line of part.split('\n')) {
      const m = /^\s*[0-9a-f]+:\t(\S+)\s*(.*)$/.exec(line);
      if (m === null) {
        continue;
      }
      const [, mnemonic, rest] = m;
      const ops = rest.split(',').map((o) => o.trim());
      const mem = ops.map((o) => /^(-?\d+)\((\w+)\)$/.exec(o)).find((x) => x !== null);
      if ((ppc ? PPC_LOAD : MIPS_LOAD).test(mnemonic) && mem !== undefined && copies.has(mem[2])) {
        const at = copies.get(mem[2])! + Number(mem[1]);
        loads.push({ at, end: at + width(mnemonic, ops[0]), text: `${mnemonic} ${rest}` });
      }
      // a write to a register ends what it held; a copy of the stack pointer starts one
      const writes = !/^(s[bhwd]\w*|st\w*|psq_st\w*|b\w*|j|jal|jr|cmp\w*|mt\w*)$/.test(mnemonic);
      if (writes && ops[0] !== sp) {
        const copy = ppc
          ? /^(mr|addi)$/.test(mnemonic) && ops[1] === sp
            ? Number(ops[2] ?? 0)
            : undefined
          : (mnemonic === 'move' && ops[1] === sp) || (/^addiu?$/.test(mnemonic) && ops[1] === sp)
            ? Number(ops[2] ?? 0)
            : undefined;
        if (copy !== undefined) {
          copies.set(ops[0], copy);
        } else {
          copies.delete(ops[0]);
        }
      }
    }
    out.set(name, loads);
  }
  return out;
};

/** Every mnemonic each fixture uses with an `off(rA)` memory operand. */
const memoryMnemonics = (fixture: string): Set<string> => {
  const text = readFileSync(join(import.meta.dirname, 'corpus', fixture), 'utf8');
  return new Set(
    [...text.matchAll(/^[ \t]*[0-9a-f]+:\t(\S+)[ \t]*(.*)$/gm)].flatMap(([, mnemonic, rest]) =>
      /(^|,)\s*-?\d+\(\$?\w+\)\s*$/.test(rest) ? [mnemonic] : [],
    ),
  );
};

const O32_FIXTURES = [
  ...['ido71', 'ido71-O0', 'ido71-O1', 'ido71-g3'],
  ...['gcc272kmc', 'gcc272kmc-O0', 'gcc272', 'gcc272-O0', 'gcc272-O2'],
];
const MWCC_FIXTURES = [
  ...['mwcc242', 'mwcc242mp4', 'mwcc242acd'],
  ...['mwcc247', 'mwcc247mp4', 'mwcc233', 'mwcc233-O4p', 'mwcc233-O0'],
];

describe.each([
  ...O32_FIXTURES.map((f) => ({ fixture: f, from: 16, areaEnd: (w: { o32: number }) => 4 * Math.max(4, w.o32) })),
  ...MWCC_FIXTURES.map((f) => ({ fixture: f, from: 8, areaEnd: (w: { ppc: number }) => 8 + 4 * w.ppc })),
])('$fixture loads no word of its outgoing area at or above $from', ({ fixture, from, areaEnd }) => {
  const fns = frameLoads(`${fixture}-outarea.txt`);
  test('every probe is compiled and sized', () => {
    expect([...fns.keys()].sort()).toEqual(Object.keys(AREA).sort());
  });
  test('every memory mnemonic is a load the frontend bound scans, or a store', () => {
    const [load, store] = from === 16 ? [MIPS_LOAD, MIPS_STORE] : [PPC_LOAD, PPC_STORE];
    const seen = [...memoryMnemonics(`${fixture}-outarea.txt`)];
    expect(seen.filter((m) => !load.test(m) && !store.test(m))).toEqual([]);
    expect(seen.some((m) => load.test(m))).toBe(true);
  });
  test('no load reaches [from, area end)', () => {
    const inArea = [...fns].flatMap(([fn, loads]) =>
      loads.filter((l) => l.end > from && l.at < areaEnd(AREA[fn])).map((l) => `${fn}: ${l.text}`),
    );
    expect(inArea).toEqual([]);
  });
  test('the positive controls load spills, and they land above the area', () => {
    for (const fn of ['spills', 'pspills']) {
      expect(fns.get(fn)!.filter((l) => l.at >= areaEnd(AREA[fn])).length, fn).toBeGreaterThan(0);
    }
  });
});

// WHY THE START OFFSET IS NOT 0 ON O32. ido stages a by-value aggregate's register words into the
// a1..a3 home words and loads them back into the registers before the call (`big1`: `lw a1,4(sp)`
// …), and kmc and gcc 2.7.2 do the same for a char-array struct (`d3`, `d5`) — so a bound from 0
// would read the home word as a local and drop the aggregate's tail staged at 16(sp) and up.
test('O32 compilers load the a0..a3 home words they stage a by-value aggregate in', () => {
  const home = (fixture: string, fn: string) =>
    frameLoads(`${fixture}-outarea.txt`)
      .get(fn)!
      .filter((l) => l.at < 16)
      .map((l) => l.at);
  expect(home('ido71', 'big1')).toEqual(expect.arrayContaining([4, 8, 12]));
  expect(home('ido71-O0', 'big1')).toEqual(expect.arrayContaining([4, 8, 12]));
  expect(home('gcc272kmc', 'd3').length).toBeGreaterThan(0);
  expect(home('gcc272', 'd5').length).toBeGreaterThan(0);
});

// The universal is stated per compiler, from the offset its own probe measured: agbcc's from 0,
// the three O32 toolchains' past the a0..a3 home, mwcc's from the parameter area. Every claimant
// states the after-call form too, which the strong form requires.
test('each claimant states the start offset its probe measured, and the after-call form', () => {
  const claims = Object.fromEntries(
    Object.entries(TOOLCHAIN_TARGETS).flatMap(([tc, t]) => {
      const from = t.description.compilerBehaviors.outgoingAreaNeverLoadedFrom;
      return from === undefined ? [] : [[tc, from]];
    }),
  );
  expect(claims).toEqual({
    agbcc: 0,
    'ido7.1': 16,
    'gcc2.7.2kmc': 16,
    'gcc2.7.2': 16,
    mwcc_242_81: 8,
    mwcc_247_107: 8,
    mwcc_233_163n: 8,
  });
  for (const t of Object.values(TOOLCHAIN_TARGETS)) {
    if (t.description.compilerBehaviors.outgoingAreaNeverLoadedFrom !== undefined) {
      expect(t.description.compilerBehaviors.localsAboveOutgoingArea).toBe(true);
    }
  }
  expect(ARMV4T_AGBCC.compilerBehaviors.localsAboveOutgoingArea).toBe(true);
});
