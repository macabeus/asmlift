// Annotate mode (`onGap: "annotate"`) — the always-emit-something counterpart of the default
// strict loud-fail, with the loudness RELOCATED from the process (a throw) into the artifact
// (an undefined ASMLIFT_ERROR symbol — the m2c M2C_ERROR discipline). Contract under test:
//   1. a LOCALIZABLE gap (a live `opaque` from an unmodelled instruction) emits the full function
//      with an inline `ASMLIFT_ERROR("reason", operands…)` marker + a structured diagnostic;
//   2. a NON-localizable failure (an unliftable control transfer) degrades to a stub carrying the
//      reason and the ORIGINAL ASM as comments — never a bare throw;
//   3. a gap-free function emits byte-identically to strict mode with zero diagnostics (annotate
//      must not perturb the matching path);
//   4. strict mode stays the default and keeps its loud-fail behavior (the wider guarantee
//      lives in contract-invariant.test.ts; re-pinned here for contrast);
//   5. the emitted marker text and the structured diagnostics agree (one is the projection of the
//      other), and the whole thing is deterministic.
import { describe, expect, test } from 'vitest';

import { pascalBackend } from '../src/backend/pascal';
import { ContractError } from '../src/contracts';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, MIPS_IDO } from '../src/target';

// Probe shapes borrowed from contract-invariant.test.ts (the pinned live/dead opaque corpus).
const THUMB_LIVE_CLZ = 'clzlive:\n\tclz\tr0, r0\n\tbx\tlr\n'; // live opaque
const THUMB_DEAD_CLZ = 'clzdead:\n\tclz\tr1, r0\n\tadd\tr0, r0, #1\n\tbx\tlr\n'; // dead opaque
const THUMB_CLEAN = 'addone:\n\tadd\tr0, r0, #1\n\tbx\tlr\n'; // gap-free
const MIPS_JR_T9 = '0:\tlw\tt9,0(a0)\n4:\tjr\tt9\n8:\tnop\n'; // unliftable transfer

describe('annotate mode — localizable gap → inline marker', () => {
  test('live unmodelled instruction emits ASMLIFT_ERROR marker + diagnostic instead of throwing', () => {
    const res = decompile('clzlive', THUMB_LIVE_CLZ, ARMV4T_AGBCC, { onGap: 'annotate' });
    expect(res.source).toContain(`ASMLIFT_ERROR("unmodelled instruction 'clz'"`);
    // the marker carries the source operand for context, inside a complete function
    expect(res.source).toContain('return ASMLIFT_ERROR(');
    expect(res.diagnostics).toEqual([{ stage: 'structure', reason: "unmodelled instruction 'clz'" }]);
  });

  test('strict mode (the default) still fails loud on the same input', () => {
    expect(() => decompile('clzlive', THUMB_LIVE_CLZ, ARMV4T_AGBCC)).toThrow(ContractError);
  });

  test('a DEAD opaque stays harmless: no marker, no diagnostic, same clean source as strict', () => {
    const res = decompile('clzdead', THUMB_DEAD_CLZ, ARMV4T_AGBCC, { onGap: 'annotate' });
    expect(res.diagnostics).toEqual([]);
    expect(res.source).toBe('s32 clzdead(s32 a0) {\n    return a0 + 1;\n}\n');
  });
});

describe('annotate mode — non-localizable failure → stub with asm', () => {
  test('an unliftable control transfer degrades to a commented stub, not a throw', () => {
    const res = decompile('jrt9', MIPS_JR_T9, MIPS_IDO, { onGap: 'annotate' });
    expect(res.source).toContain("asmlift could not decompile 'jrt9'");
    expect(res.source).toContain('ASMLIFT_ERROR(');
    expect(res.source).toContain('jr'); // the original asm rides along as comments
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0].stage).toBe('lift');
    // strict mode still throws
    expect(() => decompile('jrt9', MIPS_JR_T9, MIPS_IDO)).toThrow();
  });

  test("a raise-pass decline is classified stage 'raise', not blamed on 'lift'", () => {
    // `ldr r0, [r0, #2]` = a word load at offset 2: not array-indexable (2 % 4 ≠ 0) and not a
    // naturally-aligned struct field, so struct recovery declines — a RAISE decline. Recording it
    // as a "lift" gap would misroute the report.
    const res = decompile('skewload', 'skewload:\n\tldr\tr0, [r0, #2]\n\tbx\tlr\n', ARMV4T_AGBCC, {
      onGap: 'annotate',
    });
    expect(res.diagnostics.length).toBe(1);
    expect(res.diagnostics[0].stage).toBe('raise');
    expect(res.diagnostics[0].reason).toMatch(/not naturally aligned/);
  });

  test('the stub honors the language backend seam (Pascal comments + undeclared marker)', () => {
    const res = decompile('jrt9', MIPS_JR_T9, MIPS_IDO, { onGap: 'annotate', backend: pascalBackend });
    expect(res.source).toContain("(* asmlift could not decompile 'jrt9'");
    expect(res.source).toContain("ASMLIFT_ERROR('"); // Pascal string quoting
    expect(res.source).not.toContain('/*'); // no C spelling leaked
  });
});

describe('annotate mode — gap-free functions are untouched', () => {
  test('emits byte-identically to strict mode, with zero diagnostics', () => {
    const strict = decompile('addone', THUMB_CLEAN, ARMV4T_AGBCC);
    const annotated = decompile('addone', THUMB_CLEAN, ARMV4T_AGBCC, { onGap: 'annotate' });
    expect(annotated.source).toBe(strict.source);
    expect(annotated.diagnostics).toEqual([]);
    expect(strict.diagnostics).toEqual([]);
  });

  test('annotate output is deterministic across runs', () => {
    const a = decompile('clzlive', THUMB_LIVE_CLZ, ARMV4T_AGBCC, { onGap: 'annotate' });
    const b = decompile('clzlive', THUMB_LIVE_CLZ, ARMV4T_AGBCC, { onGap: 'annotate' });
    expect(a.source).toBe(b.source);
    expect(a.diagnostics).toEqual(b.diagnostics);
  });
});
