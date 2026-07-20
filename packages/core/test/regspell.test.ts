// The register-copy re-spelling (l3/regspell.ts) — the fourth differ-ranked lever. Pins: the
// three rewrites' goldens (R1 diamond→copy+in-place, R2 const staging, R3 tail assign-back with
// the dead-var reuse the match depends on); decline shapes; purity.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { Expr, SFn } from '../src/l3/ast';
import { registerishSpellings } from '../src/l3/regspell';

const V = (name: string): Expr => ({ k: 'var', name });
const C = (value: number): Expr => ({ k: 'const', value });

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
        cond: { k: 'bin', op: '>=', l: E, r: C(0) },
        then: [{ k: 'assign', name: 'v0', value: E }],
        else: [{ k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: E, r: C(255) } }],
      },
      {
        k: 'return',
        value: {
          k: 'bin',
          op: '>>',
          l: { k: 'bin', op: '<<', l: V('v0'), r: C(8) },
          r: C(16),
        },
      },
    ],
  };
}
const MUL: Expr = {
  k: 'bin',
  op: '*',
  l: { k: 'cast', to: T.s(16), e: V('a0') },
  r: { k: 'cast', to: T.s(16), e: V('a1') },
};

describe('R1 — diamond → copy + in-place update', () => {
  test('the MultiplyQ8 shape re-spells with the copy, flipped guard, and downstream rename', () => {
    const out = registerishSpellings(diamond(MUL));
    expect(out.length).toBe(3); // base + both R3 tails (reuse / fresh)
    const src = cBackend.emit(out[0]);
    expect(src).toContain('v0 = (s16)a0 * (s16)a1;');
    expect(src).toContain('w0 = v0;');
    expect(src).toContain('if (w0 < 0) w0 = w0 + 255;'); // update arm reads the COPY, in place
    expect(src).toContain('return w0 << 8 >> 16;'); // downstream renamed v0 → w0
  });

  test('R3 reuses the DEAD value var for the tail (the byte-exactness depends on it)', () => {
    const src = cBackend.emit(registerishSpellings(diamond(MUL))[1]);
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
            l: { k: 'bin', op: '<<', l: C(128), r: C(9) },
            r: { k: 'cast', to: T.s(16), e: V('a0') },
          },
        },
      ],
    };
    const out = registerishSpellings(sfn);
    expect(out.length).toBeGreaterThan(0);
    const src = cBackend.emit(out[0]);
    expect(src).toContain('w0 = 128 << 9;');
    expect(src).toContain('return w0 / (s16)a0;');
  });

  test('a bare const operand does NOT stage (no depth-0 noise)', () => {
    const sfn: SFn = {
      name: 'f',
      retType: T.s(32),
      params: [{ name: 'a0', type: T.s(32) }],
      locals: [],
      body: [{ k: 'return', value: { k: 'bin', op: '+', l: V('a0'), r: C(5) } }],
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
        { k: 'assign', name: 'v0', value: C(0) },
        {
          k: 'while',
          cond: { k: 'bin', op: '<', l: V('a1'), r: C(10) },
          body: [
            {
              k: 'if',
              cond: { k: 'bin', op: '>=', l: V('a0'), r: C(0) },
              then: [{ k: 'assign', name: 'v0', value: V('a0') }],
              else: [{ k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: V('a0'), r: C(255) } }],
            },
          ],
        },
        { k: 'return', value: V('v0') },
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
        { k: 'assign', name: 'v0', value: C(7) },
        {
          k: 'if',
          cond: { k: 'bin', op: '<', l: V('a0'), r: V('v0') },
          then: [{ k: 'assign', name: 'v0', value: V('a0') }],
          else: [{ k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: V('a0'), r: C(5) } }],
        },
        { k: 'return', value: V('v0') },
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
          cond: { k: 'bin', op: '>', l: V('a0'), r: C(5) },
          then: [{ k: 'assign', name: 'v0', value: V('a0') }],
          else: [{ k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: V('a0'), r: C(3) } }],
        },
        { k: 'return', value: V('v0') },
      ],
    };
    const out = registerishSpellings(sfn);
    expect(out.length).toBeGreaterThan(0);
    const src = cBackend.emit(out[0]);
    expect(src).toContain('u32 w0;'); // E (a0) is u32 — the compare keeps its unsignedness
  });

  test('BOTH R3 tails are ranked when R1 fired (the tail choice is allocator-ambiguous)', () => {
    const out = registerishSpellings(diamond(MUL));
    expect(out).toHaveLength(3); // base, tail-reuse, tail-fresh
    const reuse = cBackend.emit(out[1]);
    const fresh = cBackend.emit(out[2]);
    expect(reuse).toContain('v0 = w0 << 8 >> 16;');
    expect(fresh).toContain('w1 = w0 << 8 >> 16;');
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
          cond: { k: 'bin', op: '>=', l: { k: 'call', fn: 'g', args: [] }, r: C(0) },
          then: [{ k: 'assign', name: 'v0', value: { k: 'call', fn: 'g', args: [] } }],
          else: [
            { k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: { k: 'call', fn: 'g', args: [] }, r: C(1) } },
          ],
        },
        {
          k: 'assign',
          name: 'v0',
          value: { k: 'bin', op: '/', l: { k: 'bin', op: '<<', l: C(128), r: C(9) }, r: V('v0') },
        },
        { k: 'return', value: V('v0') },
      ],
    };
    const out = registerishSpellings(sfn);
    expect(out.length).toBeGreaterThan(0);
    const names = out[0].locals.map((l) => l.name).filter((n) => n.startsWith('w'));
    expect(names).toEqual(['w0']); // exactly the R2 staging var — nothing leaked by the decline
  });
});
