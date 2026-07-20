// Rendered-type discipline for memory accesses (the S1–S5 invalid-C family, found via the
// benchmark's 29 asmlift-noncompile rows, 2026-07-17). The IR value under a deref can be
// pointer-typed while the EXPRESSION it renders as is not (a literal address, an int-typed
// arithmetic tree, a deref whose declared pointee is scalar) — and gcc rejects `*50345188` with
// "invalid type argument of `unary *'". Contract under test:
//   1. `exprCType` — the C static type of a rendered L3 expression (l3/typing.ts);
//   2. memAccess/arrayAccess wrap any not-provably-pointer base in the honest reinterpret cast
//      at the ACCESS's own width (end-to-end through decompile());
//   3. `assertDerefsTyped` — the stage-boundary contract that flags a definite ill-typed deref;
//   4. the printer parenthesizes prefix nodes (cast/unary) under postfix parents, and the
//      single-line `if` inlining no longer truncates a multi-line then-statement (the gcd bug).
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { cppBackend } from '../src/backend/cpp';
import { pascalBackend } from '../src/backend/pascal';
import { ContractError, assertDerefsTyped } from '../src/contracts';
import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import type { Expr, SFn } from '../src/l3/ast';
import { exprCType } from '../src/l3/typing';
import { decompile } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC } from '../src/target';

/** IR text → C, the structure-guard.test.ts idiom (verify + recoverTypes + structure + emit). */
function emitIr(ir: string): string {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
}

const V = (name: string): Expr => ({ k: 'var', name });
const C = (value: number): Expr => ({ k: 'const', value });

describe('exprCType — the C static type of a rendered expression', () => {
  const env = new Map([
    ['p', T.ptr(T.s(32))],
    ['n', T.s(32)],
  ]);
  const ct = (e: Expr) => exprCType(e, (n) => env.get(n));

  test('a literal spells int, never a pointer', () => {
    expect(ct(C(50345188))).toEqual(T.s(32));
  });
  test('pointer arithmetic keeps the pointer type; int arithmetic stays int', () => {
    expect(ct({ k: 'bin', op: '+', l: V('p'), r: V('n') })).toEqual(T.ptr(T.s(32)));
    expect(ct({ k: 'bin', op: '+', l: V('n'), r: V('p') })).toEqual(T.ptr(T.s(32)));
    expect(ct({ k: 'bin', op: '+', l: V('n'), r: V('n') })).toEqual(T.s(32));
    expect(ct({ k: 'bin', op: '-', l: V('p'), r: V('p') })).toEqual(T.s(32)); // ptr - ptr = int
  });
  test('deref unwraps one pointer level; an over-deref types as the LEGALIZED read', () => {
    const derefP: Expr = { k: 'index', base: V('p'), idx: C(0), width: 4, signed: true };
    expect(ct(derefP)).toEqual(T.s(32)); // *p : s32
    // **p: the inner read is s32, so the outer deref is legalized by the backend at its own
    // width — its C type is the access scalar, total by construction.
    expect(ct({ k: 'index', base: derefP, idx: C(0), width: 4, signed: true })).toEqual(T.s(32));
  });
  test('a cast overrides; a call is unknowable', () => {
    expect(ct({ k: 'cast', to: T.ptr(T.u(8)), e: V('n') })).toEqual(T.ptr(T.u(8)));
    expect(ct({ k: 'call', fn: 'f', args: [] })).toBeUndefined();
  });
});

describe('end-to-end: a not-provably-pointer base gets the reinterpret cast at access width', () => {
  test('S1 — deref of a literal address casts instead of emitting invalid C', () => {
    // `mov r0, #80; ldr r0, [r0]`: the load base renders as the literal 128... (mov #80 → const),
    // which C types as int. The emission must cast at the access width, never emit `*128`.
    const res = decompile('litref', 'litref:\n\tmov\tr0, #128\n\tldr\tr0, [r0]\n\tbx\tlr\n', ARMV4T_AGBCC);
    expect(res.source).toContain('*(s32 *)128');
    expect(res.source).not.toMatch(/\*\s*\d/); // no bare deref-of-literal
  });

  test('S2 — the over-deref shape derefs through a cast, not `**scalar`', () => {
    const res = decompile('dblref', 'dblref:\n\tldr\tr0, [r0]\n\tldr\tr0, [r0]\n\tbx\tlr\n', ARMV4T_AGBCC);
    expect(res.source).toContain('*(s32 *)*a0');
    expect(res.source).not.toContain('**');
  });

  test('a well-typed deref is untouched — no spurious cast on the ordinary path', () => {
    const res = decompile('deref', 'deref:\n\tldr\tr0, [r0]\n\tbx\tlr\n', ARMV4T_AGBCC);
    expect(res.source).toBe('s32 deref(s32 * a0) {\n    return *a0;\n}\n');
  });
});

describe('adversarial-round pins — the cast must never legitimize wrong address math', () => {
  test('stride scaling keys on the RENDERED type: an int-rendered walk keeps its raw byte constant', () => {
    // asm reads a0+a1+4. The add-result is value-typed `s32*` (load-base seed), which used to
    // trigger the /4 element pre-scale — but the tree RENDERS as int-typed C, where C does no
    // element scaling, so the pre-scale baked in a0+a1+1: valid C at the WRONG address once the
    // deref cast landed. The constant must stay 4.
    const res = decompile('sy', 'sy:\n\tadd\tr0, r0, r1\n\tadd\tr0, #4\n\tldr\tr0, [r0]\n\tbx\tlr\n', ARMV4T_AGBCC);
    expect(res.source).toContain('*(s32 *)(a0 + a1 + 4)');
    expect(res.source).not.toContain('+ 1)');
  });

  test('a pointer rendering with the WRONG element size is cast, not trusted (width-blind fast path)', () => {
    // A byte load through a base declared `s32 *`: uncast, C would read a word. The access-width
    // cast is required even though the rendering IS a pointer.
    const src = emitIr(`fn wb {
^bb0(%0: s32*):
  %1: s32 = load %0 {off=0, signed=false, width=1}
  ret %1
}
`);
    expect(src).toContain('*(u8 *)a0');
    expect(src).not.toContain('return *a0');
  });

  test('a pointer under a non-additive operator is cast to its integer self (C rejects `3 & ptr`)', () => {
    const src = emitIr(`fn pa {
^bb0(%0: s32*):
  %1: s32 = load %0 {off=0, signed=true, width=4}
  %2: s32 = const {value=3}
  %3: s32 = and %2, %0
  %4: s32 = add %1, %3
  ret %4
}
`);
    expect(src).toContain('3 & (s32)a0');
  });

  test('exprCType reports ptr + ptr as unknowable (not C), ptr - ptr as int', () => {
    const env = new Map([['p', T.ptr(T.s(32))]]);
    const ct = (e: Expr) => exprCType(e, (n) => env.get(n));
    expect(ct({ k: 'bin', op: '+', l: V('p'), r: V('p') })).toBeUndefined();
    expect(ct({ k: 'bin', op: '-', l: V('p'), r: V('p') })).toEqual(T.s(32));
  });
});

describe('assertDerefsTyped — the stage-boundary contract', () => {
  const sfn = (body: SFn['body'], locals: SFn['locals'] = []): SFn => ({
    name: 'f',
    params: [
      { name: 'p', type: T.ptr(T.s(32)) },
      { name: 'n', type: T.s(32) },
    ],
    locals,
    retType: T.s(32),
    body,
  });

  test('index bases are never contract errors — the backend legalizes ANY base from the node width', () => {
    // The width-carrying node makes deref-of-non-pointer a spelling decision, not an ill-formed
    // tree: the C printer casts. The contract stays silent on all of these.
    for (const base of [V('p'), C(50345188), V('n'), { k: 'call', fn: 'g', args: [] } as Expr]) {
      expect(() =>
        assertDerefsTyped(sfn([{ k: 'return', value: { k: 'index', base, idx: C(0), width: 4, signed: true } }])),
      ).not.toThrow();
    }
    // ...and the printer's legalization is what upholds the C validity the old rule guarded:
    const out = cBackend.emit({
      name: 'f',
      params: [{ name: 'n', type: T.s(32) }],
      locals: [],
      retType: T.s(32),
      body: [{ k: 'return', value: { k: 'index', base: V('n'), idx: C(0), width: 4, signed: true } }],
    });
    expect(out).toContain('*(s32 *)n');
  });

  test('throws on a pointer operand under a non-additive operator (the emitter intifies these)', () => {
    expect(() => assertDerefsTyped(sfn([{ k: 'return', value: { k: 'bin', op: '&', l: C(3), r: V('p') } }]))).toThrow(
      ContractError,
    );
  });

  test('throws on member access through a non-struct base', () => {
    expect(() =>
      assertDerefsTyped(sfn([{ k: 'return', value: { k: 'field', base: V('n'), name: 'field_0' } }])),
    ).toThrow(ContractError);
  });
});

describe('printer — prefix nodes under postfix parents, and the truncating single-line if', () => {
  test('a cast base parenthesizes under [] and -> (C would otherwise re-associate)', () => {
    const struct = T.struct('S', [{ off: 0, type: T.s(32), name: 'field_0' }]);
    const fn: SFn = {
      name: 'f',
      params: [{ name: 'n', type: T.s(32) }],
      locals: [],
      retType: T.s(32),
      body: [
        {
          k: 'return',
          value: {
            k: 'field',
            base: { k: 'cast', to: T.ptr(struct), e: V('n') },
            name: 'field_0',
          },
        },
      ],
    };
    expect(cBackend.emit(fn)).toContain('((struct S *)n)->field_0');
    const idx: SFn = {
      ...fn,
      body: [
        {
          k: 'return',
          value: {
            k: 'index',
            base: { k: 'cast', to: T.ptr(T.u(8)), e: V('n') },
            idx: V('n'),
            width: 1,
            signed: false,
          },
        },
      ],
    };
    expect(cBackend.emit(idx)).toContain('((u8 *)n)[n]');
  });

  test('the prefix `*` form self-parenthesizes under a postfix parent; nested `-` never lexes as --', () => {
    const mk = (value: Expr): SFn => ({
      name: 'f',
      params: [{ name: 'p', type: T.ptr(T.ptr(T.s(32))) }],
      locals: [],
      retType: T.s(32),
      body: [{ k: 'return', value }],
    });
    const derefP: Expr = { k: 'index', base: V('p'), idx: C(0), width: 4, signed: true };
    expect(cBackend.emit(mk({ k: 'index', base: derefP, idx: C(1), width: 4, signed: true }))).toContain('(*p)[1]'); // not *p[1]
    expect(cBackend.emit(mk({ k: 'un', op: '-', e: { k: 'un', op: '-', e: V('p') } }))).toContain('-(-p)'); // not --p
  });

  test('a multi-line then-statement gets braces — the body is never truncated (gcd bug)', () => {
    const fn: SFn = {
      name: 'f',
      params: [{ name: 'n', type: T.s(32) }],
      locals: [],
      retType: T.s(32),
      body: [
        {
          k: 'if',
          cond: V('n'),
          then: [{ k: 'dowhile', cond: V('n'), body: [{ k: 'assign', name: 'n', value: C(0) }] }],
          else: [],
        },
        { k: 'return', value: V('n') },
      ],
    };
    const out = cBackend.emit(fn);
    expect(out).toContain('} while (n);'); // the loop survives intact
    const opens = (out.match(/\{/g) ?? []).length;
    expect((out.match(/\}/g) ?? []).length).toBe(opens); // balanced braces
    // the single-LINE inlining still works
    const single: SFn = { ...fn, body: [{ k: 'if', cond: V('n'), then: [{ k: 'return', value: C(1) }], else: [] }] };
    expect(cBackend.emit(single)).toContain('if (n) return 1;');
  });
});

describe('F1 adversarial-round pins — hook width, dot-form typing, Pascal width discipline', () => {
  test('C++ member rewrite fires ONLY for word accesses; a sub-word access falls through to the honest cast', () => {
    // The breaker's CRITICAL: a halfword read at byte offset 4 of an all-word class used to map
    // its byte-scaled idx through the WORD-index field table (idx 2 → third member, a 4-byte
    // read at offset 8) — silent wrong member, wrong width. It must spell as the cast instead.
    const backend = cppBackend({
      method: 'get',
      cls: 'C',
      retType: { base: 'int', ptr: 0 },
      params: [],
      classes: {
        C: {
          fields: [
            { name: 'a', type: { base: 'int', ptr: 0 } },
            { name: 'b', type: { base: 'int', ptr: 0 } },
            { name: 'c', type: { base: 'int', ptr: 0 } },
          ],
        },
      },
    });
    const sfn: SFn = {
      name: 'get',
      params: [{ name: 'a0', type: T.ptr(T.s(32)) }],
      locals: [],
      retType: T.s(32),
      body: [{ k: 'return', value: { k: 'index', base: V('a0'), idx: C(2), width: 2, signed: false } }],
    };
    const out = backend.emit(sfn);
    expect(out).toContain('((u16 *)this)[2]'); // the honest spelling
    expect(out).not.toMatch(/return c;/); // never the wrong member
    // ...and the word access still gets the idiomatic member rewrite:
    const word: SFn = {
      ...sfn,
      body: [{ k: 'return', value: { k: 'index', base: V('a0'), idx: C(1), width: 4, signed: true } }],
    };
    expect(backend.emit(word)).toContain('return b;');
  });

  test('a dot-form struct-array element types as the STRUCT — the contract accepts the valid tree', () => {
    // The breaker's HIGH: exprCType's total index case typed a struct-stride element as
    // scalarTypeForAccess(structSize) (s64/s96 garbage), making the field rule reject valid
    // trees the moment struct-arrays wire in.
    const elem = T.struct('Elem0', [{ off: 4, type: T.s(32), name: 'field_4' }], 8);
    const env = new Map([
      ['a0', T.ptr(elem)],
      ['a1', T.s(32)],
    ]);
    const ct = (e: Expr) => exprCType(e, (n) => env.get(n));
    const arrIx: Expr = { k: 'index', base: V('a0'), idx: V('a1'), width: 8, signed: false };
    expect(ct(arrIx)).toEqual(elem); // the struct VALUE, not s64
    const tree: SFn = {
      name: 'f',
      params: [
        { name: 'a0', type: T.ptr(elem) },
        { name: 'a1', type: T.s(32) },
      ],
      locals: [],
      retType: T.s(32),
      body: [{ k: 'return', value: { k: 'field', base: arrIx, name: 'field_4' } }],
    };
    expect(() => assertDerefsTyped(tree)).not.toThrow();
    // ...and a garbage width on a SCALAR index is the new contract catch:
    const garbage: SFn = {
      ...tree,
      body: [{ k: 'return', value: { k: 'index', base: V('a1'), idx: C(0), width: 3, signed: false } }],
    };
    expect(() => assertDerefsTyped(garbage)).toThrow(/width 3/);
  });

  test('Pascal: wrong-stride and sub-word-unknowable derefs decline LOUD; word derefs print', () => {
    const mk = (value: Expr, params: SFn['params']): SFn => ({
      name: 'f',
      params,
      locals: [],
      retType: T.s(32),
      body: [{ k: 'return', value }],
    });
    const pInt = [{ name: 'p', type: T.ptr(T.s(32)) }];
    // word deref through ^Integer — prints
    expect(pascalBackend.emit(mk({ k: 'index', base: V('p'), idx: C(0), width: 4, signed: true }, pInt))).toContain(
      'p^',
    );
    // byte deref through ^Integer — no reinterpret cast exists: loud decline
    expect(() =>
      pascalBackend.emit(mk({ k: 'index', base: V('p'), idx: C(0), width: 1, signed: false }, pInt)),
    ).toThrow(/no faithful spelling/);
    // unknowable base (call): word prints, sub-word declines (the node width would be discarded)
    const call: Expr = { k: 'call', fn: 'g', args: [] };
    expect(pascalBackend.emit(mk({ k: 'index', base: call, idx: C(0), width: 4, signed: true }, pInt))).toContain(
      'g()^',
    );
    expect(() => pascalBackend.emit(mk({ k: 'index', base: call, idx: C(0), width: 2, signed: false }, pInt))).toThrow(
      /unknowable/,
    );
  });
});

describe('C-family pointer-write legalization (the assign-side sibling, F6)', () => {
  const mk = (body: SFn['body'], locals: SFn['locals'], ret = T.s(32)): SFn => ({
    name: 'f',
    params: [
      { name: 'a0', type: T.s(32) },
      { name: 'a1', type: T.s(32) },
    ],
    locals,
    retType: ret,
    body,
  });

  test('an int-rendered value assigned into a pointer var gets the declared-type cast (mwcc errors otherwise)', () => {
    const src = cBackend.emit(
      mk(
        [
          { k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: V('a0'), r: V('a1') } },
          { k: 'return', value: C(0) },
        ],
        [{ name: 'v0', type: T.ptr(T.u(8)) }],
      ),
    );
    expect(src).toContain('v0 = (u8 *)(a0 + a1);');
  });

  test('a ptr-returning function casts an int-rendered return value', () => {
    const src = cBackend.emit(
      mk([{ k: 'return', value: { k: 'bin', op: '+', l: V('a0'), r: V('a1') } }], [], T.ptr(T.s(32))),
    );
    expect(src).toContain('return (s32 *)(a0 + a1);');
  });

  test('a call rendering is unknowable — left to prototypes, never cast', () => {
    const src = cBackend.emit(
      mk(
        [
          { k: 'assign', name: 'v0', value: { k: 'call', fn: 'g', args: [] } },
          { k: 'return', value: C(0) },
        ],
        [{ name: 'v0', type: T.ptr(T.u(8)) }],
      ),
    );
    expect(src).toContain('v0 = g();');
  });

  test('Pascal declines the int→ptr assign LOUD (no reinterpret cast exists there)', () => {
    expect(() =>
      pascalBackend.emit(
        mk(
          [
            { k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: V('a0'), r: V('a1') } },
            { k: 'return', value: C(0) },
          ],
          [{ name: 'v0', type: T.ptr(T.u(32)) }],
        ),
      ),
    ).toThrow(/no faithful spelling/);
  });

  test('Pascal repeat/until spells the single-block do-while (its first producer landed with F6)', () => {
    const src = pascalBackend.emit(
      mk(
        [
          {
            k: 'dowhile',
            cond: { k: 'bin', op: '>', l: V('a0'), r: C(0) },
            body: [{ k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: V('v0'), r: V('a0') } }],
          },
          { k: 'return', value: V('v0') },
        ],
        [{ name: 'v0', type: T.s(32) }],
      ),
    );
    expect(src).toContain('repeat');
    expect(src).toMatch(/until \(not \(/);
  });
});
