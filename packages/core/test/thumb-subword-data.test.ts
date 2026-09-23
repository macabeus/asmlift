// A `.short`/`.byte`/`.2byte` data table, and the three things asm can do with the label that
// heads it. The distinction this file pins is between the table's ADDRESS and the table's BYTES:
//
//   (a) the address, taken through a `.word` literal-pool entry, then indexed at runtime — the
//       shape agbcc emits for `sTable[i]` and the only one it emits. Nothing here needs the
//       element width or the table's contents: the address is a `gaddr` and the indexed read is
//       an ordinary sized load, both already modelled.
//   (b) the label as a POOL WORD (`ldr rD, sHw`) — a whole-word read of a table that holds no
//       whole word. `dataWords` never holds a sub-word label, so `poolRef` would answer "not a
//       pool" and the load path would materialise the label as a phantom pointer parameter.
//   (c) the label as a REGISTER BASE (`ldrh rD, [sHw]`) — the same hole one directive over, at
//       `readData` rather than at `poolRef`.
//
// (b) and (c) refuse. Their reach over the corpus is zero BY CONSTRUCTION, not by measurement:
// agbcc reaches a halfword table through (a), pools are `.word`, and the synthetic benchmark tier
// builds every row by compiling authored C, so no row can carry an instruction no compiler emits.
// That is why the witnesses here are unit tests — and why each one is written against the `.word`
// sibling of its own input, which LIFTS. The directive under the label is the only difference
// between the two, so a guard that stopped looking at it would have to fail one of the pairs.
//
// Hand-written fixtures, NOT copied from any game.
import { describe, expect, test } from 'vitest';

import { FrontendUnsupportedError } from '../src/frontend/errors';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const d = (name: string, asm: string) => decompile(name, asm, ARMV4T_AGBCC);

describe('(a) the ADDRESS of a sub-word table, reached through a word pool, is ordinary', () => {
  // agbcc's `sTable[i]`: the table's address arrives as a `.word` pool entry, the index is scaled
  // into a register, and the element is read with a load sized to the element. The table's own
  // bytes are never an input.
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

describe('(b) a sub-word label used as a POOL WORD refuses, and says which directive decided it', () => {
  const wholeWordLoad = (directive: string) => `	.section .rodata
sTab:
	.${directive} 0x1234

	.text
	thumb_func_start f
f:
	ldr r0, sTab
	bx lr
	thumb_func_end f
`;

  // The wrong answer, measured by deleting the refusal: `s32 f(s32 *a0) { return *a0; }` — a
  // pointer PARAMETER on a function that takes none, reading memory that does not exist. Both
  // halves are asserted, because a guard that threw the right message while still having fabricated
  // the parameter upstream would pass on the message alone.
  test('`.short` refuses by name and fabricates no parameter', () => {
    expect(() => d('f', wholeWordLoad('short'))).toThrow(FrontendUnsupportedError);
    expect(() => d('f', wholeWordLoad('short'))).toThrow(
      /the sub-word data table 'sTab' \(\.short\), which holds no whole word to load/,
    );
    expect(() => d('f', wholeWordLoad('short'))).not.toThrow(/a0/);
  });

  test('`.byte` refuses the same way, naming ITS directive', () => {
    expect(() => d('f', wholeWordLoad('byte'))).toThrow(
      /the sub-word data table 'sTab' \(\.byte\), which holds no whole word to load/,
    );
  });

  test('the `.word` sibling — the same instruction, one directive over — lifts to the word it reads', () => {
    expect(d('f', wholeWordLoad('word')).source).toBe('s32 f(void) {\n    return 4660;\n}\n');
  });
});

describe('(c) a sub-word label used as a REGISTER BASE refuses separately from a word label', () => {
  const asBase = (directive: string) => `	.section .rodata
sTab:
	.${directive} 0x1234

	.text
	thumb_func_start f
f:
	ldrh r0, [sTab]
	bx lr
	thumb_func_end f
`;

  // Wrong answer here: `s32 f(u16 *a0) { return *a0; }` — again a parameter the function does not
  // have.
  test('`.short` refuses as a sub-word data table, fabricating no parameter', () => {
    expect(() => d('f', asBase('short'))).toThrow(FrontendUnsupportedError);
    expect(() => d('f', asBase('short'))).toThrow(/the sub-word data table 'sTab' \(\.short\) is used as a register/);
    expect(() => d('f', asBase('short'))).not.toThrow(/a0/);
  });

  test('the `.word` sibling still refuses under the OLD message — two gaps, two answers', () => {
    // Widening `readData`'s existing data-label guard would have swallowed the sub-word case into
    // this one message. They stay apart because answering either means changing a different line:
    // this one wants a word label read as dataflow, the one above wants sub-word table data.
    expect(() => d('f', asBase('word'))).toThrow(/data label 'sTab' used as a register/);
  });
});
