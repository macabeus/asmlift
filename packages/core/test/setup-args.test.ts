// The `/setup-args` lever (rank.ts, frontend/ssa.ts narrowToSetupArgs) — the arity a
// prototype-less call gets when only the CALLING BLOCK's own setup counts. Pins: that the wider
// reading stays the default, that the narrower one is offered beside it, that the pair collapses
// where the two agree, and that a declared arity is outside the lever's reach entirely.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

const P = { f: { returnsVoid: true } };
const fn = (body: string) => `f:\n\tpush\t{lr}\n${body}\tpop\t{r0}\n\tbx\tlr\n`;
const cands = (body: string, pool = '') => enumerateCandidates('f', fn(body) + pool, ARMV4T_AGBCC, { prototypes: P });

// kleod's GameUpdate: a global read for the guard, and a call on the guarded path that sets up
// nothing of its own. Whether the source passed the guarded value is what the two arms disagree on.
const GUARDED_CALL = '\tldr\tr0, .Lp\n\tldrb\tr0, [r0]\n\tcmp\tr0, #0\n\tbne\t.L1\n\tbl\tbar\n.L1:\n';
const POOL = '.Lp:\n\t.word\t0x3000000\n';

describe('a guessed argument that survived from an earlier block', () => {
  test('is passed by default — compiled code really does leave one in place and branch to the call', () => {
    expect(decompile('f', fn(GUARDED_CALL) + POOL, ARMV4T_AGBCC, { prototypes: P }).source).toContain('bar(v0)');
  });

  test('…and is dropped by the `/setup-args` sibling, which is enumerated beside it', () => {
    const cs = cands(GUARDED_CALL, POOL);
    expect(cs.some((c) => c.source.includes('bar(v0)'))).toBe(true);
    expect(cs.some((c) => /bar\(\)/.test(c.source))).toBe(true);
    expect(cs.some((c) => c.label.includes('/setup-args'))).toBe(true);
  });

  test('the lever is inert where the calling block set every argument up itself', () => {
    // Nothing to disagree about: `mov r0,#1` is this block's own setup, so both readings are 1.
    const body = '\tmov\tr0, #1\n\tbl\tbar\n';
    expect(cands(body).every((c) => c.source.includes('bar(1)'))).toBe(true);
    expect(cands(body).some((c) => c.label.includes('/setup-args'))).toBe(false);
  });

  test('a DECLARED arity is not the lever’s to narrow', () => {
    // The headers already answered the question the lever exists to ask, so no sibling is offered
    // and the argument survives in every spelling.
    const cs = enumerateCandidates('f', fn(GUARDED_CALL) + POOL, ARMV4T_AGBCC, {
      prototypes: { ...P, bar: { params: 1 } },
    });
    expect(cs.every((c) => c.source.includes('bar(v0)'))).toBe(true);
    expect(cs.some((c) => c.label.includes('/setup-args'))).toBe(false);
  });
});
