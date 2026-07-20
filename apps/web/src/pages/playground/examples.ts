// One-click examples: real captured toolchain output from @asmlift/core's offline corpus
// (imported at build time via Vite ?raw — the same fixtures corpus-offline.test.ts pins).
import agbccClamp0 from '../../../../../packages/core/test/corpus/agbcc-clamp0.s?raw';
import agbccDeref from '../../../../../packages/core/test/corpus/agbcc-deref.s?raw';
import gccAget from '../../../../../packages/core/test/corpus/gcc-aget.asm?raw';
import gccClamp0 from '../../../../../packages/core/test/corpus/gcc-clamp0.asm?raw';
import idoClamp0 from '../../../../../packages/core/test/corpus/ido-clamp0.asm?raw';
import idoCountdown from '../../../../../packages/core/test/corpus/ido-countdown.asm?raw';
import idoMaxab from '../../../../../packages/core/test/corpus/ido-maxab.asm?raw';
import ppcDeref from '../../../../../packages/core/test/corpus/ppc-deref.asm?raw';
import ppcMaxab from '../../../../../packages/core/test/corpus/ppc-maxab.asm?raw';

export interface Example {
  label: string;
  target: string; // toolchain id (App's TARGETS key)
  backend?: string; // App BACKENDS key; default "c"
  spec?: string; // C++ signature JSON (backend "cpp")
  asm: string;
}

// Real committed mwcceppc disassembly of `int Vec::dot(Vec*)` — the same fixture
// packages/cli/test/matching/ppc-cpp.test.ts pins offline.
const VEC_DOT_ASM = `00000000 <dot__3VecFP3Vec>:
   0:\tlwz     r6,0(r3)
   4:\tlwz     r5,0(r4)
   8:\tlwz     r3,4(r3)
   c:\tlwz     r0,4(r4)
  10:\tmullw   r4,r6,r5
  14:\tmullw   r0,r3,r0
  18:\tadd     r3,r4,r0
  1c:\tblr
`;

const VEC_DOT_SPEC = JSON.stringify({
  method: 'dot',
  cls: 'Vec',
  retType: { base: 'int', ptr: 0 },
  params: [{ name: 'o', type: { base: 'Vec', ptr: 1 } }],
  classes: {
    Vec: {
      fields: [
        { name: 'x', type: { base: 'int', ptr: 0 } },
        { name: 'y', type: { base: 'int', ptr: 0 } },
      ],
    },
  },
});

// agbcc's canonical Thumb lowering of `x / 2` (sign-correct pow2 division) — the shape the
// SDIV_POW2_2 idiom pattern folds, so the lifted and folded IR dumps differ on it (the Pipeline tab shows the rewrite).
const AGBCC_HALF_ASM = `\t.code\t16
\t.globl\thalf
\t.thumb_func
half:
\tlsr\tr1, r0, #31
\tadd\tr0, r0, r1
\tasr\tr0, r0, #1
\tbx\tlr
`;

export const EXAMPLES: Example[] = [
  { label: 'GBA / agbcc — clamp to zero (if-assign)', target: 'agbcc-arm', asm: agbccClamp0 },
  { label: 'GBA / agbcc — pointer deref', target: 'agbcc-arm', asm: agbccDeref },
  { label: 'GBA / agbcc — x / 2 (idiom folding: watch the Pipeline tab)', target: 'agbcc-arm', asm: AGBCC_HALF_ASM },
  { label: 'N64 / IDO — countdown loop (while + coalesced induction var)', target: 'ido-mips', asm: idoCountdown },
  { label: 'N64 / IDO — clamp to zero (divergent if)', target: 'ido-mips', asm: idoClamp0 },
  { label: 'N64 / IDO — max(a, b)', target: 'ido-mips', asm: idoMaxab },
  { label: 'N64 / KMC GCC — branchless clamp (sign trick)', target: 'gcc-mips', asm: gccClamp0 },
  { label: 'N64 / KMC GCC — array indexing a[i]', target: 'gcc-mips', asm: gccAget },
  { label: 'GC / mwcc — max(a, b) (conditional return)', target: 'mwcc-ppc', asm: ppcMaxab },
  { label: 'GC / mwcc — pointer deref', target: 'mwcc-ppc', asm: ppcDeref },
  {
    label: 'GC / mwcc — Vec::dot (C++ member function, demangled)',
    target: 'mwcc-ppc',
    backend: 'cpp',
    spec: VEC_DOT_SPEC,
    asm: VEC_DOT_ASM,
  },
];
