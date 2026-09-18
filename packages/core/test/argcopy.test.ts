// A region copy of a pointer parameter (l3/argcopy.ts).
//
// A pointer parameter used across a whole function pins its incoming register for the whole body.
// The source may instead copy it into a local that one region uses, which hands the allocator a
// second name to home elsewhere and frees the parameter's register for something else — on
// pokeemerald:SetMauvilleOldManLanguage that something else is the loop counter.
//
// WHICH region the source copied in is not derivable from the tree, so every legal region is
// offered and the differ referees — the `/regcopy` idiom this file shares with l3/coalesce.ts.
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import { ARGCOPY_GATES, ARGCOPY_REGION_GATES, argCopyCandidates, argCopyUnder } from '../src/l3/argcopy';
import type { Expr, SFn, Stmt } from '../src/l3/ast';

const u8p = T.ptr(T.u(8));
const rd = (n: string): Expr => ({ k: 'var', name: n });
const call = (n: string, ...args: Expr[]): Stmt => ({ k: 'exprstmt', value: { k: 'call', fn: n, args } });
const fn = (body: Stmt[], locals: SFn['locals'] = []): SFn => ({
  name: 'f',
  params: [{ name: 'a0', type: u8p }],
  locals,
  retType: T.void(),
  body,
});
/** a two-armed `if`, the smallest thing with regions */
const armIf = (thenS: Stmt[], elseS: Stmt[]): Stmt => ({ k: 'if', cond: rd('c'), then: thenS, else: elseS });

describe('a region copy of a pointer parameter', () => {
  test('a parameter used inside one arm is copied into a local that arm assigns first', () => {
    const out = argCopyCandidates(fn([armIf([call('g', rd('a0')), call('g', rd('a0'))], [call('h')])]));
    expect(out.length).toBeGreaterThanOrEqual(1);
    const c = out[0];
    // the copy is a NEW local, declared and assigned from the parameter
    const copy = c.sfn.locals.find((l) => !l.name.startsWith('v'))!;
    expect(copy).toBeDefined();
    const arm = (c.sfn.body[0] as Extract<Stmt, { k: 'if' }>).then;
    expect(arm[0]).toEqual({ k: 'assign', name: copy.name, value: { k: 'var', name: 'a0' } });
    // and the arm's use is repointed at it, while the parameter itself still exists
    expect(JSON.stringify(arm.slice(1))).toContain(copy.name);
    expect(JSON.stringify(arm.slice(1))).not.toContain('"a0"');
    expect(c.sfn.params.map((p) => p.name)).toEqual(['a0']);
  });

  test('a use OUTSIDE the region keeps naming the parameter', () => {
    // both arms read a0; the candidate that copies in the THEN arm must leave the ELSE arm alone
    const out = argCopyCandidates(
      fn([armIf([call('g', rd('a0')), call('g', rd('a0'))], [call('h', rd('a0')), call('h', rd('a0'))])]),
    );
    const c = out.find((x) => x.merged === 'a0@0.0')!;
    const both = c.sfn.body[0] as Extract<Stmt, { k: 'if' }>;
    const copy = (both.then[0] as Extract<Stmt, { k: 'assign' }>).name;
    // the copied arm reads a0 ONLY in the copy's own initializer, and nowhere after it
    expect(JSON.stringify(both.then.slice(1))).not.toContain('"a0"');
    expect(JSON.stringify(both.then.slice(1))).toContain(copy);
    // the untouched arm still names the parameter and never the copy
    expect(JSON.stringify(both.else)).toContain('"a0"');
    expect(JSON.stringify(both.else)).not.toContain(copy);
  });

  test('a parameter the function ASSIGNS is never copied — the copy would go stale', () => {
    const body = [armIf([call('g', rd('a0'))], []), { k: 'assign', name: 'a0', value: rd('c') } as Stmt];
    const { candidates, refusals } = argCopyUnder(ARGCOPY_GATES, fn(body));
    expect(candidates).toEqual([]);
    expect(refusals.get('assigned')).toBeGreaterThan(0);
  });

  test('a parameter whose ADDRESS is taken is never copied — the copy is a different object', () => {
    const body = [armIf([call('g', { k: 'addr', name: 'a0' } as Expr)], [])];
    const { candidates, refusals } = argCopyUnder(ARGCOPY_GATES, fn(body));
    expect(candidates).toEqual([]);
    expect(refusals.get('addressed')).toBeGreaterThan(0);
  });

  test('a NON-POINTER parameter is never copied — this variation is about a base register', () => {
    const s = fn([armIf([call('g', rd('n'))], [])]);
    s.params = [{ name: 'n', type: T.s(32) }];
    expect(argCopyCandidates(s)).toEqual([]);
  });

  test('the whole function body is not a region — parkfirst owns the entry prefix', () => {
    // the only mention sits in the top-level list, so no nested region contains it
    expect(argCopyCandidates(fn([call('g', rd('a0'))]))).toEqual([]);
  });

  test('a region that never mentions the parameter yields no candidate', () => {
    expect(argCopyCandidates(fn([armIf([call('h')], [call('h')])]))).toEqual([]);
  });

  test('a region with a SINGLE read is refused — one use gives the allocator no range to shorten', () => {
    const body = [armIf([call('g', rd('a0')), call('g', rd('a0'))], [call('h', rd('a0'))])];
    const { candidates, refusals } = argCopyUnder(ARGCOPY_GATES, fn(body), ARGCOPY_REGION_GATES);
    // the two-read THEN arm is offered; the one-read ELSE arm is not
    expect(candidates.map((c) => c.merged)).toEqual(['a0@0.0']);
    expect(refusals.get('single-read')).toBeGreaterThan(0);
  });

  test('a LOOP body is not a region — the copy would re-run every iteration', () => {
    const loop: Stmt = {
      k: 'dowhile',
      cond: rd('c'),
      body: [call('g', rd('a0')), call('g', rd('a0'))],
    };
    const { candidates, refusals } = argCopyUnder(ARGCOPY_GATES, fn([armIf([loop], [])]), ARGCOPY_REGION_GATES);
    // the arm HOLDING the loop is still offered; the loop's own body is not
    expect(candidates.map((c) => c.merged)).toEqual(['a0@0.0']);
    expect(refusals.get('loop-region')).toBeGreaterThan(0);
  });

  test('every legal region is offered, each as its own tree', () => {
    // two sibling arms both reading a0 twice → two candidates, and each names its own region
    const out = argCopyCandidates(
      fn([armIf([call('g', rd('a0')), call('g', rd('a0'))], [call('h', rd('a0')), call('h', rd('a0'))])]),
    );
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(new Set(out.map((c) => c.merged)).size).toBe(out.length);
  });
});
