// The names a function's parameters and locals print under (src/l3/names.ts): the declaration's own
// parameter names, and every refusal that keeps the structurer's name where a new one would change
// what a name means.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { cppBackend } from '../src/backend/cpp';
import { T } from '../src/ir/types';
import { type Expr, type SFn, type Stmt, renameVariables } from '../src/l3/ast';
import { nameVariables } from '../src/l3/names';
import { decompile } from '../src/pipeline';
import { type FnProto, prototypesFromSymbols } from '../src/proto';
import { structuringOptions } from '../src/structuring-options';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const s32 = T.s(32);

/** `s32 f(s32 a0, s32 a1) { return a0 + a1; }`, with `extra` statements ahead of the return. */
const sum = (paramNames?: readonly string[], extra: SFn['body'] = []): SFn => ({
  name: 'f',
  params: [
    { name: 'a0', type: s32 },
    { name: 'a1', type: s32 },
  ],
  locals: [],
  retType: s32,
  body: [
    ...extra,
    { k: 'return', value: { k: 'bin', op: '+', l: { k: 'var', name: 'a0' }, r: { k: 'var', name: 'a1' } } },
  ],
  ...(paramNames ? { paramNames } : {}),
});

describe("the declaration's parameter names", () => {
  test('print in the signature and at every use', () => {
    expect(cBackend.emit(sum(['x', 'y']))).toBe('s32 f(s32 x, s32 y) {\n    return x + y;\n}\n');
  });

  test('print nothing where they do not pair one to one with the lifted parameters', () => {
    expect(cBackend.emit(sum(['x']))).toContain('s32 f(s32 a0, s32 a1)');
    expect(cBackend.emit(sum(['x', 'y', 'z']))).toContain('s32 f(s32 a0, s32 a1)');
  });

  test('a name the function already spells keeps the structurer name, and only that one', () => {
    const call = (fn: string): SFn['body'] => [{ k: 'exprstmt', value: { k: 'call', fn, args: [] } }];
    // a callee, which the parameter would shadow
    expect(cBackend.emit(sum(['x', 'y'], call('x')))).toContain('s32 f(s32 a0, s32 y)');
    // a global the body reads
    const reads: SFn['body'] = [{ k: 'store', lval: { k: 'var', name: 'gOut' }, value: { k: 'var', name: 'y' } }];
    expect(cBackend.emit(sum(['x', 'y'], reads))).toContain('s32 f(s32 x, s32 a1)');
    // the function's own name, and another variable's structurer name
    expect(cBackend.emit(sum(['f', 'a0']))).toContain('s32 f(s32 a0, s32 a1)');
  });

  test('a name a compiler predefines as a macro, or one in the reserved namespace, is not printed', () => {
    expect(cBackend.emit(sum(['linux', 'mips']))).toContain('s32 f(s32 a0, s32 a1)');
    expect(cBackend.emit(sum(['__x', '_Y']))).toContain('s32 f(s32 a0, s32 a1)');
  });

  test('a unit compiled as C++ prints them too, save a C++ keyword', () => {
    expect(cBackend.emit({ ...sum(['x', 'y']), dialect: 'c++' })).toContain('s32 f(s32 x, s32 y)');
    expect(cBackend.emit({ ...sum(['new', 'y']), dialect: 'c++' })).toContain('s32 f(s32 a0, s32 y)');
    expect(cBackend.emit(sum(['new', 'y']))).toContain('s32 f(s32 new, s32 y)');
  });

  test('a function with nothing to rename is printed once, as it was', () => {
    const fn = sum();
    let asked = 0;
    expect(
      nameVariables(fn, () => {
        asked++;
        return '';
      }),
    ).toBe(fn);
    expect(asked).toBe(0);
  });

  // end to end: the context's own entry carries the names, and the lift prints them
  test('a lift prints the names its own declaration gives', () => {
    const asm = 'f:\n\tlsl\tr0, r0, r1\n\tbx\tlr\n';
    const lift = (ownContextProto: FnProto) => decompile('f', asm, ARMV4T_AGBCC, { ownContextProto }).source;
    // the names only: the declaration's TYPES are no part of this
    expect(lift({ params: ['s32', 'u8'], returns: 's32', paramNames: ['x', 'shift'] })).toContain(
      's32 f(s32 x, s32 shift)',
    );
    expect(lift({ params: ['s32', 'u8'], returns: 's32', paramNames: ['x', 'shift'] })).toContain('x << shift');
    // a parameter that is not one argument word names none
    expect(lift({ params: ['s32', 'float'], returns: 's32', paramNames: ['x', 'shift'] })).not.toContain('shift');
  });

  // The names are derived where the structuring options are, over the table those options read:
  // a symbol map that merges in a struct returned through memory refuses them.
  test('are derived from the table the structuring options read, the symbol merge included', () => {
    const table: Record<string, FnProto> = { F: { params: ['u8', 'u8'], paramNames: ['x', 'y'] } };
    const symbols = new Map([
      [
        0x08000000,
        [{ name: 'F', kind: 'code', signature: { returns: { size: 8, signed: null, pointer: false }, params: [] } }],
      ],
    ]) as unknown as SymbolMap;
    const names = (prototypes: Record<string, FnProto>) =>
      structuringOptions({ target: ARMV4T_AGBCC, name: 'F', returnsVoid: false, prototypes, backend: cBackend })
        .paramNames;
    expect(names(table)).toEqual(['x', 'y']);
    expect(names(prototypesFromSymbols(symbols, table))).toBeUndefined();
    // and from the context's own entry beside the table
    const own: FnProto = { params: ['s32'], paramNames: ['n'] };
    expect(
      structuringOptions({
        target: ARMV4T_AGBCC,
        name: 'F',
        returnsVoid: false,
        prototypes: {},
        backend: cBackend,
        ownContextProto: own,
      }).paramNames,
    ).toEqual(['n']);
  });
});

// Role names: `i`/`j`/`k` for a loop's counter by how many counted loops enclose it, and `result`
// for the one local every return returns.
describe('role names', () => {
  const v = (name: string): Expr => ({ k: 'var', name });
  const c = (value: number): Expr => ({ k: 'const', value });
  const set = (name: string, value: Expr): Stmt => ({ k: 'assign', name, value });
  const step = (name: string): Stmt => set(name, { k: 'bin', op: '+', l: v(name), r: c(1) });
  const lt = (name: string, n: number): Expr => ({ k: 'bin', op: '<', l: v(name), r: c(n) });
  const work = (...args: Expr[]): Stmt => ({ k: 'exprstmt', value: { k: 'call', fn: 'work', args } });
  const fn = (locals: string[], body: Stmt[], retType = T.void()): SFn => ({
    name: 'f',
    params: [{ name: 'a0', type: s32 }],
    locals: locals.map((name) => ({ name, type: s32 })),
    retType,
    body,
    roleNames: true,
  });

  test('nested counters are i, j and k, outermost first, in a for or a do-while', () => {
    const body: Stmt[] = [
      set('v0', c(0)),
      {
        k: 'dowhile',
        cond: lt('v0', 4),
        body: [
          {
            k: 'for',
            init: set('v1', c(0)),
            cond: lt('v1', 8),
            inc: step('v1'),
            body: [
              set('v2', c(0)),
              { k: 'while', cond: lt('v2', 2), body: [work(v('v0'), v('v1'), v('v2')), step('v2')] },
            ],
          },
          step('v0'),
        ],
      },
    ];
    const out = cBackend.emit(fn(['v0', 'v1', 'v2'], body));
    expect(out).toContain('i = 0;');
    expect(out).toContain('for (j = 0; j < 8; j = j + 1)');
    expect(out).toContain('k = 0;');
    expect(out).toContain('work(i, j, k);');
    expect(out).not.toMatch(/\bv[0-9]\b/);
  });

  test('two loops in sequence, each with its own counter, take i and then j', () => {
    const loop = (n: string): Stmt[] => [set(n, c(0)), { k: 'while', cond: lt(n, 3), body: [work(v(n)), step(n)] }];
    const out = cBackend.emit(fn(['v0', 'v1'], [...loop('v0'), ...loop('v1')]));
    expect(out).toContain('work(i);');
    expect(out).toContain('work(j);');
  });

  test('a local with two roles is no counter: reset for a second loop, or written past a step', () => {
    const loop = (n: string): Stmt[] => [set(n, c(0)), { k: 'while', cond: lt(n, 3), body: [work(v(n)), step(n)] }];
    // the coalescer's one carrier for two loops' counters
    expect(cBackend.emit(fn(['v0'], [...loop('v0'), ...loop('v0')]))).not.toMatch(/\bi\b/);
    // written by something other than a step inside the loop
    const scaled: Stmt[] = [
      set('v0', c(0)),
      { k: 'while', cond: lt('v0', 9), body: [work(v('v0')), set('v0', { k: 'bin', op: '*', l: v('v0'), r: c(2) })] },
    ];
    expect(cBackend.emit(fn(['v0'], scaled))).toContain('work(v0);');
    // stepped only inside a nested loop
    const deep: Stmt[] = [
      set('v0', c(0)),
      { k: 'while', cond: lt('v0', 9), body: [{ k: 'while', cond: v('a0'), body: [step('v0')] }] },
    ];
    expect(cBackend.emit(fn(['v0'], deep))).toContain('v0 = 0;');
  });

  test('a counter name the function spells is passed over for the next free one', () => {
    const body: Stmt[] = [
      set('v0', c(0)),
      {
        k: 'while',
        cond: lt('v0', 3),
        body: [{ k: 'exprstmt', value: { k: 'call', fn: 'i', args: [v('v0')] } }, step('v0')],
      },
    ];
    expect(cBackend.emit(fn(['v0'], body))).toContain('i(j);');
  });

  test('the one local every return returns is the result, where it plays no other role', () => {
    const body: Stmt[] = [
      set('v0', c(0)),
      { k: 'if', cond: v('a0'), then: [set('v0', c(5)), { k: 'return', value: v('v0') }], else: [] },
      work(),
      { k: 'return', value: v('v0') },
    ];
    expect(cBackend.emit(fn(['v0'], body, s32))).toContain('return result;');
    // a return of anything else
    const other: Stmt[] = [
      { k: 'if', cond: v('a0'), then: [{ k: 'return', value: c(1) }], else: [] },
      set('v0', c(0)),
      { k: 'return', value: v('v0') },
    ];
    expect(cBackend.emit(fn(['v0'], other, s32))).toContain('return v0;');
    // a counter returned stays the counter
    const counted: Stmt[] = [
      set('v0', c(0)),
      { k: 'while', cond: lt('v0', 3), body: [work(v('v0')), step('v0')] },
      { k: 'return', value: v('v0') },
    ];
    expect(cBackend.emit(fn(['v0'], counted, s32))).toContain('return i;');
  });

  // snowboardkids2's func_800154A8_160A8 (kmc): `if (n != 0) { do { … } while (…); v1 = …; } return v1;`
  test('the result is assigned on every path into each return', () => {
    const ret: Stmt = { k: 'return', value: v('v0') };
    const loop = (body: Stmt[]): Stmt => ({ k: 'dowhile', cond: v('a0'), body });
    const named = (body: Stmt[]) => cBackend.emit(fn(['v0'], body, s32));
    // set inside an if with no else: unset on the other path
    expect(named([{ k: 'if', cond: v('a0'), then: [work(), set('v0', c(1))], else: [] }, ret])).toContain('return v0;');
    // set in a while body, which may run no times
    expect(named([{ k: 'while', cond: v('a0'), body: [set('v0', c(1))] }, ret])).toContain('return v0;');
    // unset ahead of an early return
    expect(named([{ k: 'if', cond: v('a0'), then: [ret], else: [] }, set('v0', c(1)), ret])).toContain('return v0;');
    // set in both arms, or in a do-while body that always runs to its end
    expect(named([{ k: 'if', cond: v('a0'), then: [set('v0', c(1))], else: [set('v0', c(2))] }, ret])).toContain(
      'return result;',
    );
    expect(named([loop([work(), set('v0', c(1))]), ret])).toContain('return result;');
    // a do-while body left early may skip its write
    expect(
      named([loop([{ k: 'if', cond: v('a0'), then: [{ k: 'break' }], else: [] }, set('v0', c(1))]), ret]),
    ).toContain('return v0;');
  });

  // pokeemerald's GetImprisonedMovesCount: `v0 = 0; if (v0 < gBattlersCount) { v3 = v0; …; v0 = v3; }`
  test('the result is not read ahead of its last write, save by its own update', () => {
    const ret: Stmt = { k: 'return', value: v('v0') };
    const named = (locals: string[], body: Stmt[]) => cBackend.emit(fn(locals, body, s32));
    // the carrier's constant tested and copied before the count is written back
    const carried: Stmt[] = [
      set('v0', c(0)),
      {
        k: 'if',
        cond: lt('v0', 7),
        then: [
          set('v1', v('v0')),
          work(v('v1')),
          set('v1', { k: 'bin', op: '+', l: v('v1'), r: c(1) }),
          set('v0', v('v1')),
        ],
        else: [],
      },
      ret,
    ];
    expect(named(['v0', 'v1'], carried)).toContain('return v0;');
    // an accumulator reads itself only in its own update
    const sum: Stmt[] = [
      set('v0', c(0)),
      { k: 'while', cond: v('a0'), body: [set('v0', { k: 'bin', op: '+', l: v('v0'), r: v('a0') }), work()] },
      ret,
    ];
    expect(named(['v0'], sum)).toContain('return result;');
    // a read inside a loop that writes it reads the value that loop computes (sa3's sa2__sub_8085654)
    const iterated: Stmt[] = [
      set('v0', v('a0')),
      {
        k: 'dowhile',
        cond: v('a0'),
        body: [work(v('v0')), set('v0', { k: 'bin', op: '-', l: v('v0'), r: c(1) })],
      },
      ret,
    ];
    expect(named(['v0'], iterated)).toContain('return result;');
    // a read after the last write reads the result itself, a do-while's condition included
    expect(named(['v0'], [set('v0', c(3)), work(v('v0')), ret])).toContain('return result;');
    expect(
      named(['v0'], [{ k: 'dowhile', cond: v('v0'), body: [set('v0', { k: 'call', fn: 'g', args: [] })] }, ret]),
    ).toContain('return result;');
  });

  // kleod's EepromTimerIntr, declared `void EepromTimerIntr(void);` and lifted returning r0
  test('no local is the result of a function its own declaration says returns void', () => {
    const body: Stmt[] = [set('v0', c(0)), work(), { k: 'return', value: v('v0') }];
    expect(cBackend.emit({ ...fn(['v0'], body, s32), declaredVoid: true })).toContain('return v0;');
    // end to end: the context's own entry says void, the lift still returns r0's leftover
    const asm =
      'f:\n\tpush\t{r4, lr}\n\tbl\tg\n\tadd\tr4, r0, #0\n\tbl\th\n\tadd\tr0, r4, #0\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    const lift = (ownContextProto?: FnProto) =>
      decompile('f', asm, ARMV4T_AGBCC, { roleNames: true, ...(ownContextProto ? { ownContextProto } : {}) }).source;
    expect(lift()).toContain('return result;');
    expect(lift({ params: [], returns: 'void' })).toContain('return v0;');
  });

  test('only where the caller asks for them', () => {
    const body: Stmt[] = [set('v0', c(0)), work(), { k: 'return', value: v('v0') }];
    const { roleNames: _asked, ...plain } = fn(['v0'], body, s32);
    expect(cBackend.emit(plain)).toContain('return v0;');
    expect(cBackend.emit(fn(['v0'], body, s32))).toContain('return result;');
  });

  test('a countdown spelled `v + -1` is a counter, as mwcc, kmc and IDO lifts print it', () => {
    const down: Stmt[] = [
      set('v0', v('a0')),
      {
        k: 'while',
        cond: { k: 'bin', op: '!=', l: v('v0'), r: c(0) },
        body: [work(v('v0')), set('v0', { k: 'bin', op: '+', l: v('v0'), r: c(-1) })],
      },
    ];
    expect(cBackend.emit(fn(['v0'], down))).toContain('i = i + -1;');
  });

  // pokeemerald's StringCopy: `while (*v0 != 255) { *v1 = *v0; v1 = v1 + 1; v0 = v0 + 1; } return v1;`
  const u8p = T.ptr(T.u(8));
  const deref = (name: string): Expr => ({ k: 'index', base: v(name), idx: c(0), width: 1, signed: false });
  const copy = (): SFn => ({
    ...fn(
      [],
      [
        set('v0', v('a0')),
        set('v1', v('a0')),
        {
          k: 'while',
          cond: { k: 'bin', op: '!=', l: deref('v0'), r: c(255) },
          body: [work(deref('v0'), v('v1')), step('v1'), step('v0')],
        },
        { k: 'return', value: v('v1') },
      ],
      u8p,
    ),
    locals: [
      { name: 'v0', type: u8p },
      { name: 'v1', type: u8p },
    ],
  });

  test('a pointer stepped by one is a cursor, not a counter', () => {
    const out = cBackend.emit(copy());
    expect(out).not.toMatch(/\bi\b/);
    expect(out).toContain('v0 = v0 + 1;');
  });

  test('a returned cursor, or an index its loop tests, is no result; a tally its loop does not test is', () => {
    expect(cBackend.emit(copy())).toContain('return v1;');
    // an integer the loop tests but no counter (initialized twice): an index, not the result
    const index: Stmt[] = [
      set('v0', c(0)),
      { k: 'if', cond: v('a0'), then: [set('v0', c(1))], else: [] },
      { k: 'while', cond: lt('v0', 3), body: [work(v('v0')), step('v0')] },
      { k: 'return', value: v('v0') },
    ];
    expect(cBackend.emit(fn(['v0'], index, s32))).toContain('return v0;');
    // a tally: stepped in a loop that tests something else
    const tally: Stmt[] = [
      set('v0', c(0)),
      { k: 'while', cond: v('a0'), body: [work(), step('v0')] },
      { k: 'return', value: v('v0') },
    ];
    expect(cBackend.emit(fn(['v0'], tally, s32))).toContain('return result;');
  });

  // pokeemerald AllocOamMatrix / CountTrailingZeroBits: `for (i = 0; i < 32; i++) … return i;`,
  // lifted with the bound test in the body; and `while (p[r] != 0) r += 2; return r;`
  test('an index its loop tests in an if that leaves the loop, or steps by more than one, is no result', () => {
    const exitTested: Stmt[] = [
      set('v0', c(0)),
      {
        k: 'while',
        cond: v('a0'),
        body: [
          step('v0'),
          { k: 'if', cond: lt('v0', 32), then: [], else: [set('v0', c(255)), { k: 'return', value: v('v0') }] },
        ],
      },
      { k: 'return', value: v('v0') },
    ];
    expect(cBackend.emit(fn(['v0'], exitTested, s32))).toContain('return v0;');
    // an if in the body that does not leave the loop tests nothing: a tally still
    const readOnly: Stmt[] = [
      set('v0', c(0)),
      { k: 'while', cond: v('a0'), body: [step('v0'), { k: 'if', cond: lt('v0', 32), then: [work()], else: [] }] },
      { k: 'return', value: v('v0') },
    ];
    expect(cBackend.emit(fn(['v0'], readOnly, s32))).toContain('return result;');
    const byTwo = (cond: Expr): Stmt[] => [
      set('v0', c(0)),
      { k: 'while', cond, body: [set('v0', { k: 'bin', op: '+', l: v('v0'), r: c(2) })] },
      { k: 'return', value: v('v0') },
    ];
    expect(cBackend.emit(fn(['v0'], byTwo(lt('v0', 8)), s32))).toContain('return v0;');
    expect(cBackend.emit(fn(['v0'], byTwo(v('a0')), s32))).toContain('return result;');
  });

  // synthetic preupdate_cond_effect: `do { v0 = cb(a0); } while (v1++ <= a0 && v0 != 0); return v1;`
  test('a step in the loop condition reads its local: the counter, so no result', () => {
    const post = (name: string): Expr => ({ k: 'postincr', name, by: 1 });
    const body: Stmt[] = [
      set('v1', c(0)),
      {
        k: 'dowhile',
        cond: {
          k: 'bin',
          op: '&&',
          l: { k: 'bin', op: '<=', l: post('v1'), r: v('a0') },
          r: { k: 'bin', op: '!=', l: v('v0'), r: c(0) },
        },
        body: [set('v0', { k: 'call', fn: 'cb', args: [v('a0')] })],
      },
      { k: 'return', value: v('v1') },
    ];
    const out = cBackend.emit(fn(['v0', 'v1'], body, s32));
    expect(out).toContain('} while (i++ <= a0 && v0 != 0);');
    expect(out).toContain('return i;');
    expect(out).not.toMatch(/\bresult\b/);
  });

  // `int K(int n){ int s = 0; int q; for (q = 0; q < n; q++) s += ext(q); return s; }`
  test('the C++ backend prints them too, under the parameter names its own spec gives', () => {
    const body: Stmt[] = [
      set('v1', c(0)),
      {
        k: 'for',
        init: set('v0', c(0)),
        cond: { k: 'bin', op: '<', l: v('v0'), r: v('a0') },
        inc: step('v0'),
        body: [set('v1', { k: 'bin', op: '+', l: v('v1'), r: { k: 'call', fn: 'ext', args: [v('v0')] } })],
      },
      { k: 'return', value: v('v1') },
    ];
    const int = { base: 'int', ptr: 0 };
    const cpp = cppBackend({ method: 'K', retType: int, params: [{ name: 'n', type: int }] }, undefined);
    // the declaration's names are the spec's to give: one that disagrees is not asked for
    const out = cpp.emit({ ...fn(['v0', 'v1'], body, s32), paramNames: ['m'] });
    expect(out).toContain('for (i = 0; i < n; i = i + 1)');
    expect(out).toContain('return result;');
    expect(out).not.toMatch(/\bv[0-9]\b|\bm\b/);
  });

  test('a local whose address is taken, or that is a frame object, keeps its name', () => {
    const body: Stmt[] = [set('v0', c(0)), work({ k: 'addr', name: 'v0' }), { k: 'return', value: v('v0') }];
    expect(cBackend.emit(fn(['v0'], body, s32))).toContain('return v0;');
  });
});

// The one rename walk every L3 rename goes through (ast.ts `renameVariables`): the coalescer's
// merge, the register spelling's phi split and the printed names.
describe('the rename walk', () => {
  test('renames every node that names a variable, and every assignment, at any depth', () => {
    const v0: Expr = { k: 'var', name: 'v0' };
    const body: Stmt[] = [
      {
        k: 'for',
        init: { k: 'assign', name: 'v0', value: { k: 'const', value: 0 } },
        cond: { k: 'bin', op: '<', l: v0, r: { k: 'const', value: 3 } },
        inc: { k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: v0, r: { k: 'const', value: 1 } } },
        body: [
          { k: 'exprstmt', value: { k: 'call', fn: 'work', args: [{ k: 'addr', name: 'v0' }] } },
          { k: 'exprstmt', value: { k: 'postincr', name: 'v0', by: 1 } },
          { k: 'assign', name: 'v1', value: v0 },
        ],
      },
    ];
    const out = JSON.stringify(renameVariables(body, new Map([['v0', 'i']])));
    expect(out).not.toContain('"v0"');
    expect(out).toContain('"v1"');
    // the coalescer and the register spelling keep an address as it was (coalesce.test.ts's pinned gap)
    const kept = renameVariables(body, new Map([['v0', 'i']]), { addresses: false });
    expect(JSON.stringify(kept).match(/"v0"/g)).toHaveLength(1);
  });
});
