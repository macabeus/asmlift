// A label heading data, and everything the asm around it can do with that label. `decode()` records
// each one under `dataWords` (the `.word` values it read) or `nonWordData` (a directive it did
// not); what the latter's directives share is NOT a width — `.short` and `.byte` are narrower than
// a word, `.quad` and `.ascii` are wider or unsized, `.float` is exactly a word — but that the pass
// recorded no words for them, which blinds the four-bytes-per-entry index to their bytes AND to the
// offsets they shift everything behind them by.
//
//   (a) the table's ADDRESS, taken through a `.word` literal-pool entry and indexed at runtime —
//       the shape agbcc emits for `sTable[i]` and the only one it emits. Nothing here needs the
//       element width or the table's contents: the address is a `gaddr` and the indexed read is an
//       ordinary sized load, both already modelled.
//   (b) the label as a POOL WORD (`ldr rD, sTab`) — a whole-word read of a label whose words this
//       pass did not record, or recorded at offsets an unread directive shifted.
//   (c) the label as a REGISTER BASE (`ldrh rD, [sTab]`, `adds rD, sTab+0x4, #1`) — the same hole
//       at `readData` rather than at `poolRef`.
//   (d) the label under a JUMP TABLE's pool, or under the case table itself — the same index, in
//       the one reader whose wrong answer is a wrong BLOCK rather than a wrong value.
//   (e) the label as a POOL WORD IN ANOTHER FUNCTION'S SENSE: it is defined HERE, so it is not the
//       external symbol the numeric-pool naming veto is looking for.
//   (f) the label as a BRANCH TARGET (`bl sTab`) — data, not a callee.
//   (g) the label ALIASED, two names on one block, which is a question about decode's KEY rather
//       than about any reader.
//
// Everything but (a) refuses, and (e) is the one that must NOT. Their reach over the corpus is zero
// because every benchmark row is a COMPILED function: agbcc reaches a halfword table through (a),
// its pools are `.word`, and the synthetic tier builds each row by compiling authored C. That is a
// fact about the corpus, not about the shapes — hand-written asm emits (b), four times over two
// `.ascii` labels in `pokeemerald/src/libgcnmultiboot.s`. So the witnesses here are unit tests, and
// they are not pinning dead code.
//
// WHAT EACH WITNESS FAILS ON is stated beside it, because a refusal asserted only to throw is
// pinned on its message and not on its behaviour. Most spellings in (b) and (c) are reachable by
// BOTH guards, so ablating either one leaves them declining on the other's message; the ones that
// carry the load are called out. Everything in (d) through (g) is single-guarded and LIFTS under
// its ablation, so `toThrow` fails outright rather than reporting a different string.
//
// Hand-written fixtures, NOT copied from any game.
import { describe, expect, test } from 'vitest';

import { FrontendUnsupportedError } from '../src/frontend/errors';
import { decompile } from '../src/pipeline';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const d = (name: string, asm: string) => decompile(name, asm, ARMV4T_AGBCC);

describe('(a) the ADDRESS of a table, reached through a word pool, is ordinary whatever the table holds', () => {
  // agbcc's `sTable[i]`: the table's address arrives as a `.word` pool entry, the index is scaled
  // into a register, and the element is read with a load sized to the element. The table's own
  // bytes are never an input — which is the whole claim, and the reason the `.word` arm is here is
  // that it shows the SAME C coming out of both. It is not a discriminator: the two inputs differ
  // in the directive, the shift amount and the load mnemonic, and deleting the `.rodata` block
  // outright gives byte-identical output for either. What (a) pins is the over-refusal that used to
  // decline both — it fails at the commit before this file.
  const indexed = (directive: string, shift: string, load: string) => `	.section .rodata
sTable:
	.${directive} 0x0
	.${directive} 0x1189
	.${directive} 0x2312
	.${directive} 0x329b

	.text
	thumb_func_start get
get:
	ldr r1, _p
	lsls r0, r0, #0x0${shift}
	${load}
	bx lr
	.align 2, 0
_p: .4byte sTable
	thumb_func_end get
`;

  test('a `.short` table indexes exactly as the `.word` table beside it does', () => {
    const expected = 's32 get(s32 a0) {\n    return sTable[a0];\n}\n';
    expect(d('get', indexed('short', '1', 'ldrh r0, [r0, r1]')).source).toBe(expected);
    expect(d('get', indexed('word', '2', 'ldr r0, [r0, r1]')).source).toBe(expected);
  });
});

describe('(b) a non-word label used as a POOL WORD refuses, and names the directive that decided it', () => {
  const poolLoad = (data: string, operand: string) => `	.section .rodata
sTab:
${data}
	.text
	thumb_func_start f
f:
	ldr r0, ${operand}
	bx lr
	thumb_func_end f
`;

  test('`.short` refuses by name; the `.word` sibling one directive over loads its word', () => {
    expect(() => d('f', poolLoad('	.short 0x1234', 'sTab'))).toThrow(FrontendUnsupportedError);
    expect(() => d('f', poolLoad('	.short 0x1234', 'sTab'))).toThrow(
      /data label 'sTab', which carries a '\.short' directive this reader does not read as words/,
    );
    expect(d('f', poolLoad('	.word 0x1234', 'sTab')).source).toBe('s32 f(void) {\n    return 4660;\n}\n');
  });

  test('the message names the directive it saw, and claims no width for it', () => {
    // `.quad` is WIDER than a word and `.byte` narrower; the refusal is the same because the
    // reason is the same — this pass recorded no words for either. A message that called `.quad`
    // sub-word, or said the label "holds no whole word", would be false about its own input.
    expect(() => d('f', poolLoad('	.byte 0x12', 'sTab'))).toThrow(/carries a '\.byte' directive/);
    expect(() => d('f', poolLoad('	.quad 0x1', 'sTab'))).toThrow(/carries a '\.quad' directive/);
    expect(() => d('f', poolLoad('	.ascii "abcdefgh"', 'sTab'))).toThrow(/carries a '\.ascii' directive/);
  });

  test('an OFFSET spelling refuses too, whichever guard gets there first', () => {
    // A coverage pin, not a behaviour one, and the difference is measured: `poolRef`'s arm ablated,
    // this input still declines — at `readData`, one guard over, on the other message. Both guards
    // read the operand's leading NAME, which is the property being pinned; an exact-key reader on
    // either side answers "not a label" here and hands the label to the load path.
    expect(() => d('f', poolLoad('	.short 0x1234\n	.short 0x5678', 'sTab+0x4'))).toThrow(FrontendUnsupportedError);
  });

  test('a label that DOES hold a recorded word still refuses, because the offsets are not its own', () => {
    // FAILS ON: letting the `dataWords` lookup have this operand — by ablating the arm, or by
    // guarding it on `!dataWords.has(…)`. Both LIFT to `return 4660;`, measured. That is a wrong
    // VALUE, which compiles and scores: `dataWords` records `0x1234`, but `.word` does not
    // self-align, so the `.short` in front shifts it. Assembled with this project's `as` the
    // label's bytes are `05 00 34 12 00 00`, and the word at `sTab+0` is `0x12340005`.
    // This is the ONE shape `poolRef`'s arm alone decides.
    expect(() => d('f', poolLoad('	.short 0x5\n	.word 0x1234', 'sTab'))).toThrow(
      /data label 'sTab', which carries a '\.short' directive this reader does not read as words/,
    );
  });
});

describe('(c) a non-word label used as a REGISTER BASE refuses separately from a word label', () => {
  const asBase = (directive: string, body: string) => `	.section .rodata
sTab:
	.${directive} 0x1234
	.${directive} 0x5678

	.text
	thumb_func_start f
f:
${body}
	bx lr
	thumb_func_end f
`;

  test('`.short` refuses as a data label, naming its directive', () => {
    expect(() => d('f', asBase('short', '	ldrh r0, [sTab]'))).toThrow(FrontendUnsupportedError);
    expect(() => d('f', asBase('short', '	ldrh r0, [sTab]'))).toThrow(
      /data label 'sTab', which carries a '\.short' directive this reader does not read as words, is used as a register/,
    );
  });

  test('the OFFSET spellings refuse, bracketed and bare', () => {
    // FAILS ON: `readData` keyed by an exact `Map.has(operand)` rather than by the operand's
    // leading NAME. Measured with that keying, all FOUR of these lift: `[sTab+0x4]` to
    // `s32 f(u16 *a0) { return *a0; }` and `sTab+0x4` in arithmetic to
    // `s32 f(s32 a0) { return a0 + 1; }`, under both directives — a parameter fabricated out of a
    // label, silently. The `.word` pair is here because the exact keying is wrong for the
    // pre-existing word-label guard too, not only for the one beside it: `poolRef` has always read
    // the lead, and one question answered by two readers is what this file exists to prevent.
    expect(() => d('f', asBase('short', '	ldrh r0, [sTab+0x4]'))).toThrow(FrontendUnsupportedError);
    expect(() => d('f', asBase('short', '	adds r0, sTab+0x4, #1'))).toThrow(FrontendUnsupportedError);
    expect(() => d('f', asBase('word', '	ldrh r0, [sTab+0x4]'))).toThrow(FrontendUnsupportedError);
    expect(() => d('f', asBase('word', '	adds r0, sTab+0x4, #1'))).toThrow(FrontendUnsupportedError);
  });

  test('the `.word` sibling refuses under the OLD message — two gaps, two answers', () => {
    // Widening `readData`'s existing data-label guard would have swallowed the non-word case into
    // this one message. They stay apart because answering either means changing a different line:
    // this one wants a word label read as dataflow, the one above wants a directive read as bytes.
    expect(() => d('f', asBase('word', '	ldrh r0, [sTab]'))).toThrow(/data label 'sTab' used as a register/);
  });
});

describe('(d) a JUMP TABLE reached through such a label declines instead of dispatching', () => {
  // The dispatch reader indexes the same four-byte `dataWords` index `poolRef` does, over two
  // hops: the literal pool holding the table's address, and the table of case labels itself. An
  // unread directive under either shifts what those indices select.
  //
  // FAILS ON: the reader taking `dataWords` without going through `recordedWords`. Measured with
  // that lookup, every input here LIFTS — to output byte-identical to the control below. That is
  // the worst answer this file can produce: not a wrong expression but a wrong BLOCK, a `switch`
  // that looks entirely ordinary and runs code nothing dispatches to (thumb-switch.test.ts).
  //
  // The `as` layout, for the `.short`-before-the-pointer case: assembling
  // `.Lp: .short 0x5 / .word .Ltab / .Ltab: .word … / .word …` gives `.rodata` bytes
  // `05 00 06 00 00 00 …`, so the word at `.Lp+0` is `0x00060005` — not the table's address — and
  // `.Ltab` lands at offset 6, which a hardware `ldr` cannot even address.
  const table = (poolData: string, tableData: string) => `	.section .rodata
.Lp:
${poolData}	.word .Ltab
.Ltab:
${tableData}	.word .Lc0
	.word .Lc1

	.text
	thumb_func_start f
f:
	cmp r1, #0x1
	bhi .Ldef
	lsl r0, r1, #0x2
	ldr r1, .Lp
	add r0, r0, r1
	ldr r0, [r0]
	mov pc, r0
.Lc0:
	mov r0, #0xa
	bx lr
.Lc1:
	mov r0, #0xb
	bx lr
.Ldef:
	mov r0, #0x63
	bx lr
	thumb_func_end f
`;

  const dispatches =
    's32 f(s32 a0, s32 a1) {\n    switch (a1) {\n        case 0:\n            return 10;\n' +
    '        case 1:\n            return 11;\n        default:\n            return 99;\n    }\n}\n';

  test('the control — no unread directive anywhere — recovers the table', () => {
    expect(d('f', table('', '')).source).toBe(dispatches);
  });

  test('an unread directive in the POOL declines, reaching the existing loud refusal', () => {
    for (const dir of ['	.short 0x5\n', '	.byte 0x5\n', '	.ascii "ab"\n']) {
      expect(() => d('f', table(dir, ''))).toThrow(
        /indirect\/computed jump 'mov pc, r0' — jump tables \/ computed gotos \/ register tail calls not supported/,
      );
    }
  });

  test('an unread directive in the CASE TABLE declines on the second hop', () => {
    // The pool is clean here, so the first lookup succeeds and the table's own label is what
    // `recordedWords` refuses — the hop a guard placed only at the pool would miss.
    expect(() => d('f', table('', '	.short 0x5\n'))).toThrow(/indirect\/computed jump 'mov pc, r0'/);
  });
});

describe('(e) such a label is DEFINED HERE, so it is not the external symbol a naming veto looks for', () => {
  // `poolNamesASymbol` asks whether this asm's pools name anything EXTERNAL, and a yes vetoes
  // spelling a numeric pool word with the symbol map's name for that address. The three label sets
  // `decode` builds are all "defined here"; leaving one out makes a purely local label answer yes.
  //
  // FAILS ON: dropping `nonWordData` from that predicate. Measured, the `.short` row then lifts to
  // `return *(u16 *)67109168;` while the `.word` row keeps `REG_KEYINPUT` — the same function, the
  // same map, a different directive on a table whose CONTENTS nothing here reads.
  const symbols: SymbolMap = new Map([[0x4000130, [{ name: 'REG_KEYINPUT', kind: 'data', size: 2 }]]]);

  const addressTaken = (directive: string) => `	.section .rodata
sTab:
	.${directive} 0x1234

	.text
	thumb_func_start f
f:
	ldr r0, _q
	ldr r1, _p
	ldrh r0, [r1]
	bx lr
	.align 2, 0
_p: .4byte 0x4000130
_q: .4byte sTab
	thumb_func_end f
`;

  test('a directive on an unrelated local table does not cost the row its map name', () => {
    const named = 's32 f(void) {\n    return REG_KEYINPUT;\n}\n';
    expect(decompile('f', addressTaken('short'), ARMV4T_AGBCC, { symbols }).source).toBe(named);
    expect(decompile('f', addressTaken('word'), ARMV4T_AGBCC, { symbols }).source).toBe(named);
  });
});

describe('(f) a BRANCH to a label this asm defines as data is not a call, under either directive', () => {
  // FAILS ON: removing the guard. The input then lifts to `return sTab();` — a call to a `.rodata`
  // object, which compiles wherever the name is declared as anything callable and is wrong in a
  // way that reads as right. The `.word` row is not a sibling here but half the finding: it lifted
  // that way before this file existed, and the blanket the rest of the file replaced was what kept
  // the `.short` half quiet.
  const call = (directive: string) => `	.section .rodata
sTab:
	.${directive} 0x1234
	.${directive} 0x5678

	.text
	thumb_func_start f
f:
	push {lr}
	bl sTab
	pop {r1}
	bx r1
	thumb_func_end f
`;

  test('both directives refuse, naming the label and what the asm defines it as', () => {
    for (const directive of ['short', 'word']) {
      expect(() => d('f', call(directive))).toThrow(FrontendUnsupportedError);
      expect(() => d('f', call(directive))).toThrow(
        /'bl sTab' branches to 'sTab', which this asm defines as a data label/,
      );
    }
  });
});

describe('(g) two labels on one data block are two names for the same bytes', () => {
  // `decode` keys both label maps by the labels naming the CURRENT run's base, so an aliased block
  // is recorded under every one of its names.
  //
  // FAILS ON: keying by the most recent label alone. The earlier name is then a label this pass
  // recorded nothing under, no guard recognises it, and the load path materialises it as a
  // parameter — `s32 f(u16 *a0) { return *a0; }` under BOTH directives, measured. A fabricated
  // pointer parameter is the exact miscompile the rest of this file exists to prevent, reached
  // through the KEY rather than through a reader.
  const aliased = (directive: string) => `	.section .rodata
sAlias:
sTab:
	.${directive} 0x1234
	.${directive} 0x5678

	.text
	thumb_func_start f
f:
	ldrh r0, [sAlias]
	bx lr
	thumb_func_end f
`;

  test('a load through the FIRST name refuses exactly as one through the second does', () => {
    expect(() => d('f', aliased('short'))).toThrow(
      /data label 'sAlias', which carries a '\.short' directive this reader does not read as words, is used as a register/,
    );
    expect(() => d('f', aliased('word'))).toThrow(/data label 'sAlias' used as a register/);
  });

  test('a label after DATA opens a new run, so a per-word pool keeps one word each', () => {
    // The other side of the same rule, and the reason it is "since the last data item" rather than
    // "since the last instruction": pret-style pools label every word. If `_p0` collected `_p1`'s
    // word too, `_p0` would resolve as a two-word pool and `_p0+0x4` would read an address the
    // pool does not hold there.
    const perWord = `	.text
	thumb_func_start f
f:
	ldr r0, _p0
	ldr r1, _p1
	add r0, r0, r1
	bx lr
	.align 2, 0
_p0: .4byte 0x1
_p1: .4byte 0x2
	thumb_func_end f
`;
    expect(d('f', perWord).source).toBe('s32 f(void) {\n    return 3;\n}\n');
    expect(() => d('f', perWord.replace('ldr r0, _p0', 'ldr r0, _p0+0x4'))).toThrow(
      /offset 0x4 is not a whole word in pool '_p0'/,
    );
  });
});
