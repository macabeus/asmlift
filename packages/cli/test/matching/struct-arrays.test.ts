// Array-of-struct recovery (raise/struct-arrays.ts, WIRED in PRE_RECOVERY_PASSES) — the
// scaledAddress extension for NON-scalar strides, exercised end-to-end through decompile() and
// validated against the REAL agbcc toolchain, byte-exact (objdiff 0). Strides/offsets here
// mirror real Klonoa: Empire of Dreams layouts (stride 108 = 0x6c; the DmaSprite {u32,u16,u16}=8).
//
// Toolchain-gated like the other agbcc tests (compileTargetAsm/scoreC use real agbcc).
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const CASES: { name: string; c: string; returnsVoid?: boolean; expect: string }[] = [
  // Non-power-of-2 stride 108 (agbcc emits `mov #0x6c; mul`), field at offset 0.
  {
    name: 'get_hp',
    c: `struct Ent { int hp; int x; char pad[100]; };
int get_hp(struct Ent *arr, int i){ return arr[i].hp; }`,
    expect:
      'struct Elem0 { s32 field_0; u8 _pad0[104]; };\ns32 get_hp(struct Elem0 * a0, s32 a1) {\n    return a0[a1].field_0;\n}\n',
  },
  // Field at NONZERO offset 4 → leading pad seats it exactly.
  {
    name: 'get_x',
    c: `struct Ent { int hp; int x; char pad[100]; };
int get_x(struct Ent *arr, int i){ return arr[i].x; }`,
    expect:
      'struct Elem0 { u8 _pad0[4]; s32 field_4; u8 _pad1[100]; };\ns32 get_x(struct Elem0 * a0, s32 a1) {\n    return a0[a1].field_4;\n}\n',
  },
  // Multiple fields, power-of-2 stride 8 (agbcc emits `lsl #3`) — DmaSprite's real {u32@0,u16@4,u16@6}.
  {
    name: 'gfx_sum',
    c: `struct Gfx { unsigned src; unsigned short f4; unsigned short tiles; };
int gfx_sum(struct Gfx *arr, int i){ return arr[i].f4 + arr[i].tiles; }`,
    expect:
      'struct Elem0 { u8 _pad0[4]; u16 field_4; u16 field_6; };\ns32 gfx_sum(struct Elem0 * a0, s32 a1) {\n    return a0[a1].field_4 + a0[a1].field_6;\n}\n',
  },
  // Store into an array-of-struct field, non-power-of-2 stride.
  {
    name: 'set_hp',
    c: `struct Ent { int hp; int x; char pad[100]; };
void set_hp(struct Ent *arr, int i, int v){ arr[i].hp = v; }`,
    returnsVoid: true,
    expect:
      'struct Elem0 { s32 field_0; u8 _pad0[104]; };\nvoid set_hp(struct Elem0 * a0, s32 a1, s32 a2) {\n    a0[a1].field_0 = a2;\n    return;\n}\n',
  },
];

describe('array-of-struct recovery — real agbcc, byte-exact, through decompile()', () => {
  for (const { name, c, returnsVoid, expect: golden } of CASES) {
    test(`${name}`, () => {
      const asm = compileTargetAsm(c);
      const res = decompile(
        name,
        asm,
        ARMV4T_AGBCC,
        returnsVoid ? { prototypes: { [name]: { returnsVoid: true } } } : {},
      );
      expect(res.source).toBe(golden); // the named-field array-of-struct access, recovered in production
      const s = scoreC(res.source, name, assembleTarget(asm));
      if (!s.match) {
        console.log(`emitted C for ${name}:\n${res.source}`, JSON.stringify(s));
      }
      expect(s.score).toBe(0); // recompiles byte-identical to the agbcc target
      expect(s.match).toBe(true);
    });
  }
});

// The adversarial round's F1a: `arr[i].self = (int)&arr[i]` was a byte-exact MATCH via the walk
// spelling until the pass's first wiring silently sizeof-scaled the surviving add (elem hid as
// the store VALUE of its own clean access). The clean gate now declines; the match must hold.
test('self-referential element store stays byte-exact (the pass declines, the walk spelling matches)', () => {
  const c = `struct E { int f; int self; };
void selfref(struct E *arr, int i){ arr[i].self = (int)&arr[i]; }`;
  const asm = compileTargetAsm(c);
  const res = decompile('selfref', asm, ARMV4T_AGBCC, { prototypes: { selfref: { returnsVoid: true } } });
  expect(res.source).not.toContain('Elem'); // the recovery declined this shape
  const s = scoreC(res.source, 'selfref', assembleTarget(asm));
  expect(s.match).toBe(true); // and the walk spelling still matches, as before the wiring
});
