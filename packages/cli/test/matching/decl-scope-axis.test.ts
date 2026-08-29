// THE PREMISE `/regionbase` RESTS ON, compiled rather than asserted in prose.
//
// `l3/scopebase.ts` and `test/regionbase.test.ts` both say the same load-bearing compiler fact:
//
//     agbcc discriminates on how many distinct locals with disjoint live ranges exist, NOT on
//     where they are declared — the N-at-function-top spelling and the N-block-scoped one
//     assemble byte-identically.
//
// That is why the lever mints N locals at function top and places only their ASSIGNMENTS per
// region, and it is why the round did not build a nested declaration block in the emitter. The
// fact lived in a scratch directory and in two prose headers, with nothing to run: this repo's own
// idiom for a load-bearing compiler fact is a pinned test (test/sign-axis.test.ts,
// test/param-pointee-axis.test.ts, test/addr-placement.test.ts), so here it is, with the flags it
// was measured under — the klonoa checkout's own `tools.asmlift.compiler` template.
//
// BOTH DIRECTIONS. The placement being free is only half the claim; the other half is that the
// COUNT is not free. A third case collapses the three region locals into one function-scope local
// and must produce DIFFERENT bytes — otherwise the lever would be re-spelling nothing and the
// whole capability would be decoration.
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

const HAVE = kleodCheckoutGate('decl-scope-axis', ['decomp.yaml', 'tools/agbcc/bin/agbcc'], ['arm-none-eabi-objcopy']);

/** The dmascope shape: one DMA base spelled inside three disjoint regions. */
const body = (decls: string, then0: string, else0: string, tail0: string): string => `
void f(int n) {
${decls}
    if (n != 0) {
${then0}
        p0[0] = 1;
        p0[1] = 2;
    } else {
${else0}
        p1[0] = 3;
        p1[1] = 4;
    }
${tail0}
    p2[0] = 5;
    p2[1] = 6;
}
`;

// A — three locals, all DECLARED at function top, assigned per region (what the lever emits)
const TOP3 = body(
  '    volatile unsigned int *p0;\n    volatile unsigned int *p1;\n    volatile unsigned int *p2;',
  '        p0 = (volatile unsigned int *)0x040000D4;',
  '        p1 = (volatile unsigned int *)0x040000D4;',
  '    p2 = (volatile unsigned int *)0x040000D4;',
);

// B — the same three, DECLARED in the block that uses them (what the emitter cannot spell)
const BLOCK3 = `
void f(int n) {
    if (n != 0) {
        volatile unsigned int *p0 = (volatile unsigned int *)0x040000D4;
        p0[0] = 1;
        p0[1] = 2;
    } else {
        volatile unsigned int *p1 = (volatile unsigned int *)0x040000D4;
        p1[0] = 3;
        p1[1] = 4;
    }
    {
        volatile unsigned int *p2 = (volatile unsigned int *)0x040000D4;
        p2[0] = 5;
        p2[1] = 6;
    }
}
`;

// C — the COUNT collapsed: ONE function-scope local for all three regions
const ONE = `
void f(int n) {
    volatile unsigned int *p;
    p = (volatile unsigned int *)0x040000D4;
    if (n != 0) {
        p[0] = 1;
        p[1] = 2;
    } else {
        p[0] = 3;
        p[1] = 4;
    }
    p[0] = 5;
    p[1] = 6;
}
`;

describe.runIf(HAVE)('the DECLARATION-PLACEMENT axis (checkout-gated)', () => {
  const hex = new Map<string, string>();

  beforeAll(() => {
    const cfg = loadDecompConfig(join(CHECKOUT, 'decomp.yaml'));
    const template = cfg?.config.tools?.asmlift?.compiler;
    if (!template) {
      throw new Error('klonoa decomp.yaml lost its tools.asmlift.compiler key');
    }
    const compile = compileFromCommand(template, { cwd: CHECKOUT });
    for (const [name, src] of [
      ['top3', TOP3],
      ['block3', BLOCK3],
      ['one', ONE],
    ] as const) {
      const obj = compile(src, 'f', 'c');
      const bin = join(mkdtempSync(join(tmpdir(), 'asmlift-declscope-')), `${name}.bin`);
      const r = spawnSync('arm-none-eabi-objcopy', ['-O', 'binary', obj, bin], { encoding: 'utf8' });
      if (r.status !== 0) {
        throw new Error(`objcopy failed for ${name}: ${r.stderr}`);
      }
      hex.set(name, readFileSync(bin).toString('hex'));
    }
  }, 240_000);

  test('the three spellings really compiled — the pair below is not comparing two undefineds', () => {
    for (const k of ['top3', 'block3', 'one']) {
      expect(hex.get(k), k).toMatch(/^[0-9a-f]{32,}$/);
    }
  });

  test('WHERE the locals are declared does not change one byte', () => {
    // the fact `/regionbase` rests on: function-top declarations + per-region assignments are the
    // block-scoped spelling, as far as agbcc is concerned
    expect(hex.get('top3')).toBe(hex.get('block3'));
  });

  test('…while HOW MANY there are does — so the lever re-spells something real', () => {
    expect(hex.get('top3')).not.toBe(hex.get('one'));
  });
});
