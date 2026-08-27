// Narrow-local recovery (raise/narrowlocal.ts, WIRED in PRE_RECOVERY_PASSES) — a loop carrier whose
// only read is its own extension is DECLARED at that width, end-to-end through decompile() and
// validated against the REAL agbcc toolchain, byte-exact (objdiff 0).
//
// The width is not cosmetic on agbcc: `gcc/thumb.h:344` PROMOTE_MODE unsigns every sub-word mode, so
// a narrow counter's write-back is an LSHIFTRT, and `gcc/loop.c` `basic_induction_var` follows only
// SIGN_EXTEND (`:5876`) and ASHIFTRT (`:5880`) — LSHIFTRT falls to `default: return 0` (`:5902`), the
// index survives, and the emitted loop is a different loop. `widecnt` is the CONTROL that pins that:
// same body, `s32 i`, and it must keep matching with no narrow local anywhere in its source.
//
// Toolchain-gated like the other agbcc tests (compileTargetAsm/scoreC use real agbcc).
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const CASES: { name: string; c: string; returnsVoid?: boolean; expect: string }[] = [
  // synthetic:narrowcnt — the capability in miniature: an `s16` counter, no memory traffic.
  {
    name: 'narrowcnt',
    c: 's32 narrowcnt(void){ short i; int s = 0; for (i = 0; i < 10; i++) s += i; return s; }',
    expect:
      's32 narrowcnt(void) {\n    s16 v0;\n    s32 v1;\n    v1 = 0;\n    v0 = 0;\n    do {\n' +
      '        v1 = v1 + v0;\n        v0 = (u16)(v0 + 1);\n    } while ((s16)v0 <= 9);\n    return v1;\n}\n',
  },
  // synthetic:basefold — the same counter feeding an ADDRESS: the extension the declaration removes
  // is the one agbcc fuses with the element scale (`asr #0xf` for `lsl #0x10 / asr #0x10 / lsl #0x1`).
  {
    name: 'basefold',
    c: 'void basefold(u8 *d, u8 *s){ short i; for (i = 0; i < 6; i++) *((u16 *)(d + 4) + i) = *((u16 *)(s + 4) + i); }',
    returnsVoid: true,
    expect:
      'void basefold(s32 a0, s32 a1) {\n    s16 v0;\n    v0 = 0;\n    do {\n' +
      '        ((u16 *)((v0 << 1) + a0))[2] = ((u16 *)((v0 << 1) + a1))[2];\n' +
      '        v0 = (u16)(v0 + 1);\n    } while ((s16)v0 <= 5);\n    return;\n}\n',
  },
  // synthetic:widecnt — the CONTROL. A wide counter's sole reader is the `add` that increments it,
  // so nothing here states a width and the pass must leave every local `s32`.
  {
    name: 'widecnt',
    c: 's32 widecnt(void){ int i; int s = 0; for (i = 0; i < 10; i++) s += i; return s; }',
    expect:
      's32 widecnt(void) {\n    s32 v0;\n    s32 v1;\n    v1 = 0;\n    v0 = 0;\n    do {\n' +
      '        v1 = v1 + v0;\n        v0 = v0 + 1;\n    } while (v0 <= 9);\n    return v1;\n}\n',
  },
];

describe('narrow-local recovery — real agbcc, byte-exact, through decompile()', () => {
  for (const { name, c, returnsVoid, expect: golden } of CASES) {
    test(`${name}`, () => {
      const asm = compileTargetAsm(c);
      const res = decompile(
        name,
        asm,
        ARMV4T_AGBCC,
        returnsVoid ? { prototypes: { [name]: { returnsVoid: true } } } : {},
      );
      expect(res.source).toBe(golden);
      const s = scoreC(res.source, name, assembleTarget(asm));
      if (!s.match) {
        throw new Error(`${name}: objdiff ${s.score}\n${res.source}`);
      }
      expect(s.match).toBe(true);
    });
  }
});
