// THE WHOLE FAN of a function whose frame bytes are a union of per-width views
// (frontend/frame-objects.ts `unionViews`): no candidate may reach those bytes through anything but
// a view. A cast on them (`((u16 *)&sp0)[0]`, or a local assigned `&sp0` and subscripted) and a
// dereference of a view's decay (`*sp0.half`) are the spellings agbcc at -O2 reads stale past a
// store of the other width — compiled, `*u.half = 1; *u.word = x; return *u.half;` returns
// `mov r0, #0x1` where `u.half[0]` reloads. The default tree is built without them; this pins that
// no respell variation brings one back (contracts.ts `assertFrameUnionsViewed` is the per-tree
// backstop, and this is the census over what is actually emitted).
//
// Each fixture is verbatim agbcc 2.9-arm-000512 at the corpus's flags.
import { describe, expect, test } from 'vitest';

import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

// `union U { s32 w; u16 h[2]; }; void k(void *); int rd(int x){ union U u; k(&u); u.h[0] = 1;
// u.w = x; return u.h[0]; }`
const RD =
  'rd:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr4, r0, #0\n\tmov\tr0, sp\n\tbl\tk\n\tmov\tr1, #0x1\n' +
  '\tmov\tr0, sp\n\tstrh\tr1, [r0]\n\tstr\tr4, [sp]\n\tldrh\tr0, [r0]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n' +
  '\tpop\t{r1}\n\tbx\tr1\n';
// `struct H { u16 a; u16 b; }; int fill(struct H *); extern u16 gA, gB; int z1(void){ struct H s =
// {0, 0}; if (fill(&s)) return 0; gA += s.a; gB += s.b; return 1; }` — one word store initializes
// both members, which are read back as halfwords
const Z1 =
  'z1:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr0, #0x0\n\tstr\tr0, [sp]\n\tmov\tr4, sp\n\tmov\tr0, sp\n' +
  '\tbl\tfill\n\tcmp\tr0, #0\n\tbne\t.L3\n\tldr\tr1, .L5\n\tmov\tr0, sp\n\tldrh\tr0, [r0]\n\tldrh\tr2, [r1]\n' +
  '\tadd\tr0, r0, r2\n\tstrh\tr0, [r1]\n\tldr\tr1, .L5+0x4\n\tldrh\tr0, [r4, #0x2]\n\tldrh\tr2, [r1]\n' +
  '\tadd\tr0, r0, r2\n\tstrh\tr0, [r1]\n\tmov\tr0, #0x1\n\tb\t.L4\n.L5:\n\t.word\tgA\n\t.word\tgB\n.L3:\n' +
  '\tmov\tr0, #0x0\n.L4:\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
// `struct P { u16 a, b, c, d; s8 e; }; int b2(struct P p){ return p.a + p.c - p.e; }`
const B2 =
  'b2:\n\tadd\tsp, sp, #-0xc\n\tstr\tr0, [sp]\n\tstr\tr1, [sp, #0x4]\n\tstr\tr2, [sp, #0x8]\n\tmov\tr0, sp\n' +
  '\tldrh\tr0, [r0]\n\tmov\tr1, sp\n\tldrh\tr1, [r1, #0x4]\n\tadd\tr0, r0, r1\n\tmov\tr1, sp\n' +
  '\tldrb\tr1, [r1, #0x8]\n\tlsl\tr1, r1, #24\n\tasr\tr1, r1, #24\n\tsub\tr0, r0, r1\n\tadd\tsp, sp, #0xc\n\tbx\tlr\n';

const PROTOTYPES = {
  k: { params: ['void *'], returnsVoid: true },
  fill: { params: ['void *'], returns: 's32' },
} as const;

/** The lines of a candidate that reach the frame union `name` other than through a view. */
function unviewed(source: string, name: string): string[] {
  const reaches = [
    new RegExp(`\\*\\s*\\(?${name}\\.`), // `*sp0.half` — the view's decay, dereferenced
    new RegExp(`\\)\\s*&${name}\\b`), // `(u16 *)&sp0` — a cast on its address
    new RegExp(`\\(\\s*&${name}\\s*\\)\\s*(\\[|->)`), // `(&sp0)[…]`
    new RegExp(`\\w+\\s*=\\s*(\\([^)]*\\)\\s*)?&${name}\\b`), // a local holding its address
  ];
  return source.split('\n').filter((l) => reaches.some((re) => re.test(l)));
}

describe('no candidate reaches a frame union except through a view', () => {
  test.each([
    { sym: 'rd', asm: RD },
    { sym: 'z1', asm: Z1 },
    { sym: 'b2', asm: B2 },
  ])('$sym', ({ sym, asm }) => {
    const cands = enumerateCandidates(sym, asm, ARMV4T_AGBCC, { prototypes: PROTOTYPES as never });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      const union = c.source.match(/union \{[^}]*\} (sp\d+);/);
      expect(union, c.source).not.toBeNull();
      expect(unviewed(c.source, union![1]), c.source).toEqual([]);
    }
  });

  test('the census sees the spellings it refuses', () => {
    expect(unviewed('    return *sp0.half + v;', 'sp0')).toHaveLength(1);
    expect(unviewed('    x = ((u16 *)&sp0)[1];', 'sp0')).toHaveLength(1);
    expect(unviewed('    p0 = (u16 *)&sp0;', 'sp0')).toHaveLength(1);
    expect(unviewed('    fill(&sp0);\n    return sp0.half[0];', 'sp0')).toHaveLength(0);
  });
});
