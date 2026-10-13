// A GLOBAL THE SYMBOL MAP DOES NOT DESCRIBE, READ ONLY AT OFFSET 0, end to end through the real agbcc.
// A project whose linker script places a global (kleod's IWRAM block) gives it no DWARF, so the map
// has no shape for it, and an access at offset 0 alone reads as a scalar: `v = gInfo;`. Against the
// project's `extern struct Info gInfo;` that is "incompatible types in assignment", and against an
// `extern u16 gTab[];` it reads the array's address. The context declares the type, so the lift
// takes the aggregate spelling `*(T *)&g` from it (core proto-context.ts `aggregateObjectsFromContext`).
//
// THE ALIAS SET. A byte read spelled `*(u8 *)&g` is a `char` access, alias set 0, which conflicts with
// every other set (c-common.c `c_get_alias_set`), so agbcc can move it past no store.
import { decompile } from '@asmlift/core/pipeline';
import { aggregateObjectsFromContext } from '@asmlift/core/proto-context';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const FLAGS = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;
const H =
  'struct Info { u8 a:1; u8 b:3; u8 c:1; u8 d; u16 e; u8 f[4]; }; extern struct Info gInfo;\n' +
  'typedef struct Info Info; extern Info gAlias;\nextern u16 gTab[];\n';
const P = { wb: { params: ['s32'], returnsVoid: true } };

describe('a context-declared aggregate the map does not describe — real agbcc', () => {
  test.each([
    // the first member is a bit-field: no member spells the byte the asm reads
    { sym: 'rb', c: 'u8 rb(void){ return gInfo.b; }', spelled: '*(u8 *)&gInfo', match: true },
    // a read-modify-write of the same byte; it compiles, and the operand order is not the source's
    { sym: 'wb', c: 'void wb(int x){ gInfo.b = x; }', spelled: '*(u8 *)&gInfo = ', match: false },
    // the struct named through a typedef
    { sym: 'rt', c: 'u8 rt(void){ return gAlias.b; }', spelled: '*(u8 *)&gAlias', match: true },
    // an array's first element
    { sym: 'ra', c: 'u16 ra(void){ return gTab[0]; }', spelled: '*(u16 *)&gTab', match: true },
  ])('$sym spells $spelled and compiles against the header', ({ sym, c, spelled, match }) => {
    const asm = compileTargetAsm(H + c, FLAGS);
    const aggregateGlobals = aggregateObjectsFromContext(H, 'c');
    const r = decompile(sym, asm, ARMV4T_AGBCC, { prototypes: P, aggregateGlobals });
    expect(r.source).toContain(spelled);
    const score = scoreC(H + r.source, sym, assembleTarget(asm), FLAGS).score;
    expect(score === 0, r.source).toBe(match);
    // without the context the same read is spelled bare: the header refuses it for the struct, and
    // for the array it compiles to a read of the address
    const bare = decompile(sym, asm, ARMV4T_AGBCC, { prototypes: P }).source;
    expect(bare).not.toContain('*)&g');
    let bareScore: number | undefined;
    try {
      bareScore = scoreC(H + bare, sym, assembleTarget(asm), FLAGS).score;
    } catch {
      bareScore = undefined;
    }
    expect(bareScore, bare).not.toBe(0);
  });
});

// A VOLATILE AGGREGATE stays out of the set (proto-context.ts `hasVolatileStorage`). `*(u16 *)&gV`
// drops the qualifier: agbcc then loads `gV.a` once and spins on the register forever (score 8), and
// merges the two reads of `gV.a + gV.a`. Left out, the read keeps the bare spelling, which the header
// refuses: a lift that does not compile, never one that compiles to other code.
describe('a context-declared volatile aggregate keeps the bare spelling — real agbcc', () => {
  const V =
    'struct V { u16 a; u16 b; }; extern volatile struct V gV;\n' +
    'struct V2 { volatile u16 a; u16 b; }; extern struct V2 gV2;\n' +
    'typedef volatile struct V VV; extern VV gVV;\n';
  test.each([
    { sym: 'vloop', c: 'void vloop(void){ while (gV.a == 0) ; }', g: 'gV' },
    { sym: 'vmember', c: 'void vmember(void){ while (gV2.a == 0) ; }', g: 'gV2' },
    { sym: 'vtypedef', c: 'void vtypedef(void){ while (gVV.a == 0) ; }', g: 'gVV' },
    { sym: 'vtwice', c: 'int vtwice(void){ return gV.a + gV.a; }', g: 'gV' },
  ])('$sym does not cast $g and does not compile against the header', ({ sym, c, g }) => {
    const asm = compileTargetAsm(V + c, FLAGS);
    const aggregateGlobals = aggregateObjectsFromContext(V, 'c');
    expect(aggregateGlobals.has(g)).toBe(false);
    const r = decompile(sym, asm, ARMV4T_AGBCC, { aggregateGlobals });
    expect(r.source).not.toContain(`*)&${g}`);
    expect(() => scoreC(V + r.source, sym, assembleTarget(asm), FLAGS), r.source).toThrow();
  });
});
