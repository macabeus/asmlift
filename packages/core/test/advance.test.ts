// The BASE-ADVANCE capability: `ldr r3,=X; strh [r3]; adds r3,#2; strh [r3]` — a register the
// machine held as an address and then moved to reach a second address.
//
// Three levels, three questions, and this file holds the last two:
//   • `raise/const.ts` records the step on the literal its fold produces — pinned in
//     `const-fold.test.ts` case (g), beside the fold whose behaviour is unchanged;
//   • the STRUCTURE SEAM copies it onto the access node as `index.baseAdvanced` (l3/ast.ts's third
//     evidence field);
//   • `l3/advance.ts` reads it and offers the one C spelling that reproduces the `add`.
//
// WHY THE SPELLING IS A CANDIDATE AND NOT A DEFAULT, compiled through the benchmark's own agbcc
// command rather than reasoned about. Against `kleod:StreamCmd_SetWindowRegs`'s target object:
//   `volatile u16 *p = (volatile u16 *)0x04000048; *p = a; p++; *p = b;`  → byte-exact
//   the same with `p[1]` instead of `p++`                                 → `strh [r3, #2]`, no add
//   the same without `volatile`                                           → `strh [r3, #2]`, no add
// So the advance is INERT wherever the pointee is not volatile — agbcc folds it straight back into
// the memory operand — and it is the `volatile` × advance CONJUNCTION that reproduces the target.
// Neither half is worth a default: the subscript spelling is right for every access the compiler
// did fold, which is nearly all of them.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { advancedBases } from '../src/l3/advance';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { recognizeConsts } from '../src/raise/const';
import { recoverTypes } from '../src/raise/recover';
import { enumerateCandidates } from '../src/rank';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC } from '../src/target';
import { count } from './helpers';

// Two halfword stores 2 bytes apart through ONE address register — the `REG_WININ` pair, reduced.
const ADVANCE_IR = `fn advance {
^bb0(%0: s32):
  %1: s32* = const {value=67108936}
  store %1, %0 {off=0, width=2}
  %2: s32 = const {value=2}
  %3: s32* = add %1, %2
  store %3, %0 {off=0, width=2}
  ret
}
`;

export const structured = (ir: string): SFn => {
  const fn = parse(ir);
  recognizeConsts(fn);
  recoverTypes(fn);
  return structure(fn, { returnsVoid: true });
};

/** Every `index` node in the tree, in emission order. */
const indexNodes = (sfn: SFn): Extract<Expr, { k: 'index' }>[] => {
  const out: Extract<Expr, { k: 'index' }>[] = [];
  const walk = (e: Expr): void => {
    if (e.k === 'index') {
      out.push(e);
    }
    for (const child of Object.values(e as Record<string, unknown>)) {
      if (child && typeof child === 'object' && 'k' in (child as object)) {
        walk(child as Expr);
      }
    }
  };
  for (const s of sfn.body) {
    if (s.k === 'store') {
      walk(s.lval);
      walk(s.value);
    }
  }
  return out;
};

test('the structure seam carries the advance onto the access it reached', () => {
  const nodes = indexNodes(structured(ADVANCE_IR));
  expect(nodes.map((n) => n.baseAdvanced)).toEqual([undefined, 2]);
});

test('the advanced access still denotes the cell its absolute address names', () => {
  const out = cBackend.emit(structured(ADVANCE_IR));
  expect(out).toContain('67108936');
  expect(out).toContain('67108938');
});

// ── the lever ────────────────────────────────────────────────────────────────────────────────
// The decline cases build trees directly rather than lifting asm: each one differs from the
// admitted shape in exactly ONE of the pass's rules, which an IR fixture cannot isolate (the
// evidence and the addresses are produced together by the fold).
const u16p: SFn['locals'][number]['type'] = { kind: 'ptr', to: { kind: 'int', width: 16, signed: false } };
const cell = (addr: number, width = 2, evidence: object = {}): Expr => ({
  k: 'index',
  base: { k: 'cast', to: u16p, e: { k: 'const', value: addr } },
  idx: { k: 'const', value: 0 },
  width,
  signed: false,
  ...evidence,
});
const storeTo = (lval: Expr): Stmt => ({ k: 'store', lval, value: { k: 'var', name: 'a' } });
const fnWith = (body: Stmt[]): SFn => ({
  name: 'f',
  params: [{ name: 'a', type: { kind: 'int', width: 32, signed: true } }],
  locals: [],
  retType: { kind: 'void' },
  body,
});
const PAIR = [storeTo(cell(0x04000048)), storeTo(cell(0x0400004a, 2, { baseAdvanced: 2 }))];

test('an advanced pair becomes one local moved in place', () => {
  const out = cBackend.emit(advancedBases(fnWith(PAIR))!);
  expect(out).toMatch(/u16 \* p0;/);
  expect(out).toMatch(/p0 = \(u16 \*\)67108936;/);
  expect(out).toMatch(/p0 = p0 \+ 1;/);
  expect(count(out, '*p0 = a;')).toBe(2);
  expect(out).not.toContain('67108938');
});

test('the whole chain rides one local, not one per link', () => {
  const out = cBackend.emit(advancedBases(fnWith([...PAIR, storeTo(cell(0x0400004c, 2, { baseAdvanced: 2 }))]))!);
  expect(count(out, 'p0 = p0 + 1;')).toBe(2);
  expect(count(out, '*p0 = a;')).toBe(3);
});

// The whole gate. Without the stamp the pair is a compiler that derived two addresses from one
// pool word, and the subscript spelling is the only one asmlift can defend.
test('the same pair with no evidence declines', () => {
  expect(advancedBases(fnWith([storeTo(cell(0x04000048)), storeTo(cell(0x0400004a))]))).toBeNull();
});

test('a step that does not land on the next access declines', () => {
  expect(
    advancedBases(fnWith([storeTo(cell(0x04000048)), storeTo(cell(0x0400004a, 2, { baseAdvanced: 4 }))])),
  ).toBeNull();
});

test('a step off the element grid declines', () => {
  const odd = [storeTo(cell(0x04000048, 4)), storeTo(cell(0x0400004a, 4, { baseAdvanced: 2 }))];
  expect(advancedBases(fnWith(odd))).toBeNull();
});

test('members of different widths decline', () => {
  expect(
    advancedBases(fnWith([storeTo(cell(0x04000048, 2)), storeTo(cell(0x0400004a, 1, { baseAdvanced: 2 }))])),
  ).toBeNull();
});

// The three NARROWING rules (l3/advance.ts's second list), each pinned on the shape it excludes
// and each of which the pass would still be address-correct without.
test('an advanced access inside a loop declines', () => {
  const loop: Stmt = { k: 'while', cond: { k: 'var', name: 'a' }, body: [...PAIR] };
  expect(advancedBases(fnWith([loop]))).toBeNull();
});

test('an advanced access inside an arm declines', () => {
  const arm: Stmt = { k: 'if', cond: { k: 'var', name: 'a' }, then: [...PAIR], else: [] };
  expect(advancedBases(fnWith([arm]))).toBeNull();
});

// …and the pair that the strictly-increasing statement rule does NOT already refuse: one member
// per arm, at two different top-level statements. This is the case the nesting rule alone decides.
test('a chain split across two arms declines', () => {
  const armed = (s: Stmt): Stmt => ({ k: 'if', cond: { k: 'var', name: 'a' }, then: [s], else: [] });
  expect(advancedBases(fnWith(PAIR.map(armed)))).toBeNull();
});

test('a NEGATIVE step declines', () => {
  const down = [storeTo(cell(0x0400004a)), storeTo(cell(0x04000048, 2, { baseAdvanced: -2 }))];
  expect(advancedBases(fnWith(down))).toBeNull();
});

// Two spellings of one cell is not something the asm can settle, so the pass keeps the one it
// arrived with.
test('a chain address reached at a second site declines', () => {
  expect(advancedBases(fnWith([...PAIR, storeTo(cell(0x04000048))]))).toBeNull();
});

test('two accesses in ONE statement are not a chain', () => {
  const one: Stmt = { k: 'store', lval: cell(0x04000048), value: cell(0x0400004a, 2, { baseAdvanced: 2 }) };
  expect(advancedBases(fnWith([one]))).toBeNull();
});

// ── the row this exists for ──────────────────────────────────────────────────────────────────
// `kleod:StreamCmd_SetWindowRegs` — two `REG_WININ` halfwords through one advanced register.
// Enumerated map-less, which is the configuration `/raw-globals` re-structures under: with a
// symbol map the pool word promotes to `&REG_WININ` and `cellAddress` answers nothing.
const KLEOD_SWR = `	thumb_func_start StreamCmd_SetWindowRegs
StreamCmd_SetWindowRegs: @ 0804E708
	push {r4, lr}
	ldr r3, _0804E730 @ =0x04000048
	ldr r4, _0804E734 @ =0x03004D84
	ldr r2, [r4, #0x00]
	ldrb r1, [r2, #0x02]
	ldrb r0, [r2, #0x03]
	lsls r0, r0, #0x08
	orrs r1, r0
	strh r1, [r3, #0x00]
	adds r3, #0x02
	ldrb r1, [r2, #0x04]
	ldrb r0, [r2, #0x05]
	lsls r0, r0, #0x08
	orrs r1, r0
	strh r1, [r3, #0x00]
	adds r2, #0x06
	str r2, [r4, #0x00]
	pop {r4}
	pop {r0}
	bx r0
_0804E730: .4byte 0x04000048
_0804E734: .4byte 0x03004D84
`;

test('the row enumerates the advanced spelling, qualified and plain', () => {
  const cands = enumerateCandidates('StreamCmd_SetWindowRegs', KLEOD_SWR, ARMV4T_AGBCC, {
    prototypes: { StreamCmd_SetWindowRegs: { returnsVoid: true } },
  });
  const qualified = cands.find((c) => c.label.endsWith('/advance/volatile'));
  expect(qualified).toBeDefined();
  // The byte-exact spelling, compiled against the row's target object before this pass existed.
  expect(qualified!.source).toMatch(/volatile u16 \* p0;/);
  expect(qualified!.source).toMatch(/p0 = \(u16 \*\)67108936;/);
  expect(qualified!.source).toMatch(/p0 = p0 \+ 1;/);
  expect(cands.some((c) => c.label.endsWith('/advance'))).toBe(true);
  // …and the base init leads, because that is the order the target's own pool words record.
  const lines = qualified!.source.split('\n').filter((l) => l.includes(' = '));
  expect(lines[0]).toContain('p0 = (u16 *)67108936;');
});
