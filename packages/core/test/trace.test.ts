// decompileTraced — the browser-pure traced tower (trace.ts). Pins the stage sequence, the
// pattern event shape, headline-source parity with decompile(), and the annotate stub path.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, MIPS_GCC } from '../src/target';
import { decompileTraced } from '../src/trace';

// agbcc's canonical Thumb x/2 — the SDIV_POW2_2 idiom shape (same asm as the playground example).
const HALF_ASM =
  '\t.code\t16\n\t.globl\thalf\n\t.thumb_func\nhalf:\n' +
  '\tlsr\tr1, r0, #31\n\tadd\tr0, r0, r1\n\tasr\tr0, r0, #1\n\tbx\tlr\n';

test('trace: stage sequence, pattern event, and source parity with decompile()', () => {
  const { source, report } = decompileTraced('half', HALF_ASM, ARMV4T_AGBCC);
  expect(source).toBe(decompile('half', HALF_ASM, ARMV4T_AGBCC).source);
  expect(report.trace.map((s) => s.id)).toEqual([
    'stage:lift',
    // The one stage whose product is not IR: the array shapes the assembly evidences for globals
    // no map describes (raise/globalshape.ts). It carries no `irDump` — its output is the symbol
    // shapes reported as `assumedSymbols` — but it is a stage, and a spelling change with no line
    // in the trail is a change attributable to nothing.
    'stage:globalshape',
    'stage:idiom',
    'stage:recover',
    'stage:structure',
    'stage:emit',
  ]);
  expect(report.trace.every((s) => s.verified)).toBe(true);
  // this asm names no global, so the stage assumes nothing and says so
  expect(report.assumedSymbols).toEqual([]);
  expect(report.trace.find((s) => s.id === 'stage:globalshape')?.note).toContain('nothing evidenced');

  expect(report.patternEvents).toHaveLength(1);
  const ev = report.patternEvents[0];
  expect(ev.patternId).toBe('sdiv-pow2/2');
  expect(ev.hits).toBe(1);
  expect(ev.beforeIr).not.toBe(ev.afterIr);
  expect(ev.afterIr).toContain('sdiv');
  // no probeScore hook ⇒ score fields stay unset (they belong to the cli's objdiff side)
  expect(ev.scoreBefore).toBeUndefined();
  expect(ev.scoreDelta).toBeUndefined();
});

test('trace: the STAGE reports what it derived, the REPORT what the source rests on', () => {
  // These are two different questions and the trace answers both, because they differ wherever a
  // consumer refused the shape (`kleod:SetupBG3WindowOverlay` on the corpus) or the caller's own
  // map already declared the name (`sa3:sa2__sub_8083504`). The stage note is the stage's own
  // product — a reader following `stage:lift` → `stage:structure` needs to see the shape that was
  // read — while `assumedSymbols` is the obligation handed to whoever pastes the source.
  const asm =
    '\t.code\t16\n.text\n\t.align\t2, 0\n\t.globl\tf\n\t.thumb_func\nf:\n' +
    '\tldr\tr2, .L3\n\tlsl\tr1, r0, #0x3\n\tsub\tr1, r1, r0\n\tlsl\tr1, r1, #0x2\n' +
    '\tadd\tr1, r1, r2\n\tldr\tr0, [r1]\n\tbx\tlr\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgBgInfo\n';
  const { source, report } = decompileTraced('f', asm, ARMV4T_AGBCC);
  // the 28-byte stride is recognized AFTER the derivation, and the struct-element access it
  // rewrites to has no bare spelling — so the source casts and assumes nothing…
  expect(source).toContain('((struct Elem0 *)&gBgInfo)[a0].field_0');
  expect(report.assumedSymbols).toEqual([]);
  // …while the stage still reports the 4-byte element it read, which is what makes the spelling
  // decision downstream attributable to a stage rather than to nothing.
  expect(report.trace.find((s) => s.id === 'stage:globalshape')?.note).toContain('gBgInfo: elem 4');
});

test('trace: probeScore hook fills the per-boundary score fields', () => {
  const probed: number[] = [7, 3];
  let i = 0;
  const { report } = decompileTraced('half', HALF_ASM, ARMV4T_AGBCC, { probeScore: () => probed[i++] });
  expect(report.patternEvents[0]).toMatchObject({ scoreBefore: 7, scoreAfter: 3, scoreDelta: -4 });
});

test('trace: a firing pre-recovery pass traces its registered stage entry', () => {
  // gcc-aget's variable-index array triggers the `arrays` legalize pass — pins the
  // PRE_RECOVERY_TRACE table's registered stage entry.
  const asm = readFileSync(join(import.meta.dirname, 'corpus', 'gcc-aget.asm'), 'utf8');
  const { report } = decompileTraced('aget', asm, MIPS_GCC);
  expect(report.trace.some((s) => s.id === 'stage:legalize')).toBe(true);
  expect(report.trace.find((s) => s.id === 'stage:legalize')!.title).toContain('scaled access');
});

test('trace: the symbols knob has decompile() parity — named lift dump, named source', () => {
  // The TraceOptions contract: every decompile() knob exists here with the same default. A
  // symbol map must name the pool word in the LIFT dump (gaddr op, not a constant) and keep
  // the headline source byte-identical to decompile() with the same map.
  const asm = 'f:\n\tldr\tr0, .L1\n\tldr\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n';
  const symbols = new Map([[0x03001234, [{ name: 'gCounter', kind: 'data' as const }]]]);
  const { source, report } = decompileTraced('f', asm, ARMV4T_AGBCC, { symbols });
  expect(source).toBe(decompile('f', asm, ARMV4T_AGBCC, { symbols }).source);
  expect(source).toContain('gCounter');
  const lift = report.trace.find((s) => s.id === 'stage:lift')!;
  expect(lift.irDump).toContain('gCounter');
  // and WITHOUT the map the traced tower stays inert — raw constant in dump and source alike
  const bare = decompileTraced('f', asm, ARMV4T_AGBCC);
  expect(bare.source).not.toContain('gCounter');
});

test('trace: a CALLEE signature in the symbol map reaches the lift, as it does in decompile()', () => {
  // The map's contribution is not just NAMES. `prototypesFromSymbols` turns a code symbol's DWARF
  // signature into a prototype, and the frontend reads that for the callee's ARITY — otherwise it
  // falls back to counting argument registers and guesses. Both towers must merge the same table,
  // or a trace explains a lift the real run never performed.
  const asm =
    'f:\n\tpush\t{lr}\n\tmov\tr0, #1\n\tmov\tr1, #2\n\tmov\tr2, #3\n' + '\tbl\tcallee\n\tpop\t{r1}\n\tbx\tr1\n';
  const int = { size: 4, signed: true };
  const symbols = new Map([
    [0x08000100, [{ name: 'callee', kind: 'code' as const, signature: { returns: null, params: [int] } }]],
  ]);
  const traced = decompileTraced('f', asm, ARMV4T_AGBCC, { symbols });
  expect(traced.source).toBe(decompile('f', asm, ARMV4T_AGBCC, { symbols }).source);
  // the signature says ONE parameter, so the call takes one — not the three the arg registers hold
  expect(traced.source).toContain('callee(1)');
});

test('trace: annotate mode degrades a hard failure to the stub, never a throw', () => {
  const { source, report } = decompileTraced('mystery', 'not assembly at all\n', ARMV4T_AGBCC, { onGap: 'annotate' });
  expect(report.trace).toEqual([]);
  expect(report.patternEvents).toEqual([]);
  expect(source).toContain('ASMLIFT_ERROR');
  expect(source).toBe(report.source);
});
