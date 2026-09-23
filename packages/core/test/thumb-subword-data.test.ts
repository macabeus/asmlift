// A label heading data this reader does not parse into `.word` values, and the three things asm
// can do with that label. `decode()` records one such label in `nonWordData`; what the directives
// share is NOT a width — `.short` and `.byte` are narrower than a word, `.quad` and `.ascii` are
// wider or unsized, `.float` is exactly a word — but that the pass recorded no words for them.
//
//   (a) the table's ADDRESS, taken through a `.word` literal-pool entry and indexed at runtime —
//       the shape agbcc emits for `sTable[i]` and the only one it emits. Nothing here needs the
//       element width or the table's contents: the address is a `gaddr` and the indexed read is an
//       ordinary sized load, both already modelled.
//   (b) the label as a POOL WORD (`ldr rD, sTab`) — a whole-word read of a label whose words this
//       pass did not record, or recorded at offsets an unread directive shifted.
//   (c) the label as a REGISTER BASE (`ldrh rD, [sTab]`, `adds rD, sTab+0x4, #1`) — the same hole
//       at `readData` rather than at `poolRef`.
//
// (b) and (c) refuse. Their reach over the corpus is zero BY CONSTRUCTION, not by measurement:
// agbcc reaches a halfword table through (a), its pools are `.word`, and the synthetic benchmark
// tier builds every row by compiling authored C, so no row can carry an instruction no compiler
// emits. That is why the witnesses here are unit tests.
//
// WHAT EACH WITNESS FAILS ON is stated beside it, because a refusal asserted only to throw is
// pinned on its message and not on its behaviour. Two of these tests carry that load, and they are
// not the obvious ones: most spellings here are reachable by BOTH guards, so ablating either one
// leaves them declining on the other's message. The two that are single-guarded — a label whose
// recorded words the unread directive shifted, and the offset spellings at `readData` — LIFT under
// their ablation, so `toThrow` fails outright rather than reporting a different string.
//
// Hand-written fixtures, NOT copied from any game.
import { describe, expect, test } from 'vitest';

import { FrontendUnsupportedError } from '../src/frontend/errors';
import { decompile } from '../src/pipeline';
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
