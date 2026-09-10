// The structurer's `sideEffects` walk, on an op whose RESULT NOBODY READS — the memory-read half.
//
// A void function's `bx lr` leaves whatever in r0, and the structurer suppresses that phantom
// return value — `analysis.ts` drops the `ret` operand from the use registry, so the suppressed
// value reaches the walk as a result nobody reads. When it is a memory READ, dropping it deletes an
// instruction the machine executed: a compiler deletes every dead read it is allowed to delete, so
// one that survives says the source's access was `volatile`. Spelling it is what puts the access
// where l3/volatileptr.ts's `/volatile` can qualify it.
//
// THE REFUSALS ARE HALF THE RULE and each has its own test here:
//
//   • an arithmetic leftover in r0 really is phantom — nothing ran that a statement stands for;
//   • a read something else consumes is already spelled at that consumer;
//   • NO EVIDENCE THE ACCESS WAS `volatile`. That claim is about correctness, not spelling, so it
//     comes from DATA: the target's declared device-register window (`capabilities.deviceRegisters`)
//     or a symbol map that declares the named global `volatile`. Ordinary RAM, a ROM table and a
//     caller's pointer all refuse here;
//   • NO SPELLING FOR A QUALIFIER TO LAND ON, which is a SEPARATE question and not implied by the
//     one above — `/volatile` mints `volatile s32 *p0 = (s32 *)33554688;` for an EWRAM address
//     quite happily, so a reachability argument would admit ordinary RAM and only the evidence
//     question refuses it. Three populations refuse on THIS question and each has its own test: a
//     device read that is the base's ONLY access, so basecse mints no local for `/volatile` to
//     qualify; a map-declared register reached through a CAST, which has dropped the qualifier in
//     the spelling itself; and a RUNTIME-INDEXED read, whose address neither query can answer for.
//
// The rule's population is narrow: of the 22 kleod benchmark rows that declare `returnsVoid`,
// `DmaSpriteToObjVram` is the only one whose suppressed value is a memory read. The synthetic row
// `dmareadback` is the zero point that fails loudly if the rule stops firing.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import type { SymbolInfo, SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

/** `.word` pool holding one address, referenced as `_pool`. */
const pool = (hex: string) => `_pool: .4byte ${hex}\n`;

/** `X[0] = 1;` then a load of the same cell nobody consumes — the shape the whole file is about. */
const deadRead = (hex: string) =>
  'f:\n' +
  `\tldr\tr3, _pool\t@ =${hex}\n` +
  '\tmovs\tr0, #0x1\n' +
  '\tstr\tr0, [r3, #0x0]\n' +
  '\tldr\tr0, [r3, #0x0]\n' +
  '\tbx\tlr\n' +
  pool(hex);

/** 0x040000D4 = REG_DMA3SAD, inside ARMV4T_AGBCC's declared `deviceRegisters` window. */
const DEVICE = deadRead('0x040000D4');

const lift = (asm: string, returnsVoid: boolean, symbols?: SymbolMap) =>
  decompile('f', asm, ARMV4T_AGBCC, {
    prototypes: returnsVoid ? { f: { returnsVoid: true } } : {},
    ...(symbols ? { symbols } : {}),
  }).source;

/** the body of the emitted function, statements only — so a test can assert the WHOLE body and
 *  not merely the absence of one spelling it guessed the extra statement would take. */
const body = (src: string): string[] =>
  src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('void ') && l !== '}' && !l.startsWith('struct '));

test('a void function’s trailing read at a DEVICE register is spelled as a statement, not dropped', () => {
  expect(body(lift(DEVICE, true))).toEqual(['*(s32 *)67109076 = 1;', '*(s32 *)67109076;', 'return;']);
});

test('an ARITHMETIC leftover in r0 really is phantom, and stays dropped', () => {
  // Same shape with the trailing load replaced by an add: nothing observed it, nothing ran that a
  // statement would stand for, and spelling it would be noise in every void function that ends in
  // a computation. Asserted as the WHOLE body — matching on a `+` passes vacuously against an
  // ablation whose extra statement constant-folds to `3;`.
  const src = lift(
    'f:\n' +
      '\tldr\tr3, _pool\t@ =0x040000D4\n' +
      '\tmovs\tr0, #0x1\n' +
      '\tstr\tr0, [r3, #0x0]\n' +
      '\tadds\tr0, r0, #0x2\n' +
      '\tbx\tlr\n' +
      pool('0x040000D4'),
    true,
  );
  expect(body(src)).toEqual(['*(s32 *)67109076 = 1;', 'return;']);
});

test('a read something else consumes is spelled once, at its consumer', () => {
  const src = lift(
    'f:\n' +
      '\tldr\tr3, _pool\t@ =0x040000D4\n' +
      '\tldr\tr0, [r3, #0x0]\n' +
      '\tstr\tr0, [r3, #0x4]\n' +
      '\tbx\tlr\n' +
      pool('0x040000D4'),
    true,
  );
  expect(src).toMatch(/p0\[1\] = \*p0;/);
  expect(src).not.toMatch(/^\s*\*p0;$/m);
});

test('with a return VALUE to consume it, the read stays in the return', () => {
  const src = lift(DEVICE, false);
  expect(src).toMatch(/return \*\(s32 \*\)\d+;/);
  expect(src).not.toMatch(/^\s*\*\(s32 \*\)\d+;$/m);
});

test('ORDINARY RAM refuses on EVIDENCE — a lever CAN qualify it, which is why that is not the test', () => {
  // 0x02000100 is EWRAM — outside `capabilities.deviceRegisters` [0x04000000, 0x04000400).
  expect(body(lift(deadRead('0x02000100'), true))).toEqual(['*(s32 *)33554688 = 1;', 'return;']);
  // 0x08117BCC is ROM. This is the population the refusal actually protects: a WRONG `returnsVoid`
  // in a dataset turns a function's RETURN VALUE into a dead read, and without the gate the
  // truncated body is replaced by confident-looking C that computes a table index and discards it.
  expect(body(lift(deadRead('0x08117BCC'), true))).toEqual(['*(s32 *)135363532 = 1;', 'return;']);
  // …and the reason stated is the one that HOLDS. Widen the same EWRAM address to the three-store
  // shape and `/volatile` mints `volatile s32 * p0;` over it — at EWRAM, exactly as at a device
  // register. So a REACHABILITY argument would admit ordinary RAM; only the EVIDENCE question
  // refuses it.
  const wide =
    'f:\n\tldr\tr3, _pool\t@ =0x02000100\n\tmovs\tr0, #0x1\n\tstr\tr0, [r3, #0x0]\n' +
    '\tstr\tr0, [r3, #0x4]\n\tstr\tr0, [r3, #0x8]\n\tldr\tr0, [r3, #0x8]\n\tbx\tlr\n' +
    pool('0x02000100');
  const vol = enumerateCandidates('f', wide, ARMV4T_AGBCC, { prototypes: { f: { returnsVoid: true } } }).filter((c) =>
    /volatile s32 \* p0;/.test(c.source),
  );
  expect(vol.length).toBeGreaterThan(0);
  expect(body(lift(wide, true)).some((l) => /^p0\[2\];$/.test(l))).toBe(false);
});

test('a SINGLE-ACCESS device read refuses: no second use, so basecse mints no local to qualify', () => {
  // The `REG_IF`/`REG_VCOUNT` acknowledge idiom, and also what a WRONG `returnsVoid` on a register
  // accessor (`u16 GetKeys(void) { return REG_KEYINPUT; }`) produces. The address passes the
  // evidence question outright — 0x04000200 is REG_IE, inside the window — so this test pins the
  // SECOND question on its own. With one access there is no pointer local anywhere in the fan.
  const single = 'f:\n\tldr\tr3, _pool\t@ =0x04000200\n\tldr\tr0, [r3, #0x0]\n\tbx\tlr\n' + pool('0x04000200');
  expect(body(lift(single, true))).toEqual(['return;']);
  const cands = enumerateCandidates('f', single, ARMV4T_AGBCC, { prototypes: { f: { returnsVoid: true } } });
  expect(cands.every((c) => !/volatile/.test(c.source))).toBe(true);
});

test('a RUNTIME-INDEXED read refuses — neither address query can answer for the cell it touches', () => {
  // `aload` keeps its index in operands[1] and carries no `off`, so both queries see the bare base.
  // Admitting on that alone mints `volatile s32 *p0 = (s32 *)67108864; p0[a0];` — a qualified
  // access at an unbounded address, which is the hazard the window exists to prevent.
  const indexed =
    'f:\n\tldr\tr3, _pool\t@ =0x04000000\n\tmovs\tr2, #0x1\n\tstr\tr2, [r3, #0x0]\n' +
    '\tlsls\tr1, r0, #0x2\n\tldr\tr0, [r3, r1]\n\tbx\tlr\n' +
    pool('0x04000000');
  const src = decompile('f', indexed, ARMV4T_AGBCC, {
    prototypes: { f: { params: ['s32'], returnsVoid: true } },
  }).source;
  expect(body(src)).toEqual(['*(s32 *)67108864 = 1;', 'return;']);
});

test('a CALLER’S POINTER refuses — volatileptr admits a local, never a parameter', () => {
  const src = lift('g:\n\tmovs\tr2, #0x5\n\tstr\tr2, [r0, #0x4]\n\tldr\tr0, [r0, #0x0]\n\tbx\tlr\n', true).replace(
    /void g/,
    'void f',
  );
  expect(body(src)).toEqual(['a0[1] = 5;', 'return;']);
});

// ── the symbol-map admission ─────────────────────────────────────────────────────────────────
// The other half of "a qualifier can reach it", and the arm the MAP-FED default source takes:
// l3/volatileptr.ts vetoes a local fed `&gSym` because "the symbol map owns a declared global's
// volatility" — so where the map DOES declare it, the read is one a `vu32 *` source really wrote.
// 0x03000100 is IWRAM, outside the device window, so these two pin the map arm on its own.
const gInfo = (isVolatile: boolean): SymbolInfo => ({
  name: 'gStatus',
  kind: 'data',
  shape: 'scalar',
  signed: false,
  size: 4,
  declared: true,
  ...(isVolatile ? { volatile: true } : {}),
});
const NAMED = deadRead('0x03000100');

test('a map-declared VOLATILE global admits the read even outside the device window', () => {
  expect(lift(NAMED, true, new Map([[0x03000100, [gInfo(true)]]]))).toMatch(/^\s*gStatus;$/m);
});

test('the SAME global without the map’s `volatile` refuses — the map owns the qualifier', () => {
  expect(lift(NAMED, true, new Map([[0x03000100, [gInfo(false)]]]))).not.toMatch(/^\s*gStatus;$/m);
});

test('a map-declared VOLATILE register reached through a CAST refuses — the spelling dropped it', () => {
  // The target row's own map-fed default: REG_DMA3SAD declared `volatile`, three stores and the
  // wait read, but the access is spelled `((s32 *)&REG_DMA3SAD)[2]` — a cast to a PLAIN `s32 *`,
  // which is not a volatile lvalue whatever the declaration says. The declaration's qualifier only
  // reaches a NAME-spelled access, so this arm refuses and hands `BASECSE_GATES` back the base
  // local its `repeated-const-offset` rule demotes. The row matches through `/raw-globals`, where
  // the literal arm spells the read.
  const asm =
    'f:\n\tldr\tr3, _pool\t@ =0x040000D4\n\tmovs\tr0, #0x1\n\tstr\tr0, [r3, #0x0]\n' +
    '\tstr\tr0, [r3, #0x4]\n\tstr\tr0, [r3, #0x8]\n\tldr\tr0, [r3, #0x8]\n\tbx\tlr\n' +
    pool('0x040000D4');
  const reg: SymbolInfo = {
    name: 'REG_DMA3SAD',
    kind: 'data',
    shape: 'scalar',
    signed: false,
    size: 4,
    declared: true,
    volatile: true,
  };
  expect(body(lift(asm, true, new Map([[0x040000d4, [reg]]])))).toEqual([
    's32 * p0;',
    'p0 = (s32 *)&REG_DMA3SAD;',
    '*p0 = 1;',
    'p0[1] = 1;',
    'p0[2] = 1;',
    'return;',
  ]);
});

test('a volatile CONTAINER admits its named member; a `vu16` MEMBER refuses, because it is never named', () => {
  // Both halves are one rule. `memberQualsAllow` refuses to spell a volatile member by name at all
  // (the name would reintroduce a qualifier the cast form it replaces never carried), so a `vu16`
  // member is reached as `((s32 *)&gState)[2]` — no qualifier in the spelling, nothing to hold.
  // `volatile struct State gState;` qualifies every member, and `gState.ctl;` really is observable.
  const asm =
    'f:\n\tldr\tr3, _pool\t@ =0x03000100\n\tmovs\tr0, #0x1\n\tstr\tr0, [r3, #0x8]\n' +
    '\tldr\tr0, [r3, #0x8]\n\tbx\tlr\n' +
    pool('0x03000100');
  const st = (memberVol: boolean, declVol: boolean): SymbolMap =>
    new Map([
      [
        0x03000100,
        [
          {
            name: 'gState',
            kind: 'data',
            shape: 'struct',
            size: 12,
            declared: true,
            structName: 'State',
            ...(declVol ? { volatile: true } : {}),
            layout: [
              { name: 'a', offset: 0, size: 4, signed: false },
              { name: 'b', offset: 4, size: 4, signed: false },
              { name: 'ctl', offset: 8, size: 4, signed: false, ...(memberVol ? { volatile: true } : {}) },
            ],
          } as SymbolInfo,
        ],
      ],
    ]);
  expect(body(lift(asm, true, st(false, true)))).toEqual(['gState.ctl = 1;', 'gState.ctl;', 'return;']);
  expect(body(lift(asm, true, st(true, false)))).toEqual(['((s32 *)&gState)[2] = 1;', 'return;']);
  expect(body(lift(asm, true, st(false, false)))).toEqual(['gState.ctl = 1;', 'return;']);
});

// ── the payoff a stranger needs to see ───────────────────────────────────────────────────────
test('the `/volatile` candidate carries the read through a qualified pointer local', () => {
  // Three stores plus the wait read — enough uses that a base local survives basecse, which is
  // what `/volatile` qualifies. Without the statement there is nothing for the qualifier to make
  // observable, so this is the test that shows the rule reaching its stated purpose rather than
  // merely emitting a spelling.
  const asm =
    'f:\n' +
    '\tldr\tr3, _pool\t@ =0x040000D4\n' +
    '\tmovs\tr0, #0x1\n' +
    '\tstr\tr0, [r3, #0x0]\n' +
    '\tstr\tr0, [r3, #0x4]\n' +
    '\tstr\tr0, [r3, #0x8]\n' +
    '\tldr\tr0, [r3, #0x8]\n' +
    '\tbx\tlr\n' +
    pool('0x040000D4');
  const cands = enumerateCandidates('f', asm, ARMV4T_AGBCC, { prototypes: { f: { returnsVoid: true } } });
  const vol = cands.filter((c) => c.label.includes('volatile') && !c.label.includes('vol-store'));
  expect(vol.length).toBeGreaterThan(0);
  for (const c of vol) {
    expect(c.source).toMatch(/volatile s32 \* p0;/);
    expect(c.source).toMatch(/^\s*p0\[2\];$/m);
  }
});
