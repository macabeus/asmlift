// THE PROBE BEHIND `compilerBehaviors.narrowStoreConstantTakesLvalueType` (core target.ts), on every
// bench compiler. Each body stores one constant through a narrow lvalue; the lift is raised through
// the pre-recovery passes and the test reads the const each store takes, which is the register the
// compiler materialized, and the `signed` raise/storesign.ts stamped from it.
//
// The fact: the compiler converts the constant to the lvalue's type FIRST. `u16 = -1` loads 0xffff
// and `s16 = 0xFFFF` loads -1, so the upper bits say the type whenever the narrow sign bit is set.
// Every MIPS and PowerPC compiler lifts all eight bodies to a const. agbcc builds three of them out
// of two instructions the const fold does not take (`mov #1; neg` for -1, `mov #0x80; lsl #8` for
// 0x8000), so there the value is not a const and nothing is stamped — the fact holds, the reader
// does not see it.
//
// The SHARED bodies are the hazard the reader would have if a compiler reused one register for
// two narrow stores whose types differ: none does. Each store gets its own materialization.
import { defOpMap } from '@asmlift/core/ir/core';
import { applyIdiomPatterns, liftStamped, raiseRecovered } from '@asmlift/core/pipeline';
import { TOOLCHAIN_TARGETS, type TargetDescription } from '@asmlift/core/target';
import {
  type MwccToolchainId,
  compileMipsGcc272Target,
  compileMipsGccTarget,
  compileMipsTarget,
  compilePpcTarget,
  compileTargetAsm,
  gcc272Available,
} from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { kmcGate, ppcDockerGate } from './docker-gate';

const BUDGET = 300_000;

/** [symbol, body, the const each store takes on a compiler whose fold sees it] */
const BODIES: [string, string, number[]][] = [
  ['su16m1', 'void su16m1(u16 *p) { p[6] = -1; }', [65535]],
  ['ss16ffff', 'void ss16ffff(s16 *p) { p[6] = 0xFFFF; }', [-1]],
  ['su8m1', 'void su8m1(u8 *p) { p[1] = -1; }', [255]],
  ['ss8m1', 'void ss8m1(s8 *p) { p[1] = -1; }', [-1]],
  ['su16min', 'void su16min(u16 *p) { p[6] = -32768; }', [32768]],
  ['ss16min', 'void ss16min(s16 *p) { p[6] = -32768; }', [-32768]],
  ['su16big', 'void su16big(u16 *p) { p[6] = 0x1ffff; }', [65535]],
  ['ss16pos', 'void ss16pos(s16 *p) { p[6] = 0x7fff; }', [32767]],
  // shared: two types side by side, both orders, and a byte/half triple
  ['sh3', 'void sh3(u16 *p, s16 *r) { p[1] = -1; r[1] = -1; }', [65535, -1]],
  ['sh4', 'void sh4(s16 *r, u16 *p) { r[1] = -1; p[1] = -1; }', [-1, 65535]],
  ['sh5', 'void sh5(u8 *p, s8 *r, s16 *h) { p[1] = -1; r[1] = -1; h[1] = -1; }', [255, -1, -1]],
];

/** What agbcc's lift leaves at a store whose constant is not one instruction: `null`. */
const AGBCC_UNFOLDED = new Set(['ss16ffff', 'ss8m1', 'su16min', 'sh3:1', 'sh4:0', 'sh5:1', 'sh5:2']);

const read = (sym: string, asm: string, target: TargetDescription) => {
  const fn = liftStamped(sym, asm, target, {}, undefined, undefined);
  applyIdiomPatterns(fn, target);
  raiseRecovered(fn, target);
  const defs = defOpMap(fn);
  return fn.blocks.flatMap((b) =>
    b.ops
      .filter((o) => o.opcode === 'store')
      .map((o) => {
        const d = defs.get(o.operands[1]);
        return { value: d?.opcode === 'const' ? (d.attrs.value as number) : null, signed: o.attrs.signed };
      }),
  );
};

const expected = (sym: string, values: number[], agbcc: boolean) =>
  values.map((v, i) => {
    const hidden = agbcc && (AGBCC_UNFOLDED.has(sym) || AGBCC_UNFOLDED.has(`${sym}:${i}`));
    const value = hidden ? null : v;
    // what storesign stamps from that const: bit w-1 clear (32767) says nothing
    const signed = value === null || value === 32767 ? undefined : value < 0;
    return { value, signed };
  });

const PPC_FLAGS = TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags;
const PPC_O0 = [...PPC_FLAGS.filter((f) => f !== '-O4,p'), '-O0,p'];

const probes: [string, boolean, (c: string, sym: string) => string, TargetDescription][] = [
  [
    'gcc2.7.2',
    gcc272Available(),
    (c, s) => compileMipsGcc272Target(c, s, TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags).asm,
    TOOLCHAIN_TARGETS['gcc2.7.2'].description,
  ],
  [
    'gcc2.7.2kmc',
    kmcGate('narrow-store-constant'),
    (c, s) => compileMipsGccTarget(c, s, TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags).asm,
    TOOLCHAIN_TARGETS['gcc2.7.2kmc'].description,
  ],
  [
    'ido7.1',
    true,
    (c, s) => compileMipsTarget(c, s, TOOLCHAIN_TARGETS['ido7.1'].canonicalFlags).asm,
    TOOLCHAIN_TARGETS['ido7.1'].description,
  ],
  [
    'agbcc',
    true,
    (c) => compileTargetAsm(c, TOOLCHAIN_TARGETS.agbcc.canonicalFlags),
    TOOLCHAIN_TARGETS.agbcc.description,
  ],
  ...(['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'] as MwccToolchainId[]).map(
    (id): [string, boolean, (c: string, sym: string) => string, TargetDescription] => [
      id,
      ppcDockerGate('narrow-store-constant', id),
      (c, s) => compilePpcTarget(id, c, s, PPC_FLAGS).asm,
      TOOLCHAIN_TARGETS[id].description,
    ],
  ),
  [
    'mwcc_247_107 -O0,p',
    ppcDockerGate('narrow-store-constant', 'mwcc_247_107'),
    (c, s) => compilePpcTarget('mwcc_247_107', c, s, PPC_O0).asm,
    TOOLCHAIN_TARGETS.mwcc_247_107.description,
  ],
];

describe('a narrow store of a constant materializes the constant converted to the lvalue type', () => {
  for (const [name, have, compile, target] of probes) {
    test.runIf(have)(
      name,
      () => {
        expect(target.compilerBehaviors.narrowStoreConstantTakesLvalueType).toBe(true);
        for (const [sym, c, values] of BODIES) {
          expect({ sym, stores: read(sym, compile(c, sym), target) }).toEqual({
            sym,
            stores: expected(sym, values, name === 'agbcc'),
          });
        }
      },
      BUDGET,
    );
  }
});
