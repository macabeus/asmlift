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
import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { without } from '../src/l3/gates';
import { OFFMEMBER_GATES, offmemberBases, spellOperandMembers } from '../src/l3/offmember';
import { structureChecked } from '../src/pipeline';
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
    expect(offmemberBases(NON_LEAF, without(OFFMEMBER_GATES, 'non-leaf-base'))).toHaveLength(1);
  });

  test('no-operand-off: one access without a displacement refuses the WHOLE base', () => {
    // Two accesses through one address; only the first carries a displacement. The base is
    // refused whole, so the declared struct is never a partial description of the address.
    const MIXED = fn([ret(idx(cbase(64), 7, 2, { operandOff: 14 })), ret(idx(cbase(64), 4, 2))]);
    expect(offmemberBases(MIXED)).toEqual([]);
    expect(offmemberBases(MIXED, without(OFFMEMBER_GATES, 'no-operand-off'))).toHaveLength(1);
  });

  test('index-carries-more: a subscript wider than the displacement is refused', () => {
    // `.word gSym+0x4` + `ldrh [r0, #0x6]`: the subscript folds to 10 bytes, the instruction
    // carried 6, and how that split maps back onto one member is not measured.
    const SPLIT = fn([ret(idx(cbase(64), 5, 2, { operandOff: 6 }))]);
    expect(offmemberBases(SPLIT)).toEqual([]);
    expect(offmemberBases(SPLIT, without(OFFMEMBER_GATES, 'index-carries-more'))).toHaveLength(1);
  });

  test('a base whose accesses no plain struct can seat is refused', () => {
    // A word read at byte 4 and a halfword at byte 6 through one address: the two ranges collide,
    // so no plain struct declares both where the asm read them. This is the table's one SOUND
    // gate, and ablating it shows WRONGNESS rather than a worse score — `m4` occupies bytes 4..7,
    // so the declaration seats `m6` at byte 8 while the access still reads `->m6`.
    const OVERLAP = fn([ret(idx(cbase(64), 1, 4, { operandOff: 4 })), ret(idx(cbase(64), 3, 2, { operandOff: 6 }))]);
    expect(offmemberBases(OVERLAP)).toEqual([]);
    const ablated = spellOperandMembers(OVERLAP, without(OFFMEMBER_GATES, 'unspellable-layout'))!;
    expect(ablated.structs![0].fields.map((f) => f.name)).toEqual(['_pad0', 'm4', 'm6']);
    expect(cBackend.emit(ablated)).toContain('->m6');
  });
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
