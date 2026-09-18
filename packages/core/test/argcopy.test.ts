// A region copy of a pointer parameter — l3/argcopy.ts, whose header carries what the variation
// is for. What these tests pin is which regions it offers, what each gate refuses, and that every
// judgement and every rewrite sees the SAME statements.
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
const bump = (n: string, by: Expr): Stmt => ({ k: 'assign', name: n, value: by });
const plus1 = (n: string): Expr => ({ k: 'bin', op: '+', l: rd(n), r: { k: 'const', value: 1 } });
/** a `for`, the one statement whose `init`/`inc` are statements rather than nested LISTS */
const forLoop = (init: Stmt, inc: Stmt, body: Stmt[]): Stmt => ({ k: 'for', init, cond: rd('c'), inc, body });
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
    // TWO reads, so `single-read` does not refuse the region anyway: with one, the expectation is
    // met whether or not this gate fires, and the gate is what the test is named for.
    const s = fn([armIf([call('g', rd('n')), call('g', rd('n'))], [])]);
    s.params = [{ name: 'n', type: T.s(32) }];
    const { candidates, refusals } = argCopyUnder(ARGCOPY_GATES, s);
    expect(candidates).toEqual([]);
    expect(refusals.get('non-pointer')).toBeGreaterThan(0);
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

  test('a TOP-LEVEL loop is offered NOTHING — there is no region outside it to hold the copy', () => {
    // the same two reads as the nested-arm case, with the loop at the function's own list instead
    // of inside an arm. `regions()` does not offer that list, so the loop body is the only region
    // over the reads and `loop-region` refuses it: the pass declines the whole shape rather than
    // minting a per-iteration copy. The spelling this population wants — a copy BEFORE the loop,
    // repointing only the loop's reads — is a copy site separate from its region, which this pass
    // cannot express; a round that builds it should turn this test around.
    const loop: Stmt = { k: 'dowhile', cond: rd('c'), body: [call('g', rd('a0')), call('g', rd('a0'))] };
    const { candidates, refusals } = argCopyUnder(ARGCOPY_GATES, fn([loop]), ARGCOPY_REGION_GATES);
    expect(candidates).toEqual([]);
    expect(refusals.get('loop-region')).toBe(1);
  });

  // ── the walk is the WHOLE tree, `for` headers included ──────────────────────────────────────
  // `repoint` rewrites a `for`'s `init` and `inc` (mapStmtExprs recurses into both), so every
  // judgement this pass makes has to see them. `stmtLists` — the walk over the SCOPES a statement
  // opens — does not, by its own contract, and each of these three shapes is invisible to it.

  test('a parameter a `for` header ADVANCES is never copied — the copy would not advance with it', () => {
    // `for (a0 = a0 + 1; c; a0 = a0 + 1) …` — the assignment sits in the header, not in a list
    const loop = forLoop(bump('a0', plus1('a0')), bump('a0', plus1('a0')), [call('g', rd('a0')), call('g', rd('a0'))]);
    const { candidates, refusals } = argCopyUnder(ARGCOPY_GATES, fn([armIf([loop, call('g', rd('a0'))], [])]));
    expect(candidates).toEqual([]);
    expect(refusals.get('assigned')).toBeGreaterThan(0);
  });

  test('a parameter whose ADDRESS is taken in a `for` header is never copied', () => {
    const loop = forLoop(
      { k: 'exprstmt', value: { k: 'call', fn: 'h', args: [{ k: 'addr', name: 'a0' } as Expr] } },
      bump('i', plus1('i')),
      [call('g', rd('a0')), call('g', rd('a0'))],
    );
    const { candidates, refusals } = argCopyUnder(ARGCOPY_GATES, fn([armIf([loop], [])]));
    expect(candidates).toEqual([]);
    expect(refusals.get('addressed')).toBeGreaterThan(0);
  });

  test('reads in a `for` header COUNT — the rewrite touches them, so the region rule must see them', () => {
    // the arm's only two reads of a0 are the loop header's init and inc; its body has none
    const loop = forLoop(bump('p', rd('a0')), bump('p', rd('a0')), [call('g')]);
    const { candidates } = argCopyUnder(ARGCOPY_GATES, fn([armIf([loop], [])]));
    // the arm is offered (two reads, not one), and the copy repoints BOTH header reads
    expect(candidates.map((c) => c.merged)).toContain('a0@0.0');
    const arm = (candidates.find((c) => c.merged === 'a0@0.0')!.sfn.body[0] as Extract<Stmt, { k: 'if' }>).then;
    expect(JSON.stringify(arm.slice(1))).not.toContain('"a0"');
  });

  test('an arm NESTED inside a loop body is refused too — the copy still re-runs every iteration', () => {
    // the region is two levels below the loop, so a rule reading only the IMMEDIATE parent would
    // call it a branch arm and offer it
    const inner: Stmt = { k: 'if', cond: rd('c'), then: [call('g', rd('a0')), call('g', rd('a0'))], else: [] };
    const loop: Stmt = { k: 'dowhile', cond: rd('c'), body: [inner] };
    const { candidates, refusals } = argCopyUnder(ARGCOPY_GATES, fn([armIf([loop], [])]), ARGCOPY_REGION_GATES);
    // only the arm OUTSIDE the loop survives; the loop body and the arm inside it are both refused
    expect(candidates.map((c) => c.merged)).toEqual(['a0@0.0']);
    expect(refusals.get('loop-region')).toBe(2);
  });

  test('the repoint reaches EVERY nested list — a mid-`switch` default and a loop body included', () => {
    // one walk (`mapStmtExprs`) does the whole subtree; a region whose reads sit five levels down,
    // in a `for` header, a `do`-`while` body and a `default` spliced BETWEEN two cases, must come
    // back with no mention of the parameter left
    const inner: Stmt = {
      k: 'switch',
      scrutinee: rd('c'),
      defaultAt: 1,
      default: [call('d', rd('a0'))],
      cases: [
        {
          values: [0],
          // a `defaultAt` label is only legal after an arm that does NOT fall through (ast.ts), so
          // both arms here are closed — the fixture's whole point is the SPLICED default
          fallsThrough: false,
          body: [
            forLoop(bump('p', rd('a0')), bump('p', rd('a0')), [
              { k: 'dowhile', cond: rd('a0'), body: [call('g', rd('a0'))] },
            ]),
          ],
        },
        { values: [1], fallsThrough: false, body: [call('h', rd('a0'))] },
      ],
    };
    const c = argCopyCandidates(fn([armIf([inner], [])])).find((x) => x.merged === 'a0@0.0')!;
    const arm = (c.sfn.body[0] as Extract<Stmt, { k: 'if' }>).then;
    expect(arm[0]).toEqual({ k: 'assign', name: 'p0', value: { k: 'var', name: 'a0' } });
    expect(JSON.stringify(arm.slice(1))).not.toContain('"a0"');
    // and the default is still spliced where it was, not re-ordered by the rewrite
    const sw = arm[1] as Extract<Stmt, { k: 'switch' }>;
    expect(sw.defaultAt).toBe(1);
    expect(JSON.stringify(sw.default)).toContain('p0');
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
