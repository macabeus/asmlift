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
// WHY THE SPELLING IS A CANDIDATE AND NOT A DEFAULT — THE FOUR CORNERS, each compiled through the
// benchmark's own agbcc command against `kleod:StreamCmd_SetWindowRegs`'s target object rather than
// reasoned about. The base local is `u16 *p = (u16 *)0x04000048`, qualified or not:
//   volatile  ×  `*p = a; p++; *p = b;`   → byte-exact with the target
//   volatile  ×  `*p = a; p[1] = b;`      → `strh [r3, #2]`, no add
//   plain     ×  `*p = a; p++; *p = b;`   → `strh [r3, #2]`, no add
//   plain     ×  `*p = a; p[1] = b;`      → `strh [r3, #2]`, no add
// So the advance is INERT wherever the pointee is not volatile — agbcc folds it straight back into
// the memory operand — and only the CONJUNCTION reproduces the target.
//
// READ AS A MAPPING FROM THE ASM these four corners say `adds` ⇒ volatile-and-advanced, which is a
// FUNCTION, and the level tower says a function is a default. The answer to that — why it is an
// axis anyway, and what would turn it into a `compilerBehaviors` default — is at the `/advance`
// roster entry in rank.ts. It is not "the subscript spelling is right for every access the compiler
// folded": those accesses carry no stamp, so the rule below never sees them.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { ADVANCE_HEAD_GATES, ADVANCE_MEMBER_GATES, advancedBases } from '../src/l3/advance';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { without } from '../src/l3/gates';
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

// The register was advanced ONCE and then a third cell was reached with `strh [r3, #2]` — a
// DISPLACEMENT, not a second `add`. The stamp is a fact about the base register, so copying it onto
// the displaced access manufactures a chain link the machine never performed: `/advance` then
// spells two `p = p + 1;` and the target's own spelling (one advance, then `p[1]`) is unreachable.
const DISPLACED_IR = `fn advance {
^bb0(%0: s32):
  %1: s32* = const {value=67108936}
  store %1, %0 {off=0, width=2}
  %2: s32 = const {value=2}
  %3: s32* = add %1, %2
  store %3, %0 {off=0, width=2}
  store %3, %0 {off=2, width=2}
  ret
}
`;

test('a displacement off an advanced register is not another link in the chain', () => {
  const nodes = indexNodes(structured(DISPLACED_IR));
  expect(nodes.map((n) => [n.baseAdvanced, n.operandOff])).toEqual([
    [undefined, undefined],
    [2, undefined],
    [undefined, 2],
  ]);
  const out = cBackend.emit(advancedBases(structured(DISPLACED_IR))!);
  expect(count(out, 'p0 = p0 + 1;')).toBe(1);
  expect(out).toContain('[1] = a0;');
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
const loopAt = (addr: number): Stmt => ({ k: 'while', cond: { k: 'var', name: 'a' }, body: [storeTo(cell(addr))] });

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

// The two NARROWING rules (`head-already-advanced`, `member-negative-step`), each pinned on the
// shape it excludes and each of which the pass would still be address-correct without.
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

test('a chain may not START at an advanced site', () => {
  const headStamped = [
    storeTo(cell(0x04000048, 2, { baseAdvanced: 2 })),
    storeTo(cell(0x0400004a, 2, { baseAdvanced: 2 })),
  ];
  expect(advancedBases(fnWith(headStamped))).toBeNull();
});

// ── the two SOUND address rules, on the shapes that make them sound ───────────────────────────
// `rewrite` matches by ADDRESS, so any other node naming a member's cell is re-spelled `*p` too —
// at a point where `p` holds something else. These two are not "two spellings of one cell, which
// nothing here can settle"; they are the difference between a correct address and a wrong one.
test('a chain address reached at a second site declines', () => {
  expect(advancedBases(fnWith([...PAIR, storeTo(cell(0x04000048))]))).toBeNull();
});

test('an access at a chain address inside a loop is not re-spelled', () => {
  expect(advancedBases(fnWith([loopAt(0x0400004a), ...PAIR]))).toBeNull(); // a MEMBER's address
  expect(advancedBases(fnWith([...PAIR, loopAt(0x04000048)]))).toBeNull(); // the HEAD's
});

// …and what those two rules are worth, as an address rather than as a decline: with
// `member-nested-site` ablated the loop's own store is re-spelled `*p0` at a point where `p0` still
// holds the head's address, so every iteration writes 2 bytes low. THIS is why they are `sound`.
test('ablating the nesting rule moves the loop store to the wrong cell', () => {
  const ablated = advancedBases(fnWith([loopAt(0x0400004a), ...PAIR]), {
    member: without(ADVANCE_MEMBER_GATES, 'member-nested-site'),
  });
  const out = cBackend.emit(ablated!);
  expect(out).toContain('while'); // the loop survived…
  expect(out).not.toContain('67108938'); // …and its cell is gone, folded into `*p0`
  expect(count(out, '*p0 = a;')).toBe(3);
});

test('members of different signedness decline', () => {
  const mixed: Stmt[] = [
    storeTo(cell(0x04000048)),
    storeTo({ ...(cell(0x0400004a, 2, { baseAdvanced: 2 }) as Extract<Expr, { k: 'index' }>), signed: true }),
  ];
  expect(advancedBases(fnWith(mixed))).toBeNull();
});

// A non-member access BETWEEN two members does NOT end the chain: `p` is freshly minted, so a
// store that does not touch it cannot move it, and one `REG_BLDCNT = y;` between two window writes
// is the ordinary MMIO shape. (Before the head rule was made address-based this declined, while
// the same store through a `var` base was admitted.)
test('an unrelated const-addressed access between two members keeps the chain', () => {
  const out = cBackend.emit(advancedBases(fnWith([PAIR[0], storeTo(cell(0x04000050)), PAIR[1]]))!);
  expect(count(out, '*p0 = a;')).toBe(2);
  expect(count(out, 'p0 = p0 + 1;')).toBe(1);
  expect(out).toContain('*(u16 *)67108944 = a;');
});

test('two accesses in ONE statement are not a chain', () => {
  const one: Stmt = { k: 'store', lval: cell(0x04000048), value: cell(0x0400004a, 2, { baseAdvanced: 2 }) };
  expect(advancedBases(fnWith([one]))).toBeNull();
});

// ── the battery: every gate in both tables, ABLATED ───────────────────────────────────────────
// The mutation battery as data rather than as a transcript: each gate names the shape it alone
// refuses, and the test drops that one entry from the REAL table and re-runs the REAL pass. A gate
// added without a fixture fails the coverage assertion, which is the hole `gate-contract.test.ts`
// cannot see (it checks that a named guard exists, not that the gate is load-bearing).
const FIXTURES: Record<string, Stmt[]> = {
  'head-second-site': [...PAIR, storeTo(cell(0x04000048))],
  'head-nested-site': [...PAIR, loopAt(0x04000048)],
  'head-already-advanced': [storeTo(cell(0x04000048, 2, { baseAdvanced: 2 })), ...PAIR.slice(1)],
  'member-no-evidence': [storeTo(cell(0x04000048)), storeTo(cell(0x0400004a))],
  'member-second-site': [storeTo(cell(0x0400004a)), ...PAIR],
  'member-nested-site': [loopAt(0x0400004a), ...PAIR],
  'member-statement-order': [{ k: 'store', lval: cell(0x04000048), value: cell(0x0400004a, 2, { baseAdvanced: 2 }) }],
  'member-width': [storeTo(cell(0x04000048, 2)), storeTo(cell(0x0400004a, 1, { baseAdvanced: 2 }))],
  'member-signedness': [
    storeTo(cell(0x04000048)),
    storeTo({ ...(cell(0x0400004a, 2, { baseAdvanced: 2 }) as Extract<Expr, { k: 'index' }>), signed: true }),
  ],
  'member-element-grid': [storeTo(cell(0x04000048, 4)), storeTo(cell(0x0400004a, 4, { baseAdvanced: 2 }))],
  'member-step-lands': [storeTo(cell(0x04000048)), storeTo(cell(0x0400004a, 2, { baseAdvanced: 4 }))],
  'member-negative-step': [storeTo(cell(0x0400004a)), storeTo(cell(0x04000048, 2, { baseAdvanced: -2 }))],
};

test('every gate in both tables has a fixture below', () => {
  const ids = [...ADVANCE_HEAD_GATES, ...ADVANCE_MEMBER_GATES].map((g) => g.id);
  expect(ids.filter((id) => !(id in FIXTURES))).toEqual([]);
  expect(Object.keys(FIXTURES).filter((id) => !ids.includes(id))).toEqual([]);
});

test.each([...ADVANCE_HEAD_GATES, ...ADVANCE_MEMBER_GATES].map((g) => g.id))(
  '%s is load-bearing: its shape declines, and admits with the gate dropped',
  (id) => {
    const body = FIXTURES[id];
    expect(advancedBases(fnWith(body))).toBeNull();
    const ablated = id.startsWith('head-')
      ? { head: without(ADVANCE_HEAD_GATES, id) }
      : { member: without(ADVANCE_MEMBER_GATES, id) };
    // `member-no-evidence` is the one gate no fixture can isolate: with no stamp there is no step,
    // and the two arithmetic gates reject the same shape on `undefined`. It is a precondition for
    // them rather than an independent rule, and dropping the three together is what shows it.
    const gates =
      id === 'member-no-evidence'
        ? {
            member: ['member-no-evidence', 'member-element-grid', 'member-step-lands'].reduce(
              without,
              ADVANCE_MEMBER_GATES,
            ),
          }
        : ablated;
    if (id === 'member-no-evidence') {
      expect(advancedBases(fnWith(body), ablated)).toBeNull();
    }
    expect(advancedBases(fnWith(body), gates)).not.toBeNull();
  },
);

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
