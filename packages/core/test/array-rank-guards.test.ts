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
import { exprChildren, exprEquals, mapExprChildren } from '../src/l3/ast';
import { localMentions, readsOf } from '../src/l3/mentions';
import { decompile } from '../src/pipeline';
import { compareScored, composeLevers, rankBy, withheldReason } from '../src/rank';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const ixLead = (lead?: (number | string)[]): Expr => ({
  k: 'index',
  base: { k: 'var', name: 'g' },
  idx: { k: 'var', name: 'i' },
  width: 2,
  signed: false,
  ...(lead
    ? { lead: lead.map((l): Expr => (typeof l === 'number' ? { k: 'const', value: l } : { k: 'var', name: l })) }
    : {}),
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

describe('a `lead` is walked like every other sub-expression', () => {
  // A recovered row index is a VALUE, so a name mentioned there is a real use. A generic walk
  // that skipped it would rename half an address — the reader sees `g[gRow][i]` renamed to
  // `g[gRow][j]`, with the row silently left behind.
  test('exprChildren reaches the leading subscripts, in syntactic order', () => {
    const e = ixLead(['r']) as Extract<Expr, { k: 'index' }>;
    expect(exprChildren(e).map((c) => (c.k === 'var' ? c.name : c.k))).toEqual(['g', 'r', 'i']);
  });

  test('mapExprChildren rewrites them', () => {
    const out = mapExprChildren(ixLead(['r']), (c) =>
      c.k === 'var' && c.name === 'r' ? { k: 'var', name: 'q' } : c,
    ) as Extract<Expr, { k: 'index' }>;
    expect(out.lead?.[0]).toEqual({ k: 'var', name: 'q' });
  });

  test('exprEquals compares them as expressions, not by identity', () => {
    expect(exprEquals(ixLead(['r']), ixLead(['r']))).toBe(true);
    expect(exprEquals(ixLead(['r']), ixLead(['q']))).toBe(false);
    expect(exprEquals(ixLead(['r']), ixLead([0]))).toBe(false);
  });

  // …AND THE ONE WALK THAT IS NOT DERIVED FROM THAT VOCABULARY. l3/mentions.ts hand-rolls its own
  // traversal (it has to tell an `index` BASE from every other position, which `exprChildren`
  // flattens away), so the three tests above cannot speak for it: pinning the generic helpers is
  // exactly what let a walker that bypasses them diverge unnoticed. It is asked here, beside them,
  // because an undercount there does not lose a candidate — it DELETES a local the body still
  // reads, and `assertResolved` looks for absent names, not for unwritten ones.
  test('localMentions counts a name used as a leading subscript as a real read', () => {
    const f: SFn = {
      ...fnOf(ixLead(['r'])),
      locals: [
        { name: 'i', type: T.u(32) },
        { name: 'r', type: T.u(32) },
      ],
    };
    const m = localMentions(f);
    expect(readsOf(m.get('r')!)).toBe(1);
    // …and it is NOT counted as an `index` base: only `g` stands in that position, and the base
    // levers re-spell exactly that use shape.
    expect(m.get('r')!.baseUses).toBe(0);
    expect(m.get('r')!.otherUses).toBe(1);
    // the sibling positions still count as they always did
    expect(readsOf(m.get('i')!)).toBe(1);
  });
});

describe('backends either spell `lead` or refuse it', () => {
  test('the C backend spells every leading subscript', () => {
    expect(cBackend.emit(fnOf(ixLead([0, 0])))).toContain('g[0][0][i]');
    expect(cBackend.emit(fnOf(ixLead(['i'])))).toContain('g[i][i]'); // a recovered row is an expression
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

describe('the PUBLICATION rule for a proof-gated spelling (rank.ts withheldReason / rankBy)', () => {
  // A `matchOnly` spelling is one whose semantics no gate over the C can settle — `/unreduce`
  // moving a read down a span that arms a DMA transfer. It is offered, scored, and then either
  // wins on the differ's own proof or is withheld: never shown as the best-effort answer on a
  // nonmatch row, which is the case the POLICY note says a wrong re-spelling would poison.
  const plain = { label: 'unsigned', group: 0, source: 'a;' };
  const proofed = { label: 'unsigned/unreduce', group: 0, source: 'b;', matchOnly: true as const };

  test('a byte-exact score publishes it, and any other score withholds it', () => {
    expect(withheldReason(proofed, { score: 0 })).toBeNull();
    expect(withheldReason(proofed, { score: 1 })).not.toBeNull();
    // an ordinary spelling is never withheld, whatever it scores
    expect(withheldReason(plain, { score: 99 })).toBeNull();
  });

  test('rankBy withholds it rather than dropping it — the two are different facts', () => {
    const score = (source: string) => ({ score: source === 'b;' ? 5 : 40 });
    const r = rankBy([plain, proofed], 'f', (source) => score(source));
    expect(r.candidates.map((c) => c.label)).toEqual(['unsigned']);
    expect(r.dropped).toEqual([]);
    expect(r.withheld.map((w) => [w.label, w.score])).toEqual([['unsigned/unreduce', 5]]);
    // …and it WINS when it earns it, even though it scored second-best above
    const won = rankBy([plain, proofed], 'f', (source) => (source === 'b;' ? { score: 0 } : { score: 40 }));
    expect(won.best.label).toBe('unsigned/unreduce');
    expect(won.withheld).toEqual([]);
  });

  test('an all-withheld list fails LOUD and says so, rather than reading as a scorer failure', () => {
    expect(() => rankBy([proofed], 'f', () => ({ score: 7 }))).toThrow(/1 candidate\(s\) withheld/);
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

// THE PROPAGATION RULE, which is the other half of the mechanism above. `withheldReason` decides
// what a proof-gated spelling may publish AT; this decides which spellings are proof-gated at all.
//
// The obligation is created by ONE lever (`/unreduce`, when it cannot settle a device-memory fact
// from inside the pass) and has to survive every lever composed after it. That carry used to be
// hand-written per pairing — `return { sfn: t, needsProof: u.needsProof }` — and the union type
// made `return t;` a type-correct way to delete it: ablated, tsc stayed clean and every offline and
// matching suite stayed green, and the triple would have published an unprovable spelling as
// asmlift's answer. Composing through one combinator makes that inexpressible, so the combinator is
// the thing to pin.
describe('a proof obligation survives every lever composed after it (rank.ts composeLevers)', () => {
  const tree = (name: string): SFn => ({ name, params: [], locals: [], globals: [], retType: T.u(32), body: [] });
  const plain = (name: string) => (): SFn => tree(name);
  const proving = (name: string) => (): { sfn: SFn; needsProof: boolean } => ({ sfn: tree(name), needsProof: true });
  const settled = (name: string) => (): { sfn: SFn; needsProof: boolean } => ({ sfn: tree(name), needsProof: false });
  const proofOf = (r: ReturnType<typeof composeLevers>) => (r && 'sfn' in r ? r.needsProof : false);
  const treeOf = (r: ReturnType<typeof composeLevers>) => (r && 'sfn' in r ? r.sfn : r);

  test('an obligation raised by an EARLY stage rides through the later ones', () => {
    const out = composeLevers(tree('in'), [proving('a'), plain('b'), plain('c')]);
    expect(proofOf(out)).toBe(true);
    expect(treeOf(out)?.name).toBe('c'); // and the last stage's tree is what is emitted
  });

  test('an obligation raised by a LATE stage is carried too', () => {
    expect(proofOf(composeLevers(tree('in'), [plain('a'), proving('b')]))).toBe(true);
  });

  test('a stage that settles its own fact does not gate the composition', () => {
    const out = composeLevers(tree('in'), [settled('a'), plain('b')]);
    expect(proofOf(out)).toBe(false);
    expect(treeOf(out)?.name).toBe('b');
  });

  test('no obligation anywhere leaves the spelling ungated', () => {
    expect(proofOf(composeLevers(tree('in'), [plain('a'), plain('b')]))).toBe(false);
  });

  // REQUIRE-ALL, not skip-on-decline: the label names the levers that fired, so a composition
  // missing one of them must not be emitted under the full label.
  test('one declining stage declines the whole composition, wherever it sits', () => {
    const decline = () => null;
    expect(composeLevers(tree('in'), [decline, proving('b')])).toBeNull();
    expect(composeLevers(tree('in'), [proving('a'), decline])).toBeNull();
    expect(composeLevers(tree('in'), [plain('a'), decline, plain('c')])).toBeNull();
  });

  test("each stage is handed the PREVIOUS stage's tree, not the original", () => {
    const seen: string[] = [];
    const step =
      (name: string) =>
      (s: SFn): SFn => (seen.push(s.name), tree(name));
    composeLevers(tree('in'), [step('a'), step('b'), step('c')]);
    expect(seen).toEqual(['in', 'a', 'b']);
  });
});
