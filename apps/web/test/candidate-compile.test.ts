// The playground's candidate-compile path, in the two halves a node test can run: the
// TRANSLATION UNIT a candidate is compiled in (typedef prelude + synthesized declarations) and
// the ONE LINE of a failed tool's stderr the UI shows. Both live in
// src/pages/playground/candidate-compile.ts because score-wasm.ts itself cannot be imported here
// — it pulls in the `agbcc` package, whose `lib/config.json` import fails under vitest's ESM
// loader ('needs an import attribute of "type: json"') and whose wasm has no fetch in node.
//
// THE ACCEPTANCE TEST IS THE BUG REPORT: `kleod:UpdateWorldMapNodeTile:agbcc`, opened from the
// Benchmark view with "Open in playground", produced
// "ranking unavailable — no scorable candidate ... in.i: In function `UpdateWorldMapNodeTile':".
// Two bugs made that line: the candidates named three pool globals nobody declared (core, fixed
// in rank.ts), and the reported stderr line was the useless header instead of the diagnosis.
import { enumerateCandidates } from '@asmlift/core/rank';
import { ARMV4T_AGBCC, C_TYPEDEFS } from '@asmlift/core/target';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { canOpenInPlayground, playgroundShare } from '../src/pages/benchmark/lib/playground';
import { candidateContext, firstDiagnosticLine } from '../src/pages/playground/candidate-compile';

// gcc 2.9 (the pinned agbcc), VERBATIM, compiling the very candidate the bug report names — the
// stderr of `agbcc in.i -mthumb-interwork -Wimplicit -Wparentheses -O2 -fhex-asm
// -fprologue-bugfix` before the core fix. Note what it does NOT contain: the string "Error:".
const AGBCC_UNDECLARED = [
  "/tmp/uwm/fail-1.i: In function `UpdateWorldMapNodeTile':",
  "/tmp/uwm/fail-1.i:24: `gUnk_08116880' undeclared (first use in this function)",
  '/tmp/uwm/fail-1.i:24: (Each undeclared identifier is reported only once',
  '/tmp/uwm/fail-1.i:24: for each function it appears in.)',
  "/tmp/uwm/fail-1.i:27: `gBgTilemapBufs' undeclared (first use in this function)",
  "/tmp/uwm/fail-1.i:27: `gUnk_08116748' undeclared (first use in this function)",
  '/tmp/uwm/fail-1.i:27: warning: suggest parentheses around + or - inside shift',
  '/tmp/uwm/fail-1.i:28: warning: suggest parentheses around + or - inside shift',
].join('\n');

// GNU as, VERBATIM (arm-none-eabi-as on a deliberately broken `.s`) — the OTHER call site
// (`could not assemble the target asm`), and the reason the `Error:` pattern exists at all: the
// first line is a banner, and preferring `Error:` is what keeps it out of the UI.
const GNU_AS_ERRORS = [
  'bad.s: Assembler messages:',
  "bad.s:4: Error: bad instruction `bogusinsn r0,r1'",
  "bad.s:5: Error: ARM register expected -- `ldr r0,['",
].join('\n');

describe('the one stderr line the UI shows', () => {
  test('gcc 2.9: the DIAGNOSIS, never the "In function" header (the reported bug)', () => {
    // gcc 2.9 never prints "Error:", so the old `find('Error:')` could not match on this
    // compiler at all and the fallback — first non-empty line — was the only branch it took.
    expect(AGBCC_UNDECLARED).not.toContain('Error:');
    expect(firstDiagnosticLine(AGBCC_UNDECLARED)).toBe(
      "/tmp/uwm/fail-1.i:24: `gUnk_08116880' undeclared (first use in this function)",
    );
    expect(firstDiagnosticLine(AGBCC_UNDECLARED)).not.toContain('In function');
  });

  test('GNU as: the first Error: still beats the "Assembler messages:" banner', () => {
    expect(firstDiagnosticLine(GNU_AS_ERRORS)).toBe("bad.s:4: Error: bad instruction `bogusinsn r0,r1'");
  });

  test('a warning is never preferred over an error on the same file', () => {
    const s = ["x.i: In function `f':", 'x.i:3: warning: suggest parentheses', "x.i:9: `g' undeclared"].join('\n');
    expect(firstDiagnosticLine(s)).toBe("x.i:9: `g' undeclared");
  });

  test('warnings-only output still reports a line, not the header', () => {
    const s = ["x.i: In function `f':", 'x.i:3: warning: suggest parentheses'].join('\n');
    expect(firstDiagnosticLine(s)).toBe('x.i:3: warning: suggest parentheses');
  });

  test('total: a single-line message passes through, empty gives empty', () => {
    // The third call site summarises an ALREADY-THROWN Error's `.message` — normally the single
    // line the other two built — so a passthrough that mangles it would double-mangle the UI.
    expect(firstDiagnosticLine("agbcc could not compile candidate 'unsigned': boom")).toBe(
      "agbcc could not compile candidate 'unsigned': boom",
    );
    expect(firstDiagnosticLine('')).toBe('');
    expect(firstDiagnosticLine('\n\n  \nlast resort\n')).toBe('last resort');
  });
});

describe('the reported row ranks: kleod:UpdateWorldMapNodeTile:agbcc, opened in the playground', () => {
  const results = JSON.parse(
    readFileSync(join(import.meta.dirname, '../src/pages/benchmark/data/results.json'), 'utf8'),
  ) as { results: { id: string }[] };
  const row = results.results.find((r) => r.id === 'kleod:UpdateWorldMapNodeTile:agbcc')!;

  test('every candidate compiles in a TU that declares the globals its source spells', () => {
    // The exact hand-off the Benchmark view performs, then the exact enumeration + context the
    // scorer feeds agbcc-wasm (score-wasm.ts) — the only step not run here is the wasm compile.
    expect(canOpenInPlayground(row as never)).toBe(true);
    const share = playgroundShare(row as never)!;
    expect(share.target).toBe('agbcc'); // ranking is gated to the agbcc target (Playground.tsx)
    expect(share.name).toBe('UpdateWorldMapNodeTile'); // the row's symbol, carried by the hand-off
    const cands = enumerateCandidates(share.name!, share.asm, ARMV4T_AGBCC);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      const tu = candidateContext(c) + c.source;
      expect(tu.startsWith(C_TYPEDEFS)).toBe(true);
      for (const name of c.source.match(/\bg[A-Za-z_]\w*/g) ?? []) {
        expect(tu).toContain(`extern u32 ${name};`);
      }
    }
    // the three the bug report names, from this row's own literal pool
    expect(candidateContext(cands[0])).toContain('extern u32 gUnk_08116880;');
    expect(candidateContext(cands[0])).toContain('extern u32 gBgTilemapBufs;');
    expect(candidateContext(cands[0])).toContain('extern u32 gUnk_08116748;');
  });

  test('a candidate that names no symbol gets the bare prelude (no empty declaration block)', () => {
    expect(candidateContext({ source: '', label: 'x' } as never)).toBe(C_TYPEDEFS);
  });
});
