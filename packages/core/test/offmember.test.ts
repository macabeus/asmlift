// `/offmember` (l3/offmember.ts): a leaf base's constant subscript spelled as a struct MEMBER, so
// the offset stays in the load's displacement instead of folding into the pool literal. The
// SECOND source of the shape `/basefold` reads — that row answers the same evidence with a named
// base — and the one the roster had no spelling for.
//
// What these pin: the evidence really is the INSTRUCTION's displacement and not the tree's
// subscript (the addend form, which is `synthetic:bgbaked`'s shape, declines); each gate is
// load-bearing under ablation; the synthesized declaration cannot collide with the two passes
// that already mint struct names; and the respelled tree satisfies the boundary contracts a
// ranked lever is re-checked against.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { assertDerefsTyped, assertLocalsWritten, assertResolved } from '../src/contracts';
import { frontendFor } from '../src/frontend/registry';
import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { without } from '../src/l3/gates';
import { OFFMEMBER_GATES, offmemberBases, spellOperandMembers } from '../src/l3/offmember';
import { applyIdiomPatterns, raiseRecovered, structureChecked } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

const lifted = (ir: string): SFn => structureChecked(parse(ir), {});

// `.word 0x3003468` + `ldrh r0, [r0, #0xe]` — the displacement survived into the instruction, so
// something other than a subscript put it there.
const OPERAND = `fn f {
^bb0():
  %0: s32 = const {value=50345064}
  %1: s32 = load %0 {off=14, signed=false, width=2}
  ret %1
}
`;
// `.word 0x3003476` + `ldrh r0, [r0]` — the address already carried the offset. This is
// `synthetic:bgbaked`'s shape, and the row it guards: re-spelling it costs that match 2.
const ADDEND = `fn f {
^bb0():
  %0: s32 = const {value=50345078}
  %1: s32 = load %0 {off=0, signed=false, width=2}
  ret %1
}
`;

describe('the displacement is the evidence, and only the displacement', () => {
  test('a leaf base whose offset reached the instruction re-spells as a member', () => {
    const out = spellOperandMembers(lifted(OPERAND));
    expect(out).not.toBeNull();
    expect(cBackend.emit(out!)).toContain('((struct Off0 *)50345064)->m14');
    expect(out!.structs?.map((s) => s.name)).toEqual(['Off0']);
    // the declaration seats the member at its own offset on its own — a `u8[14]` pad, then `m14`
    expect(cBackend.emit(out!)).toContain('struct Off0 {');
    expect(cBackend.emit(out!)).toMatch(/u8 _pad0\[14\];/);
  });

  test('the addend form DECLINES — there is no displacement to have come from a member', () => {
    expect(spellOperandMembers(lifted(ADDEND))).toBeNull();
    expect(offmemberBases(lifted(ADDEND))).toEqual([]);
  });

  test('the respelled tree denotes the same cell as the tree it replaced', () => {
    // 50345064 + 14 both ways — the member offset is the node's own `idx * width`, never
    // `operandOff`, which is why a partial displacement can only cost a candidate.
    expect(cBackend.emit(lifted(OPERAND))).toContain('((u16 *)50345064)[7]');
    expect(cBackend.emit(spellOperandMembers(lifted(OPERAND))!)).toContain('((struct Off0 *)50345064)->m14');
  });

  test('the respelled tree satisfies the boundary contracts a ranked lever is re-checked against', () => {
    const out = spellOperandMembers(lifted(OPERAND))!;
    expect(() => {
      assertResolved(out);
      assertDerefsTyped(out);
      assertLocalsWritten(out);
    }).not.toThrow();
  });
});

// ── the gates, each ablated ────────────────────────────────────────────────────────────────
// Hand-built trees, because two of the four shapes have no lift that produces them and the point
// is the ADMISSION rather than the recovery.
const idx = (base: Expr, i: number, width: number, evidence: object = {}): Expr => ({
  k: 'index',
  base,
  idx: { k: 'const', value: i },
  width,
  signed: false,
  ...evidence,
});
const cbase = (value: number): Expr => ({ k: 'const', value });
const fn = (body: Stmt[]): SFn => ({ name: 'f', params: [], locals: [], retType: T.void(), body });
const ret = (e: Expr): Stmt => ({ k: 'return', value: e });

describe('every gate is load-bearing', () => {
  // `((u16 *)v0)[8]` — a computed base. The address is already held in a register, so nothing
  // folded into a literal and the displacement says nothing. This is `synthetic:bgshare`'s and
  // `synthetic:bgswitch`'s shape once `/addr-home` has homed their base.
  const NON_LEAF = fn([ret(idx({ k: 'var', name: 'v0' }, 8, 2, { operandOff: 16 }))]);

  test('non-leaf-base: a computed base is refused, and ablating it admits', () => {
    expect(offmemberBases(NON_LEAF)).toEqual([]);
    expect(offmemberBases(NON_LEAF, { gates: without(OFFMEMBER_GATES, 'non-leaf-base') })).toHaveLength(1);
  });

  test('no-operand-off: one access without a displacement refuses the WHOLE base', () => {
    // Two accesses through one address; only the first carries a displacement. The base is
    // refused whole, so the declared struct is never a partial description of the address.
    const MIXED = fn([ret(idx(cbase(64), 7, 2, { operandOff: 14 })), ret(idx(cbase(64), 4, 2))]);
    expect(offmemberBases(MIXED)).toEqual([]);
    expect(offmemberBases(MIXED, { gates: without(OFFMEMBER_GATES, 'no-operand-off') })).toHaveLength(1);
  });

  test('index-carries-more: a subscript wider than the displacement is refused', () => {
    // `.word gSym+0x4` + `ldrh [r0, #0x6]`: the subscript folds to 10 bytes, the instruction
    // carried 6, and how that split maps back onto one member is not measured.
    const SPLIT = fn([ret(idx(cbase(64), 5, 2, { operandOff: 6 }))]);
    expect(offmemberBases(SPLIT)).toEqual([]);
    expect(offmemberBases(SPLIT, { gates: without(OFFMEMBER_GATES, 'index-carries-more') })).toHaveLength(1);
  });

  test('a base whose accesses no plain struct can seat is refused', () => {
    // A word read at byte 4 and a halfword at byte 6 through one address: the two ranges collide,
    // so no plain struct declares both where the asm read them. This is the table's one SOUND
    // gate, and ablating it shows WRONGNESS rather than a worse score — `m4` occupies bytes 4..7,
    // so the declaration seats `m6` at byte 8 while the access still reads `->m6`.
    const OVERLAP = fn([ret(idx(cbase(64), 1, 4, { operandOff: 4 })), ret(idx(cbase(64), 3, 2, { operandOff: 6 }))]);
    expect(offmemberBases(OVERLAP)).toEqual([]);
    const ablated = spellOperandMembers(OVERLAP, { gates: without(OFFMEMBER_GATES, 'unspellable-layout') })!;
    expect(ablated.structs![0].fields.map((f) => f.name)).toEqual(['_pad0', 'm4', 'm6']);
    expect(cBackend.emit(ablated)).toContain('->m6');
  });

  // Two views of ONE offset at ONE width but different SIGNEDNESS — a union, which is not a
  // member, so it is refused exactly as the width union is. Ablating shows a changed VALUE rather
  // than a worse score: the two collapse into whichever member `membersOf` prefers, and `ldrb`
  // respelled through an `s8` sign-extends.
  const SIGN_UNION = fn([
    ret(idx(cbase(64), 3, 1, { operandOff: 3 })),
    ret({ ...(idx(cbase(64), 3, 1, { operandOff: 3 }) as Extract<Expr, { k: 'index' }>), signed: true }),
  ]);

  test('a signedness union at one offset is refused, and ablating it CHANGES what the C reads', () => {
    expect(offmemberBases(SIGN_UNION)).toEqual([]);
    const ablated = spellOperandMembers(SIGN_UNION, { gates: without(OFFMEMBER_GATES, 'unspellable-layout') })!;
    // one `s8` member, and the UNSIGNED read now goes through it — the value change the gate stops
    expect(cBackend.emit(ablated)).toMatch(/s8 m3;/);
    expect(cBackend.emit(ablated).match(/->m3/g)).toHaveLength(2);
  });

  // THE PRICE OF HAVING NO DEVICE-REGISTER REFUSAL, on real compiled asm rather than a hand-built
  // tree, so it stays true when the lift changes. 0x040000D4 + 8 is REG_DMA3CNT: this pass admits
  // the register file like any other leaf base and declares a struct over it, carrying no
  // qualifier. The header states the three measurements behind that — chiefly that a window
  // refusal removes ZERO bases corpus-wide, and that a symbol map switches one off entirely by
  // turning the address into a named `addr` no numeric window can read.
  //
  // WHAT ACTUALLY REFEREES IT is the differ, and this asm is the case where nothing else does:
  // the benchmark's own agbcc command compiles
  // `volatile u32 *d = (volatile u32 *)0x040000d4; d[2] = c | 1 << 31; while (d[2] & 1 << 31) {}`
  // to a DMACNT spin that never touches DMASAD, so `no-operand-off` — which covers every device
  // base in the corpus — does not cover this one. Ranked against its own object the shape LOSES:
  // 52 candidates, best `unsigned/derived-home/livebase/volatile: 4`, best `/offmember` 5. A row
  // where it WINS is what would earn a device gate back, together with a window reading that
  // survives a symbol map.
  const DEVICE_ASM =
    'dmakick:\n' +
    '\tldr\tr2, .L7\n' +
    '\tmov\tr1, #0x80\n' +
    '\tlsl\tr1, r1, #0x18\n' +
    '\torr\tr0, r0, r1\n' +
    '\tstr\tr0, [r2, #0x8]\n' +
    '.L3:\n' +
    '\tldr\tr0, [r2, #0x8]\n' +
    '\tand\tr0, r0, r1\n' +
    '\tcmp\tr0, #0\n' +
    '\tbne\t.L3\n' +
    '\tbx\tlr\n' +
    '.L8:\n\t.align\t2, 0\n' +
    '.L7:\n\t.word\t0x40000d4\n';

  test('a device register is admitted like any other leaf base, and the member it declares is unqualified', () => {
    const sfn = structureChecked(
      (() => {
        const f = frontendFor(ARMV4T_AGBCC).lift('dmakick', DEVICE_ASM, ARMV4T_AGBCC, {}, undefined, undefined);
        applyIdiomPatterns(f, ARMV4T_AGBCC);
        raiseRecovered(f, ARMV4T_AGBCC, {}, undefined);
        return f;
      })(),
      {},
    );
    expect(offmemberBases(sfn)).toEqual(['c:67109076']);
    const out = cBackend.emit(spellOperandMembers(sfn)!);
    expect(out).toContain('struct Off0 { u8 _pad0[8]; s32 m8; };');
    expect(out).toContain('((struct Off0 *)67109076)->m8');
    // the cost this pins: the qualifier the cell wants is not in the spelling, and no gate here
    // objects — `/volatile` is the sibling candidate that carries it, and it never composes with
    // this one because `non-leaf-base` refuses the cast it wraps the base in
    expect(out).not.toContain('volatile');
  });
});

// ── what the declaration governs ───────────────────────────────────────────────────────────
// One address CAN leave here spelled two ways, and that is the shipped behaviour rather than an
// oversight: the declaration governs the constant subscripts it was built from, and a sibling this
// pass has no member spelling for keeps its own cast. Pinned because the alternative was built and
// measured — refusing a base whose siblings it cannot spell costs
// kleod:ProcessInputAndUpdateEntities 248 → 273 and moves none of the other eight artifact rows
// whose winner carries `/offmember`, which are the only rows an extra gate here can move.
test('a variable-subscript sibling keeps its own cast beside the respelled member', () => {
  const MIXED = fn([
    ret(idx(cbase(50345232), 4, 4, { operandOff: 16 })),
    ret({ k: 'index', base: cbase(50345232), idx: { k: 'var', name: 'a0' }, width: 4, signed: false }),
  ]);
  expect(offmemberBases(MIXED)).toEqual(['c:50345232']);
  const src = cBackend.emit(spellOperandMembers(MIXED)!);
  expect(src).toContain('((struct Off0 *)50345232)->m16');
  // the sibling is untouched — it reads the bytes it always read, through its own cast
  expect(src).toContain('((s32 *)50345232)[a0]');
  // and the declaration describes only what it governs: one member, no claim about the sibling
  expect(
    spellOperandMembers(MIXED)!
      .structs!.at(-1)!
      .fields.map((f) => f.name),
  ).toEqual(['_pad0', 'm16']);
});

// A base read ONLY through a variable subscript reaches no site at all, so it is never a key and
// never a declaration — the `order` walk only ever sees constant subscripts.
test('a base read only through a variable subscript is not a key', () => {
  const ONLY_VAR = fn([ret({ k: 'index', base: cbase(64), idx: { k: 'var', name: 'a0' }, width: 4, signed: false })]);
  expect(offmemberBases(ONLY_VAR)).toEqual([]);
  expect(spellOperandMembers(ONLY_VAR)).toBeNull();
});

// ── the synthesized name ───────────────────────────────────────────────────────────────────
// raise/structs.ts mints `Struct<N>`, raise/struct-arrays.ts `Elem<N>`. A collision here declares
// one layout under a name another access reads, and nothing downstream would say so — the same
// class of silent loss as a deleted `localNames` entry.
describe('the declaration cannot collide with the two passes that already mint struct names', () => {
  const WITH_SIBLINGS: SFn = {
    ...fn([ret(idx(cbase(64), 7, 2, { operandOff: 14 }))]),
    structs: [
      { name: 'Elem0', fields: [{ off: 0, type: T.s(32), name: 'field_0' }], size: 28 },
      { name: 'Struct0', fields: [{ off: 0, type: T.s(32), name: 'field_0' }] },
    ],
  };

  test('a tree already carrying Elem0 and Struct0 gets a distinct Off0, and keeps both', () => {
    const out = spellOperandMembers(WITH_SIBLINGS)!;
    expect(out.structs?.map((s) => s.name)).toEqual(['Elem0', 'Off0', 'Struct0']);
    const src = cBackend.emit(out);
    expect(src).toContain('struct Elem0 {');
    expect(src).toContain('struct Struct0 {');
    expect(src).toContain('struct Off0 {');
  });

  test('and a tree already carrying an Off0 seeds past it', () => {
    const taken: SFn = {
      ...fn([ret(idx(cbase(64), 7, 2, { operandOff: 14 }))]),
      structs: [{ name: 'Off0', fields: [{ off: 0, type: T.s(32), name: 'm0' }] }],
    };
    expect(spellOperandMembers(taken)!.structs?.map((s) => s.name)).toEqual(['Off0', 'Off1']);
  });

  // THE SEED IS MONOTONE, NOT FIRST-FREE. A first-free walk stops at the first GAP, so a tree
  // carrying Off0 and Off2 would restart at Off1 and mint a second Off2 — one name, two layouts,
  // and `structs` is a list rather than a map, so nothing downstream would say so.
  test('a NON-CONTIGUOUS taken set does not wrap back onto a taken name', () => {
    const gappy: SFn = {
      ...fn([ret(idx(cbase(64), 7, 2, { operandOff: 14 })), ret(idx(cbase(128), 7, 2, { operandOff: 14 }))]),
      structs: [
        { name: 'Off0', fields: [{ off: 0, type: T.s(32), name: 'm0' }] },
        { name: 'Off2', fields: [{ off: 0, type: T.s(32), name: 'm0' }] },
      ],
    };
    const names = spellOperandMembers(gappy)!.structs!.map((s) => s.name);
    expect(names).toEqual(['Off0', 'Off2', 'Off3', 'Off4']);
    expect(new Set(names).size).toBe(names.length);
  });
});

// The roster wiring, end to end: the axis is offered only where the target declares the fold, and
// it produces a candidate on the shape it was built for.
test('rank offers /offmember on a fold-declaring target', () => {
  const asm =
    'f:\n' +
    '\tldr\tr0, .L1\n' +
    '\tldrh\tr0, [r0, #0xe]\n' +
    '\tbx\tlr\n' +
    '.L2:\n\t.align\t2, 0\n' +
    '.L1:\n\t.word\t0x3003468\n';
  const labels = enumerateCandidates('f', asm, ARMV4T_AGBCC).map((c) => c.label);
  expect(labels.some((l) => l.includes('/offmember'))).toBe(true);
});
