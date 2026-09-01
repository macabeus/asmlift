// THE PREMISE THE DECLARED-SUBSCRIPT RECOVERY RESTS ON, compiled rather than asserted in prose.
//
// `structure/structure.ts`'s `declaredSubscripts` recovers `g[r][i]` from a byte residual carrying
// a term at the declared ROW stride, and it does so as a DEFAULT rather than as a differ-refereed
// axis. That is only legitimate if the asm DETERMINES which of the two candidate sources was
// written — i.e. if `g[r][i]` and the flat `g[0][r*N + i]` compile to different bytes. And the
// mirror matters just as much: where the compiler reassociates them into the SAME bytes, nothing
// referees the choice, which is why the recovery refuses the already-divided element index that
// `arrayAccess` holds (see the note at that site).
//
// Both halves lived in a commit message. This repo's idiom for a load-bearing compiler fact is a
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
    for (const k of ['pow2-two', 'pow2-flat', 'odd-two', 'odd-flat']) {
      expect(hex.get(k), k).toMatch(/^[0-9a-f]{16,}$/);
    }
  });

  test('at a POWER-OF-TWO row stride the two spellings DIFFER — so the asm decides, and a default is honest', () => {
    // `gRows[a][b]` leaves the row and element scales separate (`lsl #0xb`, `lsl #0x1`, added);
    // the flat sum scales once (`lsl #0xa; add; lsl #0x1`). The byte residual the recovery reads
    // carries that difference, which is what makes it evidence rather than a preference.
    expect(hex.get('pow2-two')).not.toBe(hex.get('pow2-flat'));
  });

  test('at a NON-power-of-two row stride they are IDENTICAL — so nothing referees, and the element path refuses', () => {
    // agbcc reassociates `(a*36) + (b*4)` into `((a*9) + b)*4` itself, which is byte-for-byte the
    // flat spelling. An index already divided into elements cannot tell the two apart, and
    // `arrayAccess` therefore declines rather than recovering a row it cannot have evidence for.
    expect(hex.get('odd-two')).toBe(hex.get('odd-flat'));
  });
});
