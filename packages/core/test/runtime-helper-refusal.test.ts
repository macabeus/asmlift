// Re-emitting a compiler's own runtime call as source is the one failure that MATCHES: hand
// `mwcceppc` the source `return __div2i(a, b);` and it emits the `bl __div2i` the row was lifted
// from, byte for byte. So a row scores asmlift's failure to model 64-bit division exactly as it
// would score modelling it, and nothing downstream can referee the difference.
//
// `raise/widehelpers.ts` `refuseUnmodelledHelpers` is the gap that stops it. These cases pin both
// sides of its licence: a name the target's runtime table carries declines, and a name it does not
// stays an ordinary call — because a project's own `__`-prefixed function is not the compiler's
// runtime and nothing in the spelling tells them apart.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { PPC_MWCC } from '../src/target';

const rel = (at: string, sym: string) => `\t\t\t${at}: R_PPC_REL24\t${sym}\n`;

// The prologue/epilogue mwcc writes around a helper call, from `synthetic:lldivs:mwcc_242_81`.
const PRO = '0:\tstwu    r1,-16(r1)\n4:\tmflr    r0\n8:\tstw     r0,20(r1)\n';
const EPI = '10:\tlwz     r0,20(r1)\n14:\tmtlr    r0\n18:\taddi    r1,r1,16\n1c:\tblr\n';

const callTo = (sym: string) => PRO + 'c:\tbl      c <f+0xc>\n' + rel('c', sym) + EPI;

const dis = (sym: string, lines: string) => decompile(sym, `0 <${sym}>:\n${lines}`, PPC_MWCC).source;

describe('a runtime helper nothing folded is a gap, not a call', () => {
  test("a helper the target's table names declines, and the reason names the helper", () => {
    // The whole shape of `lldivs` on CodeWarrior: four argument registers hold two pairs, and the
    // quotient comes back in r3:r4. Nothing on this target pairs registers yet, so the recognizer
    // declines on arity — and what it declines must not reach the backend as `__div2i()`.
    expect(() => dis('f', callTo('__div2i'))).toThrow(/no model for the runtime helper '__div2i'/);
  });

  test('every name in the table is refused, not just the divisions', () => {
    for (const helper of ['__div2u', '__mod2i', '__mod2u', '__shl2i', '__shr2i', '__shr2u']) {
      expect(() => dis('f', callTo(helper))).toThrow(new RegExp(`runtime helper '${helper}'`));
    }
  });

  test('a name the table does NOT carry is an ordinary callee, `__` prefix and all', () => {
    // The discriminator is the table, never the spelling: `__assert` is a project's own function on
    // any of these targets, and refusing it would decline every function that calls one.
    expect(dis('f', callTo('__assert'))).toContain('__assert(');
  });

  // A name on `Object.prototype` reached the table through a bare `in`, and the decline it produced
  // named a runtime helper this target does not have. The reason a refusal gives is a claim.
  test('a callee named after an Object.prototype member is not a runtime helper', () => {
    for (const sym of ['toString', 'valueOf', 'hasOwnProperty', 'constructor']) {
      expect(dis('f', callTo(sym))).toContain(`${sym}(`);
    }
  });
});
