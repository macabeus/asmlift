// THE PLACEMENT DIFFERENTIAL, one composition inwards.
//
// `rank.ts`'s `respell` re-checks a lever's placement across the statement SHAPES derived onto it.
// The lever-on-lever products in the same file were outside that check: `sinkInitsToFirstUse(…)`
// and `nearBaseClusters(…)` run on a tree a PLACING lever already built, and the composition
// happens INSIDE one `make()` thunk, so the intermediate tree never reached the differential. A
// def-MOVING pass can move a def below a use exactly as a shape can — and a base local whose
// assignment does not reach its use is a DIFFERENT VARIABLE, C that compiles, scores and can win.
//
// The mover is mocked because no corpus input makes the real `sinkInitsToFirstUse` do this — the
// guard is for the class, not for a row, and a test that waited for a row would be a test that
// never runs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import type { SFn } from '../src/l3/ast';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

vi.mock('../src/l3/sinkinit', () => ({
  // every top-level assignment to the END of the body — the minted base locals included, so their
  // defs land below the uses they were placed to serve
  sinkInitsToFirstUse: (sfn: SFn): SFn => ({
    ...sfn,
    body: [...sfn.body.filter((s) => s.k !== 'assign'), ...sfn.body.filter((s) => s.k === 'assign')],
  }),
}));

describe('a def-moving pass composed onto a placing lever is judged', () => {
  const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-dmascope.s'), 'utf8');
  const errors: { label: string; error: string }[] = [];
  const cands = enumerateCandidates('dmascope', asm, ARMV4T_AGBCC, {
    prototypes: { dmascope: { params: ['s32'], returnsVoid: true } },
    onLeverError: (label, error) => errors.push({ label, error }),
  });

  test('the composition is DROPPED, not scored', () => {
    // `/livebase/sinkinit` and `/nearbase/sinkinit` both fire on this disassembly, and both mint
    // the locals the mover then strands.
    expect(cands.filter((c) => /(livebase|nearbase)\/(volatile\/)?(nearbase\/)?sinkinit/.test(c.label))).toEqual([]);
  });

  test('…and it is REPORTED, with the composed label naming it', () => {
    const named = errors.filter((e) => e.label.includes('sinkinit'));
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((e) => /assignment does not reach/.test(e.error))).toBe(true);
  });

  test('…while `/sinkinit` on the BASE tree is untouched — it mints nothing to strand', () => {
    // the differential judges MINTED locals only, so a mover applied to the primary tree is not
    // this check's business and stays in the fan.
    expect(cands.some((c) => c.label.endsWith('/sinkinit') && !/livebase|nearbase/.test(c.label))).toBe(true);
  });
});
