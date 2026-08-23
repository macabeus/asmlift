// The `index.lead` safety perimeter (the multidimensional array-global spelling).
//
// `lead` is an OPTIONAL field on an existing node, which is only safe because every generic
// rewrite preserves it (`mapExprChildren` spreads) and every site that REBUILDS an `index` from
// parts either carries it or refuses. Those refusals are the entire argument, so they are pinned
// here: each one is a place where dropping `lead` would turn an ELEMENT access into a ROW's —
// a wrong address, silently.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { T } from '../src/ir/types';
import type { Expr, SFn } from '../src/l3/ast';
import { exprEquals } from '../src/l3/ast';
import { decompile } from '../src/pipeline';
import { compareScored } from '../src/rank';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const ixLead = (lead?: number[]): Expr => ({
  k: 'index',
  base: { k: 'var', name: 'g' },
  idx: { k: 'var', name: 'i' },
  width: 2,
  signed: false,
  ...(lead ? { lead } : {}),
});

const fnOf = (value: Expr): SFn => ({
  name: 'f',
  params: [],
  locals: [{ name: 'i', type: T.u(32) }],
  globals: [{ name: 'g', type: T.ptr(T.u(16)) }],
  retType: T.u(16),
  body: [{ k: 'return', value }],
});

describe('exprEquals treats `lead` as part of the address', () => {
  test('different leading subscripts are DIFFERENT expressions', () => {
    // `g[0][i]` and `g[1][i]` are 2048 bytes apart; collapsing them in any dedup/CSE path
    // would silently reuse one element's value for the other's.
    expect(exprEquals(ixLead([0]), ixLead([1]))).toBe(false);
    expect(exprEquals(ixLead([0]), ixLead())).toBe(false); // `g[0][i]` is not `g[i]`
    expect(exprEquals(ixLead([0, 0]), ixLead([0]))).toBe(false); // rank is part of it too
  });

  test('identical leading subscripts still compare equal', () => {
    expect(exprEquals(ixLead([0, 0]), ixLead([0, 0]))).toBe(true);
    expect(exprEquals(ixLead(), ixLead())).toBe(true);
  });
});

describe('backends either spell `lead` or refuse it', () => {
  test('the C backend spells every leading subscript', () => {
    expect(cBackend.emit(fnOf(ixLead([0, 0])))).toContain('g[0][0][i]');
  });

  test('the C backend REFUSES a lead whose base does not stride the access width', () => {
    // `lead` implies the base is already a matching element pointer. If it were not, the
    // deref legalization would wrap it and spell `((u16 *)g)[0][i]` — a double subscript of a
    // scalar. The invariant is checked rather than assumed.
    const fn = fnOf(ixLead([0]));
    fn.globals = [{ name: 'g', type: T.ptr(T.u(8)) }]; // stride 1 vs the node's width 2
    expect(() => cBackend.emit(fn)).toThrow(/multidimensional array access needs a base that strides/);
  });

  test('the C backend REFUSES a lead under the dot form rather than dropping it', () => {
    // `arr[i].field` spells its base index node from parts, so a `lead` there would vanish.
    // Unreachable today (the lead branch requires `fieldOff === undefined`), but this is a
    // text-returning path and silence would spell a ROW's address.
    const fn = fnOf({ k: 'field', base: ixLead([0]), name: 'field_0' });
    expect(() => cBackend.emit(fn)).toThrow(/no struct-field spelling/);
  });

  test('the Pascal backend DECLINES rather than dropping the subscripts', () => {
    // IDO Pascal has no spelling for this yet; emitting `g[i]` would read a row's address.
    expect(() => pascalBackend.emit(fnOf(ixLead([0])))).toThrow(/multidimensional/);
  });
});

describe('shift signedness is judged in the environment that PRINTS the code', () => {
  test("an array global's ELEMENT signedness reaches the shift rule", () => {
    // The map says the elements are u32; the asm shifts one arithmetically (`asr`). The operand
    // must be cast back to signed, or C spells the LOGICAL shift over the u32 element and the
    // value differs for a negative element.
    //
    // This is why the rule lives in the backend: the structurer's variable environment holds
    // params and locals only, so it types `gTable[i]` from the access width alone and would
    // answer "signed" for every word load whatever the map said. The backend judges against
    // `declaredTypes(sfn)`, which includes the shaped globals.
    const asm =
      'f:\n\tldr\tr1, .L1\n\tlsls\tr0, r0, #0x2\n\tadds\tr0, r1, r0\n\tldr\tr0, [r0]\n' +
      '\tasrs\tr0, r0, #0x4\n\tbx\tlr\n.L1:\n\t.word\t0x08057B4C\n';
    const map: SymbolMap = new Map([
      [
        0x08057b4c,
        [
          {
            name: 'gTable',
            kind: 'data' as const,
            shape: 'array' as const,
            elemSize: 4,
            elemSigned: false,
            dims: [64],
          },
        ],
      ],
    ]);
    expect(decompile('f', asm, ARMV4T_AGBCC, { symbols: map }).source).toContain('(s32)gTable[a0] >> 4');
  });
});

describe('the candidate ordering (rank.ts compareScored)', () => {
  // Score dominates absolutely; everything below only chooses what the READER sees. The pieces
  // under it exist because the C backend's shift cast made a WRONG signedness pin byte-equal to
  // the right one — before that, the wrong pin simply lost on score.
  const cand = (label: string, group: number, source: string, score: number, order: number) => ({
    label,
    group,
    source,
    score: { score },
    order,
  });

  test('score wins over everything', () => {
    const worse = cand('a', 0, 'x;', 1, 0);
    const better = cand('b', 1, '(u32)(s32)(u8)x;', 0, 9);
    expect([worse, better].sort(compareScored)[0].label).toBe('b');
  });

  test('a named symbol-map spelling beats its /raw-globals sibling at equal bytes', () => {
    // …even though the raw one looks cheaper by cast count: its `(u8 *)` base is a POINTER cast,
    // which is not counted, so ranking these two on casts would trade named struct fields for
    // anonymous byte offsets. The group comparison is what stops that.
    const named = cand('signed', 0, 'a0 = (s32)(gSys.idx << 24) >> 24;', 20, 0);
    const raw = cand('signed/raw-globals', 1, 'p0 = (u8 *)&gSys; a0 = p0[1] << 24 >> 24;', 20, 1);
    expect([raw, named].sort(compareScored)[0].label).toBe('signed');
  });

  test('WITHIN a group, fewer casts wins over enumeration order', () => {
    // the wrong signedness pin is what manufactures the cast, and it is enumerated FIRST
    const noisy = cand('unsigned', 0, 'return (s32)a0 >> a1;', 0, 0);
    const clean = cand('signed', 0, 'return a0 >> a1;', 0, 1);
    expect([noisy, clean].sort(compareScored)[0].label).toBe('signed');
  });

  test('an ADDRESS cast is not counted — it is the correct source spelling, not noise', () => {
    // `(u32)&gSym` is what decomp projects write for integer arithmetic on a link-time address;
    // counting it would penalize the named spelling this ordering exists to prefer. Same
    // exemption the benchmark's readability metric applies (apps/benchmark/src/eval/quality.ts).
    // The address-cast candidate is enumerated FIRST, so it only loses if its `(u32)&` is
    // counted as noise. It must not be.
    const addr = cand('named', 0, 'return (u32)&gSym + 4;', 0, 0);
    const bare = cand('raw', 0, 'return 50336308 + 4;', 0, 1);
    expect([bare, addr].sort(compareScored)[0].label).toBe('named');
    // …while a genuine value cast in the same position DOES lose.
    const noisy = cand('noisy', 0, 'return (u32)v0 + 4;', 0, 0);
    expect([bare, noisy].sort(compareScored)[0].label).toBe('raw');
  });

  test('at equal casts the COMPACTER spelling wins over enumeration order', () => {
    // The two byte-identical spellings synthetic:iszero has: the bare `if/else` is enumerated
    // first, and the `/defsite`-anchored pre-initialization says the same thing in three fewer
    // lines. Casts tie at zero, so without this key enumeration order installs the longer one.
    const long = cand(
      'unsigned',
      0,
      's32 v0;\nif (a0 == 0) {\n    v0 = 1;\n} else {\n    v0 = 0;\n}\nreturn v0;',
      0,
      0,
    );
    const short = cand('unsigned/defsite', 0, 's32 v0;\nv0 = 0;\nif (a0 == 0) v0 = 1;\nreturn v0;', 0, 1);
    expect([long, short].sort(compareScored)[0].label).toBe('unsigned/defsite');
    // …and it stays UNDER the cast count: a compacter spelling does not buy its way past noise.
    const noisy = cand('noisy', 0, 'return (u32)v0;', 0, 0);
    const clean = cand('clean', 0, 's32 v1;\nv1 = v0;\nreturn v1;', 0, 1);
    expect([noisy, clean].sort(compareScored)[0].label).toBe('clean');
  });

  test('equal on every key falls back to enumeration order — a strict total order', () => {
    const a = cand('a', 0, 'x;', 0, 0);
    const b = cand('b', 0, 'x;', 0, 1);
    expect([b, a].sort(compareScored).map((c) => c.label)).toEqual(['a', 'b']);
  });
});

describe('the LOGICAL right shift has no IDO Pascal spelling — it declines, never borrows `rshift`', () => {
  // `rshift` over this backend's signed `Integer` reproduces IDO's `sra` (pinned byte-exact
  // against upas by pascal-ido.test.ts `asr2`). Mapping `>>>` onto it too would emit an
  // ARITHMETIC shift where the machine did a logical one — silently wrong, in the backend whose
  // whole discipline is to decline what it cannot spell faithfully.
  const shiftFn = (op: '>>' | '>>>'): SFn =>
    fnOf({ k: 'bin', op, l: { k: 'var', name: 'i' }, r: { k: 'const', value: 1 } });

  test('the ARITHMETIC shift still spells rshift', () => {
    expect(pascalBackend.emit(shiftFn('>>'))).toContain('rshift(i, 1)');
  });

  test('the LOGICAL shift declines LOUDLY, naming the operator', () => {
    expect(() => pascalBackend.emit(shiftFn('>>>'))).toThrow(/operator '>>>' has no faithful IDO Pascal spelling/);
  });
});
