// THE PREMISE THE DECLARED-SUBSCRIPT RECOVERY RESTS ON, compiled rather than asserted in prose.
//
// `structure/globalaccess.ts`'s `declaredSubscripts` recovers `g[r][i]` from a byte residual
// carrying a term at the declared ROW stride, and it emits that spelling BESIDE the one it
// displaces — `/flat-rank` is the arm that turns it off, `spellDeclaredSubscripts` the switch — so
// the differ referees. THREE compiled facts are what settle that posture, and they pull in
// different directions:
//
//   • `g[r][i]` and the flat `g[0][r*N + i]` compile to DIFFERENT bytes, so the residual really is
//     evidence that a row was computed and not a preference;
//   • …and so do `g[r][i]` and the byte CAST the recovery displaces, which produces the same
//     row-stride term — so the residual says nothing about which of THOSE two was written, and a
//     default would be answering a question the asm does not ask. That pair is why this is an axis;
//   • where the compiler reassociates the flat sum into the same separate scales, nothing referees
//     any of it, which is why the recovery refuses the already-divided element index that
//     `arrayAccess` holds (see the note at that site).
//
// All of it lived in commit messages. This repo's idiom for a load-bearing compiler fact is a
// pinned test (matching/decl-scope-axis.test.ts, core/test/sign-axis.test.ts), so here it is, with
// the flags it was measured under — the klonoa checkout's own `tools.asmlift.compiler` template.
//
// GATE: needs the bench-owned klonoa checkout (`pnpm bench setup --project kleod --build`) plus
// arm-none-eabi-objcopy. Missing pieces skip GREEN, checkout-gate.ts style.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';

import { compileFromCommand } from '../../src/compile-command';
import { loadDecompConfig } from '../../src/config';
import { KLEOD_CHECKOUT as CHECKOUT, kleodCheckoutGate } from './checkout-gate';

const HAVE = kleodCheckoutGate('array-rank-axis', ['decomp.yaml', 'tools/agbcc/bin/agbcc'], ['arm-none-eabi-objcopy']);

// The klonoa template prepends the project context, which already carries `u16`/`u32` — only the
// two tables are ours, and both spellings of each pair reference the SAME symbol, so the literal
// pool is equal on both sides and the comparison is about the address arithmetic alone.
const DECLS = `extern u16 gRows[4][0x400];
extern u32 gSmall[6][9];
`;

// A POWER-OF-TWO row stride (0x800 bytes) — kleod's own `u16 gBgTilemapBufs[4][0x400]` shape.
const POW2_TWO = `${DECLS}u16 f(u32 a, u32 b) { return gRows[a][b]; }\n`;
const POW2_FLAT = `${DECLS}u16 f(u32 a, u32 b) { return gRows[0][(a << 10) + b]; }\n`;
// A NON-power-of-two row stride (36 bytes) — kleod's own `gUnk_0818B8E0[6][9]` shape.
const ODD_TWO = `${DECLS}u32 f(u32 a, u32 b) { return gSmall[a][b]; }\n`;
const ODD_FLAT = `${DECLS}u32 f(u32 a, u32 b) { return gSmall[0][a * 9 + b]; }\n`;
// …and the spelling the recovery DISPLACES, which is neither of those: the honest byte cast the
// flat residual used to take. This is the `/flat-rank` arm's source.
const POW2_CAST = `${DECLS}u16 f(u32 a, u32 b) { return *(u16 *)((a << 11) + (b << 1) + (u32)&gRows); }\n`;

describe.runIf(HAVE)('the DECLARED-SUBSCRIPT premise (checkout-gated)', () => {
  const hex = new Map<string, string>();

  beforeAll(() => {
    const cfg = loadDecompConfig(join(CHECKOUT, 'decomp.yaml'));
    const template = cfg?.config.tools?.asmlift?.compiler;
    if (!template) {
      throw new Error('klonoa decomp.yaml lost its tools.asmlift.compiler key');
    }
    const compile = compileFromCommand(template, { cwd: CHECKOUT });
    const dir = mkdtempSync(join(tmpdir(), 'asmlift-arrayrank-'));
    for (const [name, src] of [
      ['pow2-two', POW2_TWO],
      ['pow2-flat', POW2_FLAT],
      ['odd-two', ODD_TWO],
      ['odd-flat', ODD_FLAT],
      ['pow2-cast', POW2_CAST],
    ] as const) {
      const obj = compile(src, 'f', 'c');
      const bin = join(dir, `${name}.bin`);
      const r = spawnSync('arm-none-eabi-objcopy', ['-O', 'binary', obj, bin], { encoding: 'utf8' });
      if (r.status !== 0) {
        throw new Error(`objcopy failed for ${name}: ${r.stderr}`);
      }
      hex.set(name, readFileSync(bin).toString('hex'));
    }
  }, 240_000);

  test('all four spellings really compiled — the pairs below are not comparing two undefineds', () => {
    for (const k of ['pow2-two', 'pow2-flat', 'odd-two', 'odd-flat', 'pow2-cast']) {
      expect(hex.get(k), k).toMatch(/^[0-9a-f]{16,}$/);
    }
  });

  test('at a POWER-OF-TWO row stride the two spellings DIFFER — so the residual is evidence, not a preference', () => {
    // `gRows[a][b]` leaves the row and element scales separate (`lsl #0xb`, `lsl #0x1`, added);
    // the flat sum scales once (`lsl #0xa; add; lsl #0x1`). The byte residual the recovery reads
    // carries that difference, which is what makes it evidence rather than a preference.
    expect(hex.get('pow2-two')).not.toBe(hex.get('pow2-flat'));
  });

  // THE PAIR THAT MAKES THE RECOVERY AN AXIS RATHER THAN A DEFAULT, and it is the pair the two
  // tests above do not cover. The evidence the recovery reads is a term at the ROW stride, and the
  // cast spelling produces one too — its agbcc output is
  //
  //     lsl r0, r0, #0xb ; lsl r1, r1, #0x1 ; add r0, r0, r1 ; ldr r1, .L3 ; add ; ldrh
  //
  // the same separate scales, differing from `gRows[a][b]` only in where the pool load sits and
  // which registers carry the sum. So the residual says a row was computed and says nothing about
  // which source wrote it — while the two are still DIFFERENT programs, which is what makes the
  // question one the differ can answer and a default cannot.
  test('the recovered spelling and the CAST it displaces differ — a refereeable question, so both are enumerated', () => {
    expect(hex.get('pow2-cast')).not.toBe(hex.get('pow2-two'));
    // …and it is not the flat sum either: three distinct programs, one asm shape shared by two.
    expect(hex.get('pow2-cast')).not.toBe(hex.get('pow2-flat'));
  });

  test('at a NON-power-of-two row stride they are IDENTICAL — so nothing referees, and the element path refuses', () => {
    // agbcc reassociates `(a*36) + (b*4)` into `((a*9) + b)*4` itself, which is byte-for-byte the
    // flat spelling. An index already divided into elements cannot tell the two apart, and
    // `arrayAccess` therefore declines rather than recovering a row it cannot have evidence for.
    expect(hex.get('odd-two')).toBe(hex.get('odd-flat'));
  });
});
