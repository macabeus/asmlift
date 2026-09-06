// The register-copy re-spelling (l3/regspell.ts) — the fourth differ-ranked lever. Pins: the
// three rewrites' goldens (R1 diamond→copy+in-place, R2 const staging, R3 tail assign-back with
// the dead-var reuse the match depends on); decline shapes; purity.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { Expr, SFn } from '../src/l3/ast';
import { registerishSpellings } from '../src/l3/regspell';
import { c, v } from './helpers';

/** the MultiplyQ8 shape: `if (E >= 0) v0 = E; else v0 = E + 255; return v0 << 8 >> 16;` */
function diamond(E: Expr): SFn {
  return {
    name: 'f',
    retType: T.s(32),
    params: [
      { name: 'a0', type: T.u(32) },
      { name: 'a1', type: T.u(32) },
    ],
    locals: [{ name: 'v0', type: T.s(32) }],
    body: [
      {
        k: 'if',
        cond: { k: 'bin', op: '>=', l: E, r: c(0) },
        then: [{ k: 'assign', name: 'v0', value: E }],
        else: [{ k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: E, r: c(255) } }],
      },
      {
        k: 'return',
        value: {
          k: 'bin',
          op: '>>',
          l: { k: 'bin', op: '<<', l: v('v0'), r: c(8) },
          r: c(16),
        },
      },
    ],
  };
}
const MUL: Expr = {
  k: 'bin',
  op: '*',
  l: { k: 'cast', to: T.s(16), e: v('a0') },
  r: { k: 'cast', to: T.s(16), e: v('a1') },
};

describe('R1 — diamond → copy + in-place update', () => {
  test('the MultiplyQ8 shape re-spells with the copy, flipped guard, and downstream rename', () => {
    const out = registerishSpellings(diamond(MUL));
    expect(out.length).toBe(3); // base + both R3 tails (reuse / fresh)
    const src = cBackend.emit(out[0].sfn);
    expect(src).toContain('v0 = (s16)a0 * (s16)a1;');
    expect(src).toContain('w0 = v0;');
    expect(src).toContain('if (w0 < 0) w0 = w0 + 255;'); // update arm reads the COPY, in place
    expect(src).toContain('return w0 << 8 >> 16;'); // downstream renamed v0 → w0
  });

  test('R3 reuses the DEAD value var for the tail (the byte-exactness depends on it)', () => {
    const src = cBackend.emit(registerishSpellings(diamond(MUL))[1].sfn);
    expect(src).toContain('v0 = w0 << 8 >> 16;'); // reused v0, not a fresh w1
    expect(src).toContain('return v0;');
  });

  test('an impure diamond (call in E) declines', () => {
    expect(registerishSpellings(diamond({ k: 'call', fn: 'g', args: [] }))).toHaveLength(0);
  });

  test('the input is never mutated', () => {
    const sfn = diamond(MUL);
    const before = JSON.stringify(sfn);
    registerishSpellings(sfn);
    expect(JSON.stringify(sfn)).toBe(before);
  });
});

describe('R2 — constant-expression staging', () => {
  test('a const-only subtree operand moves into its own local (the ReciprocalQ8 shape)', () => {
    const sfn: SFn = {
      name: 'f',
      retType: T.s(32),
      params: [{ name: 'a0', type: T.u(32) }],
      locals: [],
      body: [
        {
          k: 'return',
          value: {
            k: 'bin',
            op: '/',
            l: { k: 'bin', op: '<<', l: c(128), r: c(9) },
            r: { k: 'cast', to: T.s(16), e: v('a0') },
          },
        },
      ],
    };
    const out = registerishSpellings(sfn);
    expect(out.length).toBeGreaterThan(0);
    const src = cBackend.emit(out[0].sfn);
    expect(src).toContain('w0 = 128 << 9;');
    expect(src).toContain('return w0 / (s16)a0;');
  });

  test('a bare const operand does NOT stage (no depth-0 noise)', () => {
    const sfn: SFn = {
      name: 'f',
      retType: T.s(32),
      params: [{ name: 'a0', type: T.s(32) }],
      locals: [],
      body: [{ k: 'return', value: { k: 'bin', op: '+', l: v('a0'), r: c(5) } }],
    };
    expect(registerishSpellings(sfn)).toHaveLength(0);
  });
});

describe('adversarial-round guards', () => {
  test('a diamond INSIDE a loop declines (the downstream rename cannot see the next iteration)', () => {
    const sfn: SFn = {
      name: 'f',
      retType: T.s(32),
      params: [
        { name: 'a0', type: T.s(32) },
        { name: 'a1', type: T.s(32) },
      ],
      locals: [{ name: 'v0', type: T.s(32) }],
      body: [
        { k: 'assign', name: 'v0', value: c(0) },
        {
          k: 'while',
          cond: { k: 'bin', op: '<', l: v('a1'), r: c(10) },
          body: [
            {
              k: 'if',
              cond: { k: 'bin', op: '>=', l: v('a0'), r: c(0) },
              then: [{ k: 'assign', name: 'v0', value: v('a0') }],
              else: [{ k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: v('a0'), r: c(255) } }],
            },
          ],
        },
        { k: 'return', value: v('v0') },
      ],
    };
    expect(registerishSpellings(sfn)).toHaveLength(0);
  });

  test('a cond whose OTHER operand mentions v declines (the clamp shape)', () => {
    const sfn: SFn = {
      name: 'f',
      retType: T.s(32),
      params: [{ name: 'a0', type: T.s(32) }],
      locals: [{ name: 'v0', type: T.s(32) }],
      body: [
        { k: 'assign', name: 'v0', value: c(7) },
        {
          k: 'if',
          cond: { k: 'bin', op: '<', l: v('a0'), r: v('v0') },
          then: [{ k: 'assign', name: 'v0', value: v('a0') }],
          else: [{ k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: v('a0'), r: c(5) } }],
        },
        { k: 'return', value: v('v0') },
      ],
    };
    expect(registerishSpellings(sfn)).toHaveLength(0);
  });

  test("the copy carries E's RENDERED type, not v's declared one (comparison sense)", () => {
    const sfn: SFn = {
      name: 'f',
      retType: T.s(32),
      params: [{ name: 'a0', type: T.u(32) }],
      locals: [{ name: 'v0', type: T.s(32) }],
      body: [
        {
          k: 'if',
          cond: { k: 'bin', op: '>', l: v('a0'), r: c(5) },
          then: [{ k: 'assign', name: 'v0', value: v('a0') }],
          else: [{ k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: v('a0'), r: c(3) } }],
        },
        { k: 'return', value: v('v0') },
      ],
    };
    const out = registerishSpellings(sfn);
    expect(out.length).toBeGreaterThan(0);
    const src = cBackend.emit(out[0].sfn);
    expect(src).toContain('u32 w0;'); // E (a0) is u32 — the compare keeps its unsignedness
  });

  test('BOTH R3 tails are ranked when R1 fired (the tail choice is allocator-ambiguous)', () => {
    const out = registerishSpellings(diamond(MUL));
    expect(out).toHaveLength(3); // base, tail-reuse, tail-fresh
    const reuse = cBackend.emit(out[1].sfn);
    const fresh = cBackend.emit(out[2].sfn);
    expect(reuse).toContain('v0 = w0 << 8 >> 16;');
    expect(fresh).toContain('w1 = w0 << 8 >> 16;');
    // and each variant SAYS which tail it is — rank.ts labels off this, never off the index
    expect(out.map((v) => v.tail)).toEqual(['none', 'reuse', 'fresh']);
  });

  // THE DEFECT THIS FIELD EXISTS FOR. The reuse tail needs a dead value var, which only R1 mints,
  // so an R2-only function has ONE tail and it is the FRESH one — at index 1, where the reuse tail
  // sits when R1 fires. Index rank.ts's label table by that position and every R1-less function
  // publishes its fresh spelling as `/regcopy-ret`: a census over `/regcopy-ret-fresh` then
  // measures nothing at all on this population, and a row winning here names the wrong transform
  // in the artifact. Asserting the tail KIND at index 1 is what makes positional labelling fail.
  test('an R2-only function yields the FRESH tail at index 1, not the reuse one', () => {
    const sfn: SFn = {
      name: 'f',
      retType: T.s(32),
      params: [{ name: 'a0', type: T.s(32) }],
      locals: [],
      body: [
        {
          k: 'return',
          value: {
            k: 'bin',
            op: '/',
            l: { k: 'bin', op: '<<', l: c(128), r: c(9) },
            r: { k: 'cast', to: T.s(16), e: v('a0') },
          },
        },
      ],
    };
    const out = registerishSpellings(sfn);
    expect(out.map((v) => v.tail)).toEqual(['none', 'fresh']);
    // the tail really is a fresh local, not R1's (absent) dead var reused
    expect(cBackend.emit(out[1].sfn)).toContain('w1 = w0 / (s16)a0;');
  });

  test('a declined diamond leaves NO residue (no leaked w local)', () => {
    // impure diamond + a stageable const elsewhere: the R2 rewrite fires, the R1 decline must
    // not have leaked a w0 (fresh vars start at w0 for R2's staging)
    const sfn: SFn = {
      name: 'f',
      retType: T.s(32),
      params: [{ name: 'a0', type: T.s(32) }],
      locals: [{ name: 'v0', type: T.s(32) }],
      body: [
        {
          k: 'if',
          cond: { k: 'bin', op: '>=', l: { k: 'call', fn: 'g', args: [] }, r: c(0) },
          then: [{ k: 'assign', name: 'v0', value: { k: 'call', fn: 'g', args: [] } }],
          else: [
            { k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: { k: 'call', fn: 'g', args: [] }, r: c(1) } },
          ],
        },
        {
          k: 'assign',
          name: 'v0',
          value: { k: 'bin', op: '/', l: { k: 'bin', op: '<<', l: c(128), r: c(9) }, r: v('v0') },
        },
        { k: 'return', value: v('v0') },
      ],
    };
    const out = registerishSpellings(sfn);
    expect(out.length).toBeGreaterThan(0);
    const names = out[0].sfn.locals.map((l) => l.name).filter((n) => n.startsWith('w'));
    expect(names).toEqual(['w0']); // exactly the R2 staging var — nothing leaked by the decline
  });
});
