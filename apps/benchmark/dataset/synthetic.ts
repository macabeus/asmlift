// Tier A — synthetic dataset. Functions I author to exercise COMMON decompilation features with
// known ground truth, spread across the toolchains asmlift supports. Deliberately breadth-first over
// the idioms that dominate real game code (arithmetic, bitwise, compare/logic, width casts, memory,
// structs, arrays, loops, calls) rather than exotic constructs — the anti-overfitting goal.
//
// `toolchains` lists which toolchains to run each function on. `CALL` leaves IDO out for history
// only: ido7.1's canonical flags build `-non_shared`, whose `jal` carries an R_MIPS_26 record the
// MIPS frontend lowers (`out9` matches there), so a call row may name ido7.1 explicitly.
// C++ runs on mwcc_242_81 only (the `.cp` frontend). `ctx` is the m2c --context and `proto` feeds
// asmlift the same info. For almost every row that is prototypes only — no struct layouts, so both
// decompilers must RECOVER structure. THE EXCEPTION IS A ROW THAT CARRIES `symbols` (see below):
// there the map's declarations are rendered into `ctx` too, by `src/cases/synthetic.ts`, so the
// two channels still carry the same facts. What a row measures is its SOURCE SPELLING, which is in
// neither channel.
//
// A NAMED EXTERN DATA GLOBAL IS DECLARED IN NEITHER CHANNEL EITHER. 29 rows spell one in `src`
// (`extern u8 gGrid[5][7];`); the 9 carrying a `symbols` map hand it to both, and on the other 20 —
// all agbcc — `ctx` and `proto` carry neither the name nor the type. For the array and struct rows
// among those 20 the global's SHAPE is the thing being recovered, so a channel that spelled it
// would be spelling the answer. The two tools then differ in how they say "I do not know this
// type": asmlift emits `(u8 *)&gGrid` and the scoring layer supplies the declaration from the
// target's relocations, m2c emits `extern ? gGrid;`, which `eval/outcome.ts` reads as a decline.
// 12 of the 20 are an asmlift MATCH against 20 m2c declines, and that gap is NOT an artifact of a
// fact withheld from one side: adding the declaration to `ctx` ALONE does not dissolve it.
// Measured on `calad` — m2c then recovers `gGrid[0][6]`, the row's own spelling, and the candidate
// fails to compile with ``gGrid' undeclared`, because declarations reach the m2c compile only
// through `symbols` (`m2cDeclarationsFor`, src/eval/evaluate.ts). The map is the symmetric way to
// hand a row that fact, and it is what the other 9 do.
import type { Prototypes } from '@asmlift/core/proto';
import type { SymbolMap } from '@asmlift/core/symbols';

import type { ToolchainId } from '../src/toolchains';

export interface SynthSpec {
  sym: string;
  lang?: 'c' | 'c++';
  src: string;
  features: string[];
  toolchains: ToolchainId[];
  ctx?: string; // m2c --context (C declarations)
  proto?: Prototypes; // asmlift prototypes (void-ness / callee params)
  note?: string;
  /** THE FLAGS THIS ROW COMPILES AND DECOMPILES AT, when its own toolchain's canonical set is not
   *  the thing being measured. Absent — which is all but four rows — means the canonical set, so
   *  the tier is unchanged by this field existing. What it buys is an OPTIMISATION LEVEL of the
   *  row's own: a spelling the compiler erases at -O2 is invisible at the canonical flags, and a
   *  row that cannot fix its level cannot pin one. Both sides get the same flags (`codegenFor`
   *  resolves the target from them, exactly as the real tier does off its unit), so it is not a
   *  channel one decompiler is told about and the other is not.
   *
   *  D9: a LEVEL TWIN TAKES ITS OWN `sym`. Two rows differing only in flags would collide on the
   *  row id, and a reader comparing them wants to see two functions, not one name twice. */
  cflags?: readonly string[];
  /** A SYMBOL MAP for this row, the same value the real tier feeds asmlift off a project
   *  manifest (`src/cases/real.ts`). Synthetic rows carry none by default and that is not a
   *  neutral default: `/no-bitfield`, `/no-ptr-elem` and `/raw-globals` are enumerated only when
   *  the map answers, so a map-less tier is structurally incapable of exercising them and their
   *  zero winners carrying a variation measure the CORPUS rather than the capability. A row that sets this
   *  hand-writes the same `SymbolInfo` shape the ELF provider emits.
   *
   *  SETTING THIS ALSO FEEDS m2c. The map reaches asmlift alone, so a row that set it and stopped
   *  would be an information asymmetry — and a measured one, not a theoretical: told only its
   *  prototype, m2c emits `extern ? gBgTilemapBufs;` on `sbscope` and the row publishes a DECLINE
   *  that the declaration alone dissolves. `src/cases/synthetic.ts` therefore RENDERS this map
   *  into the row's `ctx` through core's own declaration renderer, and `authored-facts.test.ts`
   *  holds the two equal FACT BY FACT — every symbol, every declared member, every inner array
   *  extent. BY FACT AND NOT BY SYMBOL NAME: a name-level check passes with every gate green on a
   *  ctx the shape fields were stripped out of. Add a fact here and m2c is told it. The single
   *  exception is an array's OUTERMOST extent, left unsized by `declare.ts`'s own rule and measured
   *  on `sbscope` to change m2c's output not at all. */
  symbols?: SymbolMap;
}

const ALL: ToolchainId[] = ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'];
// The CodeWarrior -O0,p set `framelist`, `deadloc` and `homecall` build at, and the dead-read rows
// on all three CodeWarrior builds.
const MWCC_O0P = [
  '-proc',
  'gekko',
  '-O0,p',
  '-enum',
  'int',
  '-inline',
  'auto',
  '-fp',
  'hard',
  '-Cpp_exceptions',
  'off',
];
// The same set at -O4,p, which the update-form rows (`upd_*`) build at.
const MWCC_O4P = MWCC_O0P.map((f) => (f === '-O0,p' ? '-O4,p' : f));
// The float compare rows that branch rather than return the relation, and those of them the source
// declares void (each a float block below).
const FCMP_BRANCH_ROWS: ReadonlySet<string> = new Set([
  'fcmpbrn',
  'fcmpeqbr',
  'fcmpnebr',
  'fcmpeqlp',
  'fcmpnelp',
  'fcmphome',
  'fcmpvoid',
  'fcmpkeep',
]);
const FCMP_VOID_ROWS: ReadonlySet<string> = new Set([
  'fcmpbrn',
  'fcmpeqbr',
  'fcmpnebr',
  'fcmpeqlp',
  'fcmpnelp',
  'fcmpvoid',
]);
/** The body the `oa_bigdead*` rows share (the outgoing-area family): twenty-eight values spilled to the
 *  frame, reloaded only inside a loop the first test may skip. */
const BIGDEAD_BODY =
  '    int v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, w0, w1, w2, w3, w4, w5, w6, w7, w8, w9, x0, x1, x2, x3, x4, x5, x6, x7;\n' +
  '    int i, s = 0;\n' +
  '    v0 = p[0]; v1 = p[1]; v2 = p[2]; v3 = p[3]; v4 = p[4]; v5 = p[5]; v6 = p[6]; v7 = p[7]; v8 = p[8]; v9 = p[9];\n' +
  '    w0 = p[10]; w1 = p[11]; w2 = p[12]; w3 = p[13]; w4 = p[14]; w5 = p[15]; w6 = p[16]; w7 = p[17]; w8 = p[18]; w9 = p[19];\n' +
  '    x0 = p[20]; x1 = p[21]; x2 = p[22]; x3 = p[23]; x4 = p[24]; x5 = p[25]; x6 = p[26]; x7 = p[27];\n' +
  '    for (i = 0; i < k; i++) {\n' +
  '        s += p[i] * v0 ^ v1 * i ^ v2 * s ^ v3 * k ^ v4 * v5 ^ v6 * v7 ^ v8 * v9 ^ (w0 + i) * w1 ^ w2 * w3 ^ w4 * w5 ^ w6 * w7 ^ w8 * w9\n' +
  '           ^ x0 * x1 ^ x2 * x3 ^ x4 * x5 ^ x6 * x7 ^ x0 * i ^ x7 * s;\n' +
  '    }\n';
const CALL: ToolchainId[] = ['agbcc', 'gcc2.7.2kmc', 'mwcc_242_81']; // see the header for ido7.1

// The map the `/no-ptr-elem` row below is fed: a struct global with a SIZED pointer member
// (`u16 *pMap`), which is the exact predicate `fnHasSizedPtrFields` enumerates the variation on.
const BGPTRS_MAP: SymbolMap = new Map([
  [
    0x03004790,
    [
      {
        name: 'gBgPtrs',
        kind: 'data' as const,
        declared: true,
        shape: 'struct' as const,
        structName: 'BgPtrs',
        size: 8,
        layout: [
          { name: 'pMap', offset: 0, size: 4, pointer: true, pointeeSize: 2, pointeeSigned: false },
          { name: 'pad', offset: 4, size: 4, signed: false },
        ],
      },
    ],
  ],
]);

// The map the `/scopebase` row below is fed: a rank-2 u16 array global, the real
// `gBgTilemapBufs` shape read off a project ELF. The RANK is the load-bearing part — with `dims`
// the access renders as the bare `gBgTilemapBufs[0][i]`, whose base is a `var` that
// `l3/basecse.ts`'s `isHoistableBase` cannot see, which is exactly the eligibility hole
// `l3/scopebase.ts` was built for.
const TILEMAP_MAP: SymbolMap = new Map([
  [
    0x03000900,
    [
      {
        name: 'gBgTilemapBufs',
        kind: 'data' as const,
        declared: true,
        shape: 'array' as const,
        elemSize: 2,
        elemSigned: false,
        size: 8192,
        dims: [4, 1024],
      },
    ],
  ],
]);

// The map the two `/no-bitfield` rows below are fed — the same `SymbolInfo` shape the ELF
// provider emits for a struct global whose first u16 packs three unsigned bitfields (the kleod
// Unk_03005220 layout), with a plain u32 following at byte 4. `bfwordread`/`bfwordwrite` read and
// write the third field, `dreamStones`, at bits [11:5].
const PACKED_MAP: SymbolMap = new Map([
  [
    0x03005220,
    [
      {
        name: 'gPacked',
        kind: 'data' as const,
        declared: true,
        shape: 'struct' as const,
        structName: 'Packed',
        size: 8,
        layout: [
          { name: 'hearts', offset: 0, size: 1, signed: false, bitWidth: 2, bitOffset: 0 },
          { name: 'stars', offset: 0, size: 1, signed: false, bitWidth: 3, bitOffset: 2 },
          { name: 'dreamStones', offset: 0, size: 2, signed: false, bitWidth: 7, bitOffset: 5 },
          { name: 'unk4', offset: 4, size: 4, signed: false },
        ],
      },
    ],
  ],
]);

// ═══ Maps for the CountCollectedGems attribution rows (attr/countgems) ══════════════════════
// `PROBE_BLOB_MAP` is the first synthetic map to declare `shape: 'pointer'` with a `pointee`
// layout — but symbol maps on synthetic rows are NOT new: `bfwordread`/`bfwordwrite` carry
// `PACKED_MAP`, `ptrelem` carries `BGPTRS_MAP` and `sbscope` carries `TILEMAP_MAP`, and
// `PROBE_FLAG_MAP` below is the same KIND of map as `PACKED_MAP`.
//
// IT IS TWO MAPS, and the split is the row's whole subject rather than bookkeeping. A map states
// what the row's OWN header declares, and these three headers do not agree: `pmarr1` declares
// `u8 unk8[48]`, `pmarr2` and `pmarrfix` declare `u8 unk8[6][8]`. One shared map flattening all
// three is what made the pair unable to test rank at all — the candidate SELF-DECLARES from the
// map, so a rank-1 spelling type-checked whatever the reference source said, while the real tier
// compiles the same candidate against a fixed project header where it does not. Two maps put the
// rank back on the question the rows are supposed to measure.
//
// WHAT EACH MAP BUYS, MEASURED (re-run with `symbols:` removed, `bench run`, cache off):
// `PROBE_GRID_MAP` now carries THREE rows, and they partition the subscript split rather than
// repeating it: `pmarr2`'s residual holds a term at the row stride and the split RECOVERS a row;
// `pmarrrow`'s holds none and the leading subscript comes out the literal `0`; `pmarrfix`'s index
// is constant and never reaches the split at all.
//
//   PROBE_BLOB_MAP  pmarr1 MATCH→5                                  — LOAD-BEARING since the
//     indexed member spelling shipped: `gBlob->unk8[i]` is the winner, and it needs both the
//     pointee layout and the member's stated rank (`dims: [48]` — absence means "the map could not
//     say", which structure.ts refuses rather than reading as rank 1). Before that it was inert
//     for asmlift and kept only for m2c, which goes MATCH → noncompile(1) without it.
//   PROBE_GRID_MAP  pmarr2 MATCH→9 · pmarrrow MATCH→5 · pmarrfix MATCH→MATCH
//                                                                   — LOAD-BEARING on `pmarr2`
//     (`gBlob->unk8[i][j]`, which only a stated `dims: [6, 8]` can spell) and on `pmarrrow`
//     (`gBlob->unk8[0][k]`, the same rank reached by ONE flat counter — map-less it is diff:5 and
//     m2c goes MATCH → noncompile(1)), inert on the control, whose constant index needs no member
//     spelling at all.
//   PROBE_FLAG_MAP  bfconstn MATCH→diff:5 · bfzero 5→5              — LOAD-BEARING, on the
//     CONTROL rather than on the gap row: without it `bfconstn` scores what `bfzero` scores and
//     the pair stops being a pair. It cuts the OTHER way for m2c, and that is stated rather than
//     hidden: map-LESS, m2c compiles `bfconstn` and scores diff:5; map-ful it noncompiles. The map
//     is not context withheld from m2c — m2c is GIVEN the same rendered declaration asmlift spells
//     `gFlags.unk0_0 = 4;` from, and answers with word arithmetic applied to the struct OBJECT
//     (`gFlags = (-0x10 & gFlags) | 4;`), which no C compiler accepts. Both configurations were
//     measured; the pair is authored map-ful because a control that scores what its gap row scores
//     pins nothing.
//
// `PROBE_BLOB_MAP`'s `size` is 60, not 64: compiled with the benchmark's own agbcc invocation,
// `sizeof(struct Blob)` is `mov r0, #0x3c` and `offsetof(unk38)` is `mov r0, #0x38`. `pad3` is a
// SCALAR, matching the row's own `u8 pad3;` — an earlier version declared it `{ elemSize: 1,
// length: 1 }`, an array of one. Neither is byte-load-bearing for these five rows (every access is
// at offset <= 55), which is exactly why no gate could catch them; the map is authored data a later
// round reads as the row's layout, so it has to be right on its own terms.
//
// `PROBE_FLAG_MAP` is a SEPARATE map from `PACKED_MAP` on purpose: `PACKED_MAP`'s fields are
// `unsigned` bitfields in a word, so a named store there compiles at the DECLARATION's access
// width (`ldrb`/`ldrh`) while the raw word spelling uses `ldr` — which is the question `bfwordread` measures.
// A `u8` field keeps both sides at the same width, so `bfzero` isolates the mask.
const PROBE_BLOB_MAP: SymbolMap = new Map([
  [
    0x03004670,
    [
      {
        name: 'gBlob',
        kind: 'data' as const,
        declared: true,
        shape: 'pointer' as const,
        pointee: {
          structName: 'Blob',
          size: 60,
          layout: [
            { name: 'unk0', offset: 0, size: 1, signed: false },
            { name: 'unk1', offset: 1, size: 1, signed: false },
            { name: 'unk2', offset: 2, size: 1, signed: false },
            { name: 'unk3', offset: 3, size: 1, signed: false },
            { name: 'unk4', offset: 4, size: 1, signed: false },
            { name: 'unk5', offset: 5, size: 1, signed: false },
            { name: 'unk6', offset: 6, size: 1, signed: false },
            { name: 'unk7', offset: 7, size: 1, signed: false },
            { name: 'unk8', offset: 8, size: 48, elemSize: 1, elemSigned: false, length: 48, dims: [48] },
            { name: 'unk38', offset: 56, size: 4, signed: true },
          ],
        },
      },
    ],
  ],
]);

// The SAME pointee, at the rank `pmarr2`/`pmarrfix` actually declare (`u8 unk8[6][8]`). It is a
// separate map for the same reason `PROBE_FLAG_MAP` is separate from `PACKED_MAP`: a map states
// what the row's own header says, and `pmarr1`'s header says `u8 unk8[48]` (see the split note
// above `PROBE_BLOB_MAP`).
const PROBE_GRID_MAP: SymbolMap = new Map([
  [
    0x03004670,
    [
      {
        name: 'gBlob',
        kind: 'data' as const,
        declared: true,
        shape: 'pointer' as const,
        pointee: {
          structName: 'Blob2',
          size: 60,
          layout: [
            { name: 'unk0', offset: 0, size: 1, signed: false },
            { name: 'unk1', offset: 1, size: 1, signed: false },
            { name: 'unk2', offset: 2, size: 1, signed: false },
            { name: 'unk3', offset: 3, size: 1, signed: false },
            { name: 'unk4', offset: 4, size: 1, signed: false },
            { name: 'unk5', offset: 5, size: 1, signed: false },
            { name: 'unk6', offset: 6, size: 1, signed: false },
            { name: 'unk7', offset: 7, size: 1, signed: false },
            { name: 'unk8', offset: 8, size: 48, elemSize: 1, elemSigned: false, length: 48, dims: [6, 8] },
            { name: 'unk38', offset: 56, size: 4, signed: true },
          ],
        },
      },
    ],
  ],
]);

const PROBE_FLAG_MAP: SymbolMap = new Map([
  [
    0x03004c08,
    [
      {
        name: 'gFlags',
        kind: 'data' as const,
        declared: true,
        shape: 'struct' as const,
        structName: 'Flags',
        size: 4,
        layout: [
          { name: 'unk0_0', offset: 0, size: 1, signed: false, bitWidth: 4, bitOffset: 0 },
          { name: 'unk0_4', offset: 0, size: 1, signed: false, bitWidth: 4, bitOffset: 4 },
          { name: 'unk1', offset: 1, size: 1, signed: true },
          { name: 'unk2', offset: 2, size: 1, signed: false },
          { name: 'pad3', offset: 3, size: 1, signed: false },
        ],
      },
    ],
  ],
]);

// The STRADDLING-field map. `unk0_c`'s bits are 12-19: they touch bytes 1 and 2, so no aligned
// halfword holds them and agbcc reaches the field with a WORD read-modify-write (compiled, pinned
// agbcc: `mov #0xff; and; lsl #0xc; ldr [r3]; ldr .word -0xff001; and; orr; str [r3]`). Every
// other bitfield map here — `PACKED_MAP`, `PROBE_FLAG_MAP` — declares fields whose bits sit inside
// ONE byte, so this is the corpus's only row that can tell a store-width rule expressed in the
// field's byte SPAN from one expressed in its bit WINDOW.
const PROBE_SPAN_MAP: SymbolMap = new Map([
  [
    0x03004c10,
    [
      {
        name: 'gSpan',
        kind: 'data' as const,
        declared: true,
        shape: 'struct' as const,
        structName: 'Span',
        size: 4,
        layout: [
          { name: 'unk0_0', offset: 0, size: 2, signed: false, bitWidth: 12, bitOffset: 0 },
          { name: 'unk0_c', offset: 1, size: 2, signed: false, bitWidth: 8, bitOffset: 4 },
          { name: 'unk0_14', offset: 2, size: 2, signed: false, bitWidth: 12, bitOffset: 4 },
        ],
      },
    ],
  ],
]);

// ═══ Maps for the SECOND CountCollectedGems attribution round (attr2/ladder) ════════════════
// The real function reads its flags through a POINTER global into a byte array (`gP->f[k]`) and
// writes a callback slot in a second struct (`gQ.cur`), and the five ladder rows below
// (`ladder4`, `ladder5`, `ladidx1`, `ladidx2`, `revlad5s`) keep that spelling rather than the
// flat `extern u8 gGrid[5][7]` the earlier attribution rows use. What each map buys is MEASURED
// per row, `symbols:` deleted, cache off, and it is not the same purchase on both halves of the
// family — the numbers are in "WHAT EACH MAP BUYS" below.
// Summarised: `PROBE_SLOTC_MAP` is load-bearing for asmlift on the LADDER rows (map-less
// `ladder4` MATCH -> 27 on a synthesized `struct Off0 { u8 _pad0[4]; s32 m4; }` for `gQ` plus a
// hoisted `p0 = (u8 *)&gC` base local — struct synthesis, a pre-existing link that is not this
// family, so the map is what keeps the row measuring the LADDER); `PROBE_SLOT_MAP`,
// `PROBE_CALLS_MAP` and `PROBE_NEST_MAP` are INERT for asmlift and load-bearing for m2c only.
const PROBE_SLOT_MAP: SymbolMap = new Map([
  [
    0x03001000,
    [
      {
        name: 'gP',
        kind: 'data' as const,
        declared: true,
        shape: 'pointer' as const,
        pointee: {
          structName: 'Slots',
          size: 64,
          layout: [{ name: 'f', offset: 0, size: 64, elemSize: 1, elemSigned: false, length: 64, dims: [64] }],
        },
      },
    ],
  ],
  [0x08001000, [{ name: 'fnA', kind: 'code' as const, declared: true }]],
  [0x08001100, [{ name: 'fnB', kind: 'code' as const, declared: true }]],
  [
    0x03001040,
    [
      {
        name: 'gQ',
        kind: 'data' as const,
        declared: true,
        shape: 'struct' as const,
        structName: 'Q',
        size: 8,
        layout: [
          { name: 'prev', offset: 0, size: 4, pointer: true },
          { name: 'cur', offset: 4, size: 4, pointer: true },
        ],
      },
    ],
  ],
]);

// The SAME two globals plus the per-arm counter `gC` that `ladder4`, `ladder5` and `revlad5s`
// write. A row's map states what its own header declares, so `ladidx1`/`ladidx2`, whose bodies
// have no `gC`, carry `PROBE_SLOT_MAP` instead.
const PROBE_SLOTC_MAP: SymbolMap = new Map([
  ...PROBE_SLOT_MAP,
  [
    0x03001050,
    [
      {
        name: 'gC',
        kind: 'data' as const,
        declared: true,
        shape: 'struct' as const,
        structName: 'C',
        size: 2,
        layout: [
          { name: 'a', offset: 0, size: 1, signed: false },
          { name: 'b', offset: 1, size: 1, signed: false },
        ],
      },
    ],
  ],
]);

// `gcseflat`'s globals: `PROBE_SLOT_MAP` plus the third callee its second arm stores. The harness
// compiles m2c's output against the map's declarations, so without `fnC` here that compile fails
// on "`fnC' undeclared" (`noncompile(1)`). That is context the row withheld, not m2c's behaviour:
// with it m2c scores 13/51. asmlift scores 19/53 either way.
const PROBE_SLOTFNC_MAP: SymbolMap = new Map([
  ...PROBE_SLOT_MAP,
  [0x08001200, [{ name: 'fnC', kind: 'code' as const, declared: true }]],
]);

// `ladcall5`'s globals: the SAME `gP` slots pointer the ladder rows carry, plus the six callees
// its arms name. It has no `gQ` and no `gC` because the per-arm STORE body those two exist for is
// exactly what that row replaces — the map follows the row's own src (authored-facts.test.ts
// enforces that), so it is a consequence of the body edit, not a second variable.
const PROBE_CALLS_MAP: SymbolMap = new Map([
  [0x03001000, PROBE_SLOT_MAP.get(0x03001000)!],
  [0x08001200, [{ name: 'fn0', kind: 'code' as const, declared: true }]],
  [0x08001300, [{ name: 'fn1', kind: 'code' as const, declared: true }]],
  [0x08001400, [{ name: 'fn2', kind: 'code' as const, declared: true }]],
  [0x08001500, [{ name: 'fn3', kind: 'code' as const, declared: true }]],
  [0x08001600, [{ name: 'fn4', kind: 'code' as const, declared: true }]],
  [0x08001100, [{ name: 'fnB', kind: 'code' as const, declared: true }]],
]);

// The nest pair's global: the same pointer-to-struct shape at the RANK the two loops index it by
// (`gP->f[i][j]`), which is what `dims: [8, 8]` states and `length: 64` alone cannot.
const PROBE_NEST_MAP: SymbolMap = new Map([
  [
    0x03001000,
    [
      {
        name: 'gP',
        kind: 'data' as const,
        declared: true,
        shape: 'pointer' as const,
        pointee: {
          structName: 'Grid',
          size: 64,
          layout: [{ name: 'f', offset: 0, size: 64, elemSize: 1, elemSigned: false, length: 64, dims: [8, 8] }],
        },
      },
    ],
  ],
]);

export const SYNTHETIC: SynthSpec[] = [
  // ── baseline ──────────────────────────────────────────────────────────────────────────
  // The control group: a function carrying no other feature. Its body must derive no tag at all
  // (no operator, no branch, no call), or it stops being a control. The corpus's only `baseline`
  // row used to be `kleod:ReturnOne:agbcc` (retired), which the 2026-09 source swap found is not a
  // function (it is the `movs r0, #1; bx lr` tail label of `StringCompare` in testyourmine/kleod's
  // asm/util.s), so the control lives here, where no binary can dispute its boundaries.
  //
  // Two lanes, and the second is not decoration: a control says "a decompiler that cannot match
  // this has a problem unrelated to any feature", which is a claim about ONE compiler's codegen at
  // a time. Animal Crossing is about to be the tag's only real carrier and it is CodeWarrior, so
  // the PowerPC control (`li r3,1; blr`) is what its row can be read against. ido7.1 and
  // gcc2.7.2kmc are left off: neither carries the tag anywhere, and a control nothing is read
  // against is a compile, not a measurement.
  {
    sym: 'retone',
    src: 'int retone(void){ return 1; }',
    features: ['baseline'],
    toolchains: ['agbcc', 'mwcc_242_81'],
  },
  // `retflat` — THE ROW THAT PINS `return;` SPELLING, first of the three rows that follow. They and
  // `tax_gprel` in the memory family are the four rows in the tier that set their own `cflags`.
  // Every other synthetic row compiles at -O2, where a
  // redundant trailing `return;` is free: written both ways, 124 of 125 agbcc sources give identical
  // objects at -O2 and at -O1, so no row at the canonical flags can tell a decompiler that emits one
  // from a decompiler that does not. At -O0 it is not free — every source `return;` becomes its own
  // `b <epilogue>` — and this body is the smallest place that shows it. Compiled at the flags below,
  // the two spellings of its own emitted C differ in the object:
  //
  //     void retflat(void){ *(s32 *)50345024 = 3; }            ldr/mov/str; bx lr
  //     void retflat(void){ *(s32 *)50345024 = 3; return; }    ldr/mov/str; b .L2; bx lr
  //
  // so the row is a MATCH for the spelling the assembly shows and a nonmatch for the other. That is
  // the whole of what it witnesses.
  //
  // `-fomit-frame-pointer` is not decoration. agbcc's -O0 frame (`push {r7,lr}; mov r7,sp`) homes
  // every local on the stack and asmlift declines it outright ("stack pointer used as data"), so
  // an -O0 row with a frame measures the frame and never reaches the backend. A parameterless body
  // with no locals has no frame to omit, which leaves the return spelling as the only thing in it.
  //
  // NO FEATURE TAG FOR THE LEVEL, on any of the three. The 42 rows already built at -O0 are real
  // ones and carry none either — their level comes off their unit's flags, which the artifact
  // publishes per row the same way it publishes these. A tag here would be a filter that matched
  // these three and missed those, which is worse than no filter. `baseline` is what all three carry,
  // and it is the truth rather than a placeholder: a body with no other feature in it, which is also
  // the one tag the vocabulary requires of every published row.
  {
    sym: 'retflat',
    src: '#define gOutA ((u32 *)0x03003440)\nvoid retflat(void){ *gOutA = 3; }',
    cflags: ['-mthumb-interwork', '-O0', '-fomit-frame-pointer', '-fhex-asm', '-fprologue-bugfix'],
    features: ['baseline'],
    toolchains: ['agbcc'],
    ctx: 'void retflat(void);',
    proto: { retflat: { returnsVoid: true } },
  },
  // `retjoin` — the same pin one shape up, where the epilogue is reached BOTH ways. Its `if`/`else`
  // join sits on the epilogue at -O0: the `then` arm branches there (`b .L4`) and the `else` arm
  // falls in. A block-level reading that keeps a return whenever SOME path branches in keeps one
  // here, and the object says the source wrote none — an `if`/`else` over a void tail is the
  // commonest shape in the corpus that `retflat` cannot speak for.
  //
  //     void retjoin(void){ … }             b .L4; .L4: .L2: bx lr
  //     void retjoin(void){ …; return; }    b .L4; .L4: b .L2; .L2: bx lr
  //
  // Same flags as `retflat`, and for the same reason.
  {
    sym: 'retjoin',
    src:
      '#define gFlag ((u8 *)0x03003430)\n#define gOutA ((u32 *)0x03003440)\n#define gOutB ((u32 *)0x03003444)\n' +
      'void retjoin(void){ if (*gFlag) *gOutA = 3; else *gOutB = 4; }',
    cflags: ['-mthumb-interwork', '-O0', '-fomit-frame-pointer', '-fhex-asm', '-fprologue-bugfix'],
    features: ['baseline'],
    toolchains: ['agbcc'],
    ctx: 'void retjoin(void);',
    proto: { retjoin: { returnsVoid: true } },
  },
  // `retsolo` — the same pin where there is NO EPILOGUE BLOCK to read. `retflat` and `retjoin` are
  // agbcc, and an agbcc `.s` carries the epilogue LABEL (`.L2:`) whether or not a `return;` branched to
  // it, so the epilogue is always a block of its own there and the reading always has in-edges to
  // weigh. On an OBJECT there is no label: a body that never branches is ONE block, the `ret` sits
  // at the end of it, and nothing arrived from anywhere. That is the commonest shape in the corpus
  // — a flat void body — and the `.s` path cannot speak for it.
  //
  // IDO 7.1 at -O0 is where it costs bytes, measured at the flags below:
  //
  //     void retsolo(void){ *gOutA = 3; }            li/lui/sw; jr ra; nop; jr ra; nop; nop
  //     void retsolo(void){ *gOutA = 3; return; }    li/lui/sw; jr ra; nop; jr ra; nop; jr ra; nop
  //
  // ido7.1 only. agbcc is the path this row exists to get past, and mwcc cannot host it: written
  // both ways, this body and an `if`/`else` over a void tail compile to BYTE-IDENTICAL `.text` on
  // mwcc_242_81 and mwcc_247_107 at `-O0,p` AND at `-O4,p`, 8 of 8. That is also why the 42 rows
  // the corpus already builds at -O0 — every one of them Mario Party 4, on those two builds — can
  // never move on this question. Same `-O0` reasoning as the other two: at the canonical -O2 the
  // spellings are one object and no row there can tell the two decompilers apart.
  {
    sym: 'retsolo',
    src: '#define gOutA ((u32 *)0x80003010)\nvoid retsolo(void){ *gOutA = 3; }',
    cflags: ['-mips2', '-O0', '-32', '-non_shared', '-G', '0'],
    features: ['baseline'],
    toolchains: ['ido7.1'],
    ctx: 'void retsolo(void);',
    proto: { retsolo: { returnsVoid: true } },
  },
  // ── arithmetic ────────────────────────────────────────────────────────────────────────
  { sym: 'add', src: 'int add(int a,int b){ return a+b; }', features: ['arithmetic'], toolchains: ALL },
  { sym: 'sub', src: 'int sub(int a,int b){ return a-b; }', features: ['arithmetic'], toolchains: ALL },
  { sym: 'mul', src: 'int mul(int a,int b){ return a*b; }', features: ['arithmetic'], toolchains: ALL },
  { sym: 'mulc', src: 'int mulc(int a){ return a*10; }', features: ['arithmetic'], toolchains: ALL },
  {
    sym: 'divc',
    src: 'int divc(int a){ return a/7; }',
    features: ['arithmetic', 'div-const', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'div2',
    src: 'int div2(int a){ return a/2; }',
    features: ['arithmetic', 'div-pow2', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'udivc',
    src: 'unsigned udivc(unsigned a){ return a/7; }',
    features: ['arithmetic', 'div-const', 'unsigned'],
    toolchains: ALL,
  },
  {
    sym: 'modc',
    src: 'int modc(int a){ return a%10; }',
    features: ['arithmetic', 'mod-const', 'signed'],
    toolchains: ALL,
  },
  // register-divisor division — exercises the soft-division fold (`bl __divsi3(a,b)` on agbcc)
  // AND the hardware-divide decode on ido/gcc/ppc.
  {
    sym: 'divv',
    src: 'int divv(int a,int b){ return a/b; }',
    features: ['arithmetic', 'div-reg', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'modv',
    src: 'int modv(int a,int b){ return a%b; }',
    features: ['arithmetic', 'mod-reg', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'umodv',
    src: 'unsigned umodv(unsigned a,unsigned b){ return a%b; }',
    features: ['arithmetic', 'mod-reg', 'unsigned'],
    toolchains: ALL,
  },
  // The remainder written OUT, as a source-level subtract-multiply-divide. It is not a `%` and must
  // not be respelled as one: on an ISA that synthesizes `%` from exactly these three instructions,
  // the two spellings differ by the multiply's operand order.
  {
    sym: 'modb',
    src: 'int modb(int a,int b){ return a - b*(a/b); }',
    features: ['arithmetic', 'div-reg', 'signed'],
    toolchains: ALL,
  },
  // The remainder whose two operands are CALLS, in the order the machine runs them. Folding the
  // written-out idiom to `%` would drop both from two uses to one and inline them into the one
  // expression, where C leaves their order unspecified and mwcc runs the RIGHT one first — so the
  // fold must refuse here and spell the decomposition out, which names them and states the order.
  // This row is that refusal's price: it is the shape the guard costs, published rather than argued.
  {
    sym: 'modseq',
    src: 'int lo(void);\nint hi(void);\nint modseq(void){ int a = lo(); return a % hi(); }',
    features: ['arithmetic', 'mod-reg', 'signed'],
    toolchains: CALL,
    ctx: 'int lo(void); int hi(void);',
    proto: { lo: { params: 0 }, hi: { params: 0 } },
  },
  // `modseq` one PURE op deeper. The structurer inlines through single-use pure ops, so what lands
  // at an operand of the invented `%` is the operand's whole CONE — a `+ 1` between the call and the
  // fold does not make the call stay put. Sampling the refusal only where the effect is the operand's
  // immediate def cannot see that, which is what this row exists to stop.
  {
    sym: 'modcone',
    src: 'int lo(void);\nint hi(void);\nint modcone(void){ int a = lo() + 1; return a % hi(); }',
    features: ['arithmetic', 'mod-reg', 'signed'],
    toolchains: CALL,
    ctx: 'int lo(void); int hi(void);',
    proto: { lo: { params: 0 }, hi: { params: 0 } },
  },
  // The same question asked of a memory READ rather than a second call: the read answers whichever
  // stores ran before it, and the call it would be hoisted over is one asmlift hands the pointer to.
  // Two reads would commute; a read against a call does not.
  //
  // Its agbcc cell (8) is a KNOWN, pre-existing silent de-sequencing, not a scoring curiosity —
  // DO NOT close it by making the spelling match. agbcc reaches `smod` through raise/softdiv.ts
  // (`bl __modsi3`), which invents the `%` exactly as the PPC fold does and carries no guard at
  // all: asmlift emits `*a0 % (s32)hi()` and agbcc emits `bl hi | ldr r0,[r4]` against the
  // reference's `ldr r4,[r0] | bl hi`. Proved pre-existing by decompiling the same asm with the
  // hwmod patterns removed — byte-identical source. Guarding softdiv re-prices the largest tier.
  {
    sym: 'modread',
    src: 'int hi(void);\nint modread(int *p){ int x = *p; return x % hi(); }',
    features: ['arithmetic', 'mod-reg', 'signed', 'pointer'],
    toolchains: CALL,
    ctx: 'int hi(void);',
    proto: { hi: { params: 0 } },
  },
  {
    sym: 'udivv',
    src: 'unsigned udivv(unsigned a,unsigned b){ return a/b; }',
    features: ['arithmetic', 'div-reg', 'unsigned'],
    toolchains: ALL,
  },
  // A divide ahead of a store. On agbcc it is a `bl __divsi3`, which agbcc leaves where the source
  // computes it, so inlined at the add it recompiles behind the store. On every toolchain because
  // everywhere else it is an instruction the compiler schedules: kmc, IDO and mwcc compile the
  // divide at the add and the divide ahead of the store to one object, so those cells are the
  // control that the inline spelling costs nothing there.
  {
    sym: 'divstore',
    src: 'int divstore(int *q, int n, int k){ int t = k / n; *q = n; return t + 1; }',
    features: ['arithmetic', 'div-reg', 'signed', 'pointer'],
    toolchains: ALL,
  },
  { sym: 'neg', src: 'int neg(int a){ return -a; }', features: ['arithmetic'], toolchains: ALL },
  {
    sym: 'expr1',
    src: 'int expr1(int a,int b,int c){ return a*b + c - 3; }',
    features: ['arithmetic'],
    toolchains: ALL,
  },

  // ── bitwise ───────────────────────────────────────────────────────────────────────────
  { sym: 'band', src: 'int band(int a,int b){ return a&b; }', features: [], toolchains: ALL },
  { sym: 'bor', src: 'int bor(int a,int b){ return a|b; }', features: [], toolchains: ALL },
  { sym: 'bxor', src: 'int bxor(int a,int b){ return a^b; }', features: [], toolchains: ALL },
  { sym: 'bnot', src: 'int bnot(int a){ return ~a; }', features: [], toolchains: ALL },
  { sym: 'shl', src: 'int shl(int a,int b){ return a<<b; }', features: [], toolchains: ALL },
  {
    sym: 'shru',
    src: 'unsigned shru(unsigned a,int b){ return a>>b; }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'shrs',
    src: 'int shrs(int a,int b){ return a>>b; }',
    features: ['signed'],
    toolchains: ALL,
  },
  {
    sym: 'mask8',
    src: 'unsigned mask8(unsigned x){ return x & 0xff; }',
    features: ['mask'],
    toolchains: ALL,
  },
  {
    sym: 'bittest',
    src: 'int bittest(int x,int n){ return (x>>n)&1; }',
    features: ['mask'],
    toolchains: ALL,
  },
  {
    sym: 'setbit',
    src: 'int setbit(int x,int n){ return x | (1<<n); }',
    features: [],
    toolchains: ALL,
  },

  // ── comparison / logic ──────────────────────────────────────────────────────────────────
  { sym: 'maxi', src: 'int maxi(int a,int b){ return a>b?a:b; }', features: ['compare'], toolchains: ALL },
  { sym: 'mini', src: 'int mini(int a,int b){ return a<b?a:b; }', features: ['compare'], toolchains: ALL },
  {
    sym: 'clamp0',
    src: 'int clamp0(int x){ if(x<0) return 0; return x; }',
    features: ['compare', 'branch'],
    toolchains: ALL,
  },
  { sym: 'absi', src: 'int absi(int x){ return x<0?-x:x; }', features: ['compare'], toolchains: ALL },
  {
    sym: 'sign',
    src: 'int sign(int x){ if(x>0)return 1; if(x<0)return -1; return 0; }',
    features: ['compare', 'branch'],
    toolchains: ALL,
  },
  { sym: 'iszero', src: 'int iszero(int x){ return x==0; }', features: ['compare', 'bool'], toolchains: ALL },
  {
    sym: 'land',
    src: 'int land(int a,int b){ return a && b; }',
    features: ['compare', 'branch'],
    toolchains: ALL,
  },
  { sym: 'lor', src: 'int lor(int a,int b){ return a || b; }', features: ['compare', 'branch'], toolchains: ALL },
  {
    sym: 'inrange',
    src: 'int inrange(int x,int lo,int hi){ return x>=lo && x<=hi; }',
    features: ['compare', 'branch'],
    toolchains: ALL,
  },
  {
    sym: 'clampr',
    src: 'int clampr(int x,int lo,int hi){ if(x<lo)x=lo; if(x>hi)x=hi; return x; }',
    features: ['compare', 'branch'],
    toolchains: ALL,
  },

  // ── width / casts ───────────────────────────────────────────────────────────────────────
  { sym: 'tou8', src: 'u8 tou8(int x){ return (u8)x; }', features: ['cast', 'narrow'], toolchains: ALL },
  { sym: 'tos8', src: 's8 tos8(int x){ return (s8)x; }', features: ['cast', 'narrow', 'signed'], toolchains: ALL },
  { sym: 'tou16', src: 'u16 tou16(int x){ return (u16)x; }', features: ['cast', 'narrow'], toolchains: ALL },
  { sym: 'sextb', src: 'int sextb(s8 x){ return x; }', features: ['sign-extend'], toolchains: ALL },
  { sym: 'zextb', src: 'int zextb(u8 x){ return x; }', features: ['zero-extend'], toolchains: ALL },

  // ── memory ──────────────────────────────────────────────────────────────────────────────
  { sym: 'deref', src: 'int deref(int *p){ return *p; }', features: ['memory', 'load'], toolchains: ALL },
  // The float half of the same tag. `deref` covers every toolchain, so `load` already has a
  // CodeWarrior carrier — but a load into the FPU is a different instruction into a different
  // register file (`lfs f1,0(r3)` against `lwz r3,0(r3)`), decided by the pointer's type and by
  // nothing in the surrounding code, and the Animal Crossing rows about to claim `load` include
  // exactly this shape. mwcc_242_81 alone: `deref` already stands on the other three, and a float
  // load is soft-float on the GBA, where it is a different construct altogether.
  //
  // It DECLINES, on `lfs` being unmodelled in the PowerPC frontend, and that is the row's second
  // use. Every mwcc float row here already declines that way (`fadd` on `fadds`, `f2i` on
  // `fctiwz`, `i2f` on `lfd`, `upun` on `stfs`) — this is the smallest of them, two instructions
  // with no arithmetic, no conversion and no store, so the Animal Crossing float-load row it
  // mirrors cannot have its decline blamed on the relocation it also carries.
  {
    sym: 'loadf',
    src: 'float loadf(float *p){ return *p; }',
    features: ['memory', 'load', 'float'],
    toolchains: ['mwcc_242_81'],
    ctx: 'float loadf(float*);',
  },
  {
    sym: 'storep',
    src: 'void storep(int *p,int v){ *p=v; }',
    features: ['memory', 'store'],
    toolchains: ALL,
    ctx: 'void storep(int*,int);',
    proto: { storep: { returnsVoid: true } },
  },
  {
    sym: 'loadoff',
    src: 'int loadoff(int *p){ return p[2]; }',
    features: ['memory', 'load'],
    toolchains: ALL,
  },
  {
    sym: 'aidx',
    src: 'int aidx(int *p,int i){ return p[i]; }',
    features: ['memory', 'array', 'variable-index'],
    toolchains: ALL,
  },
  {
    sym: 'astore',
    src: 'void astore(int *p,int i,int v){ p[i]=v; }',
    features: ['memory', 'array', 'store'],
    toolchains: ALL,
    ctx: 'void astore(int*,int,int);',
    proto: { astore: { returnsVoid: true } },
  },
  {
    sym: 'byteidx',
    src: 'u8 byteidx(u8 *p,int i){ return p[i]; }',
    features: ['memory', 'array'],
    toolchains: ALL,
  },
  {
    sym: 'ptradd',
    src: 'int *ptradd(int *p,int n){ return p+n; }',
    features: ['memory', 'pointer'],
    toolchains: ALL,
  },
  // `tax_gprel` — THE WITNESS FOR A GLOBAL REACHED THROUGH gp, and the only row here that exists to
  // be DECLINED. The benchmark's decline taxonomy (`apps/web/src/pages/benchmark/lib/declines.ts`)
  // names a small-data class that no row inhabited, and a class with no inhabitant is a claim
  // nobody can check: it reads the same whether the refusal is still emitted, has been reworded, or
  // was never reachable, and those three have opposite fixes.
  //
  // It is not reachable at the canonical flags, and that is a FLAG and not a limit. Every MIPS
  // toolchain in the corpus compiles with no small-data threshold — `-non_shared -G 0` for ido7.1,
  // `-mno-abicalls -fno-PIC -G 0` for gcc2.7.2kmc — so no corpus object has ever carried a
  // gp-relative access. `-G 8` is one token off ido7.1's canonical set and puts an `int` in
  // `.sbss`, where IDO reaches it off `gp`:
  //
  //     -G 0   lui v1,0x0 / addiu v1,v1,0 / lw t6,0(v1) / addu / sw    R_MIPS_HI16 + R_MIPS_LO16
  //     -G 8   lw v1,0(gp) / addu v0,v1,a0 / jr ra / sw v0,0(gp)       R_MIPS_GPREL16 x2
  //
  // MEASURED BOTH WAYS, because a flag asserted to be load-bearing is a claim about the compiler:
  // at `-G 8` the lift refuses with "gp used as data (PIC / small-data global access)", and at
  // `-G 0` the same source does not reach that refusal at all. `-KPIC -G 0` arrives at a gp read
  // the long way, through the PIC prologue and a GOT load, so it would pin two causes and neither
  // of them cleanly; this shape has one.
  //
  // ido7.1 only. The gcc2.7.2kmc build would need its own flag change and would witness the same
  // refusal twice, and neither PPC nor agbcc reaches this site — PPC's small-data refusals are
  // `frontend/ppc.ts`'s own, under `R_PPC_EMB_SDA21`.
  //
  // BOTH DECOMPILERS MISS IT, differently, which is what makes the row worth publishing rather than
  // merely worth declining: asmlift refuses loudly and names the gap, and m2c emits a body naming
  // `saved_reg_gp`, which IDO then rejects ("'saved_reg_gp' undefined"). One is a decline and the
  // other a noncompile, and the row records the pair.
  //
  // NO `sda-global` TAG, although that tag names exactly this capability: it is CODEGEN-DERIVED and
  // `src/cases/features.ts` derives it from `R_PPC_EMB_SDA21`, the PowerPC spelling. The MIPS
  // spelling of the same mechanism is `R_MIPS_GPREL16` and the derivation does not read it, so this
  // row publishes `global` and the tag stays PowerPC-only until something widens it. Authoring
  // `sda-global` here is not the fix — `features.test.ts` requires authored tags to be judgement
  // tags, and a hand-written codegen tag is the assertion a derivation exists to replace.
  {
    sym: 'tax_gprel',
    src: 'int gTaxRate;\nint tax_gprel(int n){ gTaxRate += n; return gTaxRate; }',
    cflags: ['-mips2', '-O2', '-32', '-non_shared', '-G', '8'],
    features: ['memory', 'global', 'load', 'store'],
    toolchains: ['ido7.1'],
  },

  // `arrback` — THE WITNESS FOR A NEGATIVE POOL ADDEND. `&gTab[i - 1]` contains no subtract: agbcc
  // folds the element bias into the literal pool, and under `-fhex-asm` its hex printer emits the
  // `+` OPERATOR followed by a constant that spells its own sign — `.word gTab+-0x4`. The
  // benchmark's canonical agbcc flags already carry `-fhex-asm`, as all three of the corpus's GBA
  // makefiles do, so this row sets no `cflags` of its own; what it pins is one line of output.
  //
  // MEASURED AT THOSE FLAGS, because "the compiler emits this" is a claim about the compiler and
  // not about C: `&gTab[i-1]` gives `gTab+-0x4`, `&gElems[i-1]` over an 8-byte struct gives
  // `gElems+-0x8`, `&gBytes[i-2]` gives `gBytes+-0x2`. Drop `-fhex-asm` and the same source emits
  // `gTab-4` instead, which is why the `sym-N` branch of the pool reader had no inhabitant to find
  // this by: agbcc never writes it.
  //
  // `sa3:OamMalloc:agbcc` is the real row this came off, and it is not a substitute for this one.
  // It is 27 lines over three gaps, so it cannot MATCH on the pool addend alone and a regression
  // in the addend would move it from one nonmatch score to another. This body has nothing else in
  // it, so it is the row that goes from MATCH to not.
  //
  // agbcc only. `+-` is agbcc's hex printer; the other three toolchains reach the same address
  // through their own relocations and would measure something else under the same source.
  {
    sym: 'arrback',
    src: 'extern u32 gTab[];\nu32 *arrback(u32 i){ return &gTab[i - 1]; }',
    features: ['global', 'array', 'variable-index', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'u32 *arrback(u32 i);',
  },

  // ── structs (layout NOT in context — must be recovered) ─────────────────────────────────
  {
    sym: 'sfield',
    src: 'struct S{int a;int b;int c;};\nint sfield(struct S*s){ return s->b; }',
    features: ['struct', 'field'],
    toolchains: ALL,
  },
  {
    sym: 'sstore',
    src: 'struct S{int a;int b;};\nvoid sstore(struct S*s,int v){ s->b=v; }',
    features: ['struct', 'field', 'store'],
    toolchains: ALL,
    ctx: 'struct S; void sstore(struct S*,int);',
    proto: { sstore: { returnsVoid: true } },
  },
  {
    sym: 'smixed',
    src: 'struct P{u8 hp;s16 x;int id;};\nint smixed(struct P*p){ return p->x + p->id; }',
    features: ['struct', 'field', 'mixed-width'],
    toolchains: ALL,
  },
  // A MEMBER PAST THE DISPLACEMENT RANGE, reached through an address the machine materialises first
  // (`adds r3, #38; strb r2, [r3]`; a Thumb byte displacement stops at 31, a halfword's at 62).
  // agbcc stores the member's loaded value in a different order from the cast `*((u8 *)s + 38)`:
  // the member form loads `*q` before the `adds`, the cast after it (gcc/expr.c expand_assignment,
  // :2535 vs :2689), so these two pin the member spelling (raise/structs.ts foldDisplacedAccesses).
  {
    sym: 'sfar_b',
    src: 'struct S{s32 a;s32 b;u8 pad[30];u8 c;};\nvoid sfar_b(struct S*s,u8*q){ s->c=*q; s->a=0; }',
    features: ['struct', 'field', 'store', 'mixed-width'],
    toolchains: ['agbcc'],
    ctx: 'struct S; void sfar_b(struct S*,u8*);',
    proto: { sfar_b: { returnsVoid: true } },
  },
  {
    sym: 'sfar_h',
    src: 'struct T{s32 a;u8 pad[66];u16 h;};\nvoid sfar_h(struct T*s,u16*q){ s->h=*q; s->a=0; }',
    features: ['struct', 'field', 'store', 'mixed-width'],
    toolchains: ['agbcc'],
    ctx: 'struct T; void sfar_h(struct T*,u16*);',
    proto: { sfar_h: { returnsVoid: true } },
  },
  // The other side of the same pair: the source wrote the cast, or held the address in a pointer,
  // and agbcc built the address before the right-hand side. The `/far-cast` lift keeps the store
  // on its address; the default member spelling compiles to a different object.
  {
    sym: 'sfar_cast',
    src: 'struct S{s32 a;s32 b;u8 pad[30];u8 c;};\nvoid sfar_cast(struct S*s,u8*q){ *((u8*)s+38)=*q; s->a=0; }',
    features: ['struct', 'field', 'store', 'mixed-width'],
    toolchains: ['agbcc'],
    ctx: 'struct S; void sfar_cast(struct S*,u8*);',
    proto: { sfar_cast: { returnsVoid: true } },
  },
  {
    sym: 'sfar_ptr',
    src: 'struct S{s32 a;s32 b;u8 pad[30];u8 c;u8 d;};\nvoid sfar_ptr(struct S*s,u8*q,u8*r){ u8*p=&s->c; p[0]=*q; p[1]=*r; s->a=0; }',
    features: ['struct', 'field', 'store', 'mixed-width'],
    toolchains: ['agbcc'],
    ctx: 'struct S; void sfar_ptr(struct S*,u8*,u8*);',
    proto: { sfar_ptr: { returnsVoid: true } },
  },
  // A uniform-width root: every access one byte wide, so the access set alone reads as an array.
  // The far store's order (`*q` loaded before the `adds #38`) is the member's and no cast's, and
  // only the member spelling reproduces it. `sfar_bb` also leaves the second address in r0 at the
  // void function's `bx lr`, which is no use of it.
  {
    sym: 'sfar_ub',
    src: 'struct B{u8 a;u8 pad[37];u8 c;};\nvoid sfar_ub(struct B*p,u8*q){ p->c=*q; p->a=0; }',
    features: ['struct', 'field', 'store'],
    toolchains: ['agbcc'],
    ctx: 'struct B; void sfar_ub(struct B*,u8*);',
    proto: { sfar_ub: { returnsVoid: true } },
  },
  {
    sym: 'sfar_bb',
    src: 'struct B{u8 a;u8 pad[37];u8 c;u8 d;};\nvoid sfar_bb(struct B*p){ p->d=p->c; }',
    features: ['struct', 'field', 'store'],
    toolchains: ['agbcc'],
    ctx: 'struct B; void sfar_bb(struct B*);',
    proto: { sfar_bb: { returnsVoid: true } },
  },
  // A held pointer read at two offsets: agbcc shares one `adds r1, #38` between `ldrb [r1]` and
  // `ldrb [r1, #1]`, where the member spelling `p->c + p->d` gives each access its own `adds`. So
  // the pointer is the source's and the fold leaves it alone (raise/structs.ts
  // `held-pointer-offsets`). Inside the `addiu` reach ido and mwcc share one base across members
  // as they do for a held pointer, and KMC lifts the held pair as members at the same bytes, so
  // this pins agbcc only; ido past that reach is `sfar_msg`'s.
  {
    sym: 'sfar_held',
    src: 'struct S{s32 a;u16 b;u8 pad[32];u8 c;u8 d;};\nu32 sfar_held(struct S*p){ u8*d=&p->c; return d[0]+d[1]+p->a; }',
    features: ['struct', 'field', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'struct S; u32 sfar_held(struct S*);',
  },
  // The same gap past a 16-bit displacement: ido's `addiu at, a0, 32767; sb a1, 7232(at)`, KMC's and
  // GCC 2.7.2's `lui at, 1; addu at, at, a0; sb a1, -25537(at)`, mwcc's `addis r5, r3, 1;
  // stb r4, -25537(r5)`. There the member and both cast spellings compile to the same bytes
  // (compiled on all six builds, a stored loaded value too), so these rows pin the recovered
  // struct type, not the bytes. `x` is a word: a `u8` parameter adds ido's `sw a1, 4(sp)` home,
  // a parameter-width question this row is not about.
  {
    sym: 'sfar_big',
    src: 'struct S{s32 a;u8 pad[39995];u8 big;};\nvoid sfar_big(struct S*p,u32 x){ p->a=1; p->big=x; }',
    features: ['struct', 'field', 'store', 'mixed-width'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'struct S; void sfar_big(struct S*,u32);',
    proto: { sfar_big: { returnsVoid: true } },
  },
  {
    sym: 'sfar_big',
    src: 'struct S{s32 a;u8 pad[39995];u8 big;};\nvoid sfar_big(struct S*p,u32 x){ p->a=1; p->big=x; }',
    features: ['struct', 'field', 'store', 'mixed-width'],
    toolchains: ['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'],
    cflags: MWCC_O4P,
    ctx: 'struct S; void sfar_big(struct S*,u32);',
    proto: { sfar_big: { returnsVoid: true } },
  },
  // A held far pointer past ido's `addiu` reach, the OoT/MM idiom of a message context inside the
  // play state (msg at 0x10A24): ido shares one `lui at, 1; addu v1, a0, at` between the held
  // pointer's accesses where the member spelling gives every access its own `lui`/`addu`, so the
  // fold leaves it on its address (`held-pointer-offsets`, target.ts `farMemberBasePerAccess`).
  // `sfar_msgs` stores first and reads after: KMC loads both before the store, and only the store
  // kept on its address (`/far-cast`) keeps the loads where the source wrote them. Elsewhere these
  // two pin the type.
  ...(
    [
      [['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'], undefined],
      [['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'], MWCC_O4P],
    ] as const
  ).flatMap(([toolchains, cflags]): SynthSpec[] => [
    {
      sym: 'sfar_msg',
      src:
        'struct Msg{u8 a;u8 a1;u16 b;s32 c;};struct Play{s32 frames;u8 pad[0x10A20];struct Msg msg;};\n' +
        's32 sfar_msg(struct Play*play,u8*q){ struct Msg*m=&play->msg; m->a=*q; return m->c; }',
      features: ['struct', 'field', 'pointer'],
      toolchains: [...toolchains],
      ...(cflags ? { cflags } : {}),
      ctx: 'struct Play; s32 sfar_msg(struct Play*,u8*);',
    },
    {
      sym: 'sfar_msgs',
      src:
        'struct Msg{u8 a;u8 a1;u16 b;s32 c;};struct Play{s32 frames;u8 pad[0x10A20];struct Msg msg;};\n' +
        's32 sfar_msgs(struct Play*play){ struct Msg*m=&play->msg; m->b=0; return m->c+m->a; }',
      features: ['struct', 'field', 'pointer'],
      toolchains: [...toolchains],
      ...(cflags ? { cflags } : {}),
      ctx: 'struct Play; s32 sfar_msgs(struct Play*);',
    },
    // A held far pointer written at three offsets: mwcc_242_81 and mwcc_247_107 give it and the
    // member spelling one shared `addis` base each, in different registers, so only `/far-cast`
    // rebuilds it there.
    {
      sym: 'sfar_hold',
      src:
        'struct H{s32 a;u8 pad[69996];u8 b;u8 b1;u16 b2;u8 b3;u8 b4;};\n' +
        'void sfar_hold(struct H*p,u8*q){ u8*d=&p->b; d[0]=*q; *(u16*)(d+2)=0; d[5]=1; }',
      features: ['struct', 'field', 'pointer', 'store'],
      toolchains: [...toolchains],
      ...(cflags ? { cflags } : {}),
      ctx: 'struct H; void sfar_hold(struct H*,u8*);',
      proto: { sfar_hold: { returnsVoid: true } },
    },
  ]),
  // An address constant added to an integer (GBA VRAM here, any segment or device base on MIPS and
  // PPC): no member offset, so the integer stays one (raise/structs.ts `address-constant`).
  {
    sym: 'sfar_addr',
    src: 'u32 sfar_addr(u32 x){ return *(u16*)(x+0x6000000) + *(u8*)(x+0x6000004); }',
    features: ['pointer', 'mixed-width'],
    toolchains: ALL,
    ctx: 'u32 sfar_addr(u32);',
  },
  // A byte buffer whose far store takes a value an earlier statement loaded: the member and the
  // cast spelling both load it before the address, so the order is no struct evidence and the
  // buffer stays one.
  {
    sym: 'sfar_buf',
    src: 'void sfar_buf(u8*p,u8*q,u8*r){ u8 v=*q; *r=0; p[38]=v; }',
    features: ['pointer', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void sfar_buf(u8*,u8*,u8*);',
    proto: { sfar_buf: { returnsVoid: true } },
  },
  // A byte buffer whose far store takes a call's result: agbcc expands the call before the address
  // under the member and the cast spelling alike, so the order is no struct evidence and the
  // buffer stays one.
  {
    sym: 'sfar_call',
    src: 'int sfar_k(int);\nvoid sfar_call(u8*p,u8*q,s32 n){ p[60]=sfar_k(n); p[q[0]]=0; }',
    features: ['pointer', 'store'],
    toolchains: ['agbcc'],
    ctx: 'int sfar_k(int); void sfar_call(u8*,u8*,s32);',
    proto: { sfar_k: { params: 1 }, sfar_call: { returnsVoid: true } },
  },
  // A held far pointer beside a far member store on one root: the pointer stays on its address and
  // the store still joins the struct.
  {
    sym: 'sfar_mix',
    src:
      'struct S{s32 a;u16 b;u8 pad[32];u8 f38;u8 f39;u8 pad2[28];u16 f68;u16 f70;};\n' +
      'u32 sfar_mix(struct S*p,u8*q){ u16*d=&p->f68; p->f38=*q; return d[0]+d[1]; }',
    features: ['struct', 'field', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'struct S; u32 sfar_mix(struct S*,u8*);',
  },

  // ── unions (the same storage read at two widths / in two type domains) ──────────────────
  // A union is only measurable when the SAME bytes are reached through members of different width
  // or domain: that is what a decompiler has to reconstruct. A union whose members are never
  // aliased compiles identically to a struct, so it would be unscorable — see `sfield`.
  //
  // OVERLAPPING WIDTHS ARE NOT A UNION QUESTION, which is the second thing this family measures.
  // `unitrunc` declares no union at all — it reads one word member and its low byte — and produces
  // exactly the instructions `utag` does. raise/truncload.ts folds the narrow read into a cast of
  // the wider one where the bytes are the field's LOW-ORDER end. WHICH ROWS THAT LIFTS IS A
  // MEASUREMENT, and the committed artifact is where it is read — `node -e` over
  // apps/benchmark/results/results.json filtering `^synthetic:(unitrunc|utag|uhalf|ureread|uniwrite|unidev):`
  // prints the outcome and the decline of every cell. As it stands:
  //   • `unitrunc` LIFTS on all four toolchains — one word member and its low byte, which is the
  //     fold's own shape.
  //   • `utag`, `uhalf`, `ureread` and `uniwrite` carry what the fold leaves: a read on a path the
  //     cover does not dominate (`utag`'s switch arms), narrow reads whose only cover is the word
  //     STORE, which fixes no signedness (`uhalf`, `ureread`: `covering-store`, whichever end of the
  //     word they read), and a narrow STORE (`uniwrite`). No value cast spells any of them, and
  //     raise/structs.ts declares each overlap on a parameter as a UNION member — a view per width
  //     — which is what these rows' sources declare. On mwcc_242_81 `utag`'s switch arms are
  //     reached through CodeWarrior's binary-search dispatch, whose `bge` reads the compare its
  //     `beq` already consumed (frontend/flags-edge.ts) and pins `case 0` by its path
  //     (`switchBoundCase`, target.ts).
  //   • `unidev` is not a case of that sentence at all: its base is a LITERAL ADDRESS, so the
  //     accesses are not evidence about a layout nobody declared, and raise/structs.ts forgives the
  //     failed synthesis. It LIFTS, at each access's own width, and what it measures is below.
  //
  // The aliasing probes take the union through a POINTER on purpose. As a local it lands in a stack
  // slot on the register-poor targets, and asmlift declines on the stack-frame gap BEFORE it ever
  // sees the overlap — the probe would then measure frames, not unions. `upun` is the exception:
  // punning a float through memory is the whole construct, so its FP store/load is the point.
  {
    sym: 'uhalf',
    src: 'union W{u32 w;u16 h[2];};\nu32 uhalf(union W*u,u32 v){ u->w=v; return u->h[0]+u->h[1]; }',
    features: ['union', 'field', 'array', 'mixed-width'],
    toolchains: ALL,
  },
  // WHY THE RECOVERY DECLARES A UNION AND NOT A CAST. `((u16 *)u)[1]` beside `*u` spells the same
  // accesses as the union, and on `uhalf` it compiles to the same bytes everywhere. Here it does
  // not: agbcc -O2 applies C's aliasing rules, so through casts the halfword read after the word
  // store is taken to be the one read before it — `ldrh; str; adds` — where the union reloads it,
  // `ldrh; str; ldrh`, which is this target. gcc2.7.2kmc, ido7.1 and mwcc_242_81 reload for both,
  // so the agbcc cell is the one that referees the spelling.
  {
    sym: 'ureread',
    src: 'union W{u32 w;u16 h[2];};\nu32 ureread(union W*u,u32 v){ u16 a=u->h[1]; u->w=v; return a+u->h[1]; }',
    features: ['union', 'field', 'array', 'mixed-width'],
    toolchains: ALL,
  },
  {
    sym: 'ubyte',
    src: 'union B{u32 w;u8 b[4];};\nu32 ubyte(union B*u,u32 v,int i){ u->w=v; return u->b[i]; }',
    features: ['union', 'field', 'array', 'variable-index', 'mixed-width'],
    toolchains: ALL,
  },
  {
    sym: 'upun',
    src: 'union F{float f;u32 u;};\nu32 upun(float x){ union F t; t.f=x; return t.u; }',
    features: ['union', 'field', 'float'],
    toolchains: ALL,
    ctx: 'u32 upun(float);',
  },
  {
    sym: 'utag',
    src: 'struct T{int kind;union{int i;u16 h;u8 b;}v;};\nint utag(struct T*t){ switch(t->kind){case 0:return t->v.i;case 1:return t->v.h;default:return t->v.b;} }',
    features: ['union', 'struct', 'field', 'mixed-width'],
    toolchains: ALL,
  },
  {
    sym: 'ustore',
    src: 'union E{s32 a;u16 b[2];};\nvoid ustore(union E*e,int i,s32 v){ e[i].a=v; e[i].b[0]=0; }',
    features: ['union', 'field', 'array', 'store', 'mixed-width'],
    toolchains: ALL,
    ctx: 'union E; void ustore(union E*,int,s32);',
    proto: { ustore: { returnsVoid: true } },
  },
  // NOT A UNION, and that is what it measures: one word member, read whole and read as its low
  // byte for a narrower use. The compiler emits the same `ldr`/`ldrb` pair a union would, at one
  // offset and two widths, so nothing in the object tells the two spellings apart — and the cast
  // is the one that needs no type the asm does not pin. Both endiannesses are inhabited by this one
  // source: the low byte of the word sits at byte 0 on ARM and at byte 3 on the MIPS/PPC rows.
  {
    sym: 'unitrunc',
    src: 'struct N{s32 w;s32 id;};\nint unitrunc(struct N*n){ return n->w + (u8)n->w + n->id; }',
    features: ['struct', 'field', 'cast', 'narrow', 'mixed-width'],
    toolchains: ALL,
  },
  // THE NARROW STORE, which `ustore` above does not reach: its own narrow write goes through a
  // variable index, so it arrives as an element access rather than as a constant-offset one. Here
  // there is no index, so the write lands on the overlap itself. raise/truncload.ts must never
  // widen it — that would clobber the byte past it, and no value cast spells a partial write — and
  // the row SCORES that: the union's `byte` view stores one byte, and a widened store would compile
  // to a halfword store and stop matching.
  {
    sym: 'uniwrite',
    src: 'union U{u16 h;u8 b;};\nu32 uniwrite(union U*u){ u->b=1; return u->h; }',
    features: ['union', 'field', 'store', 'mixed-width'],
    toolchains: ALL,
  },
  // A HARDWARE REGISTER read at two widths, where the ACCESS WIDTH is itself the observable event:
  // the device answers a halfword read and a byte read differently, so the two reads are not one
  // datum and the narrower is not a cast of the wider.
  //
  // THAT IS A CLAIM ABOUT THE FOLD, NOT ABOUT THE FUNCTION. raise/truncload.ts's `fixed-cell` gate
  // must keep refusing to make one read out of the two — widening a device read is unsound — and
  // it does. Declining the whole function was never required by it: the row lifts, with the two
  // reads intact at their own widths, and WITHOUT the `volatile` qualifier the reference carries.
  //
  // WHICH CELLS STILL WITNESS THE REFUSAL, AND IT IS NOT ALL FOUR. #240 added this row to decline
  // everywhere, so that widening a fixed-address read would be noticed. It no longer declines
  // anywhere, and the guard survives only where the cell MATCHES: **`gcc2.7.2kmc` and
  // `mwcc_242_81`**. There an unsound widening changes the bus events, the bytes stop matching, the
  // cell flips match -> nonmatch, and `bench regression` reports a LOST row — the loudest signal
  // the harness has. **`agbcc` and `ido7.1` witness nothing**: they sit at nonmatch for the two
  // unrelated per-toolchain reasons spelled out below, and the same regression would move them
  // nonmatch -> nonmatch at some other score, which `bench regression` does not report at all and
  // `bench diff` shows only as a score field nobody reads for soundness.
  //
  // A ROW'S VERDICT CHANGING IS NOT THE SAME AS ITS GUARD SURVIVING. A row that starts declining
  // and ends matching has silently swapped which direction it discriminates in, and which cells
  // still discriminate is not readable from the verdict column.
  //
  // WHAT THE FOUR CELLS DO, read off the artifact rather than predicted: two MATCH (`gcc2.7.2kmc`
  // from the same spelling asmlift wins on agbcc, `mwcc_242_81` from the indexed
  // `((u16 *)K)[2] + ((u8 *)K)[4]`) and two nonmatch at 3 (`agbcc`, `ido7.1`). So the missing
  // `volatile` bounds what can be SPELLED and not what can match — and THE TWO NONMATCHES DO NOT
  // SHARE A CAUSE. Both were compiled, `.text` only, at each row's own flags out of
  // `pnpm bench target synthetic:unidev:<toolchain> --out <dir>` (its decomp.yaml carries the
  // command; the candidate needs core's typedef prelude, `C_TYPEDEFS` in target.ts):
  //   • agbcc — `volatile` IS the whole diff. The qualified spelling's `.text` is 16 bytes,
  //     sha256 `59d1be4e7bc52fa1`, byte-identical to `target.o`; drop the two qualifiers and it is
  //     `d1f4ab83fb563391`. The return type does not enter it: `u32` and `s32` hash the same on
  //     both sides of that pair, so the qualifier is the only byte-bearing difference from the
  //     reference. This cell is the witness for `/vol-load`, the load-side respell nothing
  //     enumerates (`/vol-store` qualifies stores, `/volatile` needs a pointer local holding the
  //     address, and neither fits a bare literal).
  //   • ido7.1 — `volatile` costs NOTHING and the cause is OPERAND ORDER.
  //     `s32 unidev(void){ return *(u16 *)K + *(u8 *)K; }` — no qualifier — compiles to
  //     `dfd1972548b6b208`, 32 bytes, byte-identical to `target.o`, while asmlift's winner reads
  //     the BYTE first (`ff74d3d9c04eff77`). IDO emits the second operand's load first (`lbu`
  //     then `lhu` for a `u16 + u8` source), so a reader taking def order for source order gets
  //     this pair backwards. A `volatile` respell would not move this cell.
  {
    sym: 'unidev',
    src: 'u32 unidev(void){ return *(volatile u16*)0x4000004 + *(volatile u8*)0x4000004; }',
    features: ['device-access', 'mixed-width'],
    toolchains: ALL,
  },

  // ── loops ──────────────────────────────────────────────────────────────────────────────
  {
    sym: 'sumto',
    src: 'int sumto(int n){ int s=0,i; for(i=0;i<n;i++)s+=i; return s; }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'countdown',
    src: 'int countdown(int n){ int c=0; while(n>0){c++;n--;} return c; }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'arraysum',
    src: 'int arraysum(int *a,int n){ int s=0,i; for(i=0;i<n;i++)s+=a[i]; return s; }',
    features: ['memory', 'array'],
    toolchains: ALL,
  },
  {
    sym: 'strlen1',
    src: 'int strlen1(char *s){ int n=0; while(*s){n++;s++;} return n; }',
    features: ['memory', 'pointer'],
    toolchains: ALL,
  },
  {
    sym: 'memset1',
    src: 'void memset1(u8 *p,int n,u8 v){ int i; for(i=0;i<n;i++)p[i]=v; }',
    features: ['memory', 'store'],
    toolchains: ALL,
    ctx: 'void memset1(u8*,int,u8);',
    proto: { memset1: { returnsVoid: true } },
  },
  {
    sym: 'findfirst',
    src: 'int findfirst(int *a,int n,int t){ int i; for(i=0;i<n;i++) if(a[i]==t) return i; return -1; }',
    features: ['branch', 'memory'],
    toolchains: ALL,
  },

  // ── calls ───────────────────────────────────────────────────────────────────────────────
  {
    sym: 'call1',
    src: 'int helper(int);\nint call1(int x){ return helper(x)+1; }',
    features: [],
    toolchains: CALL,
    ctx: 'int helper(int);',
    proto: { helper: { params: 1 } },
  },
  {
    sym: 'call2',
    src: 'int add3(int,int,int);\nint call2(int a,int b){ return add3(a,b,a+b); }',
    features: ['multi-arg'],
    toolchains: CALL,
    ctx: 'int add3(int,int,int);',
    proto: { add3: { params: 3 } },
  },
  {
    sym: 'voidcall',
    src: 'void sink(int);\nvoid voidcall(int x){ sink(x); }',
    features: [],
    toolchains: CALL,
    ctx: 'void sink(int); void voidcall(int);',
    proto: { sink: { params: 1, returnsVoid: true }, voidcall: { returnsVoid: true } },
  },
  // CodeWarrior's OUT-OF-LINE REGISTER SAVE beside real calls: five parameters live across the
  // calls take r27..r31, which mwcc 2.4.2 saves with `addi r11,r1,N; bl _savegpr_27` and restores
  // with `_restgpr_27` (the `savegpr-helper` tag). `dotprod` carries the same idiom, but its
  // unrolled loop is a gap of its own, so this is the row on which the save itself can MATCH.
  // mwcc_242_81 only: the routine is CodeWarrior's runtime, so on the other three lanes the row would
  // be one more call chain. The other two CodeWarrior builds are pinned by
  // packages/cli/test/matching/ppc-save-routines.test.ts.
  {
    sym: 'savechain',
    src: 'int k(int);\nint savechain(int a,int b,int c,int d,int e,int f){ return k(k(k(k(k(a)+b)+c)+d)+e)+f; }',
    features: [],
    toolchains: ['mwcc_242_81'],
    ctx: 'int k(int);',
    proto: { k: { params: 1 } },
  },

  // AN ARGUMENT PASSED ON UNCHANGED TO AN UNDECLARED CALLEE, with another set up past it. Nothing
  // states the callee's arity, so it is guessed from the argument registers a value reaches, and a
  // register this function never wrote may still hold its own incoming argument: `s` stays in the
  // first argument register while `1` goes into the second, and a count that stops at the first
  // lifts `logv() + 1`. The gap is DECIDED where the register above it surely is an argument
  // (frontend/call-plan.ts `decideGap`): the call's own block set it to a value nothing else reads,
  // that no base writeback left and, off ido7.1, that no memory read produced. Where argument words
  // fill in order, the gap below it is then the function's own arguments passed on. On ido7.1 a gap
  // at a0 also needs the call's result read, as `+ 1` reads it here (`passsr`). On O32 the own
  // declaration (`ctx`) must put an integer word in the gap register, since a leading float leaves
  // a0 empty, and on O32 and PowerPC the second word of an 8-byte argument that could skip the gap
  // must hold nothing — `passmid`'s a3/r6 is no parameter of `(int, int)`. On PowerPC the own
  // declaration must also show no floating parameter, since a float passed on in f1 is invisible.
  // Every register the count takes past the decided one needs the same proof, and the call must
  // show nothing past its count: no own parameter, no outgoing stack word (`decidedCallRefusal`).
  // `ctx` declares neither callee, so neither decompiler is told the arity. A run of pass-through
  // arguments with nothing set up past it (`g2(a, b)`) is the same
  // machine code as `g2()`, so no row expects a decline for it.
  ...(
    [
      [[...ALL, 'gcc2.7.2'], undefined],
      [
        ['mwcc_233_163n', 'mwcc_247_107'],
        ['-proc', 'gekko', '-O4,p', '-fp', 'hard'],
      ],
    ] as const
  ).flatMap(([toolchains, cflags]): SynthSpec[] => [
    {
      sym: 'passgap',
      src: 'int logv();\nint passgap(const char *s){ return logv(s, 1) + 1; }',
      features: [],
      toolchains: [...toolchains],
      ...(cflags === undefined ? {} : { cflags: [...cflags] }),
      ctx: 'int passgap(const char *);',
    },
    {
      sym: 'passmid',
      src: 'int g3();\nint passmid(int a, int b){ return g3(1, b, 3) + 1; }',
      features: [],
      toolchains: [...toolchains],
      ...(cflags === undefined ? {} : { cflags: [...cflags] }),
      ctx: 'int passmid(int, int);',
    },
    // A CONSTANT SOMETHING ELSE READS decides nothing: agbcc keeps the `1` it stores to `gx` in r1,
    // so this is one object with `gx = 1; return logv(s) + 1;`, and its cell is a declined
    // witness. Every other compiler sets the argument register apart from the store, so the gap is
    // decided there.
    {
      sym: 'passst',
      src: 'int logv();\nint gx;\nint passst(const char *s){ gx = 1; return logv(s, 1) + 1; }',
      features: ['store'],
      toolchains: [...toolchains],
      ...(cflags === undefined ? {} : { cflags: [...cflags] }),
      ctx: 'extern int gx;\nint passst(const char *);',
    },
  ]),
  // A VALUE A MEMORY READ LEFT IN THE REGISTER ABOVE decides nothing: agbcc puts a discarded
  // volatile read in the lowest free argument register (`ldr r1,[r1]; bl g`), the `passgap` shape,
  // while the source passes `s` alone. agbcc's alone, a declined witness: on its own, this read goes
  // to $zero, v0 or r0 elsewhere.
  {
    sym: 'passvol',
    src: 'int g();\nint passvol(int s){ *(volatile int *)0x4000000; return g(s) + 1; }',
    features: [],
    toolchains: ['agbcc'],
    ctx: 'int passvol(int);',
  },
  // …AND THE SAME HOLDS OFF agbcc BUT ON ido7.1. gcc2.7.2kmc and gcc2.7.2 discard into v0/v1 and
  // the three mwcc builds into r0 only while those are free; once they are busy, the read goes to
  // a1/r4. `int a = ga * 3; *(volatile int *)&gx; *(volatile int *)&gx; ga = a + 1; return logv(s)
  // + 1;` is `lw a1,0(v0); ... jal logv` on KMC and `lwz r4,gx` on mwcc, the bytes of the twin that
  // passes the read (target.ts `discardedReadMayFillArgRegister`). So `logv(s, gx)` is undecidable
  // there, and those cells are declined witnesses. ido7.1 discards into $zero every time, so there a
  // load only the call reads is an argument, and its cell is MATCH. Not on agbcc, where `logv(s, gx)`
  // is the object `passvol`'s shape compiles to, `ldr r1,[r1]` either way.
  ...(
    [
      [['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'], undefined],
      [
        ['mwcc_233_163n', 'mwcc_247_107'],
        ['-proc', 'gekko', '-O4,p', '-fp', 'hard'],
      ],
    ] as const
  ).map(([toolchains, cflags]): SynthSpec => ({
    sym: 'passld',
    src: 'int logv();\nint gx;\nint passld(const char *s){ return logv(s, gx) + 1; }',
    features: ['global'],
    toolchains: [...toolchains],
    ...(cflags === undefined ? {} : { cflags: [...cflags] }),
    ctx: 'extern int gx;\nint passld(const char *);',
  })),
  // A BASE WRITEBACK LEFT IN THE REGISTER ABOVE decides nothing: agbcc copies a struct of 3+ words
  // as `ldmia r3!, {r4, r5, r6}; stmia r2!, {r4, r5, r6}` and leaves both advanced bases dead in
  // r2/r3, so with `s` and `n` passed on in r0/r1 the call looks like it takes `p + 3` and `q + 3`
  // too. Read as arguments they would lift `logv(a0, a1, a2 + 3, a3 + 3)`, which agbcc recompiles
  // to separate `add`s. A writeback is no evidence that anything wanted the value
  // (frontend/ssa.ts `noteIncidentalWrite`), so the cell is a declined witness. agbcc's alone: the
  // other compilers copy with plain loads and stores, or in a loop outside the call's block.
  {
    sym: 'passwb',
    src:
      'struct T { int x, y, z; };\nint logv();\n' +
      'int passwb(const char *s, int n, struct T *p, struct T *q){ *p = *q; return logv(s, n) + 1; }',
    features: ['struct-copy', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'struct T { int x, y, z; };\nint passwb(const char *, int, struct T *, struct T *);',
  },
  // IDO HANDS A CALLER'S OWN DESTINATION ON AS THE CALLEE'S HIDDEN STRUCT-RETURN POINTER, leaving a0
  // untouched under the set a1: `*p = sg(1)` is `jal sg; li a1,1`, the bytes of `sg(p, 1)` with its
  // result unused (target.ts `forwardsStructReturnDestination`). So a gap at a0 is decided only where
  // something other than a `ret` reads the call's result, and this cell is a declined witness. The
  // other compilers copy through a frame temporary and leave no gap, so the row is ido7.1's alone.
  {
    sym: 'passsr',
    src: 'struct S { int a, b, c; };\nstruct S sg();\nint passsr(struct S *p){ *p = sg(1); return 0; }',
    features: ['struct-return'],
    toolchains: ['ido7.1'],
    ctx: 'struct S { int a, b, c; };\nint passsr(struct S *);',
  },
  // THE HOLE AN 8-BYTE ARGUMENT SKIPS: `g(1, 3LL)` and `g(1, b, 0, 3)` are one object on O32 and
  // PowerPC (a1/r4 untouched under the set a2:a3/r5:r6 pair), so the gap is not decidable and these
  // cells are declined witnesses. Not on agbcc, which fills r1:r2 in order, nor ido7.1, whose home
  // store of the unused `b` sets a1 up, so neither leaves a gap.
  ...(
    [
      [['gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'], undefined],
      [
        ['mwcc_233_163n', 'mwcc_247_107'],
        ['-proc', 'gekko', '-O4,p', '-fp', 'hard'],
      ],
    ] as const
  ).map(([toolchains, cflags]): SynthSpec => ({
    sym: 'passll',
    src: 'int g();\nint passll(int a, int b){ return g(1, 3LL) + 1; }',
    features: [],
    toolchains: [...toolchains],
    ...(cflags === undefined ? {} : { cflags: [...cflags] }),
    ctx: 'int passll(int, int);',
  })),
  // …AND THE SAME PASS-THROUGH TO A CALLEE THAT IS DECLARED, where the declaration states no
  // layout for all of its arguments and a guess stands in for the rest. There a TRAILING argument
  // passed on unchanged leaves no gap: `logv(s + 1, c)` sets the first argument register and leaves
  // `c` in the second, the bytes of `logv(s + 1)`. A variadic declaration whose fixed parameters are
  // each one word states its first argument words exactly, so they are read as stated and only what
  // the `...` takes is guessed, above them (frontend/call-plan.ts `variadicFloor`): `passvar` lifts
  // `logv(a0 + 1, a1)`, and `passfmt`, the `DebugPrintf(fmt, …)` shape, keeps the format it passes
  // through below a set-up argument where a guess from the first register refuses the gap. mwcc's
  // variadic call clears a condition-register bit (`crclr`), which the PowerPC frontend does not
  // model, so those cells decline. agbcc lays out a `double` in general
  // words and a `float` not at all, so `g(int, float)` refuses there (`refuseUnplacedFloat`); a
  // target with an FPU refuses it already, so that row is agbcc's alone, a declined witness.
  {
    sym: 'passfmt',
    src: 'int dprint(const char *, ...);\nint passfmt(const char *s){ return dprint(s, 1) + 1; }',
    features: [],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 'int dprint(const char *, ...);\nint passfmt(const char *);',
    proto: { dprint: { returns: 'int', variadicParams: ['const char *'] } },
  },
  {
    sym: 'passvar',
    src: 'int logv(const char *, int, ...);\nint passvar(const char *s, int c){ return logv(s + 1, c); }',
    features: [],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 'int logv(const char *, int, ...);\nint passvar(const char *, int);',
    proto: { logv: { returns: 'int', variadicParams: ['const char *', 'int'] } },
  },
  // …AND PAST THAT FLOOR, A REGISTER THE FUNCTION ONLY READ. A read of its own incoming argument (a
  // compare, IDO's home store of an unused parameter) leaves the entry value behind as a definition,
  // so a guess would count it as set up and hand the callee an argument the source never passed:
  // `passread` lifted `dprint(a0, a1)`, and on IDO `passhome` lifted `logv(a0, a1, a2)`. Whether
  // the call is handed it is the gap's own undecidable question, so both refuse there
  // (frontend/ssa.ts `fallbackArgc`). `passhome` leaves its unused `x` untouched on the other
  // compilers, where `logv(a0, a1)` is the bytes it compiles to.
  {
    sym: 'passread',
    src: 'int dprint(const char *, ...);\nint passread(const char *s, int x){ if (x) return dprint(s) + 1; return 0; }',
    features: [],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 'int dprint(const char *, ...);\nint passread(const char *, int);',
    proto: { dprint: { returns: 'int', variadicParams: ['const char *'] } },
  },
  {
    sym: 'passhome',
    src: 'int logv(const char *, int, ...);\nint passhome(const char *s, int c, int x){ return logv(s, c) + 1; }',
    features: [],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 'int logv(const char *, int, ...);\nint passhome(const char *, int, int);',
    proto: { logv: { returns: 'int', variadicParams: ['const char *', 'int'] } },
  },
  {
    sym: 'passflt',
    src: 'int g(int, float);\nint passflt(int a, float b){ return g(a + 1, b); }',
    features: [],
    toolchains: ['agbcc'],
    ctx: 'int g(int, float);\nint passflt(int, float);',
    proto: { g: { params: ['int', 'float'], returns: 'int' } },
  },

  // ── nested control flow ─────────────────────────────────────────────────────────────────
  {
    sym: 'nestedif',
    src: 'int nestedif(int a,int b){ if(a>0){ if(b>0) return a+b; return a; } return 0; }',
    features: ['branch'],
    toolchains: ALL,
  },
  {
    sym: 'loopif',
    src: 'int loopif(int *a,int n){ int s=0,i; for(i=0;i<n;i++){ if(a[i]>0) s+=a[i]; } return s; }',
    features: ['branch', 'memory'],
    toolchains: ALL,
  },

  // ── switch (comparison-tree, sparse, fallthrough, default, and a DENSE jump table) ───────────
  // The small (2–5-case) switches below compile to comparison trees on every toolchain; only a
  // dense contiguous switch (sw_jt) becomes a real jump table. Both regimes are exercised.
  {
    sym: 'sw_ret',
    src: 'int sw_ret(int x){ switch(x){case 0:return 10;case 1:return 20;case 2:return 30;case 3:return 40;default:return -1;} }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'sw_op',
    src: 'int sw_op(int op,int a,int b){ switch(op){case 0:return a+b;case 1:return a-b;case 2:return a*b;case 3:return a&b;default:return 0;} }',
    features: ['arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'sw_fall',
    src: 'int sw_fall(int x){ int r=0; switch(x){case 3:r++;case 2:r++;case 1:r++;} return r; }',
    features: ['fallthrough'],
    toolchains: ALL,
  },
  // Fall-through with nothing crossing the arms: each body reads and writes through the pointer, so
  // no value is handed from one arm to the next and the recovered `switch` needs no variable the
  // dispatch did not already give it. `sw_fall` above is the harder half of the pair — there the
  // accumulator crosses every arm as a block parameter, which the dispatch edges also write.
  {
    sym: 'sw_fallmem',
    src: 'void sw_fallmem(int x,int *p){ switch(x){case 3:*p=1;case 2:*p+=2;case 1:*p+=3;} }',
    features: ['fallthrough'],
    toolchains: ALL,
    ctx: 'void sw_fallmem(int,int*);',
    proto: { sw_fallmem: { returnsVoid: true } },
  },
  // The dispatch does NOT own its return: a guard jumps onto the same `return r;` from outside the
  // switch. Locally that merge is indistinguishable from `sw_fall`'s — one arm falls into the next
  // and the fallen-into arm has two predecessors — and the right answer is the opposite one. Here
  // the tails must be SUNK: kept, the merge stands, comparison-tree recovery declines on it, and
  // if-recovery duplicates the tails anyway. The row pins `retsink`'s `ownedBy` clause: agbcc
  // MATCHes, and scores 6 with the clause dropped.
  {
    sym: 'sw_fallguard',
    src: 'int sw_fallguard(int x,int y){ int r=y; if(y>0) goto done; switch(x){case 3:r=1;case 2:r++;case 1:r++;} done: return r; }',
    features: ['fallthrough'],
    toolchains: ALL,
  },
  // `sw_fall` with ONE MORE CASE, and the same bare `return r;` tail. Three cases is where
  // refusing to sink is right (that is `sw_fall`); at four, sinking is the better spelling and no
  // local predicate knows it. Both spellings recover the `switch`, so the DIFFER referees — and it
  // does: the row MATCHes, but only on the `/merge-home` variation, never on the default spelling. That
  // dependence is the fragility the fall-in subtraction carries, and why this row is in the
  // corpus.
  {
    sym: 'sw_fall4',
    src: 'int sw_fall4(int x){ int r=0; switch(x){case 4:r++;case 3:r++;case 2:r++;case 1:r++;} return r; }',
    features: ['fallthrough'],
    toolchains: ALL,
  },
  // Two chains: `case 0` runs on into `case 1`, which closes, and `case 2` runs on into `default:`.
  // So where the default's label goes is decided by the fall-through rather than by where its body
  // is laid out, and one of the two `break`s a four-arm switch could carry is genuinely absent.
  {
    sym: 'sw_falldef',
    src: 'void sw_falldef(int x,int *p){ switch(x){case 0:*p=1;case 1:*p+=2;break;case 2:*p+=3;default:*p+=4;} }',
    features: ['fallthrough'],
    toolchains: ALL,
    ctx: 'void sw_falldef(int,int*);',
    proto: { sw_falldef: { returnsVoid: true } },
  },
  // The mirror: four arms, of which only the middle pair is a chain, so a closed arm sits on either
  // side of it.
  {
    sym: 'sw_fallmid',
    src: 'void sw_fallmid(int x,int *p){ switch(x){case 0:*p=1;break;case 1:*p+=2;case 2:*p+=3;break;case 3:*p=7;} }',
    features: ['fallthrough'],
    toolchains: ALL,
    ctx: 'void sw_fallmid(int,int*);',
    proto: { sw_fallmid: { returnsVoid: true } },
  },
  // A `default:` written BETWEEN two closed arms while a chain runs beside it. Where the label goes
  // is a POSITION: the two arms it sits between are closed, so it diverts nothing — the chain two
  // arms further down says nothing about it. Reading the evidence per position rather than per
  // switch is what this row prices (spelled with the label last it is a nonmatch on agbcc).
  {
    sym: 'sw_defmid',
    src: 'void sw_defmid(int x,int *p){ switch(x){case 0:*p=1;break;default:*p=9;break;case 1:*p+=2;case 2:*p+=3;break;} }',
    features: ['fallthrough'],
    toolchains: ALL,
    ctx: 'void sw_defmid(int,int*);',
    proto: { sw_defmid: { returnsVoid: true } },
  },
  // The DENSE half of the fall-through family: eight contiguous cases compile to a real jump table,
  // so these two exercise the switch_br regime rather than the comparison tree. `sw_jtfall`'s chain
  // runs WITH the table's ascending order; `sw_jtfalldesc`'s runs against it — case 3 falls into
  // case 2 — so the emitted arm order has to be re-threaded rather than read off either the table
  // or ascending case value.
  {
    sym: 'sw_jtfall',
    src: 'void sw_jtfall(int x,int *p){ switch(x){case 0:*p=1;break;case 1:*p=2;break;case 2:*p+=3;case 3:*p+=4;break;case 4:*p=5;break;case 5:*p=6;break;case 6:*p=7;break;case 7:*p=8;break;} }',
    features: ['fallthrough', 'dense'],
    toolchains: ALL,
    ctx: 'void sw_jtfall(int,int*);',
    proto: { sw_jtfall: { returnsVoid: true } },
  },
  {
    sym: 'sw_jtfalldesc',
    src: 'void sw_jtfalldesc(int x,int *p){ switch(x){case 0:*p=1;break;case 1:*p=2;break;case 3:*p+=4;case 2:*p+=3;break;case 4:*p=5;break;case 5:*p=6;break;case 6:*p=7;break;case 7:*p=8;break;} }',
    features: ['fallthrough', 'dense'],
    toolchains: ALL,
    ctx: 'void sw_jtfalldesc(int,int*);',
    proto: { sw_jtfalldesc: { returnsVoid: true } },
  },
  // …AND ONE WHOSE `bgtlr` DEFAULT RETURNS AN ARGUMENT IT NEVER TOUCHES. mwcc bounds the table with a
  // conditional return when the out-of-range path returns `a`, which arrived in r3: that path neither
  // reads nor writes r3, so the return block has no definition of it, and the lift must still return
  // the first argument there (frontend/ppc.ts `returnUntouchedArg`) — a bare `return;` in an `int`
  // function recompiles to the same bytes on mwcc and loses `a`.
  {
    sym: 'sw_jtretarg',
    src: 'int sw_jtretarg(int a,unsigned x,int *p){ switch(x){case 0:p[0]=1;return 3;case 1:p[1]=5;return 4;case 2:p[2]=6;return 7;case 3:p[3]=7;return 1;case 4:p[4]=3;return 9;case 5:p[5]=2;return 2;case 6:p[6]=9;return 0;case 7:p[7]=4;return 8;} return a; }',
    features: ['dense'],
    toolchains: ALL,
    ctx: 'int sw_jtretarg(int,unsigned,int*);',
  },
  {
    sym: 'sw_sparse',
    src: 'int sw_sparse(int x){ switch(x){case 1:return 1;case 10:return 2;case 100:return 3;case 1000:return 4;default:return 0;} }',
    features: ['sparse'],
    toolchains: ALL,
  },
  {
    sym: 'sw_void',
    src: 'void sw_void(int x,int *p){ switch(x){case 0:*p=1;break;case 1:*p=2;break;default:*p=0;} }',
    features: ['store'],
    toolchains: ALL,
    ctx: 'void sw_void(int,int*);',
    proto: { sw_void: { returnsVoid: true } },
  },
  // Dense 8-case switch → a jump table on every toolchain (agbcc `mov pc` inline table; IDO/KMC
  // `jr` + `.rodata`; mwcc `bctr` + `.data`); MIPS/PPC recovery needs the AsmData side-table.
  {
    sym: 'sw_jt',
    src: 'int sw_jt(int x){ switch(x){case 0:return 3;case 1:return 5;case 2:return 7;case 3:return 9;case 4:return 11;case 5:return 13;case 6:return 15;case 7:return 17;default:return -1;} }',
    features: ['dense'],
    toolchains: ALL,
  },
  // A DENSE TABLE ONE OF WHOSE ARMS RETURNS. `case 1` can leave without reaching the tail, so EXIT
  // is the only block on every path out of the dispatch and post-dominance gives it no join. With
  // no merge the default edge's target joins the arms' sibling set and every plain `break` reads as
  // a fall-through into it, which does not linearize — the whole function declined, naming a
  // fall-through the source does not contain. `sa3:Sio32MultiLoadMain` is the real inhabitant.
  //
  // THE ROW REFEREES, which is the thing that has to be shown before writing one: the wrong answer
  // here is the tail duplicated into each arm (`case 0: *p=1; return 1;` …), and at this row's own
  // flags agbcc compiles the two spellings to DIFFERENT instructions — different register
  // allocation at entry and an extra instruction at the fall-out — so the differ can tell them
  // apart. The right spelling keeps `*p=r; return r;` once, after the switch.
  {
    sym: 'sw_jtret',
    src: 'int sw_jtret(int x,int *p){ int r=0; switch(x){case 0:r=1;break;case 1:if(*p)return -1;r=2;break;case 2:r=3;break;case 3:r=4;break;case 4:r=5;break;case 5:r=6;break;case 6:r=7;break;case 7:r=8;break;} *p=r; return r; }',
    features: ['dense', 'switch-arms'],
    toolchains: ALL,
    ctx: 'int sw_jtret(int,int*);',
  },
  // …AND ONE WHOSE RETURNING ARM REACHES NO TAIL AT ALL. `case 2` returns unconditionally, so no
  // other successor reaches its `ret` and the every-successor reading that ends `sw_jtret`'s switch
  // has nothing to intersect: the default block joins the siblings and the seven `break`s all read
  // as falling into it. The structurer's default-anchored retry ends the switch where the other arms
  // meet, the source's `return 0;`. The arms write distinct slots, so no compiler sinks them into
  // one shared store. `pokeemerald:SaveOnMysteryGiftMenu:agbcc` is the real inhabitant; this row
  // keeps the step from being proven on Thumb alone. On KMC and gcc 2.7.2 that holds only with
  // `return 0;` directly after the switch: given a tail statement (`p[8]=1;`) they cross-jump a
  // `break` arm's delay-slot `li v0,1` into the middle of it, which declines — the cross-jumped-tail
  // family, a different capability.
  {
    sym: 'sw_jtisoret',
    src: 'int sw_jtisoret(int x,int *p){ switch(x){case 0:p[0]=1;break;case 1:p[1]+=2;break;case 2:p[2]=0;return 1;case 3:p[3]-=4;break;case 4:p[4]=5;break;case 5:p[5]^=6;break;case 6:p[6]=7;break;case 7:p[7]|=8;break;} return 0; }',
    features: ['dense', 'switch-arms'],
    toolchains: ALL,
    ctx: 'int sw_jtisoret(int,int*);',
  },
  // A DENSE TABLE WHOSE BOUNDS PAIR HAS AN INSTRUCTION SCHEDULED INTO IT. Every arm calls, so the
  // function saves LR, and mwcc 2.4.2 puts that store between the bound and its branch:
  // `cmplwi r3,7 ; stw r0,20(r1) ; bgt-`. The PowerPC recognizer finds the compare past it — past
  // anything that writes neither a CR field nor the scrutinee (frontend/ppc.ts `boundsCompare`).
  {
    sym: 'sw_jtsched',
    src: 'int jg(int);\nvoid jh(int);\nint sw_jtsched(int x,int *p){ switch(x){case 0:jh(1);break;case 1:jh(2);break;case 2:return jg(p[0]);case 3:jh(4);break;case 4:jh(5);break;case 5:jh(6);break;case 6:jh(7);break;case 7:jh(9);break;} return -1; }',
    features: ['dense'],
    toolchains: ALL,
    ctx: 'int jg(int); void jh(int); int sw_jtsched(int,int*);',
    proto: { jg: { params: 1 }, jh: { params: 1, returnsVoid: true } },
  },
  // A DENSE TABLE INSIDE A LOOP, whose base KMC forms ONCE, in the loop's preheader
  // (`lui t6,%hi ; addiu t6,t6,%lo`), and adds to the scaled index inside the loop — so the
  // dispatch's own block holds no `lui`. The lift decodes that pair into a table base, which nothing
  // may read as a value, and proves it reaches the dispatch on every path (frontend/jump-table.ts).
  // mwcc 2.4.2 forms the base inside the loop; mwcc 2.3.3, which hoists it too, has no synthetic
  // tier, and packages/cli/test/matching/jump-table-window.test.ts pins it there.
  {
    sym: 'sw_jtloop',
    src: 'void sw_jtloop(int n,int *p){ int i; for(i=0;i<n;i++){ switch(p[i]){case 0:p[i]=1;break;case 1:p[i]=5;break;case 2:p[i]=6;break;case 3:p[i]=7;break;case 4:p[i]=3;break;case 5:p[i]=2;break;case 6:p[i]=9;break;case 7:p[i]=4;break;} } }',
    features: ['dense'],
    toolchains: ALL,
    ctx: 'void sw_jtloop(int,int*);',
    proto: { sw_jtloop: { returnsVoid: true } },
  },
  // IDO ROTATES A `while` LOOP AROUND ITS SWITCH, so the bounds `sltiu` is in no block of its own:
  // it sits in the delay slot of the loop-entry `beqz` (run on the fall-through) and in the LIKELY
  // slot of the latch `bnezl` (run on the taken edge alone), and the bounds `beqz` heads the loop.
  // frontend/mips.ts `mipsBounds` reads the bound off every edge into that block. KMC hoists the
  // table base into the preheader here too.
  {
    sym: 'sw_jtwhile',
    src: 'int sw_jtwhile(int *p){ int s=0; while(*p){ switch(*p++){case 0:s+=1;break;case 1:s+=5;break;case 2:s^=6;break;case 3:s+=7;break;case 4:s-=3;break;case 5:s+=2;break;case 6:s|=9;break;case 7:s+=4;break;} } return s; }',
    features: ['dense'],
    toolchains: ALL,
    ctx: 'int sw_jtwhile(int*);',
  },
  // TWO LOOP SWITCHES AND A CALL AFTER THEM. KMC hoists each table base into its loop's preheader,
  // the second at `.rodata+32`, and the call makes the function non-leaf: the lift asks only that
  // each base reach its dispatch on every path (frontend/jump-table.ts), not where the allocator put
  // it. The two tables store different values, so a dispatch read through the other one's base would
  // not recompile.
  {
    sym: 'sw_jtloop2',
    src: 'void jh(int);\nvoid sw_jtloop2(int n,int *p,int *q){ int k=n; do { switch(*p){case 0:*p=11;break;case 1:*p=15;break;case 2:*p=16;break;case 3:*p=17;break;case 4:*p=13;break;case 5:*p=12;break;case 6:*p=19;break;case 7:*p=14;break;} p++; } while(--k); k=n; do { switch(*q){case 0:*q=21;break;case 1:*q=25;break;case 2:*q=26;break;case 3:*q=27;break;case 4:*q=23;break;case 5:*q=22;break;case 6:*q=29;break;case 7:*q=24;break;} q++; } while(--k); jh(n); }',
    features: ['dense'],
    toolchains: ALL,
    ctx: 'void jh(int); void sw_jtloop2(int,int*,int*);',
    proto: { jh: { params: 1, returnsVoid: true }, sw_jtloop2: { returnsVoid: true } },
  },
  // A CALL INSIDE THE LOOP: KMC keeps the hoisted base in a callee-saved register (`lui s5 ; addiu
  // s5,s5`), which its prologue saves and its epilogue restores around the loop.
  {
    sym: 'sw_jtloopcall',
    src: 'void jh(int);\nvoid sw_jtloopcall(int n,int *p){ int i; for(i=0;i<n;i++){ switch(p[i]){case 0:p[i]=11;break;case 1:p[i]=15;break;case 2:p[i]=16;break;case 3:p[i]=17;break;case 4:p[i]=13;break;case 5:p[i]=12;break;case 6:p[i]=19;break;case 7:p[i]=14;break;} jh(i); } }',
    features: ['dense'],
    toolchains: ALL,
    ctx: 'void jh(int); void sw_jtloopcall(int,int*);',
    proto: { jh: { params: 1, returnsVoid: true }, sw_jtloopcall: { returnsVoid: true } },
  },

  // ── merged value chains (several values decided by several arms, joined at one point) ───────
  // What SSA destruction has to get right. Each arm computes the same set of values, so the join
  // takes one block parameter per value and each arm hands them over on its edge — and a parameter
  // and the argument feeding it are one variable only if the structurer gives them one name. It can
  // only ever adopt ONE arm's names; every other arm's values reach the join under names of their
  // own, and each pays a copy. The C the source wrote has none of them, and neither does the
  // compiled code, which allocates all the arms into the same registers.
  //
  // Three values per arm, not one: a single value is coalesced by walking backward along its own
  // edge, which the naming pipeline already did. It takes a chain — a value whose own definition is
  // ANOTHER join, in an arm named after the one the outer join adopted — to leave a copy behind.
  // Loads through a pointer parameter give that shape with no global at all.
  //
  // mergeif is not mergechain at a smaller size: each arm decides only ONE of the two locals, so
  // the other is live ACROSS the arm that does not write it — the shape the interference rule has
  // to see, rather than two arms that both decide everything.
  //
  // mergeloop is the same shape with the join inside a loop, and coalescing is INERT on it: the
  // naming pipeline already shares every name the arms feed, so no pair is even proposed. That is
  // worth a row precisely because it is the negative — the shape reaches a loop and the pass has
  // nothing to do there, which is not the same claim as a rule refusing it. What `loop-escape`
  // actually costs is visible on `nestedloop`, which this family does not inhabit.
  //
  // WHAT THESE DO NOT COVER, so nobody later reads twelve rows as twelve tests: `mergeloop:ido7.1`
  // declines in the FRONTEND for a reason with nothing to do with merges (a branch to a
  // non-block-boundary), and `mergechain:mwcc_242_81` lifts to a nonmatch that no path of the merge
  // pass is credited with. Three more exist to be refused. Four rows reach the accept path.
  {
    sym: 'mergechain',
    src:
      'int mergechain(int s, const int *p) {\n' +
      '  int x, y, z;\n' +
      '  switch (s) {\n' +
      '    case 0: x = p[0] > 31 ? 32 : p[0]; y = p[1] > 31 ? 32 : p[1]; z = p[2] > 31 ? 32 : p[2]; break;\n' +
      '    case 1: x = p[3] > 15 ? 16 : p[3]; y = p[4] > 15 ? 16 : p[4]; z = p[5] > 15 ? 16 : p[5]; break;\n' +
      '    default: x = p[6] > 7 ? 8 : p[6]; y = p[7] > 7 ? 8 : p[7]; z = p[8] > 7 ? 8 : p[8]; break;\n' +
      '  }\n' +
      '  return x * 100 + y * 10 + z;\n' +
      '}',
    features: ['merge-chain'],
    toolchains: ALL,
  },
  {
    sym: 'mergeif',
    src:
      'int mergeif(int s, const int *p) {\n' +
      '  int x, y;\n' +
      '  x = p[0] > 31 ? 32 : p[0];\n' +
      '  y = p[1] > 31 ? 32 : p[1];\n' +
      '  if (s & 1) { y = p[2] < 0 ? 0 : p[2]; }\n' +
      '  else { x = p[3] < 0 ? 0 : p[3]; }\n' +
      '  return x * 10 + y;\n' +
      '}',
    features: ['merge-chain'],
    toolchains: ALL,
  },
  {
    sym: 'mergeloop',
    src:
      'int mergeloop(int n, const int *p) {\n' +
      '  int x = 0, y = 0, i;\n' +
      '  for (i = 0; i < n; i++) {\n' +
      '    if (p[i] & 1) { x = p[i] > 31 ? 32 : p[i]; y = p[i] * 2; }\n' +
      '    else { x = p[i] < 0 ? 0 : p[i]; y = p[i] * 3; }\n' +
      '  }\n' +
      '  return x * 10 + y;\n' +
      '}',
    features: ['merge-chain'],
    toolchains: ALL,
  },

  // ── uninitialised locals (a local read on a path that never assigns it) ─────────────────────
  // The `switch`es above with no `default` — `sw_fall`, `sw_fallmem`, `sw_fall4`, `sw_jtfall` and
  // the rest of that family — each write through a pointer or start from an initialised
  // accumulator, so until these rows the dataset never asked what happens when the unassigned
  // path READS the local. The C compiles, and the compiler emits the unassigned path
  // faithfully, so recovery has to be able to SAY "undefined here" — asmlift's IR has no `undef`,
  // and Braun's construction resolves a def-less read to a live-in, which at the entry block is a
  // PARAMETER. WHERE the local lands decides which way that goes, and the two differ sharply:
  //   • a stack slot ⇒ loud. Two guards split it — stored on SOME path (frontend/ssa.ts `finish`)
  //     vs stored on NO path reaching the read (frontend/mips.ts `emitLoad`), each outside the
  //     frame words a function provably owns (below).
  //   • an ARGUMENT register ⇒ silent: nothing guards it and the read becomes a fabricated extra
  //     parameter. MEASURED: both agbcc rows byte-MATCH anyway, because the invented parameter
  //     lands in the register the local was allocated to — `uninit_sw(s32 a0, s32 a1, s32 a2)` for
  //     a two-argument function, and `uninit_join(s32 a0, s32 a1)` for a one-argument one. A
  //     trailing parameter nothing reads costs nothing on this ABI. That is a fidelity gap the byte
  //     score cannot see, and the reason these rows are worth keeping green: they are the rows
  //     where the remaining half of `undef` must change the C and NOT the bytes. Both locals here
  //     land in r1/r2, so both rows sit on that half.
  //   • a register the ABI does NOT pass arguments in, which the prologue SAVED ⇒ an `undef`
  //     (target.nonArgRegs against thumb.ts's `savedRegs`). A caller cannot hand a value over in
  //     one, and the compiler homes a local there only after saving it, so the fabrication has no
  //     premise and the signature stops growing. That is what closed `loopfall`, below.
  //
  // WHICH of those you get is decided by register pressure, not by the C, and that is what
  // uninit_spill is for. The first two rows are small enough that agbcc keeps the local in a
  // register, so they reach the slot half on ido7.1 ONLY — and the shared postcondition would
  // then have no row reaching it through the THUMB frontend, which is the path the motivating
  // klonoa function (LoadBGTilemapData, a `switch` with no default whose arms are the only
  // writers of three frame slots) actually takes. uninit_spill keeps ten locals live across a
  // loop so agbcc has to spill, which is how the shape reaches the THUMB frontend. Its bulk IS
  // the point:
  // below roughly ten live locals agbcc has the registers to avoid the frame entirely. No calls,
  // deliberately — a store to [sp,#0] that reaches a `bl` is ambiguous with an outgoing stack
  // argument, and the row would decline on THAT instead.
  // Attribution, so nothing here is credited to the wrong gap: of the twelve rows, five turn on
  // this capability — uninit_join:ido7.1, uninit_sw:ido7.1, uninit_sw:agbcc, and both slot halves
  // of uninit_spill (agbcc, ido7.1). Of the other seven, one declines for an unrelated reason —
  // uninit_spill:mwcc_242_81, whose default arm reads the uninitialised local out of r0, which
  // still holds the return address `mflr` put there (`_savegpr_26` writes only the link register),
  // so it declines as a function reading its own return address — three recover without touching this gap
  // (uninit_join:agbcc, uninit_join:mwcc_242_81 and uninit_sw:mwcc_242_81 MATCH; the last is the
  // register half, like uninit_sw:agbcc, reached through CodeWarrior's switch dispatch), and three
  // lift to nonmatches nothing here attributes (uninit_join, uninit_sw and uninit_spill on
  // gcc2.7.2kmc).
  // Of those five, uninit_spill:agbcc is recovered on Thumb, and uninit_sw:agbcc is the register
  // half, which `undef` does not touch.
  // THE O32 HALVES (frontend/mips.ts). The three gcc2.7.2kmc rows are the REGISTER half: KMC homes
  // the local in a scratch register (v0 in uninit_join, v1 in uninit_sw), and with no O32
  // partition each def-less read is a fabricated parameter —
  // `uninit_join(s32 a0, s32 a1)`. MIPS_GCC/MIPS_IDO `scratchRegs` and the prologue's saves make it
  // an `undef`. The ido7.1 rows are the FRAME half: IDO homes the same locals in words of its own
  // frame, and O32 owns `[0, frameSize)` of a leaf's one push (past the outgoing area where it
  // calls) when no frame address is taken (`ownedFrame`), so a def-less read there is an `undef`
  // whether or not anything stores the word — uninit_spill:ido7.1 reads 36(sp) and 0(sp), which
  // nothing does. uninit_spill and uninitfirst on gcc2.7.2kmc keep a2 (and a3) as parameters: KMC
  // homes a local in an argument register past the declared arity, which only the function's own
  // declaration tells from an argument, and these rows state none: `ownar_spill` and `ownar_first`
  // (below `uninitfirst`) are the same functions handed theirs.
  // uninit_join and uninit_sw also run on stock gcc2.7.2 — the tier's first rows on that compiler —
  // because it homes the local exactly where KMC does, so the register half is pinned on both.
  // The first two rows are kept to ≤4 parameters on purpose: at 5+ the O32 reader takes its
  // stack-argument path and would decline for a reason that has nothing to do with initialisation.
  {
    sym: 'uninit_join',
    src: 'int uninit_join(int a){ int r; if(a>0) r=a*2; return r+1; }',
    features: ['uninit-local', 'branch'],
    toolchains: [...ALL, 'gcc2.7.2'],
  },
  {
    sym: 'uninit_sw',
    src: 'int uninit_sw(int k,int a){ int r; switch(k){case 0:r=a;break;case 1:r=a*2;break;case 2:r=a*3;break;case 3:r=a*4;break;} return r+1; }',
    features: ['uninit-local'],
    toolchains: [...ALL, 'gcc2.7.2'],
  },
  {
    sym: 'uninit_spill',
    src:
      'int uninit_spill(int k,int *p){ int v0,v1,v2,v3,v4,v5,v6,v7,v8,v9; int i,s=0;' +
      ' switch(k){ case 0: v0=p[0];v1=p[1];v2=p[2];v3=p[3];v4=p[4];v5=p[5];v6=p[6];v7=p[7];v8=p[8];v9=p[9]; break;' +
      ' case 1: v0=p[10];v1=p[11];v2=p[12];v3=p[13];v4=p[14];v5=p[15];v6=p[16];v7=p[17];v8=p[18];v9=p[19]; break; }' +
      ' for(i=0;i<8;i++) s+=p[i]*v0+v1*v2+v3*v4+v5*v6+v7*v8+v9; return s; }',
    features: ['uninit-local', 'array'],
    toolchains: ALL,
  },
  // The THIRD bullet above on CodeWarrior, outside the twelve: `x` is assigned on one arm only and
  // lives across five calls, so mwcc 2.4.2 homes it in r31, which its `_savegpr_27` prologue saved,
  // and the path that skips the assignment reads what the caller left there. Without the
  // prologue's save set as the PPC frontend's live-in model, that read is a seventh PARAMETER for a
  // six-parameter source (`if (a0 != 0) a6 = k(a1);`, a nonmatch); with it, the row MATCHes with
  // `s32 v0;` declared and never initialised. agbcc is left out: it already lifts the shape as
  // `s32 v0;` through Thumb's own live-in model (the rule that closed `loopfall`, below). On MIPS
  // the row pins BOTH O32 homes of the same local: gcc 2.7.2 (KMC and stock) keeps `x` in the
  // callee-saved s2 its prologue stored — the register half, a phantom seventh parameter without a
  // MIPS live-in model — and ido7.1 keeps it in a frame word (sp@28) read after the calls, above
  // the 16-byte outgoing area — the frame half. The other two CodeWarrior builds are pinned by
  // packages/cli/test/matching/ppc-save-routines.test.ts.
  {
    sym: 'uninit_saved',
    src: 'int k(int);\nint uninit_saved(int s,int a,int b,int c,int d,int e){ int x; if (s) x = k(a); return k(k(k(k(b)+c)+d)+e) + x; }',
    features: ['uninit-local', 'branch'],
    toolchains: ['mwcc_242_81', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'int k(int);',
    proto: { k: { params: 1 } },
  },
  // A JOIN NO PATH DEFINES: `x = y` with both uninitialised joins two undefined values, and the
  // structurer drops an undefined edge copy, so left alone it would keep x's local and drop all its
  // assignments (frontend/ssa.ts `markCopiedUndefs`, `collapseUndefinedJoins`). ido7.1 keeps x and y in frame
  // words (sp@4, sp@0); two words are two locals, so the copy is spelled `x = uninit_sp0` and the
  // row MATCHes. On both gcc 2.7.2 lanes they sit in v0 and v1, scratch registers hand-written asm
  // passes inputs in (`hiddenInputRegs`), and with no definition meeting either entry value the
  // lift declines rather than guess which. agbcc keeps them in saved registers across two calls,
  // where a register move is no evidence of a second local, so the join collapses into one
  // uninitialised value and the move is lost (a nonmatch).
  {
    sym: 'uninit_both',
    src: 'int uninit_both(int c){ int x; int y; if (c) x = y; return x + c; }',
    features: ['uninit-local', 'branch'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
  },
  // A REGISTER CACHING TWO UNINITIALISED FRAME WORDS. ido7.1 -O2 gives x and y their words and
  // loads them into v1 and a0 on each arm (`lw a0,0(sp); move v1,a0` against `lw v1,4(sp);
  // move a0,v1`), so the joins are register-keyed over two frame words' undefined values. Read as
  // one undefined value per register, x - y is two unrelated locals; read as a copy on each arm,
  // both arms leave them equal, as the machine does. Only ido homes these locals in frame words.
  {
    sym: 'uninit_swap',
    src: 'int uninit_swap(int c){ int x; int y; if (c) x = y; else y = x; return x - y; }',
    features: ['uninit-local', 'branch'],
    toolchains: ['ido7.1'],
  },
  {
    sym: 'uninit_both_saved',
    src:
      'void f(int,int,int,int);\nint uninit_both_saved(int c,int a,int b,int d){ int x; int y; if (c) x = y;' +
      ' f(a, b, d, c); f(d, a, b, c); return x + c + a + b + d; }',
    features: ['uninit-local', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void f(int,int,int,int);',
    proto: { f: { params: 4, returnsVoid: true } },
  },
  // A LOCAL A LOOP TRANSFORMS after assigning it on one arm — the Yaz0/MIO0 bit reader: `code` is
  // loaded only when `bits` runs out, then shifted every trip. gcc 2.7.2 (KMC and stock) keeps it in
  // t0, a scratch register hand-written asm also passes inputs in (`hiddenInputRegs`), so its entry
  // value must meet a definition it does not feed at the loop header's join. The shift reaches the
  // entry value only through the inner join the load also feeds, which makes it one; a test that
  // walks through every join argument refuses the row, and without the O32 live-in model t0 is a
  // phantom fifth parameter. ido7.1 keeps it in a frame word, and mwcc 2.4.2 in a register its
  // own way: the capability is the shared hidden-input rule, so both run too.
  {
    sym: 'uninit_bits',
    src:
      'int uninit_bits(unsigned char *src,unsigned char *dst,int n,int fill){ unsigned int code; int bits=0;' +
      ' while(n>0){ if(bits==0){ code=*src++; bits=8; } if(code&0x80) *dst++=*src++; else *dst++=fill;' +
      ' code<<=1; bits--; n--; } return bits; }',
    features: ['uninit-local', 'branch'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
  },
  // The SCRATCH half of the same rule on CodeWarrior: a LEAF needs no saved register, so mwcc 2.4.2
  // homes its uninitialised local in a volatile register no argument travels in, with no save
  // (PPC_MWCC.scratchRegs). `uninit_r0` puts `x` in r0 (`mulli r0,r4,3; add r3,r0,r4`); in
  // `uninit_r12`, all eight argument registers are live, so `x` and `y` land in r11 and r12
  // (`mullw r11,r4,r5; mullw r12,r7,r8` on one arm, `subf r4,r12,r11` after the join). Without the
  // target's scratch registers in the PPC live-in model, each def-less read lifts as one more
  // PARAMETER — a third for a two-parameter source, and a ninth and tenth past the eight argument
  // registers. mwcc_242_81 only: the Thumb half of the composed rule is `uninit_sw:agbcc`, and the
  // O32 half is `uninit_join` and `uninit_sw` on both gcc 2.7.2 lanes (v0 and v1, MIPS_GCC
  // `scratchRegs`). mwcc_233_163n is pinned by packages/cli/test/matching/ppc-save-routines.test.ts.
  {
    sym: 'uninit_r0',
    src: 'int uninit_r0(int s,int a){ int x; if (s) x = a*3; return x + a; }',
    features: ['uninit-local', 'branch'],
    toolchains: ['mwcc_242_81'],
  },
  {
    sym: 'uninit_r12',
    src:
      'int uninit_r12(int s,int a,int b,int c,int d,int e,int f,int g){ int x,y; if (s) { x = a*b; y = d*e; }' +
      ' return x - y + (a ^ b ^ c ^ d ^ e ^ f ^ g ^ s); }',
    features: ['uninit-local', 'branch'],
    toolchains: ['mwcc_242_81'],
  },

  // SPILL-SLOT ORDER — the one property of a declaration list the allocator answers by a law, and
  // the one asmlift now places by reading the target's own frame order (l3/slotorder.ts). When
  // agbcc runs out of registers, the locals that lose
  // global allocation each get a frame slot, and WHICH slot is decided by declaration order:
  // reload hands out slots walking pseudos in ascending number (gcc/reload1.c:769-770), a user
  // local's pseudo is numbered at its `expand_decl` (gcc/stmt.c:3323-3324; line numbers are the
  // real toolchain's, not an instrumented copy's), and the frame grows upward
  // (gcc/function.c:703-757; thumb.h:569 has FRAME_GROWS_DOWNWARD commented out). So the k-th
  // spilled local BY DECLARATION sits at the k-th slot, above any volatile/address-taken local
  // (those get their slot at declaration time, gcc/stmt.c:3312, and sit below every spill).
  // Verified by compiling: the body below with its ten locals declared `v0..v9` puts the two that
  // spill at [sp] and [sp,#4] one way, declared `v9..v0` the other way, and nothing else moves.
  //
  // asmlift's declaration list is the naming walk's insertion order (structure/structure.ts), and
  // backend/cfamily.ts renders it verbatim; the Thumb frontend keys every `[sp,#k]` value by its
  // offset (frontend/thumb.ts), but the offset never reaches the structurer, so the emitted order
  // agrees with the target's slot order only by accident. These two rows pin that:
  //
  //   • `spillorder` is `uninit_spill` (above) with ONE token changed, `case 1:` → `default:`, so
  //     every path defines every local — no undef, no fabricated parameter, no DMA, which are the
  //     two machineries `uninit_spill` and `dma_fill_uninit` carry. Two locals spill; asmlift's
  //     walk declared them in the REVERSE of the target's slot order, which cost six
  //     `[sp,#k]` operand rows and nothing else (recompiled and classified: no other class). The
  //     per-target slot ordering `emit` now applies (l3/slotorder.ts) closed that: the row
  //     MATCHes, and is the gate that keeps the ordering right.
  //   • `spillorder_rev` is the CONTROL: the identical body with the declaration list reversed in
  //     the source, so the target's slot order is the one asmlift's walk already emits. It
  //     MATCHES, which proves the six rows are the order alone. It is also the zero-flip read for
  //     the shipped rule: an agreeing order must stay a no-op. Its limit: it detects a sort that
  //     DISAGREES with the target (its target differs from `spillorder`'s in exactly six
  //     `[sp,#k]` lines), but it cannot tell a correct sort from no sort, so it scored 0 before
  //     the rule and scores 0 after it — `spillorder` is the row that moved (6 → MATCH).
  //
  // Attribution: `spillorder` declines nothing — it lifts, structures and ranks 40 candidates —
  // and its 6 was a missing per-target DEFAULT, not a missing variation: no site sorted a candidate's
  // slot-homed locals by the target's frame offsets. `emit` now does (l3/slotorder.ts), and the
  // same rule closed `dma_fill_uninit`'s identical twelve `[sp,#k]` rows (12 → MATCH). On the
  // klonoa function this family was cut from,
  // LoadBGTilemapData, permuting the six spilled locals of the winning candidate in place takes
  // 386 → 376 against `build/src/gfx.o` (of its stack-slot classes, 12 `stack slot` + 17 `register +
  // stack slot` rows, the permutation leaves 2 + 2, a reload eviction; the other 15 mixed rows
  // become register-only rows, 179 → 194, and no register row is fixed). It is the one
  // source-visible property of a declaration list this round found the allocator answering deterministically: count, scope, type and address-taking
  // all move a score too, but through the compiler's own temporaries, whose registers no
  // declaration list predicts (34 reorderings of the project's reference, 0 named locals rehomed).
  // That register half is a published null and gets NO row, because the capability that would
  // move it is the compiler's allocator, which asmlift answers by compiling.
  //
  // WHY a second gate beside `dma_fill_uninit`: that row is confounded — it carries the undef
  // envelope (a `switch` with no `default`) and the DMA family, so a change in either moves its
  // stack-slot rows for a reason that is not this one. This pair carries neither. The pair cannot tell head placement from an in-place
  // permutation of the slot locals (both compile to 0 here; on LoadBGTilemapData they differ by
  // one register row, 375 vs 376); a discriminating row needs a non-slot local between two spilled
  // ones and a spilled compiler temporary — not authored.
  //
  // agbcc only, by measurement: ido7.1 keeps all ten locals in s0–s5 (six `sw`, all prologue
  // saves — nothing spills) and its frontend declines both objects earlier anyway (`branch to
  // 0xbc is not a block boundary`, a MIPS-frontend blocker seven ido rows already carry);
  // gcc2.7.2kmc compiles each to 50 instructions with zero `(sp)` accesses; mwcc_242_81 touches
  // the frame only for the push, the link register and its `_savegpr_26`/`_restgpr_26` pair, so
  // the locals stay in registers and there is no slot to order. On those lanes the rows would pin
  // another family's blocker or nothing, so they are left off. The DIRECTION of the law differs by
  // compiler (a call-carrying probe of 14 locals, 24 on mwcc: ascending on agbcc and both
  // gcc 2.7.2 lanes, DESCENDING on ido7.1 and mwcc_242_81), which is why the capability is a per-target datum and
  // not a boolean — and why no non-agbcc value can be refereed today: the only shape that spills
  // under a 32-GPR compiler carries a call, and the MIPS frontend declines every call.
  // m2c NONCOMPILES both, on the identical `ctx` (it renders `s32 spillorder(s32 k, s32 *p)`, so the
  // prototype reached it): it names each spill slot `unksp0` / `unksp4` and never declares it
  // (``unksp0' undeclared (first use in this function)`), the same slot handling the stack-addr
  // family records — and, interestingly, it reads the two slots in the target's order on both
  // rows (`unksp0` first on `spillorder`, `unksp4` first on `spillorder_rev`), so a version that
  // declared them would face exactly this family's question. It also types `p` as a struct
  // (`var_r1->unk0`) against the `int *p` it was told. `uninit_spill` above is DECLINED by m2c
  // rather than noncompiled (an `M2C_ERROR(/* Read from unset register $r12 */)` marker on the
  // undef path), which is one more way the pair is cleaner than that row.
  {
    sym: 'spillorder',
    src:
      'int spillorder(int k,int *p){ int v0,v1,v2,v3,v4,v5,v6,v7,v8,v9; int i,s=0;' +
      ' switch(k){ case 0: v0=p[0];v1=p[1];v2=p[2];v3=p[3];v4=p[4];v5=p[5];v6=p[6];v7=p[7];v8=p[8];v9=p[9];' +
      ' break; default: v0=p[10];v1=p[11];v2=p[12];v3=p[13];v4=p[14];v5=p[15];v6=p[16];v7=p[17];v8=p[18];' +
      'v9=p[19]; break; } for(i=0;i<8;i++) s+=p[i]*v0+v1*v2+v3*v4+v5*v6+v7*v8+v9; return s; }',
    features: ['value-home', 'array'],
    toolchains: ['agbcc'],
    ctx: 'int spillorder(int k, int *p);',
  },
  {
    sym: 'spillorder_rev',
    src:
      'int spillorder_rev(int k,int *p){ int v9,v8,v7,v6,v5,v4,v3,v2,v1,v0; int i,s=0;' +
      ' switch(k){ case 0: v0=p[0];v1=p[1];v2=p[2];v3=p[3];v4=p[4];v5=p[5];v6=p[6];v7=p[7];v8=p[8];v9=p[9];' +
      ' break; default: v0=p[10];v1=p[11];v2=p[12];v3=p[13];v4=p[14];v5=p[15];v6=p[16];v7=p[17];v8=p[18];' +
      'v9=p[19]; break; } for(i=0;i<8;i++) s+=p[i]*v0+v1*v2+v3*v4+v5*v6+v7*v8+v9; return s; }',
    features: ['value-home', 'array'],
    toolchains: ['agbcc'],
    ctx: 'int spillorder_rev(int k, int *p);',
  },

  // A LOOP VARIABLE READ AT ITS PRE-UPDATE VALUE. agbcc hoists an induction update above the exit
  // test, so something still wants the variable one iteration back. The structurer treats every
  // such read as a hazard — rendering it under the post-update name is an off-by-one-iteration
  // miscompile — and declines wherever it has no spelling for the pre-update value. It cost 29
  // functions across the klonoa/sa3/newlib corpus, and no other benchmark row reproduces it.
  //
  // ONE decline message, THREE causes, which is the point of authoring several rows: the message
  // groups them and the fix does not. `preupdate_cond` is the loop CONDITION reading it,
  // `preupdate_exit` is the EXITING EDGE carrying it, and `preupdate_escape` is a body value read
  // after the loop deriving from it. Each has its own repair: the EDGE is rebuilt as a copy inside
  // the body, at the op its value was computed at (`sinkablePreUpdateSlots`, the trailing-pointer
  // sink), and the CONDITION is respelled `n++` at the leaf that reads it with the update dropped
  // from the foot of the body (`PREUPDATE_COND_GATES`, structure/hazards.ts). So what
  // `preupdate_cond` measures is the distance to the bytes rather than a refusal. The ESCAPE has no
  // exit arg at all — agbcc carries the value out of the loop in a register of its own — and the
  // op that computed it is named where it ran (`escapesAheadOfUpdate`, structure/analysis.ts, with
  // its refusals). A loop VARIABLE read after the loop, rather than a value computed from one, has
  // no op to name and still declines.
  //
  // DEPTH, and then WHAT THE ARG IS. For 11 of the 12 real EXIT functions the SINK is the last
  // link, but they do not all need the same thing behind it: the copy is spelled from the arg's
  // NAME, so a computed arg needs an expression, and what its def-tree holds decides whether one can
  // be rebuilt at that op at all. Measured over the corpus, the tree is PURE
  // arithmetic over a loop variable in 11 of 12 (`preupdate_exit_pure`), a memory READ in none
  // (`preupdate_exit`), and a CALL in one (`preupdate_exit_call`, and `_wrapup_reent`).
  //
  // So the EXIT rows are the tiers of that tree, not copies of one row: a fix for the pure tier
  // closes the real bucket, and the others are what say it did not overreach. The CALL tier clears
  // the guard on "a post-loop value inlines a 'call' from inside the loop": `structure/analysis.ts`
  // materializes any call whose value rides a branch edge — the placement that guard refuses — so
  // `preupdate_exit_call` RECOVERS, at 2, with `cb` inside the loop where the asm calls it. What
  // still reaches that guard is an `opaque`, the other member of `REPEATED_EFFECT`, for which no
  // such rule exists. The pure row puts a STORE in the body AHEAD of the def, which is the
  // harder of the two shapes the corpus has — ten of the twelve have no effect in the latch block
  // at all, and `LoadBGTilemapData`, the function this link is being walked for, is the one that
  // does. Neither tier is recomputed ACROSS that store: the copy is rebuilt at its own def, BEHIND
  // it, which is also what lets the memory-read tier through — `preupdate_exit` and
  // `preupdate_exit_pure` both MATCH.
  //
  // WHAT THE SINK WEIGHS NEXT IS ORDER: a rebuilt tree lands at its home, and the order-sensitive
  // ops around it must keep their order there. Three rows put a CALL beside the READ.
  // `preupdate_exit_order` is `*q + cb(q)`, where agbcc calls first and loads second: rebuilt at the
  // add, the call would have the load between it and its home. But a call that rides an edge copy
  // — bare or under the ops it is inlined into — is named where it ran (`ridesEdge`,
  // structure/analysis.ts), which C can say — compiled, `t = cb(q); r = *q + t;` is byte-identical
  // to `*q + cb(q)` — and the sink takes the name as current because its statement runs in the
  // latch ahead of the copy (`writtenAheadOf`, structure/hazards.ts). What stands between that row
  // and the bytes is not the pre-update read: the counter is spelled as a fresh copy of `n` where
  // agbcc's own callee-saved copy spells as the parameter itself — the residual
  // `preupdate_exit_call` shares. `preupdate_exit_load` is `t = *q; r = t + cb(q)`, where agbcc
  // loads first and calls second — an order no single expression gives back, since every compiler
  // here calls before it reads — so the read is named too (the barrier scan in
  // structure/analysis.ts), and the exit value reads no loop variable at all. `preupdate_exit_foot`
  // is `t = cb(q); r = *q ^ n; s = s ^ t;`, where the call runs ahead of the read but, inlined, would
  // render in `s`'s update copy at the foot of the body, behind the read rebuilt at the `eor`, which
  // would then read `*q` before `cb` could write it. Named, it runs where the asm ran it.
  //
  // `preupdate_exit_reads` is `u = q[1]; r = *q + 1; s = s + u;`: a read ahead of the tree's read
  // that renders in the update copy behind it. Two reads commute, so the sink rebuilds the exit read
  // ahead of it (`movesPast`, structure/hazards.ts) — the control that the ORDER rule weighs a read
  // only against what it can conflict with.
  //
  // `preupdate_exit_div` is `t = k / n; *q = n; r = t + 1;`, where agbcc calls `__divsi3` ahead of
  // the store. The analysis names an op the asm called a helper for where it ran whenever an effect
  // lies between it and its use (`divstore` is the straight-line row), and the exit value then reads
  // the name rather than the counter. Rebuilt at the add instead, the divide would run behind the
  // store, which `arg-safe-to-reevaluate` (PREUPDATE_SINK_GATES) refuses. It is the one exit row on
  // every toolchain, because the read arises on kmc and mwcc too (kmc computes `t + 1` in the
  // branch's delay slot, behind the counter's decrement). There the divide is an instruction, and
  // the analysis names it at its def only for this: a pre-update exit value that a memory access or
  // an effect separates it from. IDO unrolls the loop.
  //
  // AND BESIDE THE EXIT ROWS, ONE ROW THAT IS NOT ABOUT THE PRE-UPDATE READ AT ALL, which
  // `preupdate_cond_effect` carries. The fold is what puts such a loop into a short-circuit spelling,
  // so everything else in the test rides along: the CALL the body's value comes from would land in an
  // arm the emitted `&&` skips on every iteration the counter's arm answers true, while agbcc ran the
  // `bl` ahead of that arm's branch. Compiled and executed both ways, within one invocation the two
  // return the same `i` and differ in how many times `cb` ran and in what it wrote through `p`;
  // carried across invocations the shifted callee state changes the return too. What the row holds is
  // the PLACEMENT that keeps them apart — a call in a connective's guarded operand is materialized at
  // its def (structure/analysis.ts) — and, behind it, `testSkipsAnEffect` (structure/hazards.ts),
  // which then finds a name in that position and asks the same question of every `do-while` rather
  // than only of a folded one. What still reaches that guard is an `opaque`, the only other
  // effectful op that defines a value, for which no placement rule exists.
  //
  // The others are booked on agbcc only, whose rotation they were written against. The read is not
  // ARM's alone: kmc and mwcc reach it on several of the same C sources, as `preupdate_exit_div`
  // does on both.
  {
    sym: 'preupdate_cond',
    src: 'int preupdate_cond(int i){ int b = 0; if (i == 0) return 0; while (((i >> b++) & 1) == 0) ; return b; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    note:
      "a post-increment inside the loop condition's own operand (`i >> b++`), so the test reads the " +
      'value the variable held one step before the update the compiler has already emitted',
  },
  {
    sym: 'preupdate_cond_effect',
    src:
      'int cb(int *p);\n' +
      'int preupdate_cond_effect(int *p, int n){ int i = 0; int r;' +
      ' do { r = cb(p); } while (i++ <= n && r != 0); return i; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    ctx: 'int cb(int*);',
    proto: { cb: { params: 1 } },
    note:
      "the same pre-update read in the bottom test, with a CALL's result as the other arm. agbcc " +
      'calls before either branch, so the call has to be emitted ahead of the test rather than in ' +
      'the position the `&&` skips',
  },
  {
    sym: 'preupdate_exit',
    src:
      'int preupdate_exit(int *p, int n, int m){ int r = m; int *q;' +
      ' if (n > 0) { q = p + n; do { r = *q + n; q = q - 1; } while (--n); } return r; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    note:
      "the loop's exiting edge carries a value computed from the loop variables BEFORE their update " +
      '(`*q + n`). The `q = p + n` init is load-bearing: without a preheader the entry guard fuses ' +
      'into the loop and the function is refused for an unrelated reason',
  },
  {
    sym: 'preupdate_exit_pure',
    src:
      'int preupdate_exit_pure(int *p, int n, int m){ int r = m; int *q;' +
      ' if (n > 0) { q = p + n; do { *q = n; r = n << 3; q = q - 1; } while (--n); } return r; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    note:
      "the loop's exiting edge carries PURE arithmetic over the loop variable (`n << 3`), computed " +
      'before the update and read after the loop. The body stores through a second loop variable ' +
      'first, so the value the edge carries is defined behind an effect it must not be reordered ' +
      'across — the shape every real function on this decline has',
  },
  {
    sym: 'preupdate_exit_call',
    src:
      'int cb(int *p);\n' +
      'int preupdate_exit_call(int *p, int n, int m){ int r = m; int *q;' +
      ' if (n > 0) { q = p + n; do { r = cb(q); q = q - 1; } while (--n); } return r; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    ctx: 'int cb(int*);',
    proto: { cb: { params: 1 } },
    note:
      "an exiting edge carrying a CALL's result computed from the pre-update loop variable. Authored " +
      'as a second refusal behind the pre-update one; that second refusal has since been removed at ' +
      'its cause (a call feeding a branch edge is materialized where the asm ran it), so the row ' +
      'scores instead of declining and it is now the pre-update link alone that it measures',
  },
  {
    sym: 'preupdate_exit_order',
    src:
      'int cb(int *p);\n' +
      'int preupdate_exit_order(int *p, int n, int m){ int r = m; int *q;' +
      ' if (n > 0) { q = p + n; do { r = *q + cb(q); q = q - 1; } while (--n); } return r; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    ctx: 'int cb(int*);',
    proto: { cb: { params: 1 } },
    note:
      'an exiting edge whose value is a memory READ and a CALL added together (`*q + cb(q)`). agbcc ' +
      'emits the call, then the load, then the add, so rebuilding the tree at the add would move the ' +
      'call past the load; the call has to be named where it ran for the exit copy to be rebuilt',
  },
  {
    sym: 'preupdate_exit_load',
    src:
      'int cb(int *p);\n' +
      'int preupdate_exit_load(int *p, int n, int m){ int r = m; int *q;' +
      ' if (n > 0) { q = p + n; do { int t = *q; r = t + cb(q); q = q - 1; } while (--n); } return r; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    ctx: 'int cb(int*);',
    proto: { cb: { params: 1 } },
    note:
      'the same exiting edge with the READ first (`t = *q; r = t + cb(q)`): agbcc loads into a ' +
      'callee-saved register, calls, then adds, an order `*q + cb(q)` would not give back, so the ' +
      'read is named where it ran as well as the call, and the exit value reads only their names',
  },
  {
    sym: 'preupdate_exit_foot',
    src:
      'int cb(int *p);\n' +
      'int preupdate_exit_foot(int *p, int n, int m, int k){ int r = m; int s = k; int t; int *q;' +
      ' if (n > 0) { q = p; do { q = q - 1; t = cb(q); r = *q ^ n; s = s ^ t; } while (--n); }' +
      ' return r - s; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    ctx: 'int cb(int*);',
    proto: { cb: { params: 1 } },
    note:
      "the call runs ahead of the exit value's read (`bl cb; ldr; eor`) and feeds the update of `s`; " +
      'inlined there it would render at the foot of the body, behind the read rebuilt at the `eor`, ' +
      'so it is named where it ran',
  },
  {
    sym: 'preupdate_exit_reads',
    src:
      'int preupdate_exit_reads(int *p, int n, int m, int k){ int r = m; int s = k; int u; int *q;' +
      ' if (n > 0) { q = p + n; do { u = q[1]; r = *q + 1; s = s + u; q = q - 1; } while (--n); }' +
      ' return r + s; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    note:
      "a read ahead of the exit value's read, inlined into the update of `s` at the foot of the " +
      'body; two reads commute, so the exit read is rebuilt ahead of it',
  },
  {
    sym: 'preupdate_exit_div',
    src:
      'int preupdate_exit_div(int *p, int n, int m, int k){ int r = m; int *q;' +
      ' if (n > 0) { q = p + n; do { int t = k / n; *q = n; r = t + 1; q = q - 1; } while (--n); }' +
      ' return r; }',
    features: ['loop-preupdate'],
    toolchains: ALL,
    note:
      "the exit value's tree holds a DIVIDE the asm runs ahead of a store in the body, so the divide " +
      'has to keep its place there rather than be rebuilt after the loop behind the store; a ' +
      '`bl __divsi3` on agbcc, an instruction everywhere else',
  },
  {
    sym: 'preupdate_escape',
    src:
      'struct N { struct N *next; int v; };\n' +
      'void preupdate_escape(struct N *f, int n, int **out){ int *s = 0;' +
      ' do { s = &f->v; f = f->next; } while (--n); *out = s; }',
    features: ['loop-preupdate'],
    toolchains: ['agbcc'],
    ctx: 'struct N; void preupdate_escape(struct N*,int,int**);',
    proto: { preupdate_escape: { returnsVoid: true } },
    note:
      'the trailing-pointer idiom where the trailing value is DERIVED from the loop variable ' +
      '(`&f->v`) rather than being the variable itself, and is read after the loop has moved on',
  },
  {
    sym: 'listwalk',
    src:
      'struct E { u16 a, b, c; s8 next; u8 pad; };\n' +
      '#define gBuf ((struct E *)0x03002000)\n' +
      '#define gOut ((u8 *)0x03003000)\n' +
      'void listwalk(s8 i){ u8 n = 0; while (i != -1) { gOut[i] = n++; i = gBuf[i].next; } }',
    features: ['loop-preupdate', 'narrow'],
    toolchains: ['agbcc'],
    ctx: 'void listwalk(s8 i);',
    proto: { listwalk: { params: ['s8'], returnsVoid: true } },
    note:
      'an `s8` walked down a list: agbcc carries it as `next << 24` and tests the `asr #24` of that, ' +
      'which the cast idiom folds into a sign extension of the load, so the test reads what fed the ' +
      'update unless it is re-rooted on the carried shift (raise/narrow.ts). agbcc only: IDO loads ' +
      'the field with `lb` and carries no shift',
  },

  // A CONTROL-FLOW short-circuit: an `&&`/`||` that produces no value, only a branch. `a && b`
  // guarding X and its De Morgan dual `!a || !b` guarding Y are the same program, and agbcc lays
  // the arms out in SOURCE order — so they are different bytes, and which one was written is
  // recorded in the branch senses. A decompiler therefore has to choose, and choosing wrong costs
  // the whole function. The four functions are the two orientations at the two distances, and the
  // distance decides whether the shape is recognised at all.
  //
  // `ifand_near` and `ifand_far` differ in ONE thing: whether the guarded arm fits inside a Thumb
  // conditional branch's ±256-byte reach. That one distance changes TWO things at once, and the
  // second is easy to miss.
  //
  // It changes what the recogniser can SEE. Past the range agbcc spells the branch
  // `bne .L1 / b .L2 @long jump`, and a frontend that splits a block at every conditional branch
  // turns that second instruction into a block whose only op is `br`, sitting on the edge into the
  // shared block. A recogniser keyed on successor identity cannot see through those, so the fold
  // resolves the chain before comparing (raise/shortcircuit.ts `forwardingTarget`).
  //
  // And it changes the branch POLARITY, which is what decides the ORIENTATION the fold would emit.
  // A short branch is `beq shared`, putting the second test on the FALL edge; the long form
  // inverts to `bne <second test>`, putting it on the TAKEN edge. Those are the fold's two arms —
  // `logic_or` and `logic_and` — so the near row and the far row do not exercise one code path at
  // two sizes, they exercise BOTH paths. MEASURED on the primary (unranked) output: `ifand_near`
  // lands on the source's own `a != 0 && b != 0` and matches, while `ifand_far` lands on the
  // `a == 0 || b == 0` dual and misses by 262. The distance is what decides which, so the
  // orientation is a per-SITE fact and the per-function joined-sense default is a coin flip on
  // this family whichever way it is set.
  //
  // `ifor_near` is the ORIENTATION control, and it lands on the dual too (`a == 0 && b == 0`, 20).
  // So the gap is not "this shape is unrecoverable" but "one of the fold's two arms emits the
  // spelling the compiler did not" — and a row that could falsify the claim is worth more than a
  // third that restates it. What referees it on the RANKED path is `/flip-join`, which emits the
  // other joined sense: all four match, three of them carrying it — `ifand_near` is the one that
  // matches at the default sense with no variation at all.
  //
  // `ifor_far` is the fourth corner, and its SCORE referees nothing, exactly as `ifand_far`'s does
  // not: `/flip-join` is a per-FUNCTION variation, so on a one-site function it is right whichever way
  // the fold spelled the site, and both long rows MATCH either way (`ifand_far` 0/140, `ifor_far`
  // 0/139). What the row is for is the STAMP PAIR it inhabits: measured, a long `||` stamps
  // `(scSharedOnFall=false, scSharedIsTaken=true)` — the identical pair a short `&&` stamps — and
  // wants the opposite spelling. It is the counterexample to any two-boolean reading of the
  // orientation, and like `ifand_far` it is pinned by a test rather than by its number.
  //
  // TOOLCHAINS, measured rather than assumed — and the answer differs per row.
  //
  // The two `near` rows run on agbcc AND mwcc, because the orientation defect is not an agbcc
  // fact: on PowerPC the fold commits to the same `&&` spelling, so `ifand_near` matches at the
  // default joined sense and `ifor_near` lands on the dual, missing by 18 until `/flip-join` emits
  // the other sense — exactly as on Thumb. Two ISAs and two compilers agreeing is what says the
  // gap is in the recogniser and the sense variation rather than in anything about ARM.
  //
  // The other two toolchains are excluded because on them THE CONSTRUCT IS NOT THERE, which is a
  // stronger reason than "it would be an ordinary row":
  //   • gcc2.7.2kmc compiles `if (a && b)` BRANCHLESSLY — `sltu; sltu; and; beqz`. One branch, no
  //     second test, nothing for a short-circuit recogniser to recognise.
  //   • ido7.1 fills both branch DELAY SLOTS with work hoisted out of the arms (`beqz a0,…` /
  //     `li t0,-1`, which is the shared arm's stored value). That makes the second test's block
  //     impure, and the fold refuses on exactly the ground it documents. The shape dissolves on a
  //     delay-slot ISA.
  //
  // `ifand_far` stays agbcc-only, and here the original reason does hold: the row IS the Thumb
  // ±256-byte branch range, and no other target has one. On mwcc its `_savegpr_14` prologue is
  // frame bookkeeping, and the row lifts with nothing about short circuits left to measure.
  //
  // The arm's CONTENT is filler and its SIZE is the feature, so the near arm is a literal PREFIX
  // of the far one and all four share a signature. Two pointers, deliberately: a Thumb
  // `str Rd,[Rn,#N]` reaches offset 124, and a single array long enough to force the long branch
  // would spill past it into a pointer walk — a second recovery idiom riding along inside what is
  // supposed to be a one-variable control.
  //
  // WHAT THESE ROWS MOVE, so the headline is not read as progress: the six rows contribute six
  // asmlift matches and no m2c match, every one of them a synthetic row authored for an
  // asmlift-specific gap, and two of them (`ifand_far`, `ifor_far`) score MATCH either way — a byte
  // score cannot see the difference between the recovered connective and the tail-duplicated
  // spelling agbcc cross-jumps back together, so a test pins those orientations, not these rows;
  // and every row reads `noncompile` for m2c on an unrelated pointer-spelling defect of its own.
  // All six match on the ranked path, so `bench regression` holds every one — but only against a
  // LOST match, and what these rows are really about is WHICH ORIENTATION won. That is
  // packages/cli/test/matching/shortcircuit-branch.test.ts, which asserts the connective itself
  // and runs with the benchmark refresh rather than on every PR.
  {
    sym: 'ifand_near',
    src: 'int ifand_near(int a, int b, int *p, int *q){ if (a && b) { p[0] = 1; q[0] = 2; p[1] = 3; q[1] = 4; } else { p[0] = -1; } return p[1]; }',
    features: ['branch'],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx: 'int ifand_near(int,int,int*,int*);',
    note:
      "at this distance the fold lands on the source's own `&&`, so asmlift matches at the " +
      'default joined sense with no variation. m2c prints the same orientation, and its output is ' +
      'byte-exact once the `->unkN` pointer spelling it declines on is legalised — so the ' +
      'noncompile beside this row is an unrelated defect of its own, not distance from a match',
  },
  {
    sym: 'ifand_far',
    src: 'int ifand_far(int a, int b, int *p, int *q){ if (a && b) { p[0] = 1; q[0] = 2; p[1] = 3; q[1] = 4; p[2] = 5; q[2] = 6; p[3] = 7; q[3] = 8; p[4] = 9; q[4] = 10; p[5] = 11; q[5] = 12; p[6] = 13; q[6] = 14; p[7] = 15; q[7] = 16; p[8] = 17; q[8] = 18; p[9] = 19; q[9] = 20; p[10] = 21; q[10] = 22; p[11] = 23; q[11] = 24; p[12] = 25; q[12] = 26; p[13] = 27; q[13] = 28; p[14] = 29; q[14] = 30; p[15] = 31; q[15] = 32; p[16] = 33; q[16] = 34; p[17] = 35; q[17] = 36; p[18] = 37; q[18] = 38; p[19] = 39; q[19] = 40; p[20] = 41; q[20] = 42; p[21] = 43; q[21] = 44; p[22] = 45; q[22] = 46; p[23] = 47; q[23] = 48; p[24] = 49; q[24] = 50; p[25] = 51; q[25] = 52; p[26] = 53; q[26] = 54; p[27] = 55; q[27] = 56; p[28] = 57; q[28] = 58; p[29] = 59; q[29] = 60; p[30] = 61; q[30] = 62; p[31] = 63; q[31] = 64; } else { p[0] = -1; } return p[1]; }',
    features: ['branch'],
    toolchains: ['agbcc'],
    ctx: 'int ifand_far(int,int,int*,int*);',
    note:
      'the guarded arm is far enough that agbcc inverts the branch and puts the shared block behind ' +
      'a long-branch trampoline on each edge. The fold looks through them, and the inverted ' +
      "polarity lands this orientation on the `||` dual — so here the source's own `&&` is " +
      "`/flip-join`'s spelling, the mirror of `ifand_near`. The SCORE cannot police that: the " +
      'un-folded spelling tail-duplicates the else arm and agbcc cross-jumps the copies back ' +
      'together, so this row read MATCH before the shape was recovered too — what the orientation ' +
      'is pinned by is a test, not this number',
  },
  {
    sym: 'ifor_far',
    src: 'int ifor_far(int a, int b, int *p, int *q){ if (a || b) { p[0] = 1; q[0] = 2; p[1] = 3; q[1] = 4; p[2] = 5; q[2] = 6; p[3] = 7; q[3] = 8; p[4] = 9; q[4] = 10; p[5] = 11; q[5] = 12; p[6] = 13; q[6] = 14; p[7] = 15; q[7] = 16; p[8] = 17; q[8] = 18; p[9] = 19; q[9] = 20; p[10] = 21; q[10] = 22; p[11] = 23; q[11] = 24; p[12] = 25; q[12] = 26; p[13] = 27; q[13] = 28; p[14] = 29; q[14] = 30; p[15] = 31; q[15] = 32; p[16] = 33; q[16] = 34; p[17] = 35; q[17] = 36; p[18] = 37; q[18] = 38; p[19] = 39; q[19] = 40; p[20] = 41; q[20] = 42; p[21] = 43; q[21] = 44; p[22] = 45; q[22] = 46; p[23] = 47; q[23] = 48; p[24] = 49; q[24] = 50; p[25] = 51; q[25] = 52; p[26] = 53; q[26] = 54; p[27] = 55; q[27] = 56; p[28] = 57; q[28] = 58; p[29] = 59; q[29] = 60; p[30] = 61; q[30] = 62; p[31] = 63; q[31] = 64; } else { p[0] = -1; } return p[1]; }',
    features: ['branch'],
    toolchains: ['agbcc'],
    ctx: 'int ifor_far(int,int,int*,int*);',
    note:
      "the `||` at `ifand_far`'s distance. The long branch INVERTS the last test, which moves " +
      'the shared arm to the other successor slot — so a long `||` stamps the same pair ' +
      '(`scSharedOnFall` false, `scSharedIsTaken` true) as a SHORT `&&` and wants the opposite ' +
      'spelling. Two booleans cannot separate them; the third stamp `scEdgeRelayed` is what does, ' +
      'and this is the only row whose SPELLING that stamp decides — the corpus carries 9 other ' +
      'stamped sites, all MIPS rows where no ±256-byte range exists and none is a sense site ' +
      '(packages/core/test/site-sense.test.ts pins the cell). Like `ifand_far` its SCORE referees ' +
      'nothing: it MATCHes on `/flip-join` whichever way the fold spelled the site. Nor does ' +
      'the FAN carry the variation here: measured, the row enumerates 4 candidates and no ' +
      '`/site-sense` at all, because at one site the variation re-spells what `/flip-join` already ' +
      'spelled and the tree dedup drops the duplicate. A named row the fan never enumerates is ' +
      'worth saying out loud',
  },
  {
    sym: 'ifor_near',
    src: 'int ifor_near(int a, int b, int *p, int *q){ if (a || b) { p[0] = 1; q[0] = 2; p[1] = 3; q[1] = 4; } else { p[0] = -1; } return p[1]; }',
    features: ['branch'],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx: 'int ifor_near(int,int,int*,int*);',
  },

  // The DMA-fill idiom, WITH an uninitialised local — the pair no real row carries. An escaping
  // frame address retracts every `undef` in the function, on the premise that a callee may write
  // any frame offset; a DMA SOURCE register is the case where that premise is false, because the
  // engine only reads through it and the register is write-only, so the address cannot come back.
  // This row is the ACCEPTING half of that rule, and it MATCHes today
  // (`unsigned/defsite/loop-entry/derived-home/indexed`), so `bench regression` holds it — a
  // re-widening of the rule loses a match rather than only moving a flip list. Ablating
  // `readOnlyAddressSinks` was measured to turn it into a DECLINE, so it is a real gate, and the
  // direction is pinned directly by the frontend unit test (packages/core/test/thumb-frontend.ts,
  // 'an escape that the hardware only READS through keeps the undef'). Note also that asmlift
  // lifts this and m2c declines it, so a row authored for an asmlift capability moves the
  // declined/match columns one in asmlift's favour.
  // agbcc only: the addresses are GBA MMIO, and on the other toolchains this is three stores to
  // nothing in particular. Ten live locals for the same reason uninit_spill has them — below that
  // agbcc keeps the uninitialised local in a register and the frame is never touched.
  {
    sym: 'dma_fill_uninit',
    src:
      'int dma_fill_uninit(int k,int *p,void *dest){ volatile unsigned short tmp;' +
      ' int v0,v1,v2,v3,v4,v5,v6,v7,v8,v9; int i,s=0;' +
      ' switch(k){ case 0: v0=p[0];v1=p[1];v2=p[2];v3=p[3];v4=p[4];v5=p[5];v6=p[6];v7=p[7];v8=p[8];v9=p[9]; break;' +
      ' case 1: v0=p[10];v1=p[11];v2=p[12];v3=p[13];v4=p[14];v5=p[15];v6=p[16];v7=p[17];v8=p[18];v9=p[19]; break; }' +
      ' tmp=(unsigned short)k;' +
      ' *(volatile unsigned int *)0x040000D4=(unsigned int)&tmp;' +
      ' *(volatile unsigned int *)0x040000D8=(unsigned int)dest;' +
      ' *(volatile unsigned int *)0x040000DC=0x81000020;' +
      ' for(i=0;i<8;i++) s+=p[i]*v0+v1*v2+v3*v4+v5*v6+v7*v8+v9; return s; }',
    features: ['uninit-local', 'memory', 'array'],
    toolchains: ['agbcc'],
  },

  // ── float (soft-float on GBA; hardware FPU elsewhere) ───────────────────────────────────────
  {
    sym: 'fadd',
    src: 'float fadd(float a,float b){ return a+b; }',
    features: ['float', 'arithmetic'],
    toolchains: ALL,
    ctx: 'float fadd(float,float);',
  },
  {
    sym: 'fsub',
    src: 'float fsub(float a,float b){ return a-b; }',
    features: ['float', 'arithmetic'],
    toolchains: ALL,
    ctx: 'float fsub(float,float);',
  },
  {
    sym: 'fmul',
    src: 'float fmul(float a,float b){ return a*b; }',
    features: ['float', 'arithmetic'],
    toolchains: ALL,
    ctx: 'float fmul(float,float);',
  },
  {
    sym: 'fdiv',
    src: 'float fdiv(float a,float b){ return a/b; }',
    features: ['float', 'arithmetic'],
    toolchains: ALL,
    ctx: 'float fdiv(float,float);',
  },
  {
    sym: 'fcmp',
    src: 'int fcmp(float a,float b){ return a>b; }',
    features: ['float', 'compare'],
    toolchains: [...ALL, 'gcc2.7.2'],
  },
  {
    sym: 'i2f',
    src: 'float i2f(int x){ return (float)x; }',
    features: ['float', 'cast', 'int-to-float'],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 'float i2f(int);',
  },
  {
    sym: 'f2i',
    src: 'int f2i(float x){ return (int)x; }',
    features: ['float', 'cast', 'float-to-int'],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 'int f2i(float);',
  },
  {
    sym: 'fma1',
    src: 'float fma1(float a,float b,float c){ return a*b+c; }',
    features: ['float', 'arithmetic'],
    toolchains: ALL,
    ctx: 'float fma1(float,float,float);',
  },
  // THE FLOAT COMPARES AND CONVERSIONS, on every toolchain, because each spells them its own way and
  // a NaN tells the negation of a relation from its flipped twin: agbcc calls one libgcc helper per
  // relation and tests its result against 0 with a branch or a sign-bit idiom (`>> 31`, `~r >> 31`,
  // `(-r | r) >> 31`), MIPS sets one condition code with `c.eq`/`c.lt`/`c.le` and branches on it
  // either way round, and mwcc sets a condition-register field that a branch, a `cror` and an `mfcr`
  // extract read. `fcmpngt` and `fcmpbrn` are the negations, which every compiler here compiles
  // apart from `a <= b` and `a >= b`. `d2i`, `i2d` and `dcmpgt` are the double precision, which mwcc
  // compiles to the same object as the float one. mwcc's `(float)i` and `(double)i` decline: the
  // magic constant is an `lfd` of an SDA21 anonymous double, which nothing models. `fcmphome` and
  // `fcmpvoid` put a float temporary in the float return register beside the compares that read it
  // (KMC, GCC 2.7.2 and IDO allocate `c` to `$f0`): the int returns its `li`s, and the void one is
  // the object of a float function returning `c`, which only its declaration tells apart. So is
  // `fcmpkeep`, a float function returning its first argument untouched (in `f1` on PowerPC, where
  // `r3` is the other home), beside the void function that does not. `fcmpeqbr` and `fcmpnebr` are
  // the equality guards: agbcc picks `__eqsf2` or `__nesf2` by the relation the source spelled and
  // folds `!(a == b)` into `a != b` first, so only the arm order keeps the helper. `fcmpeqlp` and
  // `fcmpnelp` are those guards as a loop's break, which agbcc's branch fold joins to the loop test.
  ...(
    [
      [['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'], undefined],
      [['mwcc_233_163n', 'mwcc_247_107'], MWCC_O4P],
    ] as const
  ).flatMap(([toolchains, cflags]): SynthSpec[] =>
    [
      ['fcmplt', 'int fcmplt(float a,float b){ return a<b; }', 'int fcmplt(float,float);'],
      ['fcmple', 'int fcmple(float a,float b){ return a<=b; }', 'int fcmple(float,float);'],
      ['fcmpge', 'int fcmpge(float a,float b){ return a>=b; }', 'int fcmpge(float,float);'],
      ['fcmpeq', 'int fcmpeq(float a,float b){ return a==b; }', 'int fcmpeq(float,float);'],
      ['fcmpne', 'int fcmpne(float a,float b){ return a!=b; }', 'int fcmpne(float,float);'],
      ['fcmpngt', 'int fcmpngt(float a,float b){ return !(a>b); }', 'int fcmpngt(float,float);'],
      ['fcmpnlt', 'int fcmpnlt(float a,float b){ return !(a<b); }', 'int fcmpnlt(float,float);'],
      [
        'fcmpbrn',
        'extern int gI;\nvoid fcmpbrn(float a,float b){ if (!(a<b)) gI = 1; }',
        'extern int gI; void fcmpbrn(float,float);',
      ],
      [
        'fcmpeqbr',
        'extern int gI;\nvoid fcmpeqbr(float a,float b){ if (a==b) return; gI = 1; }',
        'extern int gI; void fcmpeqbr(float,float);',
      ],
      [
        'fcmpnebr',
        'extern int gI;\nvoid fcmpnebr(float a,float b){ if (a!=b) return; gI = 1; }',
        'extern int gI; void fcmpnebr(float,float);',
      ],
      [
        'fcmpeqlp',
        'extern int gI;\nvoid fcmpeqlp(float a,float b,int n){ int i; for (i=0;i<n;i++){ if (a==b) break; gI+=i; } }',
        'extern int gI; void fcmpeqlp(float,float,int);',
      ],
      [
        'fcmpnelp',
        'extern int gI;\nvoid fcmpnelp(float a,float b,int n){ int i; for (i=0;i<n;i++){ if (a!=b) break; gI+=i; } }',
        'extern int gI; void fcmpnelp(float,float,int);',
      ],
      [
        'fcmphome',
        'int fcmphome(float a,float b){ float c=a+b; if (c<a) return 3; if (c>b) return 7; return 5; }',
        'int fcmphome(float,float);',
      ],
      [
        'fcmpvoid',
        'extern int gI;\nvoid fcmpvoid(float a,float b){ float c=a*b; if (c<a) gI=1; if (c>b) gI=2; }',
        'extern int gI; void fcmpvoid(float,float);',
      ],
      [
        'fcmpkeep',
        'extern int gI;\nfloat fcmpkeep(float a,float b){ if (a<b) gI=1; return a; }',
        'extern int gI; float fcmpkeep(float,float);',
      ],
      ['dcmpgt', 'int dcmpgt(double a,double b){ return a>b; }', 'int dcmpgt(double,double);'],
      ['d2i', 'int d2i(double x){ return (int)x; }', 'int d2i(double);'],
      ['i2d', 'double i2d(int x){ return (double)x; }', 'double i2d(int);'],
    ].map(([sym, src, ctx]): SynthSpec => ({
      sym,
      src,
      features: sym.endsWith('2i')
        ? ['float', 'cast', 'float-to-int']
        : sym.startsWith('i2')
          ? ['float', 'cast', 'int-to-float']
          : FCMP_BRANCH_ROWS.has(sym)
            ? ['float', 'compare', 'branch']
            : ['float', 'compare'],
      toolchains: [...toolchains],
      ...(cflags ? { cflags } : {}),
      ctx,
      ...(FCMP_VOID_ROWS.has(sym) ? { proto: { [sym]: { returnsVoid: true } } } : {}),
    })),
  ),
  ...(['f2i', 'fcmp'] as const).map((sym): SynthSpec => ({
    sym,
    src: sym === 'f2i' ? 'int f2i(float x){ return (int)x; }' : 'int fcmp(float a,float b){ return a>b; }',
    features: sym === 'f2i' ? ['float', 'cast', 'float-to-int'] : ['float', 'compare'],
    toolchains: ['mwcc_233_163n', 'mwcc_247_107'],
    cflags: MWCC_O4P,
    ctx: sym === 'f2i' ? 'int f2i(float);' : 'int fcmp(float,float);',
  })),
  // agbcc's single-precision runtime (core runtime-helpers.ts AGBCC_RUNTIME_HELPERS): `__negsf2`
  // folds to a negation, `__fixsfsi` to the cast (`fconv`); and a helper whose result reaches only a
  // GUESSED call declines. That call does not count r0, which the helper wrote, so `g1(a * b)`
  // reads `__mulsf3(); return g1();` and, folded, `return g1();`, the product deleted
  // (raise/floathelpers.ts). The conversions to and from a long long are the 64-bit side of a
  // helper; `u2f` has none, agbcc open-coding `(float)u` around `__floatsisf`, and declines. agbcc
  // only: the other toolchains have a hardware FPU.
  {
    sym: 'fneg',
    src: 'float fneg(float a){ return -a; }',
    features: ['float', 'arithmetic'],
    toolchains: ['agbcc'],
    ctx: 'float fneg(float);',
  },
  {
    sym: 'fconv',
    src: 'int fconv(float a,float b){ return (int)(a+b); }',
    features: ['float', 'cast', 'float-to-int', 'arithmetic'],
    toolchains: ['agbcc'],
    ctx: 'int fconv(float,float);',
  },
  {
    sym: 'll2f',
    src: 'float ll2f(long long x){ return (float)x; }',
    features: ['float', 'cast', 'int-to-float', 'int64'],
    toolchains: ['agbcc'],
    ctx: 'float ll2f(long long);',
  },
  {
    sym: 'f2u',
    src: 'unsigned f2u(float x){ return (unsigned)x; }',
    features: ['float', 'cast', 'float-to-int', 'unsigned'],
    toolchains: ['agbcc'],
    ctx: 'unsigned f2u(float);',
  },
  {
    sym: 'u2f',
    src: 'float u2f(unsigned x){ return (float)x; }',
    features: ['float', 'cast', 'int-to-float', 'unsigned'],
    toolchains: ['agbcc'],
    ctx: 'float u2f(unsigned);',
  },
  // A byte compared with a float is promoted to `int` and converted with `__floatsisf`, which the lift
  // spells `(float)(s32)a0`: a bare `(float)a0` of the `u8` converts unsigned, which agbcc open-codes.
  // agbcc only: on O32 the float after an int arrives in `a1` (an `mtc1` bit cast the lift refuses),
  // and mwcc converts through an `lfd` of its magic constant.
  {
    sym: 'fcmpu8',
    src: 'int fcmpu8(unsigned char c,float x){ return x < c; }',
    features: ['float', 'compare', 'int-to-float', 'unsigned'],
    toolchains: ['agbcc'],
    ctx: 'int fcmpu8(unsigned char,float);',
  },
  {
    sym: 'fcall',
    src: 'float g1(float);\nfloat fcall(float a,float b){ return g1(a*b); }',
    features: ['float', 'arithmetic'],
    toolchains: ['agbcc'],
    ctx: 'float fcall(float,float);',
  },
  {
    sym: 'dadd',
    src: 'double dadd(double a,double b){ return a+b; }',
    features: ['float', 'double', 'arithmetic'],
    toolchains: ALL,
  },

  // ── 64-bit (long long — soft 64-bit ops) ────────────────────────────────────────────────────
  {
    sym: 'lladd',
    src: 'long long lladd(long long a,long long b){ return a+b; }',
    features: ['int64', 'arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'llsub',
    src: 'long long llsub(long long a,long long b){ return a-b; }',
    features: ['int64', 'arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'llshl',
    src: 'long long llshl(long long a,int b){ return a<<b; }',
    features: ['int64'],
    toolchains: ALL,
  },
  {
    sym: 'llshr',
    src: 'long long llshr(long long a,int b){ return a>>b; }',
    features: ['int64', 'signed'],
    toolchains: ALL,
  },
  { sym: 'i2ll', src: 'long long i2ll(int x){ return x; }', features: ['int64', 'sign-extend'], toolchains: ALL },
  // THE LOW HALF AS A PROJECTION, and the mirror of `llhi` below — with the same rule applied to
  // the same effect on a different toolchain, because the cell that goes null is the one whose
  // machine already has the wanted half in the return register.
  //
  // NOT ON agbcc, where the low half IS r0, so the whole function is `bx lr`. Compiled at the
  // row's own flags, three sources are one object — .text `70470000`, md5 496f2b6e:
  //
  //   int ll2i(long long x){ return (int)x; }        the row
  //   u32 ll2i(u32 a0){ return a0; }                 what asmlift publishes, and it MATCHED
  //   void ll2i(void){}                              no parameter, no return, no cast
  //
  // A cell that scores an empty function identically to the answer measures nothing about
  // `int64`, the `cast` or the `narrow` it is tagged with, so it is not one of this row's cells.
  // It fails differently from `llhi`'s mwcc cell, and the difference is worth keeping: `llhi:mwcc`
  // could not distinguish the two PROJECTIONS, so an arithmetically wrong answer scored the same;
  // this one does distinguish them — the high half is `add r0,r1,#0`, `081c7047` — and goes null
  // on ARITY and TYPE instead. Both are null, for different reasons.
  //
  // The other three cells are gates: IDO alone answers `return a1`, the wrong half, and correctly
  // nonmatches.
  {
    sym: 'll2i',
    src: 'int ll2i(long long x){ return (int)x; }',
    features: ['int64', 'cast', 'narrow'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'],
  },
  {
    sym: 'llcmp',
    src: 'int llcmp(long long a,long long b){ return a<b; }',
    features: ['int64', 'compare'],
    toolchains: ALL,
  },
  // The helper family, and what each row PINS. `llmul` is the plainest shape there is: a 64-bit
  // value in a register pair going into a call and coming back out of one.
  {
    sym: 'llmul',
    src: 'long long llmul(long long a,long long b){ return a*b; }',
    features: ['int64', 'arithmetic'],
    toolchains: ALL,
  },
  // THE PAIR THAT PROVES THE CALLEE NAME CANNOT DECIDE SIGNEDNESS. agbcc's libgcc has no
  // `__umuldi3` at all — `optabs.c` initialises the only integer multiply libfunc from the MODE,
  // and `expmed.c` routes every multiply through it — so these two compile to the SAME
  // `bl __muldi3` and differ only in how each argument was widened: `asr rN,rM,#31` per half here,
  // `mov rN,#0` in the twin below.
  {
    sym: 'llmulw',
    src: 'long long llmulw(int a,int b){ return (long long)a*(long long)b; }',
    features: ['int64', 'arithmetic', 'sign-extend'],
    toolchains: ALL,
  },
  {
    sym: 'llmulwu',
    src: 'unsigned long long llmulwu(unsigned a,unsigned b){ return (unsigned long long)a*(unsigned long long)b; }',
    features: ['int64', 'arithmetic', 'unsigned'],
    toolchains: ALL,
  },
  // …and the pair where the name DOES decide it. Division splits into `__divdi3`/`__udivdi3`, so
  // these two are the reason a helper table carries an op per NAME rather than one per shape.
  {
    sym: 'lldivs',
    src: 'long long lldivs(long long a,long long b){ return a/b; }',
    features: ['int64', 'arithmetic', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'lldivu',
    src: 'unsigned long long lldivu(unsigned long long a,unsigned long long b){ return a/b; }',
    features: ['int64', 'arithmetic', 'unsigned'],
    toolchains: ALL,
  },
  // The unsigned widen, `i2ll`'s twin: `mov rN,#0` where that one has `asr rN,rM,#31`. The shape
  // is what says which extension the machine performed, and it is the only thing that does.
  {
    sym: 'u2ull',
    src: 'unsigned long long u2ull(unsigned x){ return x; }',
    features: ['int64', 'zero-extend', 'unsigned'],
    toolchains: ALL,
  },
  // THE HIGH HALF AS A PROJECTION, and a constant shift of 32 leaves no shift opcode to key on:
  // agbcc emits `add r0,r1,#0` and nothing else, so the recovery is a fact about the register pair
  // rather than about an instruction.
  //
  // NOT ON mwcc, and the omission is the row's own rule applied honestly. Each of the other three
  // objects does SOMETHING with the shift — `add r0,r1,#0` on agbcc, a sign-extended pair and
  // `move v0,a1` on kmc, a call to a shift helper with a count of 32 on IDO. Big-endian PPC puts
  // the high half in r3 already, so the whole function is `blr`: four bytes, and not one of them
  // responds to the source. A cell whose target scores the right answer and every wrong one alike
  // is not a gate, so it is not one of this row's cells.
  {
    sym: 'llhi',
    src: 'int llhi(long long x){ return (int)(x>>32); }',
    features: ['int64', 'cast', 'narrow'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc'],
  },
  // THE ONE-WAY DOOR, and this row is here so a later round cannot quietly walk back through it.
  // agbcc spells a 64-bit OR as two plain `orr`s — ordinary 32-bit instructions that ordinary
  // 32-bit C reaches — so no 64-bit OPERATION is needed for the halves themselves, and the same
  // goes for `&`, `^`, `~`, every constant shift and every compare. What the row scores is the
  // RETURN: both `orr`s are there and the high one has nowhere to go, so it reads `1/3` with the
  // high half deleted. The door it holds shut is a 64-bit `or` opcode nothing needs; the gap it
  // measures is the pair coming back out.
  {
    sym: 'llorr',
    src: 'long long llorr(long long a,long long b){ return a|b; }',
    features: ['int64'],
    toolchains: ALL,
  },
  // THE WIDTH TWIN OF `llmul`, and the two differ in one register. A 64-bit-returning function
  // ends `bl __muldi3; pop {r2}; bx r2`; this one narrows, so agbcc is free to pop its scratch
  // into r1 — which is the pair's HIGH register. The epilogue is therefore the only place the
  // return width is written down, and a recovery that reads the register pair off the value graph
  // answers 64 for both. (Without `-mthumb-interwork` the two really are the same object, and no
  // row can pin what no function carries.)
  {
    sym: 'lomul',
    src: 'int lomul(long long a,long long b){ return (int)(a*b); }',
    features: ['int64', 'arithmetic', 'cast', 'narrow'],
    toolchains: ALL,
  },
  // THE CALL BOUNDARY THE PAIR CROSSES, and the declaration is the whole of what carries it: the
  // body is `llsink(a*b)` and nothing else, so what this scores is the shape of one argument.
  //
  // WHAT THIS CELL REFEREES, AND WHAT IT DOES NOT. It separates a DECLINE from a lift, and it
  // separates the correct argument from an over-count — the two halves as two words needs a
  // two-parameter callee and emits `add r2,r1,#0`, a different object. It does NOT separate the
  // correct argument from the LOW-HALF NARROWING, which is the likelier wrong answer of the two:
  //
  //   `llsink(a*b)` and `llsink((s32)(a*b))` compile to the SAME 16 bytes here.
  //
  // Recompute: build both bodies over `C_TYPEDEFS` alone — no declaration of `llsink` — and run
  // them through the command `pnpm bench target synthetic:llpass:agbcc --out <dir>` writes into
  // `decomp.yaml`; `arm-none-eabi-objdump -d` each. They are byte-identical, and the narrowing
  // costs its four instructions (`add r3,r1,#0` / `add r2,r0,#0` / `add r0,r2,#0` / `asr r1,r2,#0x1f`)
  // ONLY when `void llsink(long long);` is in scope to promote the `int` back.
  //
  // `ctx` IS NOT IN SCOPE FOR THAT COMPILE, and an earlier revision of this comment claimed it
  // was. On the REAL tier the candidate is compiled in the project context; on the SYNTHETIC tier
  // `rankOptionsFor` falls back to `benchCompilerFor`, whose translation unit is `C_TYPEDEFS` plus
  // declarations for the bare GLOBALS the candidate names. `ctx` reaches m2c and `bench target`,
  // and nothing else. Any synthetic row whose two spellings differ only in something a callee's
  // DECLARATION decides is scoring both of them alike.
  //
  // WHICH IS THIS ROW'S SITUATION, AND IT IS NOW A PROPERTY OF THIS ENTRY RATHER THAN OF THE
  // TIER. `collectSymbolRefs` declares a call target whose prototype states a COMPLETE C signature
  // (`proto.ts` `spellableProto` — a spellable `returns` and a spellable parameter list); this
  // row's `proto` states `params` alone, so `llsink` is still implicitly `int` in the candidate's
  // translation unit and the narrowing is still unrefereed here. Adding a `returns` would change
  // that — and would change what this cell measures — so it is a decision, not an omission.
  //
  // THE GATE FOR THE NARROWING IS A UNIT TEST, `int64-helpers.test.ts`: "a pair arriving in r0:r1
  // leaves in r0:r1, as one argument" asserts the whole source exactly, so a low-half reading
  // fails it, and "a mixed signature packs: the pair is r1:r2, not r2:r3" fails on the AAPCS
  // answer. Keeping this row is a judgement that a decline-to-lift differential and the mwcc
  // cell's refusal are worth their cost; it is not a claim that the agbcc cell is a width gate.
  // Re-check the compile the way it was measured rather than assuming either answer: compile the
  // two spellings through `bench target`'s own command and compare the objects.
  {
    sym: 'llpass',
    src: 'int llpass(long long a,long long b){ llsink(a*b); return 0; }',
    ctx: 'void llsink(long long);',
    proto: { llsink: { params: ['long long'] } },
    features: ['int64', 'arithmetic'],
    toolchains: ALL,
  },
  // THE SAME BOUNDARY FROM THE OTHER SIDE. A pair ARRIVES from an ordinary callee the way it
  // arrives from a runtime helper — in the register pair the ABI names — and the read of the high
  // register is a read of what that callee returned. `FnProto.returns` is what says so: a declared
  // 64-bit return makes the frontend name both registers, which is the ACCEPTANCE arm of the
  // refusal below, and silence still makes the high register a destroyed one.
  //
  // WHAT THE ROW GUARDS IS THE REFUSAL, not the acceptance, and that is why it is worth keeping
  // now that it matches. `frontend/ssa.ts` must go on refusing the read for every callee no width
  // is stated for — `mov r3,#0x2a ; bl f ; add r4,r3,#0` and a returned pair are the same
  // instructions — so deleting the `returns` from the entry below has to put the decline back.
  //
  // agbcc alone, by `llhi`'s rule and for both of its halves. On big-endian PPC the high half IS
  // r3, so mwcc's whole body is `bl llsrc` and a frame: asmlift matches it with `return llsrc();`
  // — the LOW half, the opposite projection — and the object is identical either way, so that
  // cell scores the right answer and a wrong one alike. All three MIPS builds refuse the declared
  // return in the frontend (`'llsrc' would hand back one half of a 64-bit value`: O32 hands the pair
  // back in v0:v1, and no MIPS lowering builds one), so they referee a different capability. agbcc
  // is the one that pays an instruction for the projection, `add r0,r1,#0`, so it is the only cell
  // where naming the high register is the difference between the answer and a decline.
  //
  // THE DECLARATION IS IN ALL THREE CHANNELS, and each one is a different compiler's input. `src`
  // builds the TARGET and must carry it: without it `llsrc` is implicitly `int` and the target
  // becomes a 32-bit `asr` by 32 over a function returning a word. `ctx` is what m2c is told.
  // `proto` is what asmlift is told, and a synthetic candidate's own translation unit is built
  // from `proto` ALONE — `ctx` never reaches it — so `returns` is also what puts
  // `long long llsrc(void);` above the candidate. Compiled in that configuration the difference is
  // one instruction: with the declaration the candidate is byte-identical to the target,
  // without it agbcc inserts `asr r1, r0, #0x1f` to widen the word it thinks came back.
  {
    sym: 'llfrom',
    src: 'long long llsrc(void);\nint llfrom(void){ return (int)(llsrc() >> 32); }',
    ctx: 'long long llsrc(void);',
    proto: { llsrc: { params: [], returns: 'long long' } },
    features: ['int64', 'cast', 'narrow'],
    toolchains: ['agbcc'],
  },

  // ── division / modulo by constant (magic-number division) ───────────────────────────────────
  {
    sym: 'divc10',
    src: 'int divc10(int a){ return a/10; }',
    features: ['arithmetic', 'div-const', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'divc100',
    src: 'int divc100(int a){ return a/100; }',
    features: ['arithmetic', 'div-const', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'udivc10',
    src: 'unsigned udivc10(unsigned a){ return a/10; }',
    features: ['arithmetic', 'div-const', 'unsigned'],
    toolchains: ALL,
  },
  {
    sym: 'umod10',
    src: 'unsigned umod10(unsigned a){ return a%10; }',
    features: ['arithmetic', 'mod-const', 'unsigned'],
    toolchains: ALL,
  },
  {
    sym: 'modpow2',
    src: 'int modpow2(int a){ return a%16; }',
    features: ['arithmetic', 'mod-pow2', 'signed'],
    toolchains: ALL,
  },
  {
    sym: 'avg2',
    src: 'int avg2(int a,int b){ return (a+b)/2; }',
    features: ['arithmetic', 'div-pow2', 'signed'],
    toolchains: ALL,
  },

  // ── bit manipulation ────────────────────────────────────────────────────────────────────────
  {
    sym: 'rotl',
    src: 'unsigned rotl(unsigned x,int n){ return (x<<n)|(x>>(32-n)); }',
    features: ['rotate'],
    toolchains: ALL,
  },
  {
    sym: 'rotr',
    src: 'unsigned rotr(unsigned x,int n){ return (x>>n)|(x<<(32-n)); }',
    features: ['rotate'],
    toolchains: ALL,
    ctx: 'unsigned rotr(unsigned,int);',
  },
  {
    sym: 'extractbits',
    src: 'unsigned extractbits(unsigned x){ return (x>>4)&0xF; }',
    features: ['mask'],
    toolchains: ALL,
  },
  {
    sym: 'clearbit',
    src: 'int clearbit(int x,int n){ return x & ~(1<<n); }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'togglebit',
    src: 'int togglebit(int x,int n){ return x ^ (1<<n); }',
    features: [],
    toolchains: ALL,
  },
  { sym: 'hi16', src: 'unsigned hi16(unsigned x){ return x>>16; }', features: [], toolchains: ALL },
  {
    sym: 'mergebits',
    src: 'unsigned mergebits(unsigned a,unsigned b){ return (a&0xFFFF)|(b<<16); }',
    features: ['mask'],
    toolchains: ALL,
  },
  {
    sym: 'signum',
    src: 'int signum(int x){ return (x>0)-(x<0); }',
    features: ['compare'],
    toolchains: ALL,
  },

  // ── compare / branchless / select ───────────────────────────────────────────────────────────
  {
    sym: 'absdiff',
    src: 'int absdiff(int a,int b){ return a>b?a-b:b-a; }',
    features: ['compare'],
    toolchains: ALL,
  },
  {
    // THE ONE-SET-ARM RETURN DIAMOND (raise/retsink.ts `SELECT_GATES`). The capability that closed
    // `kleod:IsSelectButtonPressed:agbcc` had no synthetic inhabitant at all, and the corpus's only
    // real one is that row; a rule with one row behind it cannot show whether it travels. Run on
    // ALL four toolchains deliberately: the admission is declared for agbcc alone
    // (`compilerBehaviors.hoistsSingleSetArm`), so the IDO / KMC / mwcc columns of this row are
    // what would say if that ever stopped being true.
    //
    // TAGGED LIKE THE ROW IT GENERALISES, so the capability's two rows share a feature slice wider
    // than `branch`: `kleod:IsSelectButtonPressed` carries `bool`/`branch`/`mask`/`global`, and this
    // one returns a truth value (`bool`) and isolates a bit field with an AND mask (`mask`) by
    // bench-schema's own definitions. No `global` — the condition here is on a parameter.
    sym: 'selconst',
    src: 'int selconst(int x){ if (x & 0x40) return 1; return 0; }',
    features: ['bool', 'branch', 'mask'],
    toolchains: ALL,
  },
  {
    // ONE SYNTHETIC ROW IS THIN PINNING for a rule that travels, and these are the two shapes that
    // would break first. `selhead` puts a BODY in the head rather than the arms — the arms stay one
    // SET each, so the admission must still fire, and it is the case a predicate written on the arms
    // alone would get wrong if it ever grew a "the head is bare" clause. `selloop` puts a LOOP ahead
    // of the diamond, so the sink has to compose with another variation in the ranked fan rather than be
    // the only one the row needs.
    //
    // Measured when added: `selhead` MATCH on all four (agbcc `unsigned/flip-branch`), `selloop`
    // MATCH on agbcc as `signed/flip-branch/indexed` — the composition this row exists to pin.
    // `selloop`'s ido7.1 column declines on the frontend's own gap rather than on anything the
    // select admission decides: a branch to 0x38 that is not a block boundary. `selhead` scores on
    // all four, so the decline is never its.
    sym: 'selhead',
    src: 'int selhead(int x,int *p){ *p = x; if (x & 0x40) return 1; return 0; }',
    features: ['bool', 'branch', 'mask', 'memory'],
    toolchains: ALL,
  },
  {
    sym: 'selloop',
    src: 'int selloop(int *p,int n){ int s=0,i; for(i=0;i<n;i++) s+=p[i]; if(s) return 1; return 0; }',
    features: ['bool', 'branch', 'array'],
    toolchains: ALL,
  },
  {
    sym: 'clampu8',
    src: 'int clampu8(int x){ if(x<0)return 0; if(x>255)return 255; return x; }',
    features: ['compare', 'branch'],
    toolchains: ALL,
  },
  {
    sym: 'max3',
    src: 'int max3(int a,int b,int c){ int m=a>b?a:b; return m>c?m:c; }',
    features: ['compare'],
    toolchains: ALL,
  },
  {
    sym: 'selnz',
    src: 'int selnz(int c,int a,int b){ return c?a:b; }',
    features: ['compare'],
    toolchains: ALL,
  },
  { sym: 'notb', src: 'int notb(int x){ return !x; }', features: ['compare', 'bool'], toolchains: ALL },

  // ── memory / arrays / structs ───────────────────────────────────────────────────────────────
  {
    sym: 'swapp',
    src: 'void swapp(int *a,int *b){ int t=*a;*a=*b;*b=t; }',
    features: ['memory', 'store', 'load'],
    toolchains: ALL,
    ctx: 'void swapp(int*,int*);',
    proto: { swapp: { returnsVoid: true } },
  },
  {
    sym: 'hword',
    src: 'void hword(u16 *p,int i,int v){ p[i]=(u16)v; }',
    features: ['memory', 'array', 'store', 'narrow'],
    toolchains: ALL,
    ctx: 'void hword(u16*,int,int);',
    proto: { hword: { returnsVoid: true } },
  },
  {
    sym: 'memcpy1',
    src: 'void memcpy1(u8 *d,u8 *s,int n){ int i; for(i=0;i<n;i++)d[i]=s[i]; }',
    features: ['memory', 'store', 'load'],
    toolchains: ALL,
    ctx: 'void memcpy1(u8*,u8*,int);',
    proto: { memcpy1: { returnsVoid: true } },
  },
  {
    sym: 'revarr',
    src: 'void revarr(int *a,int n){ int i,j,t; for(i=0,j=n-1;i<j;i++,j--){t=a[i];a[i]=a[j];a[j]=t;} }',
    features: ['memory', 'store'],
    toolchains: ALL,
    ctx: 'void revarr(int*,int);',
    proto: { revarr: { returnsVoid: true } },
  },
  {
    sym: 'maxarr',
    src: 'int maxarr(int *a,int n){ int m=a[0],i; for(i=1;i<n;i++)if(a[i]>m)m=a[i]; return m; }',
    features: ['memory', 'branch'],
    toolchains: ALL,
  },
  {
    sym: 'countpos',
    src: 'int countpos(int *a,int n){ int c=0,i; for(i=0;i<n;i++)if(a[i]>0)c++; return c; }',
    features: ['memory', 'branch'],
    toolchains: ALL,
  },
  {
    sym: 'dotprod',
    src: 'int dotprod(int *a,int *b,int n){ int s=0,i; for(i=0;i<n;i++)s+=a[i]*b[i]; return s; }',
    features: ['memory', 'arithmetic'],
    toolchains: ALL,
    ctx: 'int dotprod(int*,int*,int);',
  },
  {
    sym: 'structarr',
    src: 'struct P{int x;int y;};\nint structarr(struct P *a,int n){ int s=0,i; for(i=0;i<n;i++)s+=a[i].x; return s; }',
    features: ['struct', 'memory', 'array'],
    toolchains: ALL,
  },
  {
    sym: 'setfield',
    src: 'struct S{int a;int b;int c;};\nvoid setfield(struct S *s,int v){ s->a=v; s->c=v; }',
    features: ['struct', 'field', 'store'],
    toolchains: ALL,
    ctx: 'struct S; void setfield(struct S*,int);',
    proto: { setfield: { returnsVoid: true } },
  },
  {
    sym: 'strcmp1',
    src: 'int strcmp1(char *a,char *b){ while(*a && *a==*b){a++;b++;} return *a-*b; }',
    features: ['memory', 'pointer', 'compare'],
    toolchains: ALL,
  },

  // ── loops (do-while, nested, break/continue, accumulators) ──────────────────────────────────
  {
    sym: 'gcd',
    src: 'int gcd(int a,int b){ while(b){int t=b;b=a%b;a=t;} return a; }',
    features: ['mod-reg'],
    toolchains: ALL,
  },
  {
    sym: 'fib',
    src: 'int fib(int n){ int a=0,b=1,i; for(i=0;i<n;i++){int t=a+b;a=b;b=t;} return a; }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'powi',
    src: 'int powi(int base,int e){ int r=1,i; for(i=0;i<e;i++)r*=base; return r; }',
    features: ['arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'nestedloop',
    src: 'int nestedloop(int n){ int s=0,i,j; for(i=0;i<n;i++)for(j=0;j<n;j++)s+=i*j; return s; }',
    features: ['arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'dowhile',
    src: 'int dowhile(int n){ int s=0; do{s+=n;n--;}while(n>0); return s; }',
    features: [],
    toolchains: ALL,
  },
  {
    sym: 'breakloop',
    src: 'int breakloop(int *a,int n){ int i; for(i=0;i<n;i++)if(a[i]<0)break; return i; }',
    features: ['break', 'memory'],
    toolchains: ALL,
  },
  {
    sym: 'continueloop',
    src: 'int continueloop(int *a,int n){ int s=0,i; for(i=0;i<n;i++){if(a[i]<0)continue;s+=a[i];} return s; }',
    features: ['continue', 'memory'],
    toolchains: ALL,
  },
  // A retry loop whose mid-body `continue` and bottom test are two latches of one header, which is
  // neither one test at its top nor one at its bottom: `while (1)` with a `continue` and a `break`.
  // No gcc2.7.2kmc cell: its lift declines on the call before any loop is reached.
  {
    sym: 'retryloop',
    src:
      'int f(void);\nint g(int);\nvoid h(int);\n' +
      'int retryloop(int n){ int t; for(;;){ t = f(); if (t == n) continue; h(t); if (g(t)) break; } return t; }',
    features: [],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx: 'int f(void); int g(int); void h(int);',
    proto: { f: { params: 0 }, g: { params: 1 }, h: { params: 1, returnsVoid: true } },
  },
  // A do-while with a `break` into its return tail: the edge runs no update, so it hands the exit
  // what the iteration read, where the bottom test hands it the update. `while (1)` spells each
  // edge with its own copies. No MIPS cell: those compiles decline in the lift, on the call.
  {
    sym: 'dowbreak',
    src:
      'int g(int);\nvoid h(int);\n' +
      'int dowbreak(int n){ int i = 0, s = 0; do { if (g(i) == 3) break; s += i; i++; } while (i < n); h(s); return i + s; }',
    features: ['break'],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx: 'int g(int); void h(int);',
    proto: { g: { params: 1 }, h: { params: 1, returnsVoid: true } },
  },
  // A do-while whose `||` test calls a function in a later term. The IR cannot fold the call's term
  // into the one before it — the fold would run `g` on every iteration — so the loop reaches the
  // structurer with a latch per term, which is `while (1)` with a `continue` per term. agbcc only:
  // the MIPS and PPC compiles of it decline in the lift, on the call, before any loop is reached.
  {
    sym: 'orchain',
    src:
      'extern int gTbl[];\nint f(void);\nint g(int);\n' +
      'int orchain(int a, int s, int m, int n){ int t; do { t = f() % n; } ' +
      'while (t == a || g(t) == s || (m & gTbl[t])); return t; }',
    features: ['global'],
    toolchains: ['agbcc'],
    ctx: 'extern int gTbl[]; int f(void); int g(int);',
    proto: { f: { params: 0 }, g: { params: 1 } },
  },

  // ── casts / integer promotion ───────────────────────────────────────────────────────────────
  {
    sym: 'addu8',
    src: 'u8 addu8(u8 a,u8 b){ return a+b; }',
    features: ['narrow', 'arithmetic'],
    toolchains: ALL,
  },
  {
    sym: 'promsh',
    src: 'int promsh(s16 a,s16 b){ return a+b; }',
    features: ['promotion', 'arithmetic'],
    toolchains: ALL,
  },
  // The other signedness, and the one the GameCube rows need. `promsh` covers every toolchain, so
  // `promotion` already has a CodeWarrior carrier — but a promoted `s16` and a promoted `u8` are
  // different recovery problems and different instructions (`extsh` against `clrlwi`), and the real
  // carriers about to claim the tag are all unsigned, because Animal Crossing compiles `-char
  // unsigned`. mwcc_242_81 alone: what agbcc, ido7.1 and gcc2.7.2kmc do with a `u8` pair was not
  // measured, and `promsh` already stands on those three.
  //
  // The promotion is load-bearing in the object, not just in the source — measured, in
  // `packages/cli/test/matching/ppc-tag-lanes.test.ts`: `a+b` zero-extends both operands and then
  // adds (`clrlwi/clrlwi/add`), while the re-narrowed `(u8)(a+b)` adds and then zero-extends once,
  // a shorter and different object. A decompiler that spells the parameters `int` cannot match.
  {
    sym: 'promzb',
    src: 'int promzb(u8 a,u8 b){ return a+b; }',
    features: ['promotion', 'zero-extend', 'arithmetic'],
    toolchains: ['mwcc_242_81'],
  },
  {
    sym: 'narrow',
    src: 'void narrow(u8 *p,int x){ *p=(u8)x; }',
    features: ['cast', 'narrow', 'memory', 'store'],
    toolchains: ALL,
    ctx: 'void narrow(u8*,int);',
    proto: { narrow: { returnsVoid: true } },
  },
  {
    sym: 'truncmul',
    src: 's16 truncmul(s16 a,s16 b){ return a*b; }',
    features: ['narrow', 'arithmetic'],
    toolchains: ALL,
  },

  // WHERE A VALUE LIVES, NOT WHAT IT COMPUTES. In each of these rows both decompilers can
  // recover the computation; the diff is dominated by value placement — a base address kept in
  // one register and reused at immediate offsets, a clamp overwriting its own variable, a value
  // parked across a high-pressure loop. The family is cut from LoadBGTilemapData in the kleod checkout (agbcc),
  // whose residual diff is almost entirely this class, but every shape is spelled with absolute
  // addresses so the rows stay self-contained. (A named extern global would compile and score —
  // asmlift synthesizes the declaration off the target asm, and rows elsewhere in this file
  // relocate against one. Self-contained absolute addresses are still the right choice HERE,
  // because these rows are about where a value lives, not about how a base is spelled, and a
  // named symbol would add a second moving part.)
  //
  // The absolute base is PER-PLATFORM, so the spelled address is one the console actually has:
  // under agbcc the GBA DMA3 register file / EWRAM / IWRAM; under ido and kmc the N64 PI
  // register file (the osPiRawStartDma store pattern) and KSEG0 RDRAM; under mwcc the GC DI
  // register file (the DVDLowRead store pattern) and MEM1. Same spelling, same capability —
  // only the constant and the register offsets differ — so a sym appears in several specs with
  // DISJOINT toolchain lists and every `synthetic:<sym>:<toolchain>` id stays unique.
  //
  // What each row isolates, measured by compiling both spellings under agbcc -O2:
  // `dma_burst` is the control — a plain store block through one pointer local, recovered
  // today by the default base hoist. `dma_wait` adds the busy-wait read-back through the SAME
  // pointer, which the placement gates refuse; `/livebase` is basecse without them, and the row
  // MATCHes on agbcc and mwcc_242_81 (`unsigned/livebase/volatile`). What the row still prices is
  // the shared base register: without it the candidate falls back to one literal per store (gcc
  // 2.9 folds `(vu32*)0x040000d8` to a fresh constant at parse time, so only a spelling that keeps
  // ONE base expression gets `str [rN, #imm]`).
  // `bg_area` groups three fields of one struct element and MATCHes on all four toolchains; the
  // operand order of the commutative multiply (the target loads .w then .h) is what `/mulfirst`
  // referees, and it is the winner's variation on ido7.1. `bg_mix` adds a FIXED element of the same
  // array: the target derives `[2].h` from the same base register (`add #0x38`), where a per-cell
  // spelling anchors a second absolute base and splits the object in two — recovered on
  // agbcc/gcc2.7.2kmc/mwcc_242_81, still 1 on ido7.1. `clamp_inplace` is a one-sided overwrite
  // (`if (w > 31) w = 32;`): rendering it as a two-sided assignment into a fresh temp costs a
  // register, a callee-save push, and flips the branch polarity. `hipress` parks one byte across a
  // loop hot enough to fill r0-r7, so the target homes it in a call-saved HI register touched only
  // by `mov` (gcc's alternate-class allocation; hi regs cost 4 vs 2 to move but beat an 8-cost
  // SImode reload) — `/parkfirst` is what reproduces that home and it is the winner's variation on
  // agbcc; gcc2.7.2kmc is still 29 and ido7.1 declines in the frontend on `beql`.
  //
  // The placement question is universal (MIPS %hi/%lo anchoring, PPC @ha/@l pairs, all four
  // compilers' in-place-update patterns), and where a toolchain's own addressing rules make a
  // shape free, the row is a control there rather than coverage.
  //
  // WHAT THESE ROWS DO NOT PIN, recorded here because no synthetic row can. `dma_wait:agbcc`
  // MATCHes with the candidate `unsigned/livebase/volatile`, so the volatile-base capability
  // exists and that row pins it. What is NOT pinned is that the same capability is EXCLUDED once
  // the device base is spelled as a NAMED symbol rather than a numeric address. Measured on
  // LoadBGTilemapData in the kleod checkout with the project's symbol map on: of the 66,816 ranked candidates
  // 14,592 spell globals by name and 52,224 by raw address; 18,432 of the raw ones carry a
  // `/volatile*` variation and ZERO of the named ones do — counted both from the run's `[score]`
  // lines and from the 66,816 captured candidate `.c` files, 18,432 of which declare a volatile
  // pointer local, none in the named basin. Instrumented rather than read: `l3/volatileptr.ts`'s
  // eligibility prints `verdict=NOT-numericFed` for every pointer local there, and the FIRST veto
  // is `numericFed` — `rematerializableAddress` (l3/ast.ts) reaches its `default: ok = false` arm
  // on an `addr` node, so `(s32 *)&REG_DMA3SAD` is not a rematerializable feed.
  // `feedsSymbolAddress` (volatileptr.ts:136) is a real second veto, but ablating it ALONE moves
  // no candidate; a variation has to lift both. A synthetic row cannot express any of that:
  // `SynthSpec` at the top of this file has no map or ELF field, only the real-tier manifests
  // carry one, and with no map asmlift never emits `&gSym`, so the naming cannot happen here at
  // all (same minimized shape with the map off: 36 candidates, 8 of them carrying `/volatile`).
  // That is narrower than "the variation is always available": both vetoes test the NODE KIND, and
  // `laddr` mints an `addr` node for a proved frame-object address with no map in sight
  // (`structure/structure.ts`), so a pointer local fed `&aLocal` on one path is refused by the
  // same two clauses. No row reaches that either — both probes of it decline first in the Thumb
  // frontend, on the address-taken stack local. The row this wants is REAL-tier, on a project
  // that already builds a symbol map.
  {
    sym: 'dma_burst',
    src:
      'void dma_burst(u32 src,u32 dst,u32 cnt){ volatile u32 *dma = (volatile u32 *)0x040000d4;' +
      ' dma[0] = src; dma[1] = dst; dma[2] = cnt; }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void dma_burst(u32 src, u32 dst, u32 cnt);',
    proto: { dma_burst: { returnsVoid: true } },
  },
  {
    sym: 'dma_burst',
    src:
      'void dma_burst(u32 dram,u32 cart,u32 len){ volatile u32 *pi = (volatile u32 *)0xa4600000;' +
      ' pi[0] = dram; pi[1] = cart; pi[3] = len; }',
    features: ['value-home', 'pointer'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc'],
    ctx: 'void dma_burst(u32 dram, u32 cart, u32 len);',
    proto: { dma_burst: { returnsVoid: true } },
  },
  {
    sym: 'dma_burst',
    src:
      'void dma_burst(u32 mar,u32 len,u32 cr){ volatile u32 *di = (volatile u32 *)0xcc006000;' +
      ' di[5] = mar; di[6] = len; di[7] = cr; }',
    features: ['value-home', 'pointer'],
    toolchains: ['mwcc_242_81'],
    ctx: 'void dma_burst(u32 mar, u32 len, u32 cr);',
    proto: { dma_burst: { returnsVoid: true } },
  },
  {
    sym: 'dma_wait',
    src:
      'void dma_wait(u32 src,u32 dst,u32 cnt){ volatile u32 *dma = (volatile u32 *)0x040000d4;' +
      ' dma[0] = src; dma[1] = dst; dma[2] = cnt | 0x80000000; while (dma[2] & 0x80000000) {} }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void dma_wait(u32 src, u32 dst, u32 cnt);',
    proto: { dma_wait: { returnsVoid: true } },
  },
  {
    sym: 'dma_wait',
    src:
      'void dma_wait(u32 dram,u32 cart,u32 len){ volatile u32 *pi = (volatile u32 *)0xa4600000;' +
      ' pi[0] = dram; pi[1] = cart; pi[3] = len; while (pi[4] & 3) {} }',
    features: ['value-home', 'pointer'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc'],
    ctx: 'void dma_wait(u32 dram, u32 cart, u32 len);',
    proto: { dma_wait: { returnsVoid: true } },
  },
  {
    sym: 'dma_wait',
    src:
      'void dma_wait(u32 mar,u32 len,u32 cr){ volatile u32 *di = (volatile u32 *)0xcc006000;' +
      ' di[5] = mar; di[6] = len; di[7] = cr | 1; while (di[7] & 1) {} }',
    features: ['value-home', 'pointer'],
    toolchains: ['mwcc_242_81'],
    ctx: 'void dma_wait(u32 mar, u32 len, u32 cr);',
    proto: { dma_wait: { returnsVoid: true } },
  },
  {
    sym: 'bg_area',
    src:
      'struct Bg { s32 tiles; u8 pad[12]; u16 w; u16 h; u8 pad2[8]; };\n' +
      '#define gBgs ((struct Bg *)0x02000000)\n' +
      's32 bg_area(s32 i){ return gBgs[i].w * gBgs[i].h + gBgs[i].tiles; }',
    features: ['value-home', 'struct'],
    toolchains: ['agbcc'],
    ctx: 's32 bg_area(s32 i);',
  },
  {
    sym: 'bg_area',
    src:
      'struct Bg { s32 tiles; u8 pad[12]; u16 w; u16 h; u8 pad2[8]; };\n' +
      '#define gBgs ((struct Bg *)0x80200000)\n' +
      's32 bg_area(s32 i){ return gBgs[i].w * gBgs[i].h + gBgs[i].tiles; }',
    features: ['value-home', 'struct'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'],
    ctx: 's32 bg_area(s32 i);',
  },
  {
    sym: 'bg_mix',
    src:
      'struct Bg { s32 tiles; u8 pad[12]; u16 w; u16 h; u8 pad2[8]; };\n' +
      '#define gBgs ((struct Bg *)0x02000000)\n' +
      's32 bg_mix(s32 i){ return gBgs[i].w * gBgs[2].h + gBgs[i].tiles; }',
    features: ['value-home', 'struct'],
    toolchains: ['agbcc'],
    ctx: 's32 bg_mix(s32 i);',
  },
  {
    sym: 'bg_mix',
    src:
      'struct Bg { s32 tiles; u8 pad[12]; u16 w; u16 h; u8 pad2[8]; };\n' +
      '#define gBgs ((struct Bg *)0x80200000)\n' +
      's32 bg_mix(s32 i){ return gBgs[i].w * gBgs[2].h + gBgs[i].tiles; }',
    features: ['value-home', 'struct'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'],
    ctx: 's32 bg_mix(s32 i);',
  },
  {
    sym: 'clamp_inplace',
    src:
      '#define gW ((volatile u16 *)0x03000010)\n' +
      's32 clamp_inplace(s32 n){ s32 total = 0; s32 j;' +
      ' for (j = 0; j < n; j++){ s32 w = gW[j]; if (w > 31){ w = 32; } total += w; } return total; }',
    features: ['value-home'],
    toolchains: ['agbcc'],
    ctx: 's32 clamp_inplace(s32 n);',
  },
  {
    sym: 'clamp_inplace',
    src:
      '#define gW ((volatile u16 *)0x80200010)\n' +
      's32 clamp_inplace(s32 n){ s32 total = 0; s32 j;' +
      ' for (j = 0; j < n; j++){ s32 w = gW[j]; if (w > 31){ w = 32; } total += w; } return total; }',
    features: ['value-home'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'],
    ctx: 's32 clamp_inplace(s32 n);',
  },
  // The RETURN-VALUE home, and the third of `l3/regspell.ts`'s three tails. A materialized phi
  // re-spells as a copy plus an in-place update (R1: `j = i; w = j; if (w >= 8) w = w - 8;`), and
  // the assign-back that lands the result in a local before the `return` then has TWO spellings —
  // R1's now-dead value var (`/regcopy-ret`) or a fresh one (`/regcopy-ret-fresh`). Which one the
  // source used is not derivable from the asm, so both are ranked. The reuse side is already
  // pinned by real rows (`kleod:MultiplyQ8` on kl-eod-decomp's source before 2026-09-13, `pokeemerald:MathUtil_Mul16`, all agbcc,
  // where the fresh tail scores 3 against the reuse tail's 0); this row is the fresh side, which
  // no corpus row exercised.
  // WHY ido7.1 ALONE. The three spellings are three different objects only on ido: measured on
  // this row's own fan with `ASMLIFT_CANDCACHE=0`, `/regcopy-ret-fresh` scores 0 against 2 for the
  // tail-less default spelling and 5 for the reused tail, and it is the ONLY candidate of the 7 that
  // matches. agbcc, gcc2.7.2kmc and mwcc_242_81 all fold the fresh assign-back away, so the same
  // source matches there on the base `/regcopy` spelling and the row would measure nothing.
  {
    sym: 'ringread',
    src: 'int ringread(int *p,int i){ int j; int r; j = i; if (j >= 8) j -= 8; r = p[j] + i; return r; }',
    features: ['value-home', 'array', 'variable-index', 'branch'],
    toolchains: ['ido7.1'],
    ctx: 'int ringread(int *p, int i);',
  },
  // No mwcc_242_81 on `hipress`: one of the scored candidates sends mwcc -O4's global optimizer
  // into a non-terminating compile (>15 min CPU-bound on a single cand.c), which would stall
  // every full run. The homes it measures (hi-reg parking, ip counter) are Thumb/MIPS facts.
  {
    sym: 'hipress',
    src:
      's32 hipress(u8 *p, s32 n){ s32 keep = p[1];' +
      ' s32 a = p[2], b = p[3], c = p[4], d = p[5], e = p[6], f = p[7], g = p[8]; s32 i;' +
      ' for (i = 0; i < n; i++){ a += b * c; b += d * e; c += f * g; d += a; e += b; f += c; g += d; }' +
      ' return keep + a + b + c + d + e + f + g; }',
    features: ['value-home', 'array'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc'],
    ctx: 's32 hipress(u8 *p, s32 n);',
  },
  // The EXPRESSION-home third of the family (the first two thirds: `dma_*` = one base pointer's
  // home, `hipress` = a loaded value's home). Under loop pressure agbcc computes a repeated
  // expensive expression ONCE and homes it — a loop-invariant shift hoisted into a callee-saved
  // register, a two-instruction constant materialized once per iteration and read back, an
  // incremented counter parked in `ip` — where a per-use spelling re-derives each of them.
  // `sizehome` isolates the invariant hoist (w>>1 lands in TWO homes, one per signedness, plus
  // the VRAM base constant); `maskhome` is the composite frame-copy + DMA shape (the inner copy
  // loop adds the pressure that turns every home callee-saved); `fieldbase` isolates neighbor
  // CELLS of one object derived from a single base register (`add #72`/`add #74` off one pool
  // word where the halfword offset exceeds the load range, the word offset staying inline) — a
  // per-cell spelling anchors one pool constant per address instead. `dma_wait:agbcc` is the
  // whole third's control: the same mask reused once, in a function small enough that
  // re-materializing is what the compiler does too.
  //
  // agbcc only. The poll loops decline on both MIPS lanes, for two different reasons:
  // `dma_wait:ido7.1` hits the branch-likely lift gap (`bnezl`), and `dma_wait:gcc2.7.2kmc`
  // declines in the structurer ('a post-loop read reaches a temp the guarded body may never
  // assign'). Either way those lanes would measure that link, not this family (`dma_wait`
  // already carries the attributed
  // declines); mwcc_242_81 stays off per the `hipress` hazard policy until a probe clears it.
  {
    sym: 'sizehome',
    src:
      'void sizehome(u8 *dst, s32 w, s32 n){' +
      ' volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i;' +
      ' for (i = 0; i < n; i++){' +
      ' dma[0] = (s32)dst; dma[1] = 0x06000000 + (w >> 1) * i;' +
      ' dma[2] = (u32)w >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void sizehome(u8 *dst, s32 w, s32 n);',
    proto: { sizehome: { returnsVoid: true } },
  },
  {
    sym: 'maskhome',
    src:
      'void maskhome(u8 *src, u8 *dst, s32 w, s32 h){' +
      ' volatile s32 *dma = (volatile s32 *)0x040000d4; s32 x, y;' +
      ' for (y = 0; y < h; y++){' +
      ' for (x = 0; x < w; x++){ dst[x] = src[x + w * y]; }' +
      ' dma[0] = (s32)dst; dma[1] = 0x06000000 + (w >> 1) * y;' +
      ' dma[2] = (u32)w >> 1 | 0x80000000;' +
      ' if (dma[2] & 0x80000000) { do {} while (dma[2] & 0x80000000); } } }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void maskhome(u8 *src, u8 *dst, s32 w, s32 h);',
    proto: { maskhome: { returnsVoid: true } },
  },
  // The COMPOSITION and PLACEMENT aggravations behind the single-loop rows above, each verified
  // against the reference compile. All five MATCH today, so the block is coverage: each holds a
  // composition that the sibling variations close only jointly, and a regression in any one of them
  // is a variation that stopped composing. `dmafield` fuses fieldbase's neighbor cells with
  // dma_wait's poll block in one function, so it needs `/nearbase` and `/livebase` + the poll
  // spelling to arrive in the SAME candidate. `armhomes` runs the SAME hot DMA loop in both arms
  // of an `if`, and the reference homes the mask and the loop invariants PER ARM, re-materializing
  // the mask again for each poll — per-region homes of a MASK, which is a placement question and
  // not the base-COUNT question the `dmascope` family below measures. `nestinit` is sizehome's
  // exact shape nested inside a guard, so the init-first re-spelling has to reach a statement list
  // below the top level. sizehome/maskhome are the single-loop controls.
  //
  // agbcc only, as the sibling block above: the polls decline on ido/kmc branch-likely, and
  // mwcc_242_81 stays off per the hipress hazard policy.
  {
    sym: 'dmafield',
    src:
      'void dmafield(s32 n){' +
      ' u8 *b = (u8 *)0x03001000;' +
      ' volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i;' +
      ' for (i = 0; i < n; i++){' +
      ' if (i < *(u16 *)(b + 72)) { *(u16 *)(b + 74) = i; }' +
      ' dma[0] = (s32)(b + 112); dma[1] = *(s32 *)(b + 112);' +
      ' dma[2] = i | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void dmafield(s32 n);',
    proto: { dmafield: { returnsVoid: true } },
  },
  {
    sym: 'armhomes',
    src:
      'void armhomes(u8 *dst, s32 w, s32 n, s32 sel){' +
      ' volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i;' +
      ' if (sel) {' +
      ' for (i = 0; i < n; i++){' +
      ' dma[0] = (s32)dst; dma[1] = 0x06000000 + (w >> 1) * i;' +
      ' dma[2] = (u32)w >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} }' +
      ' } else {' +
      ' for (i = 0; i < n; i++){' +
      ' dma[0] = (s32)(dst + w); dma[1] = 0x06008000 + (w >> 1) * i;' +
      ' dma[2] = (u32)w >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } } }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void armhomes(u8 *dst, s32 w, s32 n, s32 sel);',
    proto: { armhomes: { returnsVoid: true } },
  },
  {
    sym: 'nestinit',
    src:
      'void nestinit(u8 *dst, s32 w, s32 n, s32 go){' +
      ' volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i;' +
      ' if (go != 0) {' +
      ' for (i = 0; i < n; i++){' +
      ' dma[0] = (s32)dst; dma[1] = 0x06000000 + (w >> 1) * i;' +
      ' dma[2] = (u32)w >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } } }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void nestinit(u8 *dst, s32 w, s32 n, s32 go);',
    proto: { nestinit: { returnsVoid: true } },
  },
  {
    sym: 'fieldbase',
    src:
      'void fieldbase(s32 n){' +
      ' u8 *b = (u8 *)0x03001000; s32 i;' +
      ' for (i = 0; i < n; i++){' +
      ' if (i < *(u16 *)(b + 72)) { *(u16 *)(b + 74) = i; }' +
      ' *(s32 *)(b + 112) = i; } }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void fieldbase(s32 n);',
    proto: { fieldbase: { returnsVoid: true } },
  },
  // The TYPED-home fourth of the family: what the first three thirds hoisted, this third TYPES.
  // On the real function the residual splits three ways, each verified by compiling the pair.
  // `sizebound` — the repeated `16 << t` homed in a **u32** local: the type is load-bearing
  // twice over (the home's compares against a u16 load and the shift bound come out UNSIGNED —
  // `bcs`/`bcc` where an s32 home gives `bge`/`blt` — and the s32-home spelling of the same
  // hoist REGRESSES the real function, so a home variation without the width/sign decision cannot
  // close it). `ucmp` isolates the compare polarity alone, home-less: a u32 counter and a cast
  // bound flip four branches and ripple two register picks — the default spells the compares
  // unsigned from the lifted icmp facts (structure.ts unsignedCompareSpelling), and `ucmp:agbcc`
  // matches on it today;
  // `ucmp:gcc2.7.2kmc` still stands at 15, unattributed. `entrypair` — one COMPUTED address
  // (`(a0 << 2) + (a1 << 1) + table`) held in a pointer local with its two bytes read at
  // `[r,#1]`/`[r,#0]`: the per-site spelling recomputes the chain and anchors a pool literal per
  // baked offset (`table`, `table+1`) where the original anchors one. /nearbase cannot see it —
  // its clusters
  // are CONST deref bases; this base is an expression.
  //
  // `sizebound` is agbcc-only like its siblings (its poll loop declines on the MIPS lanes'
  // branch-likely link, and mwcc stays off per the `hipress` hazard policy). `ucmp` and
  // `entrypair` have no poll. Measured decline attributions: `ucmp:ido7.1` declines on the
  // pre-existing branch-likely lift link (`bnezl`), `ucmp:mwcc_242_81` on the guard-fusion
  // staleExit decline (the kept-guard family's link, not this one); `entrypair:gcc2.7.2kmc`
  // declines on the MIPS `jal` call link exactly as `call1:gcc2.7.2kmc` does. Those lanes
  // measure their links; the family's signal lanes are agbcc (all three), `ucmp:gcc2.7.2kmc`,
  // and `entrypair:mwcc_242_81`. `sizebound:agbcc` still stands at `nonmatch:8`, all of it
  // argMismatch, on the `signed/expr-home/livebase-block/volatile/initfirst/pollread`
  // winner — whose two sequential inner loops still count with two separate locals, and which
  // reads the u16 bound inline rather than through a pointer local. Neither spelling needs a new
  // row. `ucmp:agbcc` carries the shared-counter shape standalone and MATCHES today on
  // `unsigned/coalesce-v0-v1`, its two counters merged into one; whether that merged
  // spelling is absent from `sizebound`'s own fan or merely scores worse there is UNMEASURED.
  // The mwcc lane's residual is NOT the shared-base home the agbcc
  // lane closed (`/addr-home`): struct-arrays recovery consumes the full element address into
  // `[a0]` indexing, so the value the PPC target holds in r3 no longer exists in the IR to
  // home — a struct-element-home class the lane keeps measuring.
  {
    sym: 'sizebound',
    src:
      'void sizebound(s32 t, s32 n){' +
      ' volatile s32 *dma = (volatile s32 *)0x040000d4;' +
      ' u32 size = 16 << t; s32 i;' +
      ' for (i = 0; i < n; i++){' +
      ' u32 j;' +
      ' for (j = 0; j < *(u16 *)0x03001048; j++){ *(u8 *)(j + 0x03002000) = *(u8 *)(j + 0x03003000); }' +
      ' for (j = *(u16 *)0x03001048; j < size; j++){ *(u8 *)(j + 0x03002000) = 0; }' +
      ' dma[0] = 0x03002000;' +
      ' dma[1] = *(s32 *)0x03001070 + size * i;' +
      ' dma[2] = size >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } }',
    features: ['value-home', 'unsigned'],
    toolchains: ['agbcc'],
    ctx: 'void sizebound(s32 t, s32 n);',
    proto: { sizebound: { returnsVoid: true } },
  },
  {
    sym: 'ucmp',
    src:
      'void ucmp(s32 t){' +
      ' u32 i;' +
      ' for (i = 0; i < *(u16 *)0x03001048; i++){ *(u8 *)(i + 0x03002000) = *(u8 *)(i + 0x03003000); }' +
      ' for (i = *(u16 *)0x03001048; i < (u32)(16 << t); i++){ *(u8 *)(i + 0x03002000) = 0; } }',
    features: ['unsigned'],
    toolchains: ALL,
    ctx: 'void ucmp(s32 t);',
    proto: { ucmp: { returnsVoid: true } },
  },
  {
    sym: 'entrypair',
    src:
      's32 g(s32 v);\n' +
      's32 entrypair(u32 a0, u32 a1){' +
      ' u8 *entry = (u8 *)((a0 << 2) + (a1 << 1) + 0x08057acc);' +
      ' s32 type = entry[1];' +
      ' s32 idx = entry[0];' +
      ' if (type == 2) { return g(*(s32 *)((idx << 3) + 0x08189ccc)); }' +
      ' return g(*(s32 *)((type - 2 << 2) + (idx << 3) + 0x08189ccc)); }',
    features: ['value-home', 'pointer'],
    toolchains: CALL,
    ctx: 's32 g(s32 v); s32 entrypair(u32 a0, u32 a1);',
    proto: { g: { params: 1 } },
  },

  // WHERE THE READ HAPPENS, not where the value lives. The sibling of the value-home family
  // above: there the diff is which register or offset holds a value; here it is which BLOCK
  // performs the read. agbcc has no instruction scheduler (gcc 2.9-arm's SRCS compiles neither
  // sched.c nor reorg.c), and its code-hoisting pass is compiled in but never runs: gcse.c
  // guards `one_code_hoisting_pass` behind `optimize_size`, which toplev.c sets only for -Os,
  // and every config here builds -O2. So a read SPELLED above a branch is EMITTED above it — the
  // direction these rows measure. (Not the converse: partial-redundancy elimination does run at
  // -O2, and compiled it inserts a load into a sibling arm the source never read in, so the asm's
  // read block is not proof of the source's.) Compiling the same read once-per-arm emits it once
  // per arm — a second load and a second pool literal for the folded address — so a decompiler
  // that renders a value at its USE site produces a spelling this compiler emits only for a source
  // that read per arm. Verified by compiling the pair: the two spellings differ, and the compiler
  // moves neither.
  //
  // Cut from LoadBGTilemapData in the kleod checkout (agbcc), where re-reading ONE entry byte in two sibling arms
  // is 15 points of the residual. Spelled with absolute GBA addresses so the rows stay
  // self-contained. (Not because a named global is impossible — the GLOBAL ARRAY SHAPE family far
  // below relocates against one and scores — but because these rows isolate a re-read, and the
  // default spelling would be a second moving part.)
  //
  // `readshare` is the isolate: one absolute byte read, two sibling arms, nothing else moving.
  // `readarm` is its control — the same read with BOTH uses inside ONE arm, which asmlift
  // already anchors at the def site, so the capability must leave it exactly where it is.
  // `armshare` is the real function's shape (an indexed byte PAIR above two branches, the low
  // byte used in both arms); it is coverage rather than an isolate, because its shape also
  // carries the struct-array index the /addr-home variation owns. It matches today on the same
  // `/unmerge` variation as the isolate.
  // `readcall` is the one shape a "two or more sibling arms" rule would MISS: a single use,
  // inside a short-circuit's right operand, feeding a call argument. It is the family's one open
  // row — nonmatch 6, winner `unsigned`, carrying no `/unmerge` — and its residual is NOT
  // attributed to the placement rule the other three satisfy. It separates a placement rule keyed
  // on strict dominance from one keyed on arm count.
  //
  // The four below are agbcc only. The mechanism above is a fact about THAT compiler, established
  // by reading its pass list and confirmed by compiling both spellings. Whether ido7.1 and
  // gcc2.7.2kmc move a read the same way is still NOT measured, so those lanes are left off
  // rather than assumed: each needs its own read-it-then-compile-it pair before these rows mean
  // anything there. `readptr` is the one lane that HAS had its pair — see its own comment.
  {
    sym: 'readshare',
    src:
      '#define gKind ((u8 *)0x08057acc)\n' +
      '#define gOutA ((u32 *)0x03003440)\n' +
      '#define gOutB ((u32 *)0x03003444)\n' +
      'void readshare(u32 c){ u32 s = *gKind;' +
      ' if (c & 1){ *gOutA = s << 3; } else { *gOutB = s << 4; } }',
    features: ['read-once', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void readshare(u32 c);',
    proto: { readshare: { returnsVoid: true } },
  },
  {
    sym: 'readarm',
    src:
      '#define gKind ((u8 *)0x08057acc)\n' +
      '#define gOutA ((u32 *)0x03003440)\n' +
      '#define gOutB ((u32 *)0x03003444)\n' +
      'void readarm(u32 c){ u32 s = *gKind;' +
      ' if (c & 1){ *gOutA = s << 3; *gOutB = s << 4; } }',
    features: ['read-once', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void readarm(u32 c);',
    proto: { readarm: { returnsVoid: true } },
  },
  {
    sym: 'armshare',
    src:
      'struct Ent { u8 kind; u8 mode; };\n' +
      '#define gEnts ((struct Ent *)0x08057acc)\n' +
      '#define gFlag ((u8 *)0x03003430)\n' +
      '#define gOutA ((u32 *)0x03003440)\n' +
      '#define gOutB ((u32 *)0x03003444)\n' +
      'void armshare(u32 a0, u32 a1){ struct Ent *e = &gEnts[(a0 << 1) + a1];' +
      ' u32 mode = e->mode; u32 kind = e->kind;' +
      ' if (*gFlag & 1){ if (mode == 2){ *gOutA = kind << 3; } else { *gOutB = kind << 4; } } }',
    features: ['read-once', 'struct', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void armshare(u32 a0, u32 a1);',
    proto: { armshare: { returnsVoid: true } },
  },
  {
    sym: 'readcall',
    src:
      'struct Ent { u8 kind; u8 mode; };\n' +
      'struct Tile { s32 size; s32 pad; };\n' +
      '#define gEnts ((struct Ent *)0x08057acc)\n' +
      '#define gTiles ((struct Tile *)0x08189ccc)\n' +
      '#define gFlag ((u8 *)0x03003430)\n' +
      'u32 decomp(s32 n);\n' +
      'void readcall(u32 a0, u32 a1){ struct Ent *e = &gEnts[(a0 << 1) + a1];' +
      ' u32 mode = e->mode; u32 kind = e->kind;' +
      ' if ((*gFlag & 1) && mode == 2){ decomp(gTiles[kind].size); } }',
    features: ['read-once', 'struct', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'u32 decomp(s32 n); void readcall(u32 a0, u32 a1);',
    proto: { decomp: { params: 1 }, readcall: { returnsVoid: true } },
  },
  // The CodeWarrior lane, and the ONLY row of this family that is not agbcc. `read-once` has no
  // machine floor, so the one thing that can keep it honest is an exemplar per compiler it is
  // claimed on — and the Animal Crossing rows claim it on CodeWarrior. The claim was measured
  // rather than transferred (`packages/cli/test/matching/ppc-tag-lanes.test.ts` holds it): the read
  // spelled once above the branch is emitted once above it into r3, a register live across the
  // branch, and the read spelled per arm is emitted twice into the scratch r0 — 0x24 bytes against
  // 0x28, at `-O4,p` and at the `-O4,s` the real rows build at alike. agbcc's pass list is not the
  // reason; it says nothing about CodeWarrior.
  //
  // Pointer PARAMETERS rather than absolute addresses, which is what the name says: the macros the
  // four rows above use are a GBA memory map, and on PowerPC an absolute address would add a
  // `lis/ori` materialisation — a second moving part in a row whose whole point is one read's
  // placement. Two output pointers rather than a subscripted one, for the same reason: `a[0]`/`a[1]`
  // would make the row an `array` row as well.
  {
    sym: 'readptr',
    src:
      'void readptr(u32 *p, u32 *a, u32 *b, u32 c){ u32 s = *p;' +
      ' if (c & 1){ *a = s << 3; } else { *b = s << 4; } }',
    features: ['read-once', 'branch'],
    toolchains: ['mwcc_242_81'],
    ctx: 'void readptr(u32 *p, u32 *a, u32 *b, u32 c);',
    proto: { readptr: { returnsVoid: true } },
  },

  // WHICH ARMS, IN WHICH ORDER. The read-once family above asks where a value is COMPUTED; this
  // one asks how a multi-way dispatch is GROUPED and SEQUENCED. Same compiler fact underneath:
  // agbcc has no instruction scheduler and no block reordering pass (gcc 2.9-arm's SRCS compiles
  // neither sched.c nor reorg.c), so a switch's case bodies are laid out in SOURCE order and the
  // dispatch tree above them is `expand_end_case`'s balanced search. Reading a 4-case switch back
  // therefore fixes both the grouping and the arm order, and getting either wrong moves every
  // instruction after the first arm.
  //
  // Cut from LoadBGTilemapData in the kleod checkout (agbcc), where it is the single largest class in the residual:
  // rewriting its `if (v1 != 1) { if (v1 <= 1) { if (v1 == 0) … } else { switch { case 2, 3 } } }
  // else { … }` as one four-case `switch` is worth 46 of 547 points — more than every capability
  // the three previous rounds landed for that function, combined. Of the 46, the grouping is 8 and
  // the ARM ORDER is 38: asmlift emits the `!= 1` arm last because an if/else has nowhere else to
  // put it, while the asm lays that body out second.
  //
  // Two defects, one per row, both since CLOSED in structure/switch-recover.ts — the rows now
  // guard them:
  //   • `swarms` — a switch with NO default, which declined to if-nesting. The attribution that
  //     authored this row named the "default entry with a phi" guard, reasoning that the fall-out
  //     edge lands on the phi-carrying MERGE. The run falsified that: instrumenting every
  //     `return null` showed the shape declining at `defaults.length > 1`, and the phi guard never
  //     firing on this corpus at all. gcc 2.9-arm's `emit_case_nodes` gives every subtree that
  //     runs out of case values its OWN jump to the default, so a four-case tree reaches it
  //     through two bare `b .Ldefault` blocks — which recovery counted as two different defaults.
  //     The default candidate is one of those bare blocks, never the merge, which is why the phi
  //     guard cannot be what refuses this shape.
  //   • `swlayout` — the arms once came back sorted by case VALUE. Its source order is 2, 0, 3, 1
  //     and agbcc lays the bodies out in exactly that order (target.o: bodies at
  //     0x18/0x1c/0x20/0x24 = 2, 0, 3, 1); emitting 0, 1, 2, 3 shifts every instruction after the
  //     first arm. It carries a default, so recognition succeeds and
  //     ONLY the order is left — which is what separates it from `swarms`.
  //
  // `swdefault` is the control: byte-identical C to `swarms` except that the fall-out is spelled
  // as `default: w = 0;` instead of an initialiser, which gives the default its own block — one
  // default candidate, so it was recovered before the collapse and must stay recovered after it.
  // The collapse that closed `swarms` is what it guards: two leaves are one default only when each
  // is a bare EXIT to the same place carrying the same values, and this row's real default arm has
  // a body, so nothing may fold it into the fall-out.
  //
  // Two rows for the halves of the ordering rule the four above cannot see:
  //   • `swdefmid` — the same four cases with `default: w = 99;` written THIRD. agbcc expands the
  //     default's body where the source wrote it like any other arm, so its block lands between
  //     case 1's and case 2's, and emitting the label last moves every instruction after it.
  //   • `swjtorder` — five dense arms written 3, 0, 4, 1, 2, with a default. Five is enough for
  //     agbcc to emit a jump TABLE, whose slots are ascending by construction: grouping them in
  //     table order spells the arms 0..4 while the bodies are laid out in the order the arms were
  //     written. `sw_jt` above is the same regime with ascending arms, where the two orders
  //     coincide and the row cannot fire.
  //
  // And two for the `default:` positions those cannot see either, one per regime:
  //   • `swdeffirst` — the same four cases with `default:` written FIRST. That is the one position
  //     where the dispatch RUNS OUT into the default's block instead of jumping to it, and the
  //     reading recovery makes of a fall-through is the one thing the other subtree's surviving
  //     `b .Ldefault` licenses. `swdefmid` cannot see it: at position 2 both subtrees jump.
  //   • `swjtdefmid` — `swjtorder`'s five arms, ascending, with `default:` written THIRD. Under the
  //     jump table the default's body lands where the source wrote it too, and `swjtorder`'s own
  //     default is written LAST, where the layout spelling and C's conventional one coincide.
  //
  // `swmulti` is the real function's shape rather than an isolate: a defaultless switch inside a
  // do-while whose four arms all decide the same three locals. It is the composition rather than
  // an isolate — the arm-order half and the loop's own value placement have to land in the same
  // candidate — and it matches today on `signed/vol-store`.
  //
  // NOT the same gap as `uninit_sw` above, which contains the identical dispatch: there the arms
  // leave a local undefined on the fall-out path, and the arm grouping alone takes that row to
  // MATCH, so the def-less read costs it nothing and the switch was all that stood between it and
  // its target. `swarms` assigns `w = 0` first, which is what keeps the two separable: it isolates
  // the dispatch with no `uninit-local` gap behind it at all.
  //
  // agbcc only, and for the same reason the read-once family is: the inference "the asm's block
  // order is the source's arm order" is a fact about a compiler with no scheduler and no block
  // reordering. The grouping half is a structurer defect and is ISA-independent, but whether
  // ido7.1, gcc2.7.2kmc and mwcc_242_81 preserve arm layout was NOT measured, so those lanes are
  // left off rather than assumed.
  {
    sym: 'swarms',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swarms(s32 mode, s32 n){ s32 w = 0;\n' +
      ' switch (mode) { case 0: w = n + 1; break; case 1: w = n + 2; break;\n' +
      '                 case 2: w = n + 3; break; case 3: w = n + 4; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swarms(s32 mode, s32 n);',
    proto: { swarms: { returnsVoid: true } },
  },
  {
    sym: 'swdefault',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swdefault(s32 mode, s32 n){ s32 w;\n' +
      ' switch (mode) { case 0: w = n + 1; break; case 1: w = n + 2; break;\n' +
      '                 case 2: w = n + 3; break; case 3: w = n + 4; break;\n' +
      '                 default: w = 0; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swdefault(s32 mode, s32 n);',
    proto: { swdefault: { returnsVoid: true } },
  },
  {
    sym: 'swdefmid',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swdefmid(s32 mode, s32 n){ s32 w;\n' +
      ' switch (mode) { case 0: w = n + 1; break; case 1: w = n + 2; break;\n' +
      '                 default: w = 99; break;\n' +
      '                 case 2: w = n + 3; break; case 3: w = n + 4; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swdefmid(s32 mode, s32 n);',
    proto: { swdefmid: { returnsVoid: true } },
  },
  {
    sym: 'swjtorder',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swjtorder(s32 mode, s32 n){ s32 w;\n' +
      ' switch (mode) { case 3: w = n + 4; break; case 0: w = n + 1; break;\n' +
      '                 case 4: w = n + 5; break; case 1: w = n + 2; break;\n' +
      '                 case 2: w = n + 3; break; default: w = 99; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'dense', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swjtorder(s32 mode, s32 n);',
    proto: { swjtorder: { returnsVoid: true } },
  },
  {
    sym: 'swdeffirst',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swdeffirst(s32 mode, s32 n){ s32 w;\n' +
      ' switch (mode) { default: w = 99; break;\n' +
      '                 case 0: w = n + 1; break; case 1: w = n + 2; break;\n' +
      '                 case 2: w = n + 3; break; case 3: w = n + 4; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swdeffirst(s32 mode, s32 n);',
    proto: { swdeffirst: { returnsVoid: true } },
  },
  {
    sym: 'swjtdefmid',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swjtdefmid(s32 mode, s32 n){ s32 w;\n' +
      ' switch (mode) { case 0: w = n + 1; break; case 1: w = n + 2; break;\n' +
      '                 default: w = 99; break;\n' +
      '                 case 2: w = n + 3; break; case 3: w = n + 4; break;\n' +
      '                 case 4: w = n + 5; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'dense', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swjtdefmid(s32 mode, s32 n);',
    proto: { swjtdefmid: { returnsVoid: true } },
  },
  {
    sym: 'swlayout',
    src:
      '#define gOut ((volatile s32 *)0x04000000)\n' +
      'void swlayout(s32 mode, s32 n){ s32 w;\n' +
      ' switch (mode) { case 2: w = n + 3; break; case 0: w = n + 1; break;\n' +
      '                 case 3: w = n + 4; break; case 1: w = n + 2; break;\n' +
      '                 default: w = 0; break; }\n' +
      ' *gOut = w; }',
    features: ['switch-arms', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void swlayout(s32 mode, s32 n);',
    proto: { swlayout: { returnsVoid: true } },
  },
  {
    sym: 'swmulti',
    src:
      'struct Ent { u16 w; u16 h; };\n' +
      '#define gEnts ((struct Ent *)0x03003430)\n' +
      '#define gDma ((volatile s32 *)0x040000d4)\n' +
      'void swmulti(s32 mode, s32 idx, s32 n){ s32 a = 0, b = 0, c = 0; s32 i = 0;\n' +
      ' do {\n' +
      '  switch (mode) {\n' +
      '   case 0: a = gEnts[idx].w; b = 32 - a; c = 0;                break;\n' +
      '   case 1: a = 32;           b = 0;      c = i << 5;           break;\n' +
      '   case 2: a = gEnts[idx].h; b = 32 - a; c = i * gEnts[idx].h; break;\n' +
      '   case 3: a = gEnts[idx].w; b = 16;     c = i & 32;           break;\n' +
      '  }\n' +
      '  gDma[0] = a; gDma[1] = b; gDma[2] = c;\n' +
      '  i++;\n' +
      ' } while (i < n); }',
    features: ['switch-arms', 'merge-chain', 'struct'],
    toolchains: ['agbcc'],
    ctx: 'void swmulti(s32 mode, s32 idx, s32 n);',
    proto: { swmulti: { returnsVoid: true } },
  },

  // WHERE A LOCAL LIVES — the third thing a store to `[sp,#N]` can be. `value-home` above is about
  // which register or offset a value ends up in; this family is about a local the compiler is not
  // ALLOWED to put in a register at all, because its address escapes. That is not a placement
  // preference, it is an instruction-count difference: every assignment becomes a store and every
  // read a load, and in gcc 2.9 the store also kills CSE of pointer-based loads made before it.
  //
  // Verified by compiling five spellings with agbcc 2.9-arm-000512 (`-O2 -mthumb-interwork
  // -fprologue-bugfix`), destination register-homed vs address-taken:
  //
  //   w = 32; if (e->h <= 31) w = e->h;            register-homed  → ONE ldrh (CSE shares it)
  //   t = e->h; w = 32; if (t <= 31) w = e->h;     register-homed  → ONE ldrh
  //   w = 32; if (e->h <= 31) w = e->h; use(&w);   address-taken   → ONE ldrh (store precedes it)
  //   t = e->h; w = 32; if (t <= 31) w = e->h; use(&w);
  //                                                address-taken   → TWO ldrh, the second after
  //                                                                  the `str` that killed the first
  //
  // So both conditions are needed — the memory home AND a load issued before the store — and
  // together they are what a decompiler has to reproduce to get the byte count right.
  //
  // Cut from LoadBGTilemapData in the kleod checkout (agbcc). At its best hand-built spelling (479 against
  // `build/src/gfx.o`, from a 531 baseline) the residual's largest nameable group is exactly this:
  // 15 stores to `[sp,#16..32]` and 5 `ldrh [rN,#18]` in the ROM with no counterpart in the
  // candidate, where the candidate keeps the same values in registers and reads the field once.
  // Forcing the home from the candidate side was measured and is WORSE — `volatile` on the one
  // local costs 29 points (479 → 508), on three costs 23 (→ 502), and moving all three into a
  // local aggregate whose address escapes costs 28 (→ 507) — because those spellings also make
  // every READ a load, which the ROM does not do. So the class is attributed, not closed, and
  // these rows pin the capability that has to exist first.
  //
  // BEFORE ANY OF THAT, asmlift could not LIFT such a function at all: the Thumb frontend refuses a
  // store to `[sp,#N]` that is never reloaded when its lower slots are supplied, on the grounds
  // that it may be a call's outgoing stack argument. For an address-taken local that is a false
  // alarm, and three of these rows carried the decline.
  //
  // That gate is now open for ONE shape and no wider: a frame of exactly one word whose base a
  // bare `mov rD, sp` lets ESCAPE — handed to a callee, or PUBLISHED by a word store through a
  // base that is neither sp nor another capture of this same frame, which is the
  // `*(vu32 *)REG_DMA3SAD = (u32)&tmp` idiom and needs no call in the function at all (a store
  // back into the frame's own bytes hands the address to nobody, and half an address is not the
  // address) — and which the caller either WRITES itself, passes at an
  // argument above r0, or hands only to callees the project declares `void` — any one of the
  // three, since a struct-return temp has none of them. NOT via callee arity, which cannot
  // license an acceptance — a declared parameter list is a LOWER bound (variadics, multi-word parameters, a
  // hidden struct-return pointer), so `arity <= 4` proves nothing and supplying a TRUE fact turned
  // a correct decline into a call with its stack arguments deleted. What the frame size buys
  // instead is that agbcc emits a bare `mov rD, sp` for a block-copy base too — a by-value struct
  // argument's outgoing area, a struct return's hidden pointer — and all but one of those needs at
  // least two frame words. The exception is a struct return of 4 bytes or fewer that is not
  // INTEGER-LIKE (`{char a,b,c,d;}`, `{short a,b;}`), which agbcc returns in memory through a
  // one-word temp: instruction for instruction an out-parameter call. What rules that out is that
  // the temp is storage the CALLEE owns — written only by the callee, and its pointer is argument
  // 0, always. `stkarg` is a MATCH and refuses nothing, because a call whose callee's declaration
  // and whose staging stores agree word for word is consumed, and every disagreement declines
  // naming what it saw (`stack-args.test.ts`).
  //
  // STILL MISSING, and what these rows will pin next: a frame word that is neither an object, a
  // keyed slot, nor a licensed outgoing argument. The object's real extent is inferred from the
  // accesses this function makes, so a wider object has bytes no model describes, and the refusal
  // stands there. An OUTPUT-only parameter taken at
  // argument 0 is the other gap, and it is not narrowable from the assembly at all: it is
  // instruction-for-instruction the struct return above.
  //
  // Coverage: 0 of the corpus's rows carried this decline. `sa3:ProcessOamBuffers:agbcc` is the
  // real row that spells its locals as `add r0, sp, #0x4`, and `stkoff` is that spelling at its
  // smallest: a capture at a CONSTANT frame offset lowers to an `laddr` there, and the audit
  // judges it like any other. What still declines `ProcessOamBuffers` is the rest of its frame —
  // three objects, a capture spilled to a slot, the addresses handed to `CpuSet` and to DMA.
  // Recompute the rows declining on the sp guard rather than read them:
  //   python3 -c "import json; a=json.load(open('apps/benchmark/results/results.json'));
  //   print([r['id'] for r in a['results'] if r['asmlift']['outcome']=='declined' and
  //     any('stack pointer used as data' in m for m in (r['asmlift']['errorMarkers'] or []))])"
  // `pokeemerald:GetMoveTarget:agbcc` is not one of them and is not a stack decline at all: its
  // blocker is the structurer's `unrecovered back-edge into block #8 (loop-recovery declined this
  // shape: multi-latch, irreducible/overlapping loops, a conditional continue, or an unsafe
  // break)`.
  //
  // A TRAP IN THE MESSAGE QUOTED BELOW. `callee \`SetupOAMSprite\` is declared with 9 arguments` is
  // emitted verbatim, but it is the OPENING of a licence refusal that goes on to name the
  // disagreement, not a statement that the capability is missing. A frame staging two of the five
  // words nine parameters ask for continues `so its outgoing stack-argument block is [sp,#0], … —
  // but [sp,#8], [sp,#12], [sp,#16] is not stored on every path to the call` (measured,
  // `--proto '{"SetupOAMSprite":{"params":9}}'`). A function whose declaration and stores AGREE
  // emits no message at all, so the sibling counts below are an upper bound on that shape.
  //
  // `spill10` is the row for a frame of SPILLS live across a call, selected by residual shape
  // rather than by subject: ten locals loaded from `p[0..9]` and read across a `callee(i)` loop, no
  // address taken anywhere. agbcc gives three user locals a frame slot — two of the ten, `v3` at
  // [sp] and `v4` at [sp,#4], plus the accumulator `s` at [sp,#8] — and the 0x18 frame's other
  // three slots are compiler temporaries: the loop-invariant products `p[0]*3` / `p[1]*5` at
  // [sp,#0xc] / [sp,#0x10] and a caller-save of `v9` at [sp,#0x14] around the `bl`. So every slot
  // is a spill, none is address-taken, and each store reaches the `bl` unread with its lower slots
  // supplied — the outgoing-argument shape, and here a false alarm. What tells them apart is that
  // every slot is RELOADED after `bl callee` before anything re-stores it: agbcc's outgoing area
  // belongs to the callee across a call and sits below every local, so a word that outlives a call
  // is a local and bounds the area of every call (`frontend/stackargs.ts`, `loadedWordBound`). The
  // declared arity cannot decide it — `callee` takes one argument, and a declared list is a lower
  // bound on the words a call is handed. The refusal this row guards against — `stack pointer used
  // as data — the store to [sp,#0] reaches \`bl callee\` unread with its lower slots supplied` — was
  // the first blocker of 7 of the 51 klonoa functions selected in the LoadBGTilemapData round, so
  // the row pins a population, not one function. The four stack-heavy siblings that round also
  // ran decline on OTHER links of the same stack-addr chain, which this row does not measure: two
  // on the declared-arity refusal (`callee \`SetupOAMSprite\` is declared with 9 arguments`,
  // `stkarg`'s shape), one address-taken (`a store at [+4] through the captured address`), one
  // `sp moves in a block that neither returns nor is the entry`.
  // Lifted, its residual is 19 register rows and 5 loop-entry rows (a
  // `[sp,#8]` store deleted and a reload replaced, an inserted `mov`, `cmp r1,r10` vs `cmp r0,#0`,
  // `bge` vs `ble`: the `for` rendered as `if (0 >= a0)` + `do {} while`) and NO row whose
  // difference is a `[sp,#k]` offset. The naming walk emits `v0..v9, v10, v11` and the target's
  // slots are `v3@[sp] v4@[sp,#4] s@[sp,#8]`, the same order. So it is NOT a spill-slot-order
  // inhabitant (`spillorder`, in the uninit-local block, is), and its residual belongs to the
  // register half of value-home.
  // agbcc only, by measurement: ido7.1, gcc2.7.2kmc and gcc2.7.2 lift it, but the false alarm it
  // pins is Thumb's outgoing-block licence, which no MIPS lift reaches, and mwcc_242_81 keeps the
  // ten locals in the registers its `_savegpr_19` prologue saves, with no other frame word, so
  // those lanes would measure another capability. Its `value-home` tag is the judgement that
  // the diff, once it lifts, is WHERE the ten locals live; it cannot carry `stack-addr`, whose
  // floor is a unary `&` the source does not contain.
  // m2c NONCOMPILES it on the identical `ctx` (``unksp8' undeclared (first use in this function)`):
  // it renders every spill slot as an undeclared `unkspN` and reads the loop-invariant products
  // `p[0]*3`, `p[1]*5` out of slots `unkspC`/`unksp10` the same way — so it REACHES the shape
  // asmlift refuses, and stalls one gate later on the declaration it never emits.
  //
  // agbcc only. The CSE-barrier half is a fact about gcc 2.9's alias handling, established by
  // compiling the pairs above; ido7.1, gcc2.7.2kmc and mwcc_242_81 were NOT measured, and the
  // outgoing-argument shape the refusal models is AAPCS's, so those lanes are left off rather than
  // assumed.
  //
  // m2c compiles none of the three address-taken rows: it renames the slot `unksp0` and never
  // declares it, on the identical `ctx` asmlift receives. It declines `stkarg` outright
  // (`Unable to find stack arg 0x0`), which is the same blocker asmlift names there.
  //
  // `stkwide` is that licence at a parameter two words wide. `void fived(s32, s32, s32, s32,
  // double)` stages the fifth as two words — `ldr r4, .L3` / `ldr r5, .L3+0x4` / `str r4, [sp]` /
  // `str r5, [sp, #0x4]`, the literal in the pool as `.long 0x3ff80000, 0x0`, HIGH word first
  // (agbcc thumb.h:335 FLOAT_WORDS_BIG_ENDIAN). The proto states the `double` the row's ctx gives
  // m2c, so the block is two words and the pair is read as the literal its words spell, `1.5`
  // (`TargetDescription.doubleArgWords`). Read as a `long long`, the same words are `1073217536`,
  // and that C scores a MATCH too: the callee is `void`, so the candidate never declares it, and an
  // unprototyped call stages a long long exactly as it stages a high-word-first double. The score
  // cannot referee the literal on this row, so `packages/core/test/double-args.test.ts` pins its
  // spelling, and the lift compiled against the ctx is the row's own object.
  //
  // The licence's refusal of a declaration that does not account for every word staged is pinned
  // by `stack-args.test.ts` (the variadic hole) and `stackargs-fixpoint.test.ts`.
  //
  // m2c renders it with SIX arguments, the double split into the two words the ABI staged —
  // `fived(a, b, a + b, a - b, /* f64+0x0 */ 0x3FF80000, /* f64+0x4 */ 0)`, a nonmatch. So the
  // row also records that the one decompiler here that does consume outgoing arguments today
  // counts WORDS as parameters, which is exactly what the two-witness licence refuses to do.
  {
    sym: 'stkwide',
    src:
      'void fived(s32 a, s32 b, s32 c, s32 d, double e);\n' +
      'void stkwide(s32 a, s32 b){ fived(a, b, a + b, a - b, 1.5); }',
    features: ['multi-arg', 'double'],
    toolchains: ['agbcc'],
    ctx: 'void fived(s32 a, s32 b, s32 c, s32 d, double e); void stkwide(s32 a, s32 b);',
    proto: {
      fived: { params: ['s32', 's32', 's32', 's32', 'double'], returnsVoid: true },
      stkwide: { returnsVoid: true },
    },
  },
  // `stkwide`'s literal in the other two places agbcc puts a double argument (thumb.h:632/636): both
  // words in r0:r1 (`dreg`), and split, the HIGH word in r3 and the low at [sp,#0] (`dsplit`). Each
  // is its own branch of the call lowering (`frontend/thumb.ts`), and `stkwide` reaches only the
  // outgoing-block one. The same caveat holds: the callee is `void` and undeclared in the candidate,
  // so the score cannot tell `1.5` from the integer its words spell as a `long long`.
  {
    sym: 'dreg',
    src: 'void g(double x);\nvoid dreg(void){ g(1.5); }',
    features: ['double'],
    toolchains: ['agbcc'],
    ctx: 'void g(double x); void dreg(void);',
    proto: { g: { params: ['double'], returnsVoid: true }, dreg: { returnsVoid: true } },
  },
  {
    sym: 'dsplit',
    src: 'void f4(s32 a, s32 b, s32 c, double d);\nvoid dsplit(s32 a, s32 b){ f4(a, b, 7, 1.5); }',
    features: ['multi-arg', 'double'],
    toolchains: ['agbcc'],
    ctx: 'void f4(s32 a, s32 b, s32 c, double d); void dsplit(s32 a, s32 b);',
    proto: { f4: { params: ['s32', 's32', 's32', 'double'], returnsVoid: true }, dsplit: { returnsVoid: true } },
  },
  {
    sym: 'stkaddr',
    src:
      'struct Ent { u16 pad[9]; u16 h; };\n' +
      '#define gEnts ((struct Ent *)0x08057acc)\n' +
      'void use(s32 *p);\n' +
      'void stkaddr(u32 i){ s32 w; w = gEnts[i].h; use(&w); }',
    features: ['stack-addr', 'struct'],
    toolchains: ['agbcc'],
    ctx: 'void use(s32 *p); void stkaddr(u32 i);',
    proto: { use: { params: 1, returnsVoid: true }, stkaddr: { returnsVoid: true } },
  },
  {
    sym: 'stkcall',
    src:
      'struct Ent { u16 pad[9]; u16 h; };\n' +
      '#define gEnts ((struct Ent *)0x08057acc)\n' +
      's32 four(s32 a, s32 b, s32 c, s32 d);\n' +
      'void use(s32 *p);\n' +
      'void stkcall(u32 i, s32 a, s32 b, s32 c){ s32 w; s32 k = a + b + c;' +
      ' w = gEnts[i].h; k += four(a, b, c, w); use(&w); four(k, k, k, k); }',
    features: ['stack-addr', 'struct'],
    toolchains: ['agbcc'],
    ctx: 's32 four(s32 a, s32 b, s32 c, s32 d); void use(s32 *p); void stkcall(u32 i, s32 a, s32 b, s32 c);',
    proto: { four: { params: 4 }, use: { params: 1, returnsVoid: true }, stkcall: { returnsVoid: true } },
  },
  {
    sym: 'stkarg',
    src:
      's32 five(s32 a, s32 b, s32 c, s32 d, s32 e);\n' +
      '#define gOut ((volatile s32 *)0x03003440)\n' +
      'void stkarg(s32 a, s32 b){ *gOut = five(a, b, a + b, a - b, a * b); }',
    features: ['multi-arg'],
    toolchains: ['agbcc'],
    ctx: 's32 five(s32 a, s32 b, s32 c, s32 d, s32 e); void stkarg(s32 a, s32 b);',
    proto: { five: { params: 5 }, stkarg: { returnsVoid: true } },
  },
  {
    sym: 'stkclamp',
    src:
      'struct Ent { u16 pad[9]; u16 h; };\n' +
      '#define gEnts ((struct Ent *)0x08057acc)\n' +
      'void use(s32 *p);\n' +
      'void stkclamp(u32 i){ s32 w; u16 t = gEnts[i].h;' +
      ' w = 32; if (t <= 31) { w = gEnts[i].h; } use(&w); }',
    features: ['stack-addr', 'struct'],
    toolchains: ['agbcc'],
    ctx: 'void use(s32 *p); void stkclamp(u32 i);',
    proto: { use: { params: 1, returnsVoid: true }, stkclamp: { returnsVoid: true } },
  },
  {
    sym: 'spill10',
    src:
      'int callee(int);\n' +
      'int spill10(int k, int *p) {\n' +
      '    int v0, v1, v2, v3, v4, v5, v6, v7, v8, v9; int i, s = 0;\n' +
      '    v0 = p[0]; v1 = p[1]; v2 = p[2]; v3 = p[3]; v4 = p[4]; v5 = p[5]; v6 = p[6]; v7 = p[7]; v8 = p[8]; v9 = p[9];\n' +
      '    for (i = 0; i < k; i++) {\n' +
      '        s += callee(i) + v0 * 3 + v1 * 5 + v2 * 7 + v3 * 11 + v4 * 13 + v5 * 17 + v6 * 19 + v7 * 23 + v8 * 29 + v9 * 31;\n' +
      '    }\n' +
      '    return s;\n' +
      '}',
    features: ['value-home', 'array'],
    toolchains: ['agbcc'],
    ctx: 'int callee(int); int spill10(int k, int *p);',
    proto: { callee: { params: 1 } },
  },
  // `spillarg` is `spill10` with a genuine outgoing argument under the spills: `five(i, 1, 2, 3,
  // v0)` stages argument 5 at [sp,#0] before every call and agbcc moves the spills above it, to
  // [sp,#4]..[sp,#0x20]. Several reach `bl five` unread, so the declaration (`five` takes one stack
  // word) and the staged words disagree until the words reloaded after the call are read as the
  // locals they are — the licence's NOTHING EXTRA, bounded by `loadedWordBound`. It is the row that
  // bound protects: without it the row declines on `[sp,#12], … also reaches the call unread`, and
  // the winner must keep `five(…, v0)`'s fifth argument. m2c noncompiles it (`request for member
  // \`unk0' in something not a structure or union`).
  {
    sym: 'spillarg',
    src:
      'int five(int a, int b, int c, int d, int e);\n' +
      'int one(int);\n' +
      'int spillarg(int k, int *p) {\n' +
      '    int v0, v1, v2, v3, v4, v5, v6, v7, v8, v9; int i, s = 0;\n' +
      '    v0 = p[0]; v1 = p[1]; v2 = p[2]; v3 = p[3]; v4 = p[4]; v5 = p[5]; v6 = p[6]; v7 = p[7]; v8 = p[8]; v9 = p[9];\n' +
      '    for (i = 0; i < k; i++) {\n' +
      '        s += five(i, 1, 2, 3, v0) + one(i) + v0 * 3 + v1 * 5 + v2 * 7 + v3 * 11 + v4 * 13 + v5 * 17 + v6 * 19 + v7 * 23 + v8 * 29 + v9 * 31;\n' +
      '    }\n' +
      '    return s;\n' +
      '}',
    features: ['multi-arg', 'array'],
    toolchains: ['agbcc'],
    ctx: 'int five(int a, int b, int c, int d, int e); int one(int); int spillarg(int k, int *p);',
    proto: { five: { params: 5 }, one: { params: 1 } },
  },

  // WHERE A CONSTANT OFFSET LIVES. The value-home family above asks which register or slot holds a
  // value; this one asks whether a constant ADDED to it is part of the home or part of each use.
  // A buffer pointer that the source advanced once (`p = alloc(k) + 4`) and a decompiler that
  // re-derives the same address at every site (`*(u8 *)(base + 4 + i)`) describe the same bytes and
  // compile to the same INSTRUCTION COUNT — they differ only in which operand carries the 4, which
  // is why the class shows up as argument mismatches and never as a size difference.
  //
  // Verified by compiling the pair with agbcc 2.9-arm-000512 (`-O2 -mthumb-interwork
  // -fprologue-bugfix`), same body, only the offset moved:
  //
  //   p = (u8 *)getbuf(k) + 4;  sink(p[i]);        putbuf(p - 4);
  //       add r5, r0, #0x4   @ materialised once, then  add r0, r5, r4 / ldrb r0, [r0]
  //       sub r0, r5, #0x4   @ and undone at the free
  //   v = getbuf(k);          sink(*(u8*)(v+4+i)); putbuf(v + 4 - 4);
  //       add r5, r0, #0     @ no offset in the home, then  add r0, r4, r5 / ldrb r0, [r0, #0x4]
  //       add r0, r5, #0     @ and `+4-4` folds away entirely
  //
  // So the compiler moves NEITHER spelling toward the other: the offset stays where the source put
  // it, and getting it wrong costs one operand on every use plus the two ends of the round trip.
  //
  // Cut from LoadBGTilemapData in the kleod checkout (agbcc), which allocates twice and frees twice through exactly
  // this shape (`thunk_HeapFree(alloc + 4 - 4)`). At the round's best hand-built spelling, homing
  // both `+ 4`s is worth 1 point (475 -> 474 against `build/src/gfx.o`) and removes 3 of the 4 ROM
  // instructions that had no counterpart — `mov r1, #4`, `ldrb r0, [r0, #0]` and `sub r0, #4` go,
  // and `sub r6, #4` stays. Round 2 measured the same edit at +5 on a 531-point rung and
  // excluded it; the sign flips once the switch and the guard placements above it are right, which
  // is why this is recorded as a row and not as an exclusion.
  //
  // `offhome` is the isolate: one call result, one `+ 4`, one indexed read, one free — and it is
  // what pins `/expr-home`'s scope (structure/analysis.ts loopSharedConsumers) at ONE in-loop
  // consumer plus one anywhere, since the bias is read once inside the loop and once at the free.
  // `offuse` is its control — the same call whose result is read at ONE constant offset and freed
  // unchanged, where folding the offset into the load is what the ROM does and asmlift MATCHes; a
  // rule that always hoisted a constant offset into the home would break it, and the loop gate is
  // why this one cannot (`offuse` has no loop, so the variation is not even enumerated). `offloop` is
  // the real function's shape rather than an isolate: the same bias with a strength-reduced
  // induction variable also riding it. Its residual is not the bias — it is the induction
  // variable, and `offgiv` below is the isolate that proves it (the same 3, with no `/expr-home`
  // in the winner). Both are MATCH now.
  //
  // AND THE ZERO-TRIP GUARD IS NOT `offloop`'S RESIDUAL, pinned here because the shape invites
  // that reading. Measured by compiling asmlift's own emitted C with this agbcc: moving the
  // induction variable's init copy below the guard by hand still scores 3, while deleting the
  // variable outright is byte-exact WITH the guard and WITHOUT it, both — the guard is irrelevant
  // in either direction. `/initfirst`, the shipped guard-placement variation, has NO REACH here — it
  // declines on every call because the recovered tree carries no `if` at all (the call count is
  // the candidate fan and moves whenever the fan does, so it is not quoted) — against `armfall`,
  // where the same probe shows it firing and LOSING at 9 to the winner's 8. Two different arms of the
  // no-reach/loses/does-not-compose distinction, and neither is this row's residual.
  //
  // agbcc only. The claim is about what THIS compiler does with the two spellings, established by
  // compiling both; ido7.1, gcc2.7.2kmc and mwcc_242_81 were NOT measured, so those lanes are left
  // off rather than assumed.
  //
  // m2c compiles none of the three, on the identical `ctx` asmlift receives: it types the call
  // result as `s32` and then dereferences it (`*(temp_r5 + var_r4)`), and on `offuse` it types the
  // same result as `void *` and reads `temp_r0->unk4`. It noncompiles the two `offhi_` rows too,
  // there on `(void *)0x03000004->unk0` — the raw-address rendering, not context withheld — and
  // its output is the neat control on this question: it writes the SAME fused initializer for both
  // (`temp_r9 = getbuf(k) + 4;` on the split target, `temp_sl = getbuf(k) + 4;` on the fused one),
  // naming the register home it read and folding the addend either way.
  //
  // THE SAME CONSTANT, ONE REGISTER CLASS HIGHER — `offhi_split` / `offhi_fused`. The three rows
  // above all sit entirely in LO_REGS (`grep -c "r8\|r9\|sl\|fp"` over `offhome`'s own compiled
  // reference: 0), and there the two spellings differ only in WHICH operand carries the 4. Raise
  // the register pressure until the buffer pointer's home is a HIGH register and a THIRD fact
  // appears, which those rows structurally cannot see: agbcc's `addsi3` (agbcc/gcc/thumb.md:595)
  // offers an immediate op2 only on the alternatives that constrain op0 to `l` (LO_REGS); its two
  // high-register alternatives (`*h`, `*r`) require op2 to be a REGISTER. So `hi = call(); hi += 4;`
  // must become `mov rH, r0 / mov rL, #4 / add rH, rH, rL`, while `hi = call() + 4;` does the add
  // while the result is still in `r0`. Compiled pair, this agbcc, four values kept live across the
  // loop so the home lands above r7 and nothing spills:
  //     p = getbuf(k); p = p + 4;   ->  bl getbuf / mov r9, r0 / mov r0, #0x4 / add r9, r9, r0
  //     p = getbuf(k) + 4;          ->  bl getbuf / add r0, r0, #0x4 / mov sl, r0
  // The ROM this was cut from writes the first shape (`3414: mov r8, r0` / `3416: movs r1, #4` /
  // `3418: add r8, r1`) and asmlift writes the second — so reproducing `mov/movs/add` here is a
  // GAIN, not the regression the shape's read-back cousin looks like.
  //
  // `offhi_fused` is the HIGH-register control and asmlift MATCHes it. `offhi_split` is the gap,
  // and its endpoint is proved rather than argued: asmlift's OWN emitted C for it scores 12, and
  // that same C with the one initializer split in two (`v0 = getbuf(a0); v0 = v0 + 4;`) scores 0,
  // byte-exact. The whole 12 is one statement, and that byte-exactness is also what establishes
  // NO REACH for the row without a census: a candidate carrying the split spelling would have
  // scored 0 and the row would read MATCH, not diff:12.
  // The shape of the fan is a separate observation and belongs to a STANDALONE probe of the same
  // asm rather than to this row — that probe was run without a `ctx` at all, so
  // its candidates score against a differently-lifted call — best 23 where this row's best is 12.
  // The enumeration itself is the same either way: 12 candidates under the same variations, and
  // a `void offhi_split(u32 a0)` whose row `proto` bounds its argument registers (without it the
  // signature carries a second, unread parameter). Of the 12 candidates 6 spell
  // `v0 = getbuf(a0) + 4;`
  // and 6 spell `v0 = getbuf(a0);` with the bias re-derived at every use (`*(u8 *)(v0 + 4 + v6)`,
  // `putbuf(v0 + 4 - 4)`). Those are the two points of the `/expr-home` lattice `offhome` and
  // `offuse` bracket, and neither of them is the split — a home that receives the RAW call result
  // and takes the addend in a following statement is a third spelling the variation does not have.
  {
    sym: 'offhome',
    src:
      'void *getbuf(s32 k);\n' +
      'void putbuf(void *p);\n' +
      'void sink(s32 x);\n' +
      'void offhome(s32 k, s32 n){ u8 *p; s32 i;' +
      ' p = (u8 *)getbuf(k) + 4;' +
      ' for (i = 0; i < n; i = i + 1) { sink(p[i]); }' +
      ' putbuf(p - 4); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void *getbuf(s32 k); void putbuf(void *p); void sink(s32 x); void offhome(s32 k, s32 n);',
    proto: {
      getbuf: { params: 1 },
      putbuf: { params: 1, returnsVoid: true },
      sink: { params: 1, returnsVoid: true },
      offhome: { returnsVoid: true },
    },
  },
  {
    sym: 'offuse',
    src:
      'void *getbuf(s32 k);\n' +
      'void putbuf(void *p);\n' +
      'void sink(s32 x);\n' +
      'void offuse(s32 k){ u8 *p;' +
      ' p = (u8 *)getbuf(k);' +
      ' sink(p[4]);' +
      ' putbuf(p); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void *getbuf(s32 k); void putbuf(void *p); void sink(s32 x); void offuse(s32 k);',
    proto: {
      getbuf: { params: 1 },
      putbuf: { params: 1, returnsVoid: true },
      sink: { params: 1, returnsVoid: true },
      offuse: { returnsVoid: true },
    },
  },
  {
    sym: 'offloop',
    src:
      'void *getbuf(s32 k);\n' +
      'void putbuf(void *p);\n' +
      '#define gDma ((volatile s32 *)0x040000d4)\n' +
      'void offloop(s32 k, s32 n){ u8 *p; s32 i;' +
      ' p = (u8 *)getbuf(k) + 4;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' gDma[0] = (s32)(p + (i << 6));' +
      ' gDma[2] = p[i]; }' +
      ' putbuf(p - 4); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void *getbuf(s32 k); void putbuf(void *p); void offloop(s32 k, s32 n);',
    proto: {
      getbuf: { params: 1 },
      putbuf: { params: 1, returnsVoid: true },
      offloop: { returnsVoid: true },
    },
  },

  // THE COUNTER'S START, WHEN IT IS THE LITERAL 0 — `offgiv` is `offloop` with the `+ 4` bias
  // removed, and it is the isolate that separates this family's two mechanisms. It was authored at
  // the same 3 as `offloop`, with no `/expr-home` in its winner (`signed/vol-store` against
  // `offloop`'s `signed/expr-home/vol-store`), so the residual was not the value home: it was the
  // strength-reduced induction variable's init copy, alone. The guard is not that residual either
  // — see the family comment above `offhome`.
  //
  // AND IT IS THE `/unreduce` FAMILY, one class its variation could not reach. `dmafill` and friends
  // start the counter at the PARAMETER `lo`, so the compiler-created giv's init is
  // `base + lo * 64` — it NAMES the start, and the substitutional closed form `INIT[lo := i]`
  // recovers it. Start the counter at a constant and agbcc folds `p + (0 << 6)` to `p` before
  // anything reaches the asm: the start term is GONE from the init, and the same loop needs the
  // ADDITIVE closed form `INIT + (i << 6)` instead. Same giv, same compiler pass, other pre-image.
  //
  // WHY THE ISOLATE HAS TO LOOK LIKE THIS, established by compiling four rejected drafts of it.
  // The class needs all three of: (a) the counter's start is the literal 0, or nothing folds;
  // (b) some OTHER use pins the counter, here `p[i]` — with the counter unused agbcc reverses the
  // loop into a countdown on the trip count and the reduced spelling matches outright (measured:
  // MATCH); and (c) the base arrives in a register from a computation, here the call, so its copy
  // competes with the loop-invariant hoist for the preheader slot — with a base that is already a
  // parameter the copy is free and the row MATCHes too (measured: MATCH). A draft missing any one
  // of the three is not an inhabitant.
  {
    sym: 'offgiv',
    src:
      'void *getbuf(s32 k);\n' +
      '#define gDma ((volatile s32 *)0x040000d4)\n' +
      'void offgiv(s32 k, s32 n){ u8 *p; s32 i;' +
      ' p = (u8 *)getbuf(k);' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' gDma[0] = (s32)(p + (i << 6));' +
      ' gDma[2] = p[i]; } }',
    features: ['pointer'],
    toolchains: ['agbcc'],
    ctx: 'void *getbuf(s32 k); void offgiv(s32 k, s32 n);',
    proto: { getbuf: { params: 1 }, offgiv: { returnsVoid: true } },
  },

  // TWO MORE STRIDES, because `offgiv` varies nothing. It is `offloop` with two terms deleted and
  // the SAME `<< 6`, so between them the class has one shape measured twice — which is not
  // evidence that the closed form is a relation rather than one function's arithmetic. These two
  // move the only parameter the additive form has.
  //
  // `offgiv2` is the stride `<< 2`, a shift Thumb's `add rd, #imm8` CAN spell in the step. It is a
  // genuine inhabitant and not a row the variation was tuned on: in its own ranked table the best
  // candidate carrying no `/unreduce` scores 3 and every candidate carrying `/unreduce` scores 0, so the
  // whole residual is the un-reduction at a stride the branch was never measured on.
  //
  // `offgiv3` is the stride `<< 8`, and it is the one that is NOT about the class. 256 does not
  // fit Thumb's 8-bit add immediate, so agbcc spells the giv's step `mov #128 / lsl #1` and
  // asmlift's L3 tree keeps it as the `bin` node `128 << 1`. Every stated scope condition holds —
  // the start is the literal 0, the counter steps by 1, the stride is a constant power of two —
  // and the relation reads that node as its VALUE rather than its SPELLING, on both paths — the
  // substitutional one compares an unfolded multiplier against a folded stride the same way — so
  // `/unreduce` fires here and wins (`signed/copy-defpos/vol-store/unreduce`, MATCH). What the row
  // pins is that a refusal on asmlift's own folding, in a variation whose framing is the COMPILER's
  // folding, must not come back.
  {
    sym: 'offgiv2',
    src:
      'void *getbuf(s32 k);\n' +
      '#define gDma ((volatile s32 *)0x040000d4)\n' +
      'void offgiv2(s32 k, s32 n){ u8 *p; s32 i;' +
      ' p = (u8 *)getbuf(k);' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' gDma[0] = (s32)(p + (i << 2));' +
      ' gDma[2] = p[i]; } }',
    features: ['pointer'],
    toolchains: ['agbcc'],
    ctx: 'void *getbuf(s32 k); void offgiv2(s32 k, s32 n);',
    proto: { getbuf: { params: 1 }, offgiv2: { returnsVoid: true } },
  },
  {
    sym: 'offgiv3',
    src:
      'void *getbuf(s32 k);\n' +
      '#define gDma ((volatile s32 *)0x040000d4)\n' +
      'void offgiv3(s32 k, s32 n){ u8 *p; s32 i;' +
      ' p = (u8 *)getbuf(k);' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' gDma[0] = (s32)(p + (i << 8));' +
      ' gDma[2] = p[i]; } }',
    features: ['pointer'],
    toolchains: ['agbcc'],
    ctx: 'void *getbuf(s32 k); void offgiv3(s32 k, s32 n);',
    proto: { getbuf: { params: 1 }, offgiv3: { returnsVoid: true } },
  },

  {
    sym: 'offhi_split',
    src:
      'void *getbuf(s32 k);\n' +
      'void putbuf(void *p);\n' +
      'void sink(s32 x);\n' +
      '#define gW ((volatile s32 *)0x03000000)\n' +
      'void offhi_split(s32 k){ u8 *p; s32 i, n, a, b, c, d;' +
      ' p = (u8 *)getbuf(k); p = p + 4;' +
      ' n = gW[0]; a = gW[1]; b = gW[2]; c = gW[3]; d = gW[4];' +
      ' for (i = 0; i < n; i = i + 1) { sink(p[i]); sink(a); sink(b); sink(c); sink(d); }' +
      ' sink(a); sink(b); sink(c); sink(d);' +
      ' putbuf(p - 4); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void *getbuf(s32 k); void putbuf(void *p); void sink(s32 x); void offhi_split(s32 k);',
    proto: {
      getbuf: { params: 1 },
      putbuf: { params: 1, returnsVoid: true },
      sink: { params: 1, returnsVoid: true },
      offhi_split: { params: ['s32'], returnsVoid: true },
    },
  },
  {
    sym: 'offhi_fused',
    src:
      'void *getbuf(s32 k);\n' +
      'void putbuf(void *p);\n' +
      'void sink(s32 x);\n' +
      '#define gW ((volatile s32 *)0x03000000)\n' +
      'void offhi_fused(s32 k){ u8 *p; s32 i, n, a, b, c, d;' +
      ' p = (u8 *)getbuf(k) + 4;' +
      ' n = gW[0]; a = gW[1]; b = gW[2]; c = gW[3]; d = gW[4];' +
      ' for (i = 0; i < n; i = i + 1) { sink(p[i]); sink(a); sink(b); sink(c); sink(d); }' +
      ' sink(a); sink(b); sink(c); sink(d);' +
      ' putbuf(p - 4); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void *getbuf(s32 k); void putbuf(void *p); void sink(s32 x); void offhi_fused(s32 k);',
    proto: {
      getbuf: { params: 1 },
      putbuf: { params: 1, returnsVoid: true },
      sink: { params: 1, returnsVoid: true },
      offhi_fused: { params: ['s32'], returnsVoid: true },
    },
  },

  // WHAT ENTERS A LOOP-CARRIED VALUE ON ITS FIRST ITERATION. The `uninit-local` family above
  // already asks what a decompiler does with a local read on a path that never assigns it, and
  // already records the register answer: nothing guards it, and the read becomes a fabricated
  // extra parameter. This family is the LOOP-CARRIED entry of that same question, which those
  // rows do not reach: their undef is decided at an ordinary join, and even where the value is
  // then used in a loop (`uninit_spill`) the phi is not a loop header's. Here it is, so the
  // fabrication lands in the preheader and its register is pinned across the whole loop.
  //
  // A local decided inside a loop body on some but not all paths is a loop-carried phi whose
  // entry operand is UNDEFINED. C spells that by simply not initialising it and agbcc emits no
  // instruction for it. asmlift used to materialise the entry as a READ — of an uninitialised
  // stack slot, or of a parameter it invented for the purpose. The cost was NOT the read: on
  // `loopfall` agbcc emits no instruction for `v1 = a1;` at all, since `a1` arrives in the
  // register `v1` is allocated to and the copy coalesces away. What it cost was the pin — a
  // register occupied across the loop, and a different allocation downstream.
  //
  // Two rules close it, and each covers one of the two ways the entry got materialised. An `undef`
  // reaching a merge as an EDGE ARGUMENT emits no copy (structure.ts undefCarriesNothing), and a
  // saved register the ABI does not pass arguments in is an `undef` rather than a parameter in the
  // first place (target.nonArgRegs, frontend/ssa.ts). `loopfall` MATCHes on both together.
  //
  // WHAT IS LEFT is the case neither rule can reach: a def-less read of an ARGUMENT register past
  // the function's real arity. Nothing in the asm separates "argument 3" from "a local agbcc homed
  // in r2", so `armfall` still declares four parameters for a two-parameter source and still opens
  // its loop with `v3 = a2;`. That is an arity question, not an initialisation one.
  //
  // Measured on LoadBGTilemapData in the kleod checkout (agbcc), both directions. The reference source carries three
  // register-allocation coercions (statements with no semantic content, marked `// FAKE?` there)
  // and the ADDING number is quoted with them deleted, because they and the materialisation
  // contend for the same registers and stacking them double-counts:
  //   • REMOVING the five preheader reads from asmlift's own ranked winner (20608 candidates, 0
  //     dropped, `unsigned/flip-branch/flip-join/merge-names/addr-home/expr-home/coalesce-v9-v23/
  //     initfirst/raw-globals`) takes it from 473 to 459 against `build/src/gfx.o` — 14 points of
  //     today's residual. The same edit against the OTHER decomp's object reads 479 to 462; that
  //     rig scores the identical winner C 6 points higher, so the two are not interchangeable.
  //   • ADDING five preheader reads of the same shape to the reference C: 207 to 386, i.e. +179.
  // Both endpoints were taken against the ranked winner OF THAT RUN, and its variations are not a handle
  // that survives: a variation's suffix names a sense relative to the target's DEFAULT, so `/flip-join`
  // in it denotes the opposite spelling to the one it denotes now. Measured at #107 (`b227590e`)
  // and not re-run since, the same command reported
  // `40320 candidate(s) scored, 0 dropped, best unsigned/flip-branch/defsite/merge-names/
  // addr-home/uns-cmp/livebase-block/volatile/coalesce-v17-v10/initfirst/raw-globals: 395`. What
  // transfers between runs is the SHAPE of the edit, never the winner's variations.
  // The construct is cheap to carry when everything else is already wrong and a hard blocker once
  // it is not, which is why both directions are quoted rather than either alone.
  //
  // AND THE PRICE IS NOT FOR THE UNDEFINEDNESS — controls on the same reference and rig, each
  // keeping all five preheader materialisations and changing ONLY where their values come from:
  //     five preheader reads of UNDEFINED locals (what this family names) .... 386  (+179)
  //     the three local sources defined at their declarations ................ 402  (+195)
  //     the three defined by assignment just above the copies ................ 392  (+185)
  //     all five sourced from ordinary extra parameters ...................... 399  (+192)
  //     all five sourced from the constant 0 ................................. 246   (+39)
  // Every DEFINED source costs MORE. So the cost is the pin, exactly as the paragraph above says,
  // and not the `undef`: five extra values materialised in a preheader and live across the nest,
  // which is the same register budget `/expr-home` and `/addr-home` spend. Only the constant is
  // cheap, because it is rematerialised and extends no live range. A rewrite that stops SPELLING the entry
  // as an undefined read but still emits the copy will move these rows by nothing.
  //
  // `loopfall` is the isolate and `loopset` its control: byte-identical C except for the
  // `else { w = 0; }`. Both MATCH now; the pair is what keeps them matching for the same reason,
  // since a rule that dropped a copy the destination still needed would break the control alone.
  //
  // `armfall` and `armdef` are the same pair at the real function's shape: a switch with no
  // default inside a loop, whose arms decide two locals that the body then uses, so BOTH become
  // loop-carried phis with undefined entries. They are coverage, not isolates — and they carry a
  // second thing the pair above does not: agbcc spells `case 0:` of an unsigned switch as
  // `cmp #1`/`bcc`, the SUBTREE BOUND rather than the value, so recovering it needs a relational
  // dispatch edge admitting exactly one value to route a case (structure/switch-recover.ts). Read
  // as navigation instead, that arm is a second default candidate, the whole tree declines to
  // if-nesting, and both the compare and the arm layout change with it. `armdef` MATCHes on that,
  // and is also what pins the reading's three refusals on agbcc: the BRANCH of the test, never its
  // fall-through; never the test that OPENS the dispatch; and only on a compiler that declared the
  // spelling (`switchBoundCase`, `'taken'` on agbcc). Each is a shape `emit_case_nodes` cannot
  // emit, so a relational test in it is an ordinary comparison and recovers as one.
  // What the pair adds over `loopfall` is that the undef survives multi-arm merging: `armdef`
  // carries no preheader read and `armfall` carries one, `v3 = a2;` — the argument-register
  // fabrication the rules above cannot reach. It costs `armfall` nothing at this rung, for the
  // reason `loopfall` records: `a2` arrives in the register `v3` is allocated to, the copy
  // coalesces, and agbcc emits no instruction for it. `armfall`'s residual 8 is the ZERO-TRIP
  // GUARD instead — the reference inits the counter above the test (`mov r6,#0 / cmp r6,r7 / bcs`)
  // where the candidate tests the bound against zero and then stages the second induction
  // register in two moves. Compiled both ways and diffed: the reference's `movs r6,#0 / cmp r6,r7 /
  // bcs / mov ip,r6` is four instructions to the winner's `cmp r7,#0 / beq / movs r0,#0 / mov ip,r0
  // / movs r6,#0` — one insert, and the `ip` stage reads a different register because the guard did
  // not leave a zero in the counter. That is the whole 8 (breakdown: insert 2, delete 2,
  // opMismatch 1, argMismatch 3). The `/initfirst` sibling is enumerated and scores 9, so the
  // guard-placement family does not close this shape on its own.
  //
  // WHY THERE IS NO ROW FOR MORE UNDEFINED ENTRIES. A ladder was measured off this family's own
  // shape, holding it fixed and varying only how many locals the arm decides (agbcc; each control
  // the same C plus the `else`, and every control MATCHes). Re-measured with the two rules above in
  // place: rung 1 is `loopfall` itself at 0, rung 4 is 14, rung 5 is 28, rung 6 is 31.
  //
  // The rungs do not stay in one class, and the claim is only about the one they leave. Every entry
  // agbcc homes in r4-r7 costs nothing now. What the higher rungs add is entries homed in an
  // ARGUMENT register — at rung 4 agbcc takes r7/r5/r4/r3 and asmlift fabricates `a1` for the r3
  // one, and no `nonArgRegs` rule can cover that, because a caller really can pass a value in r3.
  // So: no longer rung is a REGISTER fabrication this pair does not already hold, and the residue
  // above rung 3 is the argument-register fabrication `armfall` gates at 23. Nothing here reaches
  // a fabricated stack argument: rung 6 spills a real entry to `[sp]` and asmlift still fabricates
  // a REGISTER for it.
  //
  // Multiplicity is severity: NO choice of fabricated parameter
  // was free at ANY rung (at rung 1 the three spellings scored 13/12/9, at rung 3 all six
  // permutations 8..11), and only a spelling that materialised NOTHING reached 0 — which is what
  // the two rules above now emit for the callee-saved homes.
  //
  // agbcc only. The claim is about what THIS compiler emits for an uninitialised loop-carried
  // local, established by compiling both spellings of each pair; ido7.1, gcc2.7.2kmc and
  // mwcc_242_81 were NOT measured, so those lanes are left off rather than assumed.
  //
  // NOT `merge-chain`, on `loopfall`/`loopset`. That tag is reserved for arms deciding more than
  // one value; these decide exactly one (`w`) — `i` is the induction variable. The machine floor
  // does not catch it because it counts DECLARED locals and `u32 w, i;` is two, which is the
  // body-vs-declaration gap the floor's own comment calls out. `armfall`/`armdef` DO decide two
  // (`w` and `h`, both computed), and keep it.
  //
  // m2c, on the identical `ctx` asmlift receives, produces compilable C for none of the four, and
  // it reaches the same construct on the two rows that have one. On `armfall` it DECLINES:
  // `M2C_ERROR(/* Read from unset register $r2 */)`, beside its own fabricated entry read
  // `var_r5 = saved_reg_r5;`. On `loopfall` it noncompiles ON that fabrication — the first error
  // is `` `saved_reg_r4' undeclared ``, from its own `var_r4 = saved_reg_r4;`. Both decompilers
  // hit the undefined loop-carried entry, in the same place; only the failure mode differs.
  // The other two errors are not about this family and are not evidence for it: every one of the
  // four also types the address constant as `void *` and reads members off it (`var_r3->unk0`),
  // which is m2c's documented behaviour for a raw address with no struct context; and `armdef`
  // fails FIRST on `` `NULL' undeclared ``, which is a thin-`ctx` artifact — any real project
  // context declares NULL — so that row's classification rests on the `void *` error, not on it.
  {
    sym: 'loopfall',
    src:
      '#define gSrc ((u32 *)0x03003430)\n' +
      '#define gOut ((u32 *)0x03003440)\n' +
      'void loopfall(u32 n){ u32 w, i;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' if (gSrc[i] < 8) { w = gSrc[i] >> 2; }' +
      ' gOut[i] = w; } }',
    features: ['uninit-local'],
    toolchains: ['agbcc'],
    ctx: 'void loopfall(u32 n);',
    proto: { loopfall: { returnsVoid: true } },
  },
  {
    sym: 'loopset',
    src:
      '#define gSrc ((u32 *)0x03003430)\n' +
      '#define gOut ((u32 *)0x03003440)\n' +
      'void loopset(u32 n){ u32 w, i;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' if (gSrc[i] < 8) { w = gSrc[i] >> 2; } else { w = 0; }' +
      ' gOut[i] = w; } }',
    features: [],
    toolchains: ['agbcc'],
    ctx: 'void loopset(u32 n);',
    proto: { loopset: { returnsVoid: true } },
  },
  {
    sym: 'armfall',
    src:
      'struct Bg { u16 h; u16 v; };\n' +
      '#define gBgs ((struct Bg *)0x03003430)\n' +
      '#define gOut ((u32 *)0x03003440)\n' +
      'void armfall(u32 mode, u32 n){ u32 w, h, i;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' switch (mode) {' +
      ' case 0: w = gBgs[i].h; h = 32; break;' +
      ' case 1: w = 32; h = gBgs[i].v; break;' +
      ' case 2: w = gBgs[i].h; h = gBgs[i].v; break; }' +
      ' gOut[i] = w + h; } }',
    features: ['uninit-local', 'merge-chain', 'guard-init'],
    toolchains: ['agbcc'],
    ctx: 'void armfall(u32 mode, u32 n);',
    proto: { armfall: { returnsVoid: true } },
  },
  {
    sym: 'armdef',
    src:
      'struct Bg { u16 h; u16 v; };\n' +
      '#define gBgs ((struct Bg *)0x03003430)\n' +
      '#define gOut ((u32 *)0x03003440)\n' +
      'void armdef(u32 mode, u32 n){ u32 w, h, i;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' switch (mode) {' +
      ' case 0: w = gBgs[i].h; h = 32; break;' +
      ' case 1: w = 32; h = gBgs[i].v; break;' +
      ' case 2: w = gBgs[i].h; h = gBgs[i].v; break;' +
      ' default: w = 0; h = 0; break; }' +
      ' gOut[i] = w + h; } }',
    features: ['merge-chain'],
    toolchains: ['agbcc'],
    ctx: 'void armdef(u32 mode, u32 n);',
    proto: { armdef: { returnsVoid: true } },
  },

  // A STATEMENT WHOSE ONLY EFFECT IS ON THE ALLOCATOR. `gBgs[2].v = gBgs[2].v + 0;` reads a field
  // and writes the same value back. agbcc deletes both the load and the store — the compiled
  // reference contains no `ldrh`/`strh` for it — but NOT its aliasing consequence: while loop
  // optimisation still sees the store, `gBgs[k].dst` is a possibly-aliased memory read and stays
  // inside the loop. Delete the statement from the source and agbcc hoists that load to the
  // preheader and strength-reduces the store into `stmia r3!, {r0}` — a different loop. Verified
  // by compiling the pair.
  //
  // asmlift recovers the re-read correctly (its candidate loads through the base every iteration)
  // and drops the no-op statement, which is the right thing to do with a statement that emits
  // nothing. The row is here because the residual that leaves is not nothing: 8 rows, and every
  // one of them is a register NAME. The breakdown is `replace 2, argMismatch 6` with insert and
  // delete both zero — same opcodes, same operand structure, same order, so nothing here is a
  // missing or extra instruction. It is two renamings: the base is r5 in the reference and r4 in
  // the candidate (which is the `push {r4, r5, lr}` / `push {r4, lr}` pair, and the pop, and the
  // 2 replaces), and r0 and r1 are exchanged through the whole body. That the *deleted* statement
  // is what the 8 turns on IS established, by the control: `rereadctl` is the same C with the
  // statement gone and asmlift MATCHes it. What is not established is WHY — re-inserting the
  // statement into asmlift's raw-address spelling makes agbcc keep the `ldrh`/`strh` (the
  // struct-typed reference spelling is what lets it delete them), so no candidate reproduces the
  // reference's combination. The row records the residual and its size, not a mechanism.
  //
  // `value-home` and not `read-once`: read-once is about a value read once above a branch and
  // re-read per arm, and this row has no branch and no arm — the load sits inside the loop in the
  // reference AND in the candidate. A zero insert/delete breakdown over renamed registers is
  // value-home's definition exactly.
  //
  // `rereadctl` is the control: the same C with the no-op statement gone. It keeps the compiler
  // claim above under the harness instead of in a commit message, and it MATCHes — so the pair
  // brackets the gap exactly, 0 without the statement and 8 with it.
  //
  // Cut from LoadBGTilemapData in the kleod checkout (agbcc), where the second decomp's 98.24% attempt writes the
  // same construct as `gBgInfo[2].vLength += 0;` and marks it `// FAKE`. It is worth 178 points
  // there: deleting that one statement takes the spelling from 12 to 190 against the ROM object.
  //
  // agbcc only, for the same reason as the family above: the deletion-but-not-the-alias behaviour
  // is this compiler's, established by compiling both spellings.
  {
    sym: 'reread',
    src:
      'struct Bg { u32 *dst; u16 h; u16 v; };\n' +
      '#define gBgs ((struct Bg *)0x03003430)\n' +
      'void reread(u32 k, u32 n){ u32 i;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' gBgs[2].v = gBgs[2].v + 0;' +
      ' gBgs[k].dst[i] = i << 6; } }',
    features: ['value-home', 'global'],
    toolchains: ['agbcc'],
    ctx: 'void reread(u32 k, u32 n);',
    proto: { reread: { returnsVoid: true } },
  },
  {
    sym: 'rereadctl',
    src:
      'struct Bg { u32 *dst; u16 h; u16 v; };\n' +
      '#define gBgs ((struct Bg *)0x03003430)\n' +
      'void rereadctl(u32 k, u32 n){ u32 i;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' gBgs[k].dst[i] = i << 6; } }',
    features: ['global'],
    toolchains: ['agbcc'],
    ctx: 'void rereadctl(u32 k, u32 n);',
    proto: { rereadctl: { returnsVoid: true } },
  },

  // A DECLARED EXTERN ARRAY SUBSCRIPTED INSIDE A LOOP. `ereadctl` is the conjunction —
  // `extern struct Bg gReadBgs[];` reached as `gReadBgs[k].dst[i]` under a loop — and it MATCHes
  // on `unsigned/fresh-merge/orderbase-scoped/initfirst`. `ername` keeps the loop and drops the
  // array shape, reaching a named symbol through `&gReadBgsObj`; `erflat` keeps the array shape
  // and drops the loop; both MATCH too. The conjunction cost two points when this family was
  // authored and costs nothing now, so these three rows are MATCH controls and the family's open
  // rows are the read-back pairs below.
  //
  // The named data relocation is free. It is what makes this family look different from the
  // raw-address reread/rereadctl pair above, and it is not what costs anything: `ername` carries
  // the same relocation and MATCHes.
  //
  // WHAT THE READ-BACK PAIRS ADD, on top of that conjunction. `ereread` adds a same-value
  // fixed-index field write to `ereadctl`; `erback`/`erbctl` make the same comparison with a
  // read-back of that field after the indexed store. agbcc scores: ereread 11, ereadctl 0,
  // erback 12, erbctl 12. So the same-value write is worth 11 with no read-back (11 against 0)
  // and 0 with one (12 against 12): the read-back collapses the statement's price, and that
  // collapse is what this family measures.
  //
  // `ereread`'s 11 is `insert 1, delete 1, replace 2, argMismatch 7`; the replaces are `reread`'s
  // residual and the rest is its own. BOTH pairs stay: their residuals differ in kind (`reread`
  // has zero insert/delete) and the relocations differ (`.word 0x3003430` against
  // `.word gReadBgs`), which is also why m2c reads noncompile on one and declined on the other.
  //
  // `erbctl` is an intervention control, not a MATCH control, and is not `value-home`: its twelve
  // rows are six strictly register-only, one mixed immediate/operand-structure/register, an opcode
  // mismatch and four insertion/deletion — which is not a diff dominated by where a value lives.
  // (Its `argMismatch 7` is objdiff's diffKind tally, not a register census: the seventh
  // arg-mismatch row is the mixed one.) `ereadctl` MATCHes.
  //
  // m2c declines every row here, first emitting the extern as `extern ? gReadBgs;`, so the family
  // yields no cross-tool number: unknown extern-type recovery owns that blocker, not this
  // allocator/aliasing experiment. That is a fact about the context THESE rows pass. Rows such as
  // `sbscope` and `ptrelem` hand the global's declaration to both tools instead, and supplying
  // it to `ereadctl`'s spelling moves m2c from `declined` to `noncompile` — past the
  // placeholder, still without a score; whether asmlift is unmoved has not been re-measured since
  // `ereadctl` began to MATCH.
  //
  // agbcc only, for the same reason as the raw family above, and no row here is a proposed fix;
  // the measured attribution is in docs/lbg-attribution.md.
  {
    sym: 'ereread',
    src: 'struct Bg { u32 *dst; u16 h; u16 v; };\nextern struct Bg gReadBgs[];\nvoid ereread(u32 k, u32 n) { u32 i; for (i=0; i<n; i=i+1) { gReadBgs[2].v = gReadBgs[2].v + 0; gReadBgs[k].dst[i] = i << 6; } }\n',
    features: ['value-home', 'global', 'array'],
    toolchains: ['agbcc'],
    ctx: 'void ereread(u32 k, u32 n);',
    proto: { ereread: { returnsVoid: true } },
  },
  {
    sym: 'ereadctl',
    src: 'struct Bg { u32 *dst; u16 h; u16 v; };\nextern struct Bg gReadBgs[];\nvoid ereadctl(u32 k, u32 n) { u32 i; for (i=0; i<n; i=i+1) { gReadBgs[k].dst[i] = i << 6; } }\n',
    features: ['global', 'array'],
    toolchains: ['agbcc'],
    ctx: 'void ereadctl(u32 k, u32 n);',
    proto: { ereadctl: { returnsVoid: true } },
  },
  {
    sym: 'erback',
    src: 'struct Bg { u32 *dst; u16 h; u16 v; };\nextern struct Bg gReadBgs[];\nu32 erback(u32 k, u32 n) { u32 i, sum=0; for (i=0; i<n; i=i+1) { gReadBgs[2].v = gReadBgs[2].v + 0; gReadBgs[k].dst[i] = i << 6; sum += gReadBgs[2].v; } return sum; }\n',
    features: ['value-home', 'global', 'array'],
    toolchains: ['agbcc'],
    ctx: 'u32 erback(u32 k, u32 n);',
  },
  {
    sym: 'erbctl',
    src: 'struct Bg { u32 *dst; u16 h; u16 v; };\nextern struct Bg gReadBgs[];\nu32 erbctl(u32 k, u32 n) { u32 i, sum=0; for (i=0; i<n; i=i+1) { gReadBgs[k].dst[i] = i << 6; sum += gReadBgs[2].v; } return sum; }\n',
    features: ['global', 'array'],
    toolchains: ['agbcc'],
    ctx: 'u32 erbctl(u32 k, u32 n);',
  },
  {
    sym: 'ername',
    src:
      'struct Bg { u32 *dst; u16 h; u16 v; };\n' +
      'extern struct Bg gReadBgsObj;\n' +
      '#define gRB ((struct Bg *)&gReadBgsObj)\n' +
      'void ername(u32 k, u32 n){ u32 i;' +
      ' for (i = 0; i < n; i = i + 1) {' +
      ' gRB[k].dst[i] = i << 6; } }',
    features: ['global'],
    toolchains: ['agbcc'],
    ctx: 'void ername(u32 k, u32 n);',
    proto: { ername: { returnsVoid: true } },
  },
  {
    sym: 'erflat',
    src:
      'struct Bg { u32 *dst; u16 h; u16 v; };\n' +
      'extern struct Bg gReadBgs[];\n' +
      'void erflat(u32 k, u32 i){ gReadBgs[k].dst[i] = i << 6; }',
    features: ['global', 'array'],
    toolchains: ['agbcc'],
    ctx: 'void erflat(u32 k, u32 i);',
    proto: { erflat: { returnsVoid: true } },
  },

  // A BASE THE ARMS SHARE, AND A CONSTANT INDEX THAT NEEDS NONE: one fold, two surfaces, and one
  // row pinning each. The struct and the base are LoadBGTilemapData's —
  // a 28-byte `gBgInfo` element at 0x03003430.
  //
  // THE COMPILER FACT, from the pair compiled with the benchmark's agbcc. When an address
  // constant sits in the SAME syntactic PLUS tree as a member's byte offset, agbcc reassociates
  // the offset ONTO the base — `split_tree` (fold-const.c:1216) accepts the address as the
  // constant term at :1253, and `associate:` (:4959) rewrites it into `VAR +- (ARG1 +- CON)`
  // (:5009) — and thumb.h's `LEGITIMIZE_ADDRESS` (thumb.h:926) is EMPTY, so it never comes back.
  // The offset therefore leaves the load's free `[rN, #imm]` displacement:
  //   int a = m[i].hLength; int b = m[i].vLength;        ->  9 insns  .word 0x3003430  [r1,#0x10]/[r1,#0x12]
  //   ((u16 *)(i*28 + 0x03003430))[8]; … [9];            -> 11 insns  .word 0x3003440  ldrh [r0]/[r1]
  //   u16 *p = (u16 *)(i*28 + 0x03003430); p[8]; p[9];   ->  9 insns  .word 0x3003430  — back to the ref
  // Parking the base in ANY local breaks the plus tree and restores the displacement, so the
  // re-cast and the index constants are innocent; only the tree is the discriminator. The pair
  // behaves identically over a named `extern` (9 / 11 / 9 insns, `.word gBgInfo` /
  // `gBgInfo+0x10` / `gBgInfo`) and over the raw address above — which is what lets these rows
  // use an address macro and still measure the real thing.
  //
  // SURFACE 1, THE ADD — `bgshare` and `bgswitch`. Where something else wants the base plain,
  // agbcc keeps `.word 0x3003430` and pays the reassociation as an `add` on the loaded value.
  // Grep these two for a baked pool word and there is none on EITHER side: 2 and 3 plain words in
  // the target, the same 2 and 3 in the winner. On the target side nothing folds at all, because
  // the reference spells every access as a struct member and the member offset is therefore never
  // in the address constant's plus tree — which holds for the two MATCH rows equally, and for a
  // one-member-per-arm shape that shares nothing (`.word 0x3003430` twice, `[r0,#0x10]` and
  // `[r0,#0xc]`). On the winner side the base stays plain because the local asmlift minted wants
  // it plain. `bgshare`, target against winner:
  //   target   …  add r0,r0,r1                                     / ldrh r1,[r0,#0x10]
  //   winner   …  add r2,r0,r1 / add r1,r1,#0x10 / … / add r0,r0,r1 / ldrh r1,[r0]
  //
  // SURFACE 2, THE BAKE — `bgfixed`. Where nothing wants the base plain, the folded address
  // becomes its own pool word. The reference reads `gBgInfo[2].tileRow`, so agbcc folds the
  // constant ARRAY index and stops there (`.word 0x3003468` + `ldrh [r0,#0xe]`); asmlift emits
  // `((u16 *)50345064)[7]` and folds the member offset in too (`.word 0x300346c` + `ldrh [r0]`).
  // The branch is not what makes it fire — the same two accesses straight-line, with no `if` at
  // all, score 2 by the same divergence. `bg_area`/`bg_mix` cannot cover this surface even though
  // `bg_mix` reads a fixed element of the same shape: their base is 0x02000000, which agbcc
  // materializes as `mov #0x80` + `lsl #0x12` and reaches at `add #0x38`, so there is no pool
  // word for an addend to hide in. A pool-loaded base is a precondition of surface 2.
  //
  // WHAT ASMLIFT DOES WITH SURFACE 1. Where the target emits a member's load ONCE in a block that
  // more than one arm reaches, the base is live OUT of each arm; asmlift homes it —
  // `v0 = (u16 *)(a0 * 28 + 50345008);` — and reads the arm-local access off that same local
  // (`v0[8]`). `bgshare` and `bgswitch` both MATCH on `unsigned/merge-names/addr-home`. Surface 2
  // is closed the same way: `bgfixed` MATCHes on `unsigned/offmember`, which spells the folded
  // site as the fixed element's member (`((struct Off0 *)50345064)->m14`). All six rows here
  // MATCH, so what they hold is the two spellings against each other, not a gap.
  //
  // SURFACE 1'S DISCRIMINATOR IS A PROPERTY OF THE TARGET, not of the source. A member named in
  // two arms is NECESSARY and NOT SUFFICIENT; what decides it is whether agbcc puts that load in
  // a join block, and both the dispatch construct and the ORDER of the two reads decide THAT:
  //   two-arm if/else, shared member read LAST   -> shared join block    `bgshare`   `ldrh [r0,#0x12]` once, at `.L5`
  //   two-arm if/else, shared member read FIRST  -> own copy in EACH arm  no row
  //   two-arm if/else, members disjoint          -> nothing shared       `bgsplit`
  //   three-arm switch, one member shared        -> shared join block    `bgswitch`  once at `.L8`, case 1 falls in
  //   three-arm switch, members disjoint         -> nothing shared       `bgswsplit`
  //   three-arm if/else-IF chain, shared         -> own copy in EACH arm  no row
  // Reading the shared member FIRST shares it in the source exactly as `bgshare` does and the
  // class does not fire, so do not prune or widen the family on "one member shared" alone.
  // `bgswitch`'s own `default` arm makes the same point from inside a row — it reads `hLength`,
  // which `case 0` also reads, and the target emits that `ldrh [r0,#0x10]` TWICE, once per block;
  // only `vLength`, shared by the two ADJACENT arms, gets a join block.
  //
  // WHAT THE ROWS GUARD. `bgsplit`/`bgswsplit` mint no base local at all, so they pin the
  // struct-array recovery that already works and cannot over-fire a variation that prefers a minted
  // local — there is none there to prefer. `bgbaked` is the family's real over-fire guard, and it
  // guards the other surface: its target genuinely wants the folded word, asmlift spells it
  // straight (`*(s32 *)50345068`) and MATCHes, and re-spelling that one site as the fixed
  // element's member — the edit that takes `bgfixed` to byte-exact — costs it 2. Both endpoints
  // now ship, and `bgbaked` is what keeps the fixed-element spelling from over-firing where the
  // target wants the baked word.
  // `bgswsplit` is also not a one-member contrast, and cannot be: changing ONLY `case 1`'s second
  // member of `bgswitch` (`vLength` -> `tileRow`) still scored 8 when this family was cut, because
  // the sharing moves to cases 1/`default`. Two arms have to change to remove it, so `bgswsplit`'s
  // MATCH is consistent both with "the sharing is gone" and with "this member set happens to
  // match"; `bgsplit`, where
  // one member changes and nothing else does, carries the clean contrast.
  //
  // THE STRUCT IS THE REAL FUNCTION'S, NOT A PRECONDITION of surface 1. Measured before this
  // family closed: with `pad19[7]` (sizeof 32, a single `lsl #5` scale and no lsl/sub/lsl chain)
  // `bgshare` still scored 8 with the identical mint-then-respell winner, and with the arm-local
  // members moved to offsets 0 and 2 — nothing for a displacement to hold — it scored 10 with the
  // same winner shape. The 28-byte
  // stride and the 0xc–0x16 member offsets are here because they are `gBgInfo`'s.
  //
  // ATTRIBUTION, so nothing here is credited to the wrong gap:
  //  • `bg_area`/`bg_mix` above already pin the STRAIGHT-LINE variable-index capability over this
  //    same 28-byte stride: `bg_area` MATCHes on all four toolchains, `bg_mix` on agbcc/kmc/mwcc
  //    and is 1 on ido7.1. They are coverage for that, and for neither surface here.
  //  • `armfall` (agbcc, nonmatch 8, `unsigned/merge-names/copy-defpos`) is a switch over
  //    struct-array members at this very base and is NOT coverage: its winner spells the base as
  //    a pointer induction variable (`v0 = v0 + 2;`) and reads `*v0`/`v0[1]` — the safe local
  //    form, with no inline re-spelling anywhere. Its 8 is the zero-trip guard placement priced
  //    with the `uninit-local` family above, not surface 1. `armdef` MATCHes.
  //  • No `uninit-local`: every local is assigned on every path. `merge-chain` goes on the four
  //    whose arms decide `a` AND `b`, both computed loads — the tag describes the body, not
  //    the residual, so all four carry it.
  //  • EXCLUDED, with the machinery it belongs to: a clamp over the same base (`a = m[i].hLength;
  //    if (sel) a = 32; b = m[i].vLength;`) scores 22, but its winner uses the struct-member form
  //    throughout and mints no base local — clamp/merge-init, not this.
  //
  // agbcc only, like the `reread` and `arm*` families above — but as a family CONVENTION, not as a
  // tested exclusivity claim. The pair was compiled on agbcc alone, and of the three mechanisms
  // cited only thumb.h's empty `LEGITIMIZE_ADDRESS` is ARM-Thumb's: `split_tree`/`associate:` live
  // in `fold-const.c`, the target-independent folder agbcc inherits from GCC 2.x, and join-block
  // tail sharing is a target-independent RTL pass. Whether these rows reproduce on the other three
  // toolchains is UNTESTED — no cross-compiler run was attempted.
  // WHAT THESE ROWS DO NOT MEASURE, stated because it is the other half of the question they came
  // from: the NAMED-symbol spelling. These use an address macro, codegen-equivalent for the fold
  // (verified above). A row relocating against a named `gBgInfo` DOES compile and score — asmlift
  // synthesizes the declaration off the target asm — and the GLOBAL ARRAY SHAPE family far below
  // is exactly that row. So the naming question is measured here in this file, not deferred to
  // the real tier.
  //
  // THE LBG NOTE, with this family's own share of that row priced rather than assumed away. On
  // `LoadBGTilemapData in the kleod checkout (agbcc)` the 386 winner's pool holds 20 `.word` against the ROM's 20
  // `.4byte`, and it bakes four `gBgInfo` addends (+0x4, +0x3c, +0x48, +0x4a) where the ROM bakes
  // three (+0x4, +0x48, +0x4a), carrying 8 plain `0x3003430` words against the ROM's 9. The extra
  // `+0x3c` is the pool word the two `((s32 *)50345008)[15]` sites share — surface 2, `bgfixed`'s.
  // Taking that winner and parking the base of those two sites in a local scores 383 against its
  // own 386 and leaves the ROM's 9 plain words with no `+0x3c`; one site alone is 385 either way.
  // So this family reaches that row and is worth at least 3 of its 386 — but 3 is the whole
  // rewrite including register-allocation churn (104 diff lines, mostly r4/r5 renaming), not a
  // per-instruction decomposition, and neither row's endpoint produces it. `bgshare`/`bgswitch`
  // gate preferring an ALREADY-MINTED local, and a local DOES hold that base in that fan — 16,128
  // of the 68,352 candidates read the cell through one, best 399, MEASURED AT #138 (`84aa4222`)
  // AND NOT RE-RUN SINCE — so the missing capability is
  // not a MINT but the SELECTION of which keys get one, which is the
  // `livepark`/`foldpark`/`unfoldpark` family below. `bgfixed` gates the fixed-element member
  // spelling, and applying THAT to the same two sites scores 386, unmoved, because the ROM reaches
  // the member from the plain base at `#0x3c` rather than from the element base. Surface 1 occurs
  // nowhere in that winner at all.
  {
    sym: 'bgshare',
    src:
      'struct BgInfo { void *pTiles; void *pTilemap; u16 hOfs; u16 vOfs; u16 tileCol; u16 tileRow;\n' +
      '                u16 hLength; u16 vLength; u16 unk14; u16 unk16; u8 unk18; u8 pad19[3]; };\n' +
      '#define gBgInfo ((struct BgInfo *)0x03003430)\n' +
      'int bgshare(int i, int sel) { int a, b;\n' +
      '  if (sel) { a = gBgInfo[i].hLength; b = gBgInfo[i].vLength; }\n' +
      '  else     { a = gBgInfo[i].tileCol; b = gBgInfo[i].vLength; }\n' +
      '  return a + b; }',
    features: ['value-home', 'struct', 'merge-chain'],
    toolchains: ['agbcc'],
    ctx: 'int bgshare(int i, int sel);',
  },
  {
    sym: 'bgsplit',
    src:
      'struct BgInfo { void *pTiles; void *pTilemap; u16 hOfs; u16 vOfs; u16 tileCol; u16 tileRow;\n' +
      '                u16 hLength; u16 vLength; u16 unk14; u16 unk16; u8 unk18; u8 pad19[3]; };\n' +
      '#define gBgInfo ((struct BgInfo *)0x03003430)\n' +
      'int bgsplit(int i, int sel) { int a, b;\n' +
      '  if (sel) { a = gBgInfo[i].hLength; b = gBgInfo[i].vLength; }\n' +
      '  else     { a = gBgInfo[i].tileCol; b = gBgInfo[i].tileRow; }\n' +
      '  return a + b; }',
    features: ['value-home', 'struct', 'merge-chain'],
    toolchains: ['agbcc'],
    ctx: 'int bgsplit(int i, int sel);',
  },
  {
    sym: 'bgswitch',
    src:
      'struct BgInfo { void *pTiles; void *pTilemap; u16 hOfs; u16 vOfs; u16 tileCol; u16 tileRow;\n' +
      '                u16 hLength; u16 vLength; u16 unk14; u16 unk16; u8 unk18; u8 pad19[3]; };\n' +
      '#define gBgInfo ((struct BgInfo *)0x03003430)\n' +
      'int bgswitch(int i, int sel) {\n' +
      '    int a, b;\n' +
      '    switch (sel) {\n' +
      '    case 0:  a = gBgInfo[i].hLength; b = gBgInfo[i].vLength; break;\n' +
      '    case 1:  a = gBgInfo[i].tileCol; b = gBgInfo[i].vLength; break;\n' +
      '    default: a = gBgInfo[i].hLength; b = gBgInfo[i].tileRow; break;\n' +
      '    }\n' +
      '    return a + b;\n' +
      '}',
    features: ['value-home', 'struct', 'merge-chain'],
    toolchains: ['agbcc'],
    ctx: 'int bgswitch(int i, int sel);',
  },
  {
    sym: 'bgswsplit',
    src:
      'struct BgInfo { void *pTiles; void *pTilemap; u16 hOfs; u16 vOfs; u16 tileCol; u16 tileRow;\n' +
      '                u16 hLength; u16 vLength; u16 unk14; u16 unk16; u8 unk18; u8 pad19[3]; };\n' +
      '#define gBgInfo ((struct BgInfo *)0x03003430)\n' +
      'int bgswsplit(int i, int sel) {\n' +
      '    int a, b;\n' +
      '    switch (sel) {\n' +
      '    case 0:  a = gBgInfo[i].hLength; b = gBgInfo[i].vLength; break;\n' +
      '    case 1:  a = gBgInfo[i].tileCol; b = gBgInfo[i].tileRow; break;\n' +
      '    default: a = gBgInfo[i].unk14;   b = gBgInfo[i].unk16;   break;\n' +
      '    }\n' +
      '    return a + b;\n' +
      '}',
    features: ['value-home', 'struct', 'merge-chain'],
    toolchains: ['agbcc'],
    ctx: 'int bgswsplit(int i, int sel);',
  },
  {
    sym: 'bgfixed',
    src:
      'struct BgInfo { void *pTiles; void *pTilemap; u16 hOfs; u16 vOfs; u16 tileCol; u16 tileRow;\n' +
      '                u16 hLength; u16 vLength; u16 unk14; u16 unk16; u8 unk18; u8 pad19[3]; };\n' +
      '#define gBgInfo ((struct BgInfo *)0x03003430)\n' +
      'int bgfixed(int i, int sel) { int a, b;\n' +
      '  a = gBgInfo[i].hLength;\n' +
      '  b = gBgInfo[i].vLength;\n' +
      '  if (sel) return a + gBgInfo[2].tileRow;\n' +
      '  return b + gBgInfo[2].tileRow; }',
    features: ['value-home', 'struct'],
    toolchains: ['agbcc'],
    ctx: 'int bgfixed(int i, int sel);',
  },
  {
    sym: 'bgbaked',
    src:
      '#define gBgTilemapPtr (*(s32 *)0x0300346c)\n' +
      'int bgbaked(int m, int n) { return m * gBgTilemapPtr + n * gBgTilemapPtr; }',
    features: ['value-home', 'global'],
    toolchains: ['agbcc'],
    ctx: 'int bgbaked(int m, int n);',
  },

  // WHICH of several numeric bases gets the pointer local. The `dma_*` rows above ask whether a
  // reused absolute address is spelled as one base local at all; this pair asks the question a
  // function with SEVERAL of them poses, which those rows cannot: the answer is per base, and
  // asmlift's is per function.
  //
  // `l3/basecse.ts` hoists a base indexed at 2+ sites into a typed pointer local, gated by
  // BASECSE_GATES. Two of those gates — `loop` (a function-top hoist of a loop base forces a
  // callee-saved register) and `repeated-const-offset` (a fixed offset touched twice is a scalar
  // RMW the compiler re-materializes) — are exactly wrong for an MMIO poll, so rank.ts's
  // `/livebase` variation re-runs the pass with both ablated, leaving only `single-use`. That variation was
  // ALL-OR-NOTHING over bases — `hoistBaseLocals` hoisted every key the gate list admits,
  // with no candidate for a proper subset. A second admission, LIVEBASE_BLOCK_GATES, adds the
  // `single-cell` gate — a base every access of which is ONE fixed offset stays inline — and rank
  // carries both in one roster (LIVEBASE_HOISTS), running every `/livebase` pairing over each,
  // so this row MATCHES on `signed/livebase-block/volatile` and guards the gate.
  //
  // ATTRIBUTED BY ABLATION, not by reading. Adding one more gate to LIVEBASE_GATES that rejects a
  // numeric base outside MMIO — per-base selectivity in its crudest form — takes this row from 11
  // to MATCH. Re-running the WHOLE synthetic tier under it moves exactly one other row,
  // and that row is the finding's other half: `sizebound` goes 16 → 20 — measured when that row
  // stood at 16, where it now stands at 8 — because it reads
  // `*(u16 *)0x03001048` in two loop bounds and hoisting THAT base is correct. So the pass is
  // right about the spelling and wrong about which bases get it — and an address threshold is NOT
  // the predicate to fix it with: it pays 4 points on `sizebound` for the 11 it wins here.
  // `sizebound` is the row that referees whatever predicate a future variation proposes, and the
  // shipped `single-cell` gate treats it exactly as the address threshold does: that base is
  // reached at one fixed offset only, so `-block` leaves `*(u16 *)0x03001048` inline and binds
  // 0x040000d4 alone. The row does not pay for that, because the gate never SUBTRACTS a
  // candidate — sizebound stands at 8 on `signed/expr-home/livebase-block/volatile/
  // initfirst/pollread`, the `-block` spelling itself — and that coexistence is the whole reason
  // a per-base predicate is allowed to be wrong. One that PRUNES has to be right.
  //
  // WATCH THE SIGN when writing one. `dma_wait:mwcc_242_81`'s base is 0xcc006000, which the IR
  // carries as a NEGATIVE 32-bit constant; a first cut of the probe compared the key as a signed
  // decimal, rejected that base, and LOST a MATCH the tier already had. Reading it unsigned
  // restores it. A per-base predicate is a place where a sign error costs a row silently.
  //
  // THE `/volatile` SUBSET CAP IS NOT A SECOND BLOCKER — measured, because it looks like one.
  // `volatileSubsetCandidates` (l3/volatileptr.ts) returns `[]` outside `2 <= eligible <= 3`, and
  // this row has four eligible locals, so no `/volatile-<name>` variation exists here. Raising the cap
  // to 8 makes eleven subset variations appear and leaves the row at 11 — every one of them still
  // binds all four bases, and even the subsets that qualify exactly the DMA base score 11. Subset
  // VOLATILITY on an all-or-nothing HOIST buys nothing. Do not spend a round on the cap.
  //
  // `mixpoll` is the isolate: one DMA register file that must be a bound `volatile` local, and
  // three IWRAM scalars that must stay inline absolute derefs. The ROM's own C is the reference,
  // and hoisting the three IWRAM cells is what costs — measured by hand-editing asmlift's own
  // winner one clause at a time against the same object:
  //     all four bound, all four volatile (plain `/livebase/volatile`) ........... 11
  //     all four bound, only the DMA base volatile .............................. 11
  //     all four bound, none volatile .......................................... 27
  //     ONLY the DMA base bound, volatile, the three IWRAM cells inline .......... 0  ← MATCH
  //     only the DMA base bound, NOT volatile ................................... 21
  // So the 11 is the hoist alone (qualifying the IWRAM cells `volatile` on top of the wrong hoist
  // is worth 0 here), and `volatile` on the base that needs it is worth 21 — the variation pair is
  // right about both bases and wrong about which ones. A base census over the enumeration without
  // the gate: all 12 candidates bound either 0 or all 4 numeric bases, and marked 0 or 4 of them
  // `volatile`. The gate adds 8 (12 → 20), and all eight bind the DMA base alone — one block hoist
  // crossed over {unsigned, signed} × {plain, /expr-home} × {plain, /volatile}; the scored
  // `/livebase-block` reads 21, the number hand-editing that clause produced.
  //
  // The MIRROR admission — bind the scalar cells, leave the register file inline — is deliberately
  // NOT on rank.ts's roster, and what it would cost is measured rather than guessed: one gate table
  // with the complementary predicate plus one row there (a gate can only reject MORE, so it is
  // never an extra entry in LIVEBASE_BLOCK_GATES), and with it in the list the corpus enumerates
  // 8141 candidates against 7405 while not one row changes outcome, score or winner's
  // variations. It goes on the roster when a row asks for it.
  //
  // `onepoll` is the control — byte-identical C with the three IWRAM statements deleted. One base,
  // no selectivity question, and `/livebase/volatile` MATCHes it. So the pair brackets the gap
  // exactly: 0 with one base, 11 with four, same variation, same poll, same loop.
  //
  // The loop is spelled `i = 0; do … while` rather than `for` deliberately: a `for` puts the
  // family below's zero-trip guard into the same row, and this row is about the bases. That
  // separation is closed: measured on the same hand-compiled `for` shape with
  // `docs/ranked-repro.md`'s command, 76
  // candidate(s) scored, 0 dropped, 0 withheld, best `signed/livebase-block/volatile/initfirst`:
  // 0 (match). `/initfirst` is IN that winner, so the guard-placement variation does close a real
  // instance of the shape — which is worth knowing next to `armfall`, where the same variation is
  // enumerated and loses, and `offloop`, where it has no reach at all. The `do … while` spelling
  // is kept anyway: this row is still about the bases, and a row that two variations close jointly no
  // longer isolates either.
  //
  // Cut from LoadBGTilemapData in the kleod checkout (agbcc), and it pays there. The row exists because a base census
  // over that function's enumeration returned four shapes and no others: bind nothing, bind
  // 0x03003430 alone (`/nearbase`'s cluster), bind all five of 0x03003430 / 0x03003478 /
  // 0x0300347A / 0x030034A0 (IWRAM) and 0x040000D4 (the DMA register file) plain, and bind those
  // same five all `volatile`.
  // Not one bound the DMA base alone. With the gate, the narrower hoist IS LBG's ranked winner —
  // `docs/ranked-repro.md`'s command, run either side of it (an A/B against itself: the candidate
  // counts below are that pair's, not a fan size to reproduce):
  //
  //   without  17152 candidate(s) scored, 0 dropped, best …/addr-home/livebase/volatile/
  //            coalesce-v20-v17/initfirst/raw-globals: 419
  //   with     26880 candidate(s) scored, 0 dropped, best …/addr-home/livebase-block/volatile/
  //            initfirst/raw-globals: 406
  //
  // 419 → 406, attributed twice over: the with-gate log's best candidate carrying no `-block` variation
  // reads 419 exactly, which is what the without-gate log's winner scores. The 9728 extra
  // candidates are what fanning every `/livebase` composition over both `/livebase` hoists costs on a function
  // that inhabits them, and 5120 of them are the `/coalesce` pairing — worth 21 points on
  // `/livebase` here (440 → 419) and nothing on the narrow hoist, whose best paired spelling
  // reads 408, two behind going unpaired.
  //
  // agbcc only. The claim is about what THIS compiler does with the two spellings, established by
  // compiling both; the poll declines on ido7.1/gcc2.7.2kmc's branch-likely lift link exactly as
  // `dma_wait` records, and mwcc_242_81 stays off per the `hipress` hazard policy.
  {
    sym: 'mixpoll',
    src:
      '#define gRows (*(u16 *)0x03001048)\n' +
      '#define gCols (*(u16 *)0x03002048)\n' +
      '#define gTiles (*(u16 *)0x03003048)\n' +
      'void mixpoll(s32 n){ volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i; i = 0;' +
      ' do { gRows = gRows + 1; gCols = gCols + 2; gTiles = gTiles + 3;' +
      ' dma[0] = 0x03004000; dma[1] = 0x06000000 + i; dma[2] = (u32)i >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} i = i + 1; } while (i < n); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void mixpoll(s32 n);',
    proto: { mixpoll: { returnsVoid: true } },
  },
  {
    sym: 'onepoll',
    src:
      'void onepoll(s32 n){ volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i; i = 0;' +
      ' do { dma[0] = 0x03004000; dma[1] = 0x06000000 + i; dma[2] = (u32)i >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} i = i + 1; } while (i < n); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void onepoll(s32 n);',
    proto: { onepoll: { returnsVoid: true } },
  },

  // WHO OWNS THE FIRST STATEMENT OF A ZERO-TRIP GUARD'S ARM. `for (i = 0; i < n; i++)` compiles
  // with the init ABOVE the test, so the guard compares the COUNTER against the bound; the same
  // loop written `if (0 < n) { i = 0; do … }` compiles with the init behind the branch and the
  // guard against the CONSTANT. Both spellings lift to the same IR — a constant has no position —
  // so `l3/initfirst.ts` emits the init-first sibling as `/initfirst` and the differ referees.
  // Verified by compiling the four-way pair with this agbcc (`-O2 -fhex-asm -fprologue-bugfix`):
  //     s32 counter, `for`   :  mov r4, #0x0 / cmp r4, r5 / bge
  //     s32 counter, guard   :                 cmp r5, #0 / ble
  //     u32 counter, `for`   :  mov r4, #0x0 / cmp r4, r5 / bcs
  //     u32 counter, guard   :                 cmp r5, #0 / beq
  // — the operand pair always changes, and on an unsigned bound the branch OPCODE changes too
  // (fold-const rewrites the unsigned `> 0` to `!= 0`). Two instructions and a condition code.
  //
  // The re-spelling has a precondition the rest of the pipeline can take away from it: the guarded
  // arm's FIRST statement must be the init `v = X`, and the guard's other side must be X ITSELF.
  // `unsguard` is the row where the compare's own spelling contends for that side. Its counter is unsigned,
  // so the match needs the loop compares spelled unsigned (structure.ts unsignedCompareSpelling, the
  // default), and that spelling renders the guard's constant side as `(u32)0` — not the init's `0` to
  // a structural match. So this row is what pins the side match's CAST TOLERANCE (l3/initfirst.ts):
  // the match lives in the ONE candidate carrying both spellings, and each alone falls short —
  //     unsigned/livebase/volatile/initfirst ........................  0  ← MATCH
  //     unsigned/signed-cmp/livebase/volatile/initfirst .............  2  (withheld)
  //     unsigned/livebase/volatile ..................................  5
  // What stands between them is the cast alone, not a hoist — the compare spelling moves no
  // statement — and the tolerance stops at WIDTH 32, since a narrowing cast is not the value
  // `v = X` stores. This is the only row in the synthetic tier that tolerance moves, `sizebound`
  // included, which carries both spellings.
  //
  // `signguard` is the control, and it differs by ONE token: `s32 i` for `u32 i`. Nothing else in
  // the C changes, the halving keeps its `(u32)` cast so it stays an `lsr` on both, and asmlift
  // MATCHes it with `/initfirst` among its variations. So the pair brackets the gap exactly: the guard
  // re-spelling works, and it is the unsignedness that removes it.
  //
  // A SECOND blocker sits at the same precondition and has NO row: `/expr-home` can land its hoist
  // at the head of the guarded arm (`if (0 < n) { v0 = 128 << 24; v1 = 0; do …`), and then `then[0]`
  // is not the init. It reproduces on THIS row — of its 30 candidates, 12 carry `/expr-home` and
  // not one of those carries `/initfirst` — but they all score 21 against the winner's 2, and
  // hand-composing the two spellings on that branch recovers a single point (31 → 30 on a hand
  // probe of the `/expr-home` shape). So no row demands it and none was written. What would earn
  // one: a target whose ranked winner carries `/expr-home` with the hoist INSIDE the guard.
  // THAT CRITERION IS NOW MET, and the answer did not change. LoadBGTilemapData in the kleod checkout (agbcc)'s
  // ranked winner (386) carries `/expr-home` AND `/initfirst`, with the hoist landing exactly
  // here — `if (0 < *(u16 *)50345082) { v5 = 128 << 24; v14 = 0; do …`, so `then[0]` is the
  // hoist and the pass never looks at the init on the next line. Priced on that winner's own C,
  // one line moved and nothing else, each edit compiled and scored against the ROM object:
  // 386 with the init hoisted above the guard and the guard still testing the constant, and 384
  // when the guard's constant side is ALSO re-spelled against the hoisted init. The class is
  // worth 2 there, against the 35 the same edit is worth in the REFERENCE's spelling basin, so
  // it still earns no row — but now because it was measured, not for want of a target.
  // (`sizebound:agbcc` carries both `/expr-home` and `/initfirst`, because there the homed value
  // is parameter-derived and agbcc materialises it before the guard — that composition is not the
  // broken one.)
  //
  // Cut from LoadBGTilemapData in the kleod checkout (agbcc), whose L1 guard is `movs r3, #0 / … / cmp r3, r2 / bge`
  // in the ROM and `if (0 < *(u16 *)50345082)` in the ranked winner.
  //
  // agbcc only, as the poll rows above: `ucmp` already carries the compare-polarity question on all
  // four toolchains, and what this pair adds is its interaction with a guarded do-while that the
  // GBA DMA poll is what produces here.
  //
  // m2c compiles neither, on the identical `ctx` asmlift receives, and for the reason every
  // raw-address row here records rather than for anything in this family: it types the address
  // constant as `void *` and reads members off it (`(void *)0x040000D4->unk0`). It does reach the
  // construct — on `unsguard` it emits `var_r1 = 0;` ABOVE the guard and then tests
  // `if (temp_r2 > 0U)`, i.e. the init placement right and the compared operand pair wrong.
  {
    sym: 'unsguard',
    src:
      'void unsguard(s32 t){ volatile s32 *dma = (volatile s32 *)0x040000d4; u32 i;' +
      ' for (i = 0; i < 16 << t; i++){' +
      ' dma[0] = 0x03002000; dma[1] = 0x06000000 + i; dma[2] = (u32)i >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } }',
    features: ['guard-init', 'unsigned'],
    toolchains: ['agbcc'],
    ctx: 'void unsguard(s32 t);',
    proto: { unsguard: { returnsVoid: true } },
  },
  {
    sym: 'signguard',
    src:
      'void signguard(s32 t){ volatile s32 *dma = (volatile s32 *)0x040000d4; s32 i;' +
      ' for (i = 0; i < 16 << t; i++){' +
      ' dma[0] = 0x03002000; dma[1] = 0x06000000 + i; dma[2] = (u32)i >> 1 | 0x80000000;' +
      ' while (dma[2] & 0x80000000) {} } }',
    features: ['guard-init'],
    toolchains: ['agbcc'],
    ctx: 'void signguard(s32 t);',
    proto: { signguard: { returnsVoid: true } },
  },

  // ── NARROW LOOP COUNTERS, AND THE ADDRESS SPELLING THEY UNLOCK ────────────────────────
  // A counter declared `s16 i` is not a cosmetic choice: on agbcc it CHANGES WHICH LOOP THE
  // COMPILER EMITS. Compiled pairs, this agbcc, `-mthumb-interwork -O2 -fhex-asm
  // -fprologue-bugfix`:
  //     s32 i, `s += i`      : mov r1,#0x0 / add r0,r0,r1 / add r1,r1,#0x1        (no extension)
  //     s16 i, `s += i`      : lsl r0,r1,#0x10 / asr r0,r0,#0x10 / add r2,r2,r0 /
  //                            add r0,r0,#0x1 / lsl / lsr r1 / asr r0             (`widecnt`,
  //                                                                                `narrowcnt`)
  // The sign extension is materialised ONCE and reused for both the use and the increment, and
  // the raw halfword is kept live beside it.
  //
  // WHY THE INDEX SURVIVES. Not register pressure: with a WIDE counter and five extra live
  // accumulators (enough that agbcc allocates r8 and pushes it) agbcc still eliminates the
  // induction variable and emits the pointer walk `add r1,r1,#0x2 / add r3,r3,#0x2`. It is the
  // RTL SHAPE of the counter's write-back, in two steps that are in the compiler:
  //   1. `gcc/thumb.h:344` PROMOTE_MODE forces `UNSIGNEDP = 1` for EVERY sub-word integer mode,
  //      so a declared `s16` local is kept ZERO-extended in its SImode home and the sign-extended
  //      value is re-derived beside it — the `lsr r3,r1,#0x10` next to `asr r1,r1,#0x10` in
  //      `membnarrow`'s target. The write-back is therefore `(lshiftrt (ashift (plus …) 16) 16)`.
  //   2. `gcc/loop.c` `basic_induction_var` has a case for SIGN_EXTEND (5876) and one for
  //      ASHIFTRT (5880); its own comment at 5756-5762 excludes ZERO_EXTEND on purpose
  //      ("overflows … are defined … So we only check for SIGN_EXTEND and not ZERO_EXTEND").
  //      LSHIFTRT has no case and falls to `default: return 0` (5902). No BIV ⇒ no strength
  //      reduction ⇒ the indexed address survives, and only THEN does the spelling of the base decide
  //      what agbcc hoists.
  // Instrumented rather than read, by compiling the two RTL shapes with the SAME `s32` local over
  // the same range, so declared width, liveness and pressure are all held fixed:
  //     i = ((i + 1) << 16) >> 16   (ASHIFTRT) → add r1,r1,#0x2 / add r2,r2,#0x2 — IV ELIMINATED
  //     i = (s32)(u16)(i + 1)       (LSHIFTRT) → lsl r0,r2,#0x1 / add r1,r4,r0   — index SURVIVES
  // `u16 i` blocks the elimination the same way — PROMOTE_MODE unsigns both, so both reach the same
  // LSHIFTRT — but only `s16` also pays for the materialised sign extension: swap `membnarrow`'s
  // counter to `u16` and the object is 17 rows from its own `s16` target.
  //
  // So the two gaps compose in one direction only: with a wide counter asmlift MATCHES the
  // member-array walk (`membwalk`, agbcc), and it is the narrow counter that exposes the address
  // spelling. Both capabilities ship. L1 is `raise/narrowlocal.ts`: a block parameter whose sole reader
  // is its own extension is declared at that width, so the counter is `s16 v0` read without a cast.
  // L2 is `raise/memberarrays.ts`: a constant offset feeding a variable-index walk selects a
  // struct's array MEMBER, so the walked region is `a0->field_4[v0]` and agbcc gets the
  // loop-invariant base to hoist that `(a0 + 2)[v0]` never gave it.
  //
  // WHICH CAPABILITY IS WORTH WHAT. Every number is measured on THAT ROW'S OWN target, starting from
  // asmlift's OWN published winner for the row and changing ONE thing — never by subtracting two
  // rows' scores, which are two different functions with two different targets:
  //     L1 = give the local a narrow type (`s16 v0`, casts dropped) instead of `s32 v0` + `(s16)v0`
  //     L2 = render the walked region as an array MEMBER of a synthesized struct
  //                   asmlift  L1 alone  L2 alone  L1+L2
  //     widecnt        MATCH      —         —        —    CONTROL: wide counter, no memory
  //     membwalk       MATCH      —         —        —    CONTROL: the member walk under a WIDE
  //                                                       counter — the address spelling costs
  //                                                       nothing on its own, so a fix for it must
  //                                                       not be credited with a narrow-counter row
  //     narrowcnt          1   0 MATCH      —        —    L1 alone, no memory
  //     basefold          11   0 MATCH      —        —    L1 alone, WITH memory traffic
  //     membnarrow        17     11        16     0 MATCH L1 + L2: the hoisted preheader base and
  //                                                       the base-first index add
  //     sibwalk           52     25        33     0 MATCH L1 + L2 over three sibling walks under one
  //                                                       `s16` counter; also the guard below
  // The `asmlift` column is the state before either capability; `L1+L2` is what `pnpm bench run` reads.
  // WHAT THE ROWS PRICE IS A CONJUNCTION. Alone, L1 closes `narrowcnt` and `basefold` outright but
  // takes only 6 of `membnarrow`'s 17 and 27 of `sibwalk`'s 52; L2 alone is worth 1 and 19, and 0
  // under a wide counter. The decomposition held to the point: L1 shipped first and left the two
  // member rows at exactly 11 and 25, and L2 on top of it closed both to a byte match.
  // `narrowcnt`'s single row is the capability in miniature: the target derives the increment from
  // the ALREADY-EXTENDED value (`add r0,r0,#0x1`), asmlift's cast spelling re-derives it from the
  // raw halfword (`add r0,r1,#0x1`).
  //
  // `basefold` SIZES L1; it is not an association probe. BOTH sides fold the `+4` into the memory
  // operand — target `ldrh r0,[r0,#0x4] / strh r0,[r2,#0x4]`, asmlift `ldrh r0,[r0,#0x4] /
  // strh r0,[r1,#0x4]` — and changing ONLY the local's declared type in asmlift's winner makes the
  // object BYTE-IDENTICAL to the reference (`cmp` passes), so its 11 is 100% L1. What it buys over
  // `narrowcnt` is SCALE: the extension feeds the address too, so the target spends `lsl #0x10 /
  // asr #0x10` then `lsl #0x1` where asmlift fuses both into `asr #0xf` — one missing capability
  // costing 1 row in a scalar loop and 11 in an addressing one. Its `src` is AUTHORED, not cut from
  // the project: sa3:PackSaveSector's reference has 22 `p->member[i]` and no pointer cast in 117 lines.
  //
  // THE CHANGE THIS FAMILY DOES **NOT** GATE, measured rather than assumed. asmlift mints a fresh
  // local per loop (`v0`, `v1`, `v2`) where the source reuses one `i`, and on sa3:PackSaveSector
  // breaking that ONE spelling on an otherwise byte-matching source costs 243 rows — so "reuse the
  // counter" is the first change a reader will reach for. It buys NOTHING at synthetic scale. Taking
  // asmlift's own winner and collapsing every minted counter onto one, scored against the same
  // object; the probes are N sibling `u16` arrays whose lengths cycle 6/7/9, walked in order:
  //     3 sibling loops   minted 52  reused 52          9 sibling loops   minted 191 reused 191
  //     5 sibling loops   minted 102 reused 102        11 sibling loops   minted 235 reused 235
  //     7 sibling loops   minted 148 reused 148        14 sibling loops   minted 301 reused 301
  // Identical at every scale, to the row — and identical again in the state a round will actually be
  // in, AFTER L1: `sibwalk` L1-minted 25, L1-reused 25. The 243 is a PRESSURE interaction (that
  // function has 18 hoisted invariants competing for registers), not a spelling agbcc reads.
  // `sibwalk` is the guard: if a round ships counter reuse, this row must not move.
  //
  // DECLINES, each named by asmlift's own message and each a PRE-EXISTING link, never this family:
  //     widecnt   × gcc2.7.2kmc : "cannot structure 'widecnt': unrecovered back-edge into block #1
  //                               (loop-recovery declined this shape: multi-latch, irreducible/
  //                               overlapping loops, a conditional continue, or an unsafe break)"
  //     narrowcnt × ido7.1      : the same back-edge link
  //     narrowcnt × gcc2.7.2kmc : the same back-edge link
  // The MIPS toolchains emit the counted loop with a branch-likely delay slot; that slot lifts, and
  // what all three stop at is loop recovery. Every other cell scores.
  //
  // WHY THE ctx SAYS `u8 *`. `ctx` reaches m2c ONLY — `evaluateM2c` is the only tool call that takes
  // it, `runAsmlift` has no such parameter — so the spelling moves m2c's column and can never move
  // asmlift's, which is why it has to be chosen honestly. `void *` is not honest here: m2c's BODY is
  // byte-identical under `void *` and `u8 *`, but on `void *` it dereferences the void pointer
  // (`*(d + 4 + temp_r0) = …`) and no compiler in the set accepts that, so the noncompile would be
  // the harness's, not m2c's. `u8 *` withholds the layout just as completely, and under it m2c
  // compiles — and where it lands is the L1/L2 split itself: withholding the layout costs m2c
  // exactly what the two capabilities are worth, and it keeps paying it after they ship.
  //     membnarrow  m2c 11, asmlift MATCH — the 11 m2c is left with is L2's
  //     sibwalk     m2c 26, asmlift MATCH
  //     membwalk    m2c  2 under BOTH spellings — the control that says the swap is not a general
  //                 m2c boost; it moves exactly the narrow-counter rows.
  // Not the real `struct S *`, because THE LAYOUT IS THE ANSWER: given it m2c emits
  // `d->name[temp_r1_2]` and byte-MATCHes `membnarrow` (measured, 0) — that is L2 handed over, and
  // a synthetic row gives asmlift no analogue for it. Every remaining noncompile is m2c's own: on a
  // real, dereferenceable pointer type it still invents a struct member — `(temp_r0 + d)->unk4` on
  // agbcc/basefold, `->unk4`/`->unkC` on gcc2.7.2kmc, "Selector requires struct/union pointer" on
  // ido7.1, "not a struct/union/class" on mwcc; no void*/incomplete-type marker is left here. The
  // harness gap this exposed is PRE-EXISTING: the synthetic tier hands `ctx` to m2c to READ but
  // never to the candidate COMPILE, where the real tier escalates to the project context for
  // exactly this reason (compile/real.ts:52-54 — "a harness artifact, not a decompiler weakness").
  // 23 synthetic rows in older families still carry markers in that class; that is its own change.
  //
  // COVERAGE. No row CARRIED the `narrow-counter` tag before this family — trivially, the tag is new.
  // The SHAPE was not uncovered. Reference side: 22 base rows pass this tag's own floor predicate,
  // 18 agbcc, and one of those (`kleod:UpdateEntities:agbcc`, retired 2026-09-13) then MATCHED — a narrow counter is
  // not automatically a gap. Candidate side: 17 base agbcc rows already carry a narrowed self-
  // increment in their PUBLISHED asmlift output, 2 of those MATCHing; exactly ONE carries the SIGNED
  // form these rows are cut from, `v = (u16)((s16)v + 1)` — `sa3:PackSaveSector` (366). That row's
  // 15 unsigned siblings were where movement was predicted to show first; L1's own `bench diff`
  // moved TWO real rows and neither is among them — `sa3:PackSaveSector` 366 → 360 (7 counters, and
  // the winner drops `/vol-slot`) and `sa3:sa2__sub_8007958` 68 → 67 (one `s8`). The prediction was
  // wrong because the published SPELLING is not the gate: what the pass reads is whether the
  // carrier has a second reader. What the six counter rows add is ISOLATION and SIZE: the shape
  // alone, plus memory, plus a struct member, each on its target.
  //
  // TOOLCHAIN SCOPING. All twelve ship `toolchains: ALL` as COVERAGE; the analysis above is agbcc's
  // alone. On mwcc_242_81 `membnarrow`, `basefold` and `sibwalk` all MATCH outright, so the gap
  // does not exist on that compiler; `narrowcnt` is 16 there, and the MIPS lanes score something
  // structurally different (ido7.1 4/4/12, gcc2.7.2kmc 7/7/21). Those cells are coverage, not
  // evidence for the thesis.
  //
  // THE FOUR CELL-DEFINING `merge*` ROWS ASK A DIFFERENT QUESTION: not what a narrow counter is
  // worth, but WHERE THE EVIDENCE FOR A NARROW LOCAL IS. Off a loop there is no back edge to carry the
  // write-back truncation, so gcc sinks it past the join and it arrives as the carrier's own
  // reader. `raise/narrowlocal.ts`'s `edge-extends` is the rule that decides that, and not one of
  // the carriers it judges over the sa3 corpus is on a real row — these are what price it:
  //     mergenarrow  `s16 v` across an if/else, read once      MATCH  without the sunk-write-back
  //                                                                   rule it is 6
  //     mergecast    the same merge as `s32 v` + `(s16)v`      MATCH  ADVERSE: a rule that narrows
  //                                                                   on the extension alone spells
  //                                                                   this `s16 v` and scores 6
  //     mergeu16     `u16 v` across the same if/else            MATCH  the DIAMOND half of the
  //                                                                   unsigned column
  //     mergecastu   the same merge as `s32 v` + `(u16)v`       —     the HOISTED half; the row
  //                                                                   the diamond rule must not win
  // `mergeldcast` and `mergepool` belong to the same file's ARM clause rather than to this table,
  // and carry their own per-row comments.
  //
  // The unsigned column was authored as UNDECIDABLE and it is not. `u16 v` and `s32 v` + `(u16)v`
  // do reach `raise/narrowlocal.ts` as the same IR — one `zext16` over raw in-edges — but they do
  // not compile to the same CFG: `gcc/jump.c:443-445` hoists the else arm above the compare for the
  // cast spelling and cannot for the declared one, because `gcc/thumb.h:344` PROMOTE_MODE makes
  // that arm five insns and the transform's guard at `:471-502` wants one. asmlift reads the join
  // shape and takes both cells; m2c takes the narrow spelling unconditionally, so it wins `mergeu16`
  // and pays on `mergecast`. `mergecastu` is the fourth cell and exists to hold the new rule to a
  // score: it is the shape a diamond test must keep REFUSED, and without it the whole column can be
  // won by a gate that simply always narrows.
  //
  // Cut from sa3:PackSaveSector:agbcc (m2c noncompile), and the two capabilities do not reach it: it is
  // refused for a third reason, a struct carrying constant-offset fields alongside its array members
  // (`direct-access` in raise/memberarrays.ts). That row is CONJUNCTIVE, measured on the winner it
  // published at 366: applying one project spelling at a time recovers 55 rows for the member-array
  // base (366 → 311) and 17 for the narrow counter (366 → 349), while both together reach 267 — a
  // 99-row recovery, more than the 72 the two marginals sum to, and still far from a match; four
  // other single-change "fixes" make the row WORSE (375, 371, 370, 370). It reaches a byte match only
  // when every spelling is right at once. So these rows size the two capabilities at their own scale
  // and make no claim about how far they move that row alone.
  {
    sym: 'mergenarrow',
    src:
      'void mergenarrow(s32 *out, s32 a, s32 b, s32 c)\n' +
      '{\n' +
      '    s16 v;\n' +
      '\n' +
      '    if (c) {\n' +
      '        v = a + b;\n' +
      '    } else {\n' +
      '        v = a - b;\n' +
      '    }\n' +
      '    out[0] = v;\n' +
      '}',
    features: ['narrow', 'sign-extend', 'branch', 'pointer'],
    toolchains: ALL,
    ctx: 'void mergenarrow(s32 *out, s32 a, s32 b, s32 c);',
    proto: { mergenarrow: { returnsVoid: true } },
  },
  {
    sym: 'mergecast',
    src:
      'void mergecast(s32 *out, s32 a, s32 b, s32 c)\n' +
      '{\n' +
      '    s32 v;\n' +
      '\n' +
      '    if (c) {\n' +
      '        v = a + b;\n' +
      '    } else {\n' +
      '        v = a - b;\n' +
      '    }\n' +
      '    out[0] = (s16)v;\n' +
      '}',
    features: ['narrow', 'sign-extend', 'cast', 'branch', 'pointer'],
    toolchains: ALL,
    ctx: 'void mergecast(s32 *out, s32 a, s32 b, s32 c);',
    proto: { mergecast: { returnsVoid: true } },
  },
  {
    sym: 'mergeu16',
    src:
      'void mergeu16(s32 *out, s32 a, s32 b, s32 c)\n' +
      '{\n' +
      '    u16 v;\n' +
      '\n' +
      '    if (c) {\n' +
      '        v = a + b;\n' +
      '    } else {\n' +
      '        v = a - b;\n' +
      '    }\n' +
      '    out[0] = v;\n' +
      '}',
    features: ['narrow', 'zero-extend', 'branch', 'pointer'],
    toolchains: ALL,
    ctx: 'void mergeu16(s32 *out, s32 a, s32 b, s32 c);',
    proto: { mergeu16: { returnsVoid: true } },
  },
  {
    // THE FOURTH CELL of the 2x2 in raise/narrowlocal.ts's header, and the one that stops the
    // unsigned column being won by a gate that simply always narrows. It is
    // `mergecast`'s twin at the other signedness and `mergeu16`'s at the other spelling: same
    // merge, same single `zext16` reader, same raw in-edges, and it must stay REFUSED because
    // agbcc really did hoist the else arm here.
    sym: 'mergecastu',
    src:
      'void mergecastu(s32 *out, s32 a, s32 b, s32 c)\n' +
      '{\n' +
      '    s32 v;\n' +
      '\n' +
      '    if (c) {\n' +
      '        v = a + b;\n' +
      '    } else {\n' +
      '        v = a - b;\n' +
      '    }\n' +
      '    out[0] = (u16)v;\n' +
      '}',
    features: ['narrow', 'zero-extend', 'cast', 'branch', 'pointer'],
    toolchains: ALL,
    ctx: 'void mergecastu(s32 *out, s32 a, s32 b, s32 c);',
    proto: { mergecastu: { returnsVoid: true } },
  },
  {
    // THE DIAMOND `gcc/jump.c` COULD NOT HAVE HOISTED, and the reason the arm clause in
    // raise/narrowlocal.ts is about the ARM'S OPS and not only the arm's SIZE. Both arms are a
    // single load — one SET each, so an arm-SIZE test admits them — but `gcc/jump.c:483`'s
    // `! may_trap_p (SET_SRC (temp4))` refuses to speculate a MEM above the compare
    // (`gcc/rtlanal.c:1770` MEM -> `rtx_addr_can_trap_p`, `:144` a plain pseudo address CAN trap),
    // so the diamond survives for BOTH spellings and carries no information at all. Narrowing here
    // spells `u16 v` for a source that wrote `s32 v` + `(u16)v` and loses the match.
    sym: 'mergeldcast',
    src:
      'void mergeldcast(s32 *out, s32 *p, s32 c)\n' +
      '{\n' +
      '    s32 v;\n' +
      '\n' +
      '    if (c) {\n' +
      '        v = p[0];\n' +
      '    } else {\n' +
      '        v = p[1];\n' +
      '    }\n' +
      '    out[0] = (u16)v;\n' +
      '}',
    features: ['narrow', 'zero-extend', 'cast', 'branch', 'pointer'],
    toolchains: ALL,
    ctx: 'void mergeldcast(s32 *out, s32 *p, s32 c);',
    proto: { mergeldcast: { returnsVoid: true } },
  },
  {
    // THE SAME REFUSAL FROM THE OTHER DIRECTION: an arm that is one C assignment but not one
    // THUMB INSN. `v = a + 0x12345` needs a literal-pool load before the add, so the arm is two
    // insns and `gcc/jump.c:472`/`:474`'s `single_set` on `prev_active_insn` never matches — the diamond
    // survives under the CAST spelling too. In the lifted IR the pool word is a `const` feeding an
    // `add`, which is why the arm clause counts constants: an immediate the target cannot fold is
    // a second SET, and the IR does not say which is which. The FOLDABLE case (`a + 3`, one
    // `adds`) needs no such refusal — agbcc really does hoist it, so the join is not a diamond and
    // the join clause already decides it.
    sym: 'mergepool',
    src:
      'void mergepool(s32 *out, s32 a, s32 b, s32 c)\n' +
      '{\n' +
      '    s32 v;\n' +
      '\n' +
      '    if (c) {\n' +
      '        v = a + 0x12345;\n' +
      '    } else {\n' +
      '        v = a - b;\n' +
      '    }\n' +
      '    out[0] = (u16)v;\n' +
      '}',
    features: ['narrow', 'zero-extend', 'cast', 'branch', 'pointer'],
    toolchains: ALL,
    ctx: 'void mergepool(s32 *out, s32 a, s32 b, s32 c);',
    proto: { mergepool: { returnsVoid: true } },
  },
  {
    sym: 'widecnt',
    src:
      's32 widecnt(void)\n' +
      '{\n' +
      '    s32 i;\n' +
      '    s32 s;\n' +
      '\n' +
      '    s = 0;\n' +
      '    for (i = 0; i < 10; i++) {\n' +
      '        s += i;\n' +
      '    }\n' +
      '    return s;\n' +
      '}',
    features: ['arithmetic'],
    toolchains: ALL,
    ctx: 's32 widecnt(void);',
  },
  {
    sym: 'narrowcnt',
    src:
      's32 narrowcnt(void)\n' +
      '{\n' +
      '    s16 i;\n' +
      '    s32 s;\n' +
      '\n' +
      '    s = 0;\n' +
      '    for (i = 0; i < 10; i++) {\n' +
      '        s += i;\n' +
      '    }\n' +
      '    return s;\n' +
      '}',
    features: ['narrow-counter', 'narrow', 'sign-extend', 'arithmetic'],
    toolchains: ALL,
    ctx: 's32 narrowcnt(void);',
  },
  {
    sym: 'membwalk',
    src:
      'struct S { s32 id; u16 name[6]; };\n' +
      'void membwalk(struct S *d, struct S *s)\n' +
      '{\n' +
      '    s32 i;\n' +
      '\n' +
      '    for (i = 0; i < 6; i++) {\n' +
      '        d->name[i] = s->name[i];\n' +
      '    }\n' +
      '}',
    features: ['array', 'variable-index', 'struct', 'field'],
    toolchains: ALL,
    ctx: 'void membwalk(u8 *d, u8 *s);',
    proto: { membwalk: { returnsVoid: true } },
  },
  {
    sym: 'membnarrow',
    src:
      'struct S { s32 id; u16 name[6]; };\n' +
      'void membnarrow(struct S *d, struct S *s)\n' +
      '{\n' +
      '    s16 i;\n' +
      '\n' +
      '    for (i = 0; i < 6; i++) {\n' +
      '        d->name[i] = s->name[i];\n' +
      '    }\n' +
      '}',
    features: ['narrow-counter', 'narrow', 'sign-extend', 'array', 'variable-index', 'struct', 'field'],
    toolchains: ALL,
    ctx: 'void membnarrow(u8 *d, u8 *s);',
    proto: { membnarrow: { returnsVoid: true } },
  },
  {
    sym: 'basefold',
    src:
      'void basefold(u8 *d, u8 *s)\n' +
      '{\n' +
      '    s16 i;\n' +
      '\n' +
      '    for (i = 0; i < 6; i++) {\n' +
      '        *((u16 *)(d + 4) + i) = *((u16 *)(s + 4) + i);\n' +
      '    }\n' +
      '}',
    features: ['narrow-counter', 'narrow', 'sign-extend', 'cast', 'pointer'],
    toolchains: ALL,
    ctx: 'void basefold(u8 *d, u8 *s);',
    proto: { basefold: { returnsVoid: true } },
  },
  {
    sym: 'sibwalk',
    src:
      'struct S { u16 a[6]; u16 b[7]; u16 c[9]; };\n' +
      'void sibwalk(struct S *d, struct S *s)\n' +
      '{\n' +
      '    s16 i;\n' +
      '\n' +
      '    for (i = 0; i < 6; i++) {\n' +
      '        d->a[i] = s->a[i];\n' +
      '    }\n' +
      '    for (i = 0; i < 7; i++) {\n' +
      '        d->b[i] = s->b[i];\n' +
      '    }\n' +
      '    for (i = 0; i < 9; i++) {\n' +
      '        d->c[i] = s->c[i];\n' +
      '    }\n' +
      '}',
    features: ['narrow-counter', 'narrow', 'sign-extend', 'array', 'variable-index', 'struct', 'field'],
    toolchains: ALL,
    ctx: 'void sibwalk(u8 *d, u8 *s);',
    proto: { sibwalk: { returnsVoid: true } },
  },

  // WHERE A VALUE THAT SEVERAL PLACES NEED GETS ITS ONE HOME, in a function with no loop. The
  // `value-home` rows above are all loop-shaped or address-shaped: `/addr-home` homes a base
  // dereferenced at 2+ sites, `/expr-home` homes a pure value defined outside a LOOP, and
  // `/derived-home` homes a pure value standing on a memory READ (rank.ts:156-195, all three
  // gated in structure/analysis.ts). When this family was cut nothing homed a plain computed value
  // shared by two BRANCH ARMS, nor a parameter's narrowing re-spelled at every use — both are what
  // a bit-test prologue is made of, and both have since shipped (`/merge-home`, rank.ts:197-218,
  // and the recovered narrow parameter declaration; every row below is MATCH).
  //
  // Cut from sa3:sub_802DFC8:agbcc and sa3:sub_803213C:agbcc, the two rows this family was
  // written to explain — both scored 62 and 48 when it was cut and both are MATCH today; m2c
  // NONCOMPILEs both. The `['struct','field']` attribution they were cut under is FALSIFIED
  // — starting from asmlift's own winning source and changing only the
  // three homes below, 802 reaches 0 (`rows=128`) and 832 reaches 0 (`rows=71`) while still
  // carrying asmlift's synthesized `struct Struct0 { s32 field_0; u8 _pad0[4]; … }`, its `field_N`
  // member names, `16 - 17` for -1 and the raw `(-(x)|x)>>31 & C` branchless idiom. asmlift's
  // struct-pointer field recovery on those rows is already byte-perfect (offsets
  // 0/8/12/14/20/22/26/27/28/31/32, every width right).
  //
  // The 8-subset lattice, every cell compiled through the row's own scoring context and scored
  // against its own target — A = the narrowed-parameter home, B = the merge-init (802) / cross-arm
  // expression (832) home, C = the base local. RESIDUAL score per subset, so 0 is a match:
  //   802: {} 62 · A 46 · B 23 · C 58 · AB 4 · AC 42 · BC 19 · ABC 0  → Shapley 17.5 / 40.5 / 4.0
  //   832: {} 48 · A 39 · B 15 · C 46 · AB 2 · AC 38 · BC 13 · ABC 0  → Shapley 10.8 / 35.3 / 1.8
  // No subset closes either row — v(AB) is 58 of 62 and 46 of 48; only all three reach 0. A cell
  // moves by ±1 when the repair is spelled differently, so read the split as ≈17/≈40/4 and
  // ≈11/≈35/2; the ordering, v(AB) and "struct/field recovery is worth ZERO" do not move.
  //
  // A FOURTH DEGREE OF FREEDOM the class names hide: WHERE each home sits RELATIVE TO THE OTHERS
  // — and the two rows want OPPOSITE answers. On 802 the merge-zero `s32 v0 = 0;` must sit ABOVE
  // the narrowing home `s32 t0 = (s16)a0;`; put it below and `mov r5, #0x0` lands two instructions
  // late, for 3. On 832 the shared constant `s32 v0 = 1;` must sit BELOW both narrowing homes; put
  // it above and `mov r6, #0x1` lands four instructions early, for 2. What does NOT matter on 832
  // is the spelling: the hoisted expression reading a literal `1` and reading the shared `v0` both
  // score 0. A home variation picks a PLACE, and "the top of the body" is a place it can pick wrong in
  // either direction.
  //
  // WHAT m2c DOES INSTEAD, and it is one mechanism, not three. m2c binds every register write to a
  // named `Var` (`translate.py:3503-3577` `_eval_once`, the name minted at translate.py:3546), so
  // a value used twice is EMITTED as `temp_rN = …;` and referred to. Its 802 output declares
  // `s16 temp_r1;`, assigns `temp_r1 = direction;`, then tests `8 & temp_r1` — the entry `lsl/asr`
  // given a name — and carries `var_r5 = 0;` above the chain. asmlift re-DERIVES an expression at
  // each use instead, which is why the same three homes are missing at once.
  //
  // THE ROWS. Every score below is a round-trip: compile the reference with the benchmark's own
  // agbcc, run the CLI on the produced `.s` and `--score-against` the produced `.o`. All nine
  // score with 0 dropped candidates and none declines, so no number here stands in for a frontend
  // link.
  //
  //   `sxparam` MATCH — an `s16` parameter tested at three sites. agbcc extends it ONCE at entry
  //   (`lsl r0,#0x10 / asr r2,r0,#0x10`) and all three tests then read r2 with the constant in the
  //   other operand; asmlift declared `u32 a0` and re-spelled `(s16)a0` at each use, which agbcc
  //   ELIDES (an `& 8` does not care) — so the extended value never gets a register of its own and
  //   the stream instead pays `add r2,r0,#0` at entry, `add r0,r2,#0` to read it back, and a
  //   different allocation from there on. FIVE-RUNG LADDER, all compiled against this row's own
  //   target:
  //     19  asmlift when this row was cut (today it declares the narrow parameter and scores 0)
  //     16  the same source with ONLY the home added (`s32 t0 = (s16)a0;`)
  //      2  …and the now-redundant inner narrowing dropped (`-(t0 & 2)` for `-(s16)(t0 & 2)`)
  //      0  the home given the NARROW type (`s16 t0 = (s16)a0;`)
  //      0  the parameter declared `s16`
  //   Today asmlift emits the last rung itself — `void sxparam(s16 a0, s32 *a1)`, 2 candidates,
  //   `unsigned: 0`. The NARROW parameter is recovered from the prologue extension, not handed
  //   over: dropping `--proto` leaves the same 2 candidates and the same `unsigned: 0 (match)`
  //   with `s16 a0` still declared (only the return type falls back to `s32`, which is the one
  //   fact `proto` does carry).
  //   The two middle rungs are what a builder needs: the capability is a home that CARRIES THE
  //   WIDTH, or an s32 home plus the cast-cleanup a width-carrying home makes automatic. (On the
  //   real rows the s32 home alone is enough — their re-spellings are not nested inside a cast.)
  //   `zxparam` MATCH is the unsigned side (`lsl #0x18 / lsr #0x18` once per parameter): 8 when cut,
  //   and 0 for the homed `u8` temp, the homed `s32` temp AND the declared `u8` parameter alike.
  //
  //   `armexpr` MATCH (`/merge-home`; the candidate without it is still 35) — a pure expression the
  //   source computed ONCE above an `if`, whose only
  //   consumers are the two arms. asmlift sinks it into BOTH arms and agbcc does not re-hoist:
  //   compiled pair, the pre-branch spelling emits the 8-instruction `mov/and/neg/orr/asr#31/mov/
  //   lsl/and` chain once in the entry block, the per-arm spelling emits that entire chain TWICE,
  //   once per arm. Homing it above the branch scores 0 — but ONLY with the signed parameter
  //   asmlift's winner already declares (its variations are `signed`): spelled `u32`, agbcc constant-
  //   folds the whole `>>31` idiom to `mov r3, #0x0` and the same repair scores 18. The variation is a
  //   home, not a re-typing, and it must not disturb the signedness the ranked candidate picked.
  //
  //   `maskchain` MATCH (`/defsite/merge-home`; `signed/defsite` alone is still 21) — `s32 m = 0;`
  //   above a four-arm chain whose arms conditionally overwrite
  //   it. asmlift re-materializes the 0 as an `else { v0 = 0; }` arm in three places and agbcc
  //   IF-CONVERTS each two-armed form into the branchless `neg/orr/asr #31/and` idiom the source
  //   never wrote — 4 `neg`s against the reference's 1. FIRST BLOCKER WATCHED FIRING, not inferred,
  //   then ABLATED: `structure.ts`'s anchorConstCopies declines any merge variable whose name is
  //   claimed by more than one SSA value (the `nameCount.get(name) === 1` accept condition at
  //   structure.ts:2452, documented in that block's REFUSAL CONDITIONS list at structure.ts:2371),
  //   and instrumented it
  //   fires 48× on `v0` here. With that one condition ablated and the bundle rebuilt the row's
  //   ranked line goes from `best signed/defsite: 21` to a MATCH. `/defsite` IS enumerated here
  //   and wins the row — for the OTHER variable, the four-way `v`.
  //   On sub_803213C the same pass declines for a different documented reason, watched the same
  //   way: `v1` is CONSIDERED 288× and refused 288× on `opcode=or` plus 288× on `opcode=and` — the
  //   merge args there are an `or` and an `and`, not an unnamed `const`, so `/defsite` cannot reach
  //   `armexpr`'s shape at all. That is why the expression home is a separate row from this one.
  //
  //   `basecell` MATCH — ONE access through a numeric base at a nonzero byte offset. gcc 2.9
  //   folds a constant SUBSCRIPT into the pool word, so the inline cast compiles to
  //   `.word 0x3001103` + `ldrb r2, [r1]` where the pointer-local spelling keeps
  //   `.word 0x3001100` + `ldrb r1, [r1, #0x3]` (compiled pair, both dumped). `l3/basecse.ts`'s
  //   `single-use` gate rejected a base with `uses < 2` — its stated rationale, "one access
  //   re-materializes as cheaply as a named local", is false at a nonzero offset — so the offset
  //   the compiler did NOT fold rides as `BaseKey.unfoldedOffset` in a SECOND admission,
  //   `BASEFOLD_GATES`, which rank.ts offers as `/basefold` wherever the target declares
  //   `TargetDescription.compilerBehaviors.foldsConstAddrOffset`. A CANDIDATE and not a default,
  //   because the same bytes have a second source: agbcc keeps an aggregate MEMBER offset in the
  //   memory operand, so `((struct S *)0x3001100)->b` emits `.word 0x3001100` + `ldr [r0, #0x4]`,
  //   byte-identical to the named base (likewise a union member, and the write direction).
  //   asmlift can spell only one of the two, so the differ referees.
  //   The row is agbcc alone and holds the ADMITTED case; the refusals that keep the admission
  //   off the naive ablation below are gate-level, pinned in test/basecse.test.ts — an offset the
  //   ADDRESS carried rather than the memory operand (a relocation addend, a folded `add`, or an
  //   offset of 0, where the fold is the identity), a base of 0 (no literal for a subscript to
  //   fold INTO), and a target that declares no fold. A SYMBOL base reads the same rule off the
  //   same evidence: the bytes never agreed there either (`((u8 *)&gSym)[3]` emits
  //   `.word gSym+0x3` + `ldrb [r1]` where `gSym.d` and a named base both emit `.word gSym` +
  //   `ldrb [r1, #0x3]`), and `index.operandOff` is what carries the difference down from the lift.
  //
  //   `basehome` MATCH — THREE accesses through one base whose first use is not the function's
  //   first statement. The hoist fires here, but `l3/basecse.ts` emits every init at the head of
  //   `sfn.body`, so the base is live across the prologue and agbcc pays a callee-saved register
  //   for it: compiled pair, assigning at the top adds `push {r4, lr}` / `pop {r4}` / `pop {r0}` /
  //   `bx r0` where assigning at first use keeps a plain `bx lr`. LADDER: the base local at the
  //   top of the body 11;
  //   NOT hoisting at all 9 (three fresh pool words, `.word 0x3001103` / `0x300110a` /
  //   `0x3001109`); assigning at the first use that needs it 0. The current placement is worse
  //   than no hoist, which is the same signal the real row gives — on sub_802DFC8 the inline
  //   spelling scores 4, a top-assigned base local 8, a first-use-assigned one 0, and asmlift's
  //   own `/livebase` candidate (which does emit the base local, at the top) scored 66 against the
  //   then-winner's 62. `l3/sinkinit.ts` is that placement, carried as the differ-refereed `/sinkinit`
  //   candidate rather than as basecse's own `[...inits, ...rest]` — taken as a DEFAULT the same
  //   move costs `mixpoll` and `onepoll` their matches, which is the ledger below. `l3/scopebase.ts`
  //   is the scope-aware sibling and does not help: the innermost enclosing scope here IS the
  //   function body. Eligibility and placement are the two halves of one question and both ride as
  //   candidates — `/basefold` and `/sinkinit`, paired over the admission roster.
  //
  //   `foldsink` MATCH — `basecell`'s single fold-evidence access placed in `basehome`'s position:
  //   ONE access through a numeric base at a nonzero byte offset, three statements down, so the
  //   two halves of the question are BOTH live and the row can only match if both are answered.
  //   LADDER, read off this row's own `[score]` table rather than off a hand-written source:
  //   asmlift's inline cast 2; the base local assigned at the top of the body 9 — WORSE than not
  //   hoisting, the same signal `basehome` gives, and the reason a placement policy that picks
  //   wrong regresses rather than stalls; the base local assigned at its first use 0.
  //   IT DOES NOT BRACKET THE SUNK PLACEMENT. Measured through
  //   `compileTargetAsm`/`assembleTarget`/`decompileRanked` with `ASMLIFT_CANDCACHE=0`: the
  //   fan is 12 candidates and TWO spellings reach 0 — `/basefold/sinkinit` and `/offmember` — so
  //   `compareScored` settles it on `lineCount`, the member spelling has one line fewer, and the
  //   published winner is `unsigned/offmember`. Deleting the sunk admission would leave this row
  //   MATCH. `basecell` is the same story at the head position (`/offmember` 0 ties `/basefold` 0
  //   and wins the tie-break), which is why NEITHER old row puts `basefold` among a winner's
  //   variations and why a census over winners' variations reads the family as dead. A TIE IS NOT A
  //   SUBSUMPTION: `foldhead` below is the same evidence answered where the two spellings are 0 and
  //   11, and there `/offmember` is not a tie but a worse program.
  //
  //   `foldhead` MATCH — `foldsink`'s shape with the DECLARATION carrying the initializer, which is
  //   the ordinary way a C source spells a base it uses once further down: the local is assigned at
  //   the top of the body and first read three statements later. It is the HEAD-position bracket,
  //   which nothing else in this corpus is. Read off this row's own
  //   `[score]` table (12 candidates, `ASMLIFT_CANDCACHE=0`): `/basefold` 0, `/basefold/sinkinit`
  //   11, `/offmember` 11, no variation at all 11 — so deleting the HEAD entry of
  //   `BASEFOLD_HOISTS` costs this row its match while deleting the SUNK entry does not, which
  //   is the separation `foldsink` makes in the other direction.
  //   WHAT SPLITS THE THREE SPELLINGS, on compiled objects rather than on a theory: the pool order
  //   is IDENTICAL in all three (`.word 0x3001100` then `.word 0x8024c35`) and the head-assigned
  //   local is the one whose live range spans the two `out[]` stores, so agbcc gives it a
  //   call-saved register and pays the prologue: `push {r4, lr}` / `str r0, [r4, #0x4]` /
  //   `pop {r4}` / `pop {r0}` / `bx r0`, where the same local assigned at its first use and the
  //   inline member cast both use r1 and keep `bx lr` — and those two assemble to the SAME BYTES
  //   (`diff` of the two `.s`: empty), which is why they tie at 11. So the claim in `basecell`'s
  //   paragraph that a member access is "byte-identical to the named base" holds only where the two
  //   spellings materialize the base at the SAME program point — move the assignment above the use
  //   and `/offmember` is a different program, which is why it rides beside this row and loses.
  //   THE SHAPE IS NOT SYNTHETIC-ONLY. Sweeping the agbcc checkouts one tree per function (2523
  //   thumb functions split out of `sa3/asm/*.s` and klonoa's `asm/`, 1762 lifted), the set
  //   `BASEFOLD_GATES` admits and `BASECSE_GATES` refuses is non-empty on 327 functions / 431 bases
  //   map-less and 272 / 365 map-ful, and on 141 of those bases (map-less; 142 map-ful)
  //   `/offmember` is refused outright — 83 of them by `no-operand-off`, because a sibling access
  //   at offset 0 through the same base leaves no displacement to read.
  //   RANKED, AND SAY THE CONFIGURATION — a sweep score quoted without one is not a weaker claim
  //   than one with it, it is a different claim. With the target
  //   assembled by hand from the checkout's own `.s` (`.syntax unified` prepended, else the
  //   unified Thumb mnemonics do not assemble) and ranked through the benchmark's own agbcc
  //   candidate compiler, `ASMLIFT_CANDCACHE=0`, BOTH configurations. All three are functions in
  //   the klonoa checkout, ranked outside the benchmark, so none of them is a row:
  //     InitPauseMenu             map-less 28 vs 30 ablated · map-ful 28 vs 30 — REPRODUCES,
  //                               and it is the one function of the three the two
  //                               configurations agree on.
  //     UpdateUIElementAnimation  map-less 102 vs 106 (runner-up IS `/offmember`) —
  //                               REPRODUCES map-less; map-ful it is 99 vs 105, still won by
  //                               `/basefold`, so the WIN survives the configuration and the
  //                               numbers do not.
  //     StreamCmd_SetTimerAndMode map-less 11 vs 12 on this rig. A 17-vs-18 reading of the
  //                                     same function comes off a DIFFERENT target: 13 candidates
  //                                     either way, so the fan is identical and a hand-assembled
  //                                     object's pool alignment is not the project build's.
  //                                     MAP-FUL IT DOES NOT WIN AT ALL: 7 either way,
  //                                     `unsigned/inlinebase/volatile` with and without it.
  //   So the honest reading is a one-point edge on two functions in one configuration, not three
  //   wins. None of the three is a benchmark row; all of it is a rig artifact until re-run, and
  //   the row's own bracket (`synthetic:foldhead`) rests on none of it.
  //
  // THE CONTROL. `armkeep` MATCH — the same pure expression computed in BOTH arms, but consumed
  //   inside each arm rather than merged out of the `if`. agbcc keeps both copies, asmlift emits
  //   both copies, and the row matches. Hoisting it above the branch scores 9 against this row's
  //   own target, so a cross-arm home keyed on "the same pure expression appears in both arms"
  //   BREAKS it and the row says so. What it does NOT bracket: a home keyed on a MERGE VARIABLE's
  //   incoming values — nothing can, on this compiler. Measured, `if (a) { out[0]=0; m=(b<<3)+7; }
  //   else { out[0]=1; m=(b<<3)+7; } out[1]=m;` has its two copies SUNK by agbcc itself into the
  //   join block, so the ROM never carries the per-arm spelling for that shape and no reference
  //   source can produce it.
  //   Three further controls were drafted and DELETED, each because it cannot detect its own fix:
  //   `sxwide` (`out[0] = d; out[1] = d + 1;`) scores 0 in all four spellings — where the uses
  //   consume the FULL value agbcc CSEs the extension, so per-use and homed are the same program;
  //   `maskone` (`s32 m = 0; if (d & 2) m = 0x400;`) is if-converted, so it has no merge block and
  //   no `/defsite` candidate exists at all; `basefirst`'s first use IS its first statement, which
  //   makes top-placement and first-use placement the same tree. So no over-fire bracket for the
  //   WIDTH home exists anywhere in the corpus. What would earn one is a shape where the home
  //   forces a SPILL that per-use re-derivation avoids — unbuilt.
  //
  // WHAT ALREADY GATES THESE CAPABILITIES. The three capabilities were priced by ablation over the corpus as
  // it stood when this family was cut (887 rows); every row-level number that ledger carried has
  // since moved, so it is not reproduced here — re-measure against the committed artifact before
  // resting anything on it. The two findings that survive are structural: `nameCount !== 1` cost
  // ZERO regressions when ablated, which bounds only its placement cost and is not permission to
  // delete a refusal whose rationale is a MEANING concern a score cannot referee; and the two base
  // capabilities INTERACT, so ship them together and re-measure rather than one at a time.
  //
  // The `sxparam`/`zxparam` capability HAS since shipped: asmlift declares the narrow parameter
  // itself and both rows are MATCH, as are `addu8` and `truncmul` (both `narrow`) on agbcc — the
  // two pre-existing rows this family predicted would flip with it. Both still carry an ido7.1
  // residual (4 and 7), which is a different lane and not this family's evidence.
  //
  // WHERE A FIX WOULD GO. `packages/core/src/structure/structure.ts` (anchorConstCopies'
  // single-claimant refusal, ~2452) and `structure/analysis.ts` + `rank.ts` for the home itself —
  // the three variations there are ONE capability gated on three incidental shapes, and this family's
  // rows were exactly the cases none of the three admitted. The two BASE rows are closed
  // (`l3/basecse.ts`'s BASEFOLD_GATES carries the eligibility, `l3/sinkinit.ts` the placement,
  // both as candidates), and what the ledger above still prices is the SYMBOL side of
  // `single-use`. No GATE can decide that side, and the reason is the unit rather than the data:
  // `Gate<BaseKey>` judges one key at a time, and the key the relaxation would admit on the two
  // rows that move in opposite directions is the same key with the same facts —
  // `a:gCallbackQueue 4 true`, one use at offset 1, `singleCell`, not `inLoop`, not
  // `unfoldedOffset` — in BOTH symbol-map configurations, and both rows publish a map-ful winner.
  // Their censuses are NOT identical (2 keys against 5 map-less, 2 against 3 map-ful), so a
  // predicate over the whole census is a different question this has not answered. The open
  // experiment is narrower than either: `UpdateWorldMapNodeAnim`'s two map-less-only keys are the
  // only `reachedOnce` keys in the pair that are not `singleCell`, so refusing THOSE would admit
  // `gCallbackQueue` alone on both rows — if 159→162 is carried by them and not by it, the win
  // survives and the loss does not. Run that before assuming this side needs a candidate.
  // The per-site-signedness round that shares two of those files has LANDED (5df7ced) and this
  // family is measured on top of it: all seven synthetic rows then in the family (`foldsink` and
  // `foldhead` postdate it) and both real rows score identically
  // before and after, and its structure.ts hunks (577, 1648, 1976-2048, 2221) do not touch
  // anchorConstCopies. Nothing here needs `l3/typing.ts`, `backend/cfamily.ts` or `rank.ts`'s
  // `SIGNEDNESS` either: every `signed/` candidate scores identically to its `unsigned/` counterpart on
  // all 24 of 802's and all 4 of 832's, so the signedness variation contributes zero on both real rows.
  //
  // NO NEW TAG, and one was tried: `param-width`, on the theory that asmlift must consume
  // `FnProto.params`' typed list. Handing asmlift the exact declared types via
  // `--proto '{"sub_802DFC8":{"params":["s16","Sprite *"],"returnsVoid":true}}'` returns the same
  // ranked line and byte-identical stdout, while homing the cast with no declared type anywhere
  // closes both real rows — so the gap is the home, not the types. The list IS read now
  // (raise/paramwidth.ts's `proto-width`), and it changes nothing here by construction: a
  // declaration only refuses a narrowing it CONTRADICTS, and `s16` is what this row's own prologue
  // extension already states. The rows carry the list anyway, so both decompilers hold the same
  // facts — the harness hands m2c the function's own prototype.
  //
  // m2c, on the identical `ctx` asmlift receives, MATCHES `sxparam` and NONCOMPILES the other
  // eight — for two reasons, neither of them this family, and it REACHES the construct in every
  // case. (1) Seven of the eight (`zxparam`, `armexpr`, `armkeep`, `maskchain`, `basehome`,
  // `foldsink`, `foldhead`) store through a pointer PARAMETER at more than one offset and m2c
  // renders those as `out->unk0` / `out->unk4` on an `s32 *` it has no struct for — its
  // documented raw-pointer member rendering, not context
  // withheld, since the `ctx` declares the full prototype, parameter names and all. (2) Four
  // (`basecell`, `basehome`, `foldsink`, `foldhead`) type the address constant as `void *` and
  // read members off it (`(void *)0x03001100->unk3`), as every raw-address row in this file
  // already records; on
  // `basecell` that is the ONLY cause — its single store through the parameter renders as `*out`. What the output SHOWS is the point: on `armexpr` m2c hoists the
  // whole chain above the branch (`var_r2 = …;` then `if (a != 0)`), on `armkeep` it keeps BOTH
  // per-arm copies exactly as the reference wrote them, on `maskchain` it emits `var_r1 = 0;`
  // above the chain, and on `zxparam` it declares `u8 temp_r0;` and assigns `temp_r0 = a;`. Every
  // home this family is about, m2c has — and on `armkeep`, so does the restraint not to use one.
  //
  // agbcc only, as the `read-once` family is (`uninit-local` is NOT — it spans all four
  // toolchains, so it is no precedent). Every claim above is a pair of
  // spellings compiled with THIS compiler; whether ido7.1, gcc2.7.2kmc and mwcc_242_81 place a
  // parameter's extension, a merge initializer or a base local the same way was NOT measured, so
  // those lanes are left off rather than assumed. What would earn one: the same compiled pair on
  // that toolchain showing the same divergence.
  {
    sym: 'sxparam',
    src:
      'void sxparam(s16 d, s32 *out){ s32 v;' +
      ' if (d & 8) v = 6; else if (d & 4) v = 4; else if (d & 2) v = 2; else v = 0;' +
      ' out[0] = v; }',
    features: ['value-home', 'sign-extend', 'mask'],
    toolchains: ['agbcc'],
    ctx: 'void sxparam(s16 d, s32 *out);',
    proto: { sxparam: { params: ['s16', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'zxparam',
    src: 'void zxparam(u8 a, u8 b, s32 *out){ out[0] = a & 1; out[1] = b & 1; out[2] = a + b; }',
    features: ['value-home', 'zero-extend', 'mask'],
    toolchains: ['agbcc'],
    ctx: 'void zxparam(u8 a, u8 b, s32 *out);',
    proto: { zxparam: { params: ['u8', 'u8', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'armexpr',
    src:
      'void armexpr(u32 a, u32 b, s32 *out){\n' +
      '  s32 m = (b & 1) ? 0x400 : 0;\n' +
      '  if (a != 0) { out[0] = 0; } else { out[0] = 1; m |= 0x200; }\n' +
      '  out[1] = m;\n' +
      '}',
    features: ['value-home', 'mask'],
    toolchains: ['agbcc'],
    ctx: 'void armexpr(u32 a, u32 b, s32 *out);',
    proto: { armexpr: { params: ['u32', 'u32', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'armkeep',
    src:
      'void armkeep(u32 a, u32 b, s32 *out){\n' +
      '  if (a != 0) { out[0] = (b << 3) + 7; }\n' +
      '  else { out[1] = (b << 3) + 7; }\n' +
      '}',
    features: ['value-home', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void armkeep(u32 a, u32 b, s32 *out);',
    proto: { armkeep: { params: ['u32', 'u32', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'maskchain',
    src:
      'void maskchain(s32 d, s32 *out){\n' +
      '  s32 m = 0, v;\n' +
      '  if (d & 8) { v = 6; m = (d & 1) ? 0x400 : 0; }\n' +
      '  else if (d & 4) { v = 4; if (d & 2) m = 0x400; if (d & 1) m |= 0x800; }\n' +
      '  else if (d & 2) { v = 2; if (d & 1) m = 0x400; }\n' +
      '  else { v = 0; if (d & 1) m = 0x800; }\n' +
      '  out[0] = v; out[1] = m;\n' +
      '}',
    features: ['value-home', 'mask', 'merge-chain'],
    toolchains: ['agbcc'],
    ctx: 'void maskchain(s32 d, s32 *out);',
    proto: { maskchain: { params: ['s32', 's32 *'], returnsVoid: true } },
  },
  // A REGION COPY THAT SURVIVES BECAUSE THE REGION BRANCHES INSIDE ITSELF. `/argcopy`
  // (l3/argcopy.ts) refuses a STRAIGHT-LINE region: one basic block, in which every compiler in
  // the matrix forward-propagates `p = a` and the candidate is a compile that buys nothing. A
  // region holding `&&` is not one basic block — each short-circuit is an edge — and agbcc keeps
  // the copy across those edges, the same `adds rN, rM, #0` SetMauvilleOldManLanguage matches
  // through. This row is that shape with NO nested statement list: the arm's every statement is
  // a store or a call, and the reference's `p = a` is the only thing the copy models. The
  // `straight-line` gate reads the connectives, not the nesting, and this is the row that holds
  // it there; `argcopy.test.ts` pins the three sides.
  {
    sym: 'leafand',
    src:
      'void g(s32);\n' +
      's32 leafand(s32 *a, s32 c, s32 v){ s32 *p; s32 r = 0;\n' +
      ' if (c == 1) { p = a; p[3] = p[0] > v && p[4] < v; g(p[1]); p[5] = p[2] > 3 && p[6] < v; }\n' +
      ' else if (c == 2) { r = a[5]; }\n' +
      ' return r + a[7]; }',
    features: ['value-home', 'pointer', 'bool', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'void g(s32);\ns32 leafand(s32 *a, s32 c, s32 v);',
    proto: { leafand: { params: ['s32 *', 's32', 's32'] }, g: { params: ['s32'], returnsVoid: true } },
  },
  {
    sym: 'basecell',
    src: '#define gStage 0x03001100\n' + 'void basecell(s32 *out){ u8 *p = (u8 *)gStage; out[0] = (p[3] != 7); }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void basecell(s32 *out);',
    proto: { basecell: { params: ['s32 *'], returnsVoid: true } },
  },
  {
    sym: 'foldsink',
    src:
      '#define gStage 0x03001100\n' +
      'void foldsink(s32 a, s32 b, s32 *out){\n' +
      '  u8 *p;\n' +
      '  out[0] = a * b;\n' +
      '  out[1] = a + b;\n' +
      '  p = (u8 *)gStage;\n' +
      '  out[2] = (p[3] != 7);\n' +
      '}',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void foldsink(s32 a, s32 b, s32 *out);',
    proto: { foldsink: { params: ['s32', 's32', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'basehome',
    src:
      '#define gStage 0x03001100\n' +
      'void basehome(s32 a, s32 b, s32 *out){\n' +
      '  u8 *p;\n' +
      '  out[0] = a * b;\n' +
      '  out[1] = a + b;\n' +
      '  p = (u8 *)gStage;\n' +
      '  out[2] = p[3]; out[3] = p[10]; out[4] = p[9];\n' +
      '}',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void basehome(s32 a, s32 b, s32 *out);',
    proto: { basehome: { params: ['s32', 's32', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'foldhead',
    src:
      '#define gStage 0x03001100\n' +
      'void foldhead(s32 a, s32 b, s32 *out){\n' +
      '  s32 *p = (s32 *)gStage;\n' +
      '  out[0] = a * b;\n' +
      '  out[1] = a + b;\n' +
      '  p[1] = 0x8024C35;\n' +
      '}',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void foldhead(s32 a, s32 b, s32 *out);',
    proto: { foldhead: { params: ['s32', 's32', 's32 *'], returnsVoid: true } },
  },

  // HOW MANY LOCALS ONE BASE ADDRESS IS. Every base-local row above spells its base ONCE — a
  // file-scope `#define` (`dmafill`, `dmaptrsrc`, `dmavolsrc`, `dmaback`, `dmanest`) or one local
  // at the top of the function (`dmastride`, `dmafield`, `fieldbase`, `basecell`, `foldsink`,
  // `basehome`). This family is the case the source spells it N TIMES, once inside each region
  // that uses it, because a MACRO carrying its own local declaration was expanded N times — the
  // GBA `DmaSet` idiom, and the shape of every DMA macro in kleod's `include/gba/macro.h`:
  //     #define DmaSet(src, dest, control) { vu32 *dmaRegs = (vu32 *)0x040000D4; \
  //       dmaRegs[0] = (vu32)(src); dmaRegs[1] = (vu32)(dest); dmaRegs[2] = (vu32)(control); }
  // Each expansion declares its OWN `dmaRegs`, and on agbcc that is not cosmetic. A pseudo born
  // and dead inside one basic block is handled by `local_alloc` (agbcc/gcc/local-alloc.c:20-27,
  // "In this pass we consider only regs that are born and die once within one basic block ... Two
  // passes are used because this pass uses methods that work only on linear code, but that do a
  // better job than the general methods used in global_alloc"); one that spans the function falls
  // to `global_alloc`, whose priority is `floor_log2(refs)*refs / live_length`
  // (agbcc/gcc/global.c:604-624), so a long live range is allocated late and then HOLDS its hard
  // register through everything — and above r7 it is also a push/pop pair in the prologue, since
  // r4-r10 are call-saved (agbcc/gcc/thumb.h:405-411).
  //
  // IT IS THE COUNT OF DISTINCT LOCALS, NOT THE DECLARATION'S SCOPE — the decisive control, and
  // it is compiled. Take asmlift's winner C, sink the base assignment into each of the three
  // regions and un-merge the third store; holding it in ONE function-scope local scores 34,
  // and giving each region its own local scores 0. Declaring those three at FUNCTION TOP and
  // declaring them inside their blocks assemble to the SAME BYTES (`diff` of the two `.s`: empty),
  // so lexical scope is not the discriminator on this compiler and a block-scoped declaration is
  // not what closing this needs. One pseudo assigned three times is one long live range; three
  // pseudos are three, and only the second lets the invariant be hoisted into the preheader and
  // held across the loop (`ldr r2, .L12` above `.L4` and `str r0, [r2]` in both arms of the
  // matching build, against a fresh `ldr r3, .L12+0x4` inside each arm at 34). `dmascope2` says
  // the same at minimum size: one local assigned in both arms is 13, two locals one per arm is 0.
  //
  // The compiled lattice on `dmascope`'s own target — two independent dimensions, all six cells, every
  // point a real compile scored against it (`-O2 -mthumb-interwork -fhex-asm -fprologue-bugfix`),
  // all FIRST-IN from asmlift's OWN winner C so no number crosses a spelling basin:
  //
  //     base placement \ third store        MERGED below the arms    PER ARM
  //     bare cast at every use              40                       36
  //     ONE function-scope local            39                       19
  //     N locals, one per region            30                       0  MATCH
  //
  // (That lattice was measured before either variation shipped; `/unmerge` + `/regionbase` have since shipped and
  // asmlift's winner is the 0 cell — `signed/unmerge/regionbase/volatile/initfirst`, 544
  // candidates.)
  //
  // So it is a CONJUNCTION and the row exists to gate it as one, and the two conventions disagree
  // by more than 3x on each term — state which one any later number uses. The base-placement term
  // (bare cast -> N locals) is 10 FIRST-IN and 36 LAST-OUT; the un-merge term is 4 FIRST-IN and 30
  // LAST-OUT. The ONE-function-local row is a third point on the placement dimension, not this
  // family's term.
  //
  // AND THE TERM IS ADVERSE WHERE IT WAS CUT FROM. Applied FIRST-IN to LoadBGTilemapData's
  // then-ranked winner (386, its `/raw-globals` basin), giving each DMA region its own base local
  // scores 406 — twenty points WORSE, with every neighbouring divergence still in place. Pairing
  // it with the reference's read-back reads 401, still worse than the winner (the read-back alone
  // is 433). This family's OTHER term, the third-store un-merge, has not been priced on that
  // function at all. It pays only once the sibling divergences are gone; gate it here as a
  // conjunction term and never ship it as a default on its own evidence.
  //
  // NO REACH WHEN THIS FAMILY WAS CUT, censused on the candidate SOURCES asmlift compiled rather
  // than read off a gate, and
  // on the invariant that actually discriminates: TWO DISTINCT LOCALS BOUND TO THE SAME BASE, one
  // per region. Across 188 captured `dmascope` candidate sources not one binds `0x040000D4` to
  // more than a single local; across 120 `dmascope2` sources 48 do bind two, and every one of
  // them is a function-top pointer PLUS the merge temp both arms assign identically — never one
  // per arm. The ASSIGNMENT alone does reach a region (80 of the 120 sink `v0 = (s32 *)67109076;`
  // into both arms), which is the 34-point spelling above and not the 0-point one. Nor does the
  // third store un-merge: all 188 `dmascope` candidates write it through a merge temp
  // (`…[2] = v1;`, spelled `p1[2] = v1;` in 136 of them) and 0 write the constant per arm.
  // Both absences are now reachable — `/regionbase` binds one base local per region and `/unmerge`
  // un-merges the third store, and the two together are the winner's variations on `dmascope2` (184
  // candidates) and `dmascope` (544).
  //
  // `dmascope1` is the CONTROL and asmlift MATCHes it (`best unsigned/volatile: 0 (match)`, 6
  // candidates): the same macro, the same base, expanded ONCE. Naming an MMIO base is not the gap
  // — counting it is. `dmascope2` is the minimal failing shape, one structural step from the
  // control: that same expansion in two disjoint `if` arms, and it failed until
  // `/unmerge/regionbase` shipped. `dmascope` is
  // the real function's shape — a loop whose two arms each expand the macro, plus a third
  // expansion after the loop — and it is where the conjunction above is measured.
  //
  // Cut from LoadBGTilemapData in the kleod checkout (agbcc), and the two counts are the family in one line: the
  // preprocessed reference declares FIVE `vu32 *dmaRegs`, one per DMA macro expansion
  // (`grep -c 'vu32 \*dmaRegs'` over it: 5), while asmlift's ranked winner at the time (386,
  // pre-`/unmerge`/`/regionbase`,
  // `unsigned/flip-branch/defsite/merge-names/addr-home/expr-home/uns-cmp/livebase-block/volatile/
  // coalesce-v20-v14/initfirst/raw-globals`) declares ONE — `volatile s32 * p0;` at function top,
  // assigned once at the head of the body. One long live range where the source had five short
  // ones.
  //
  // WHAT THIS FAMILY DOES NOT MEASURE. Every probe here is read-back-free, and the reference is
  // not: all five of its expansions read `dmaRegs[2];` back and two of them poll it
  // (`while (dmaRegs[2] & (0x8000 << 16));`). So count-with-a-read-back is untouched here —
  // `dmascope1` shows base-count-alone is not the read-back class, and `dmaback` (17, open) holds
  // the other half; the JOINT shape, which is what the real function has, has no row on either
  // side. A `dmascope` sibling carrying the read-back would be the row that earns it.
  //
  // Two neighbours describe placements that read like this one and are not: `armhomes` (MATCH) is
  // per-region homes for a MASK and loop invariants, one home per arm of an `if`, and `sizebound`
  // (nonmatch 8) is one base's init placed at its own scope while a second base's stays at
  // function top. Both are about WHERE one home goes; this family is about HOW MANY there are.
  // And NOT what `/livebase-block` names, whose name invites the wrong reading: `LIVEBASE_HOISTS`
  // (rank-variations.ts) gives `/livebase` and `/livebase-block` the same `placement: 'head'`, and "block" there is the
  // single-cell ELIGIBILITY gate, not a scope (`HoistPlacement = 'head' | 'first-use' | 'scope'`,
  // l3/hoist.ts — the two this pair uses are both function-scope). A winner carrying
  // `/livebase-block` is not evidence that
  // the base count was considered.
  //
  // agbcc only. Every claim above is a pair of spellings compiled with THIS compiler; whether
  // ido7.1, gcc2.7.2kmc and mwcc_242_81 allocate N short-lived base pseudos differently was NOT
  // measured, so those lanes are left off rather than assumed. What would earn one: the same
  // compiled pair on that toolchain showing the same divergence.
  //
  // m2c noncompiles all three, on the identical `ctx` asmlift receives, and for the reason every
  // raw-address row in this file records rather than for anything in this family: it types the
  // address constant as `void *` and reads members off it (`(void *)0x040000D4->unk0 = ...`,
  // `invalid type argument of '->'`). It REACHES the construct in every case, and its output shows
  // it has the same two absences asmlift had before `/regionbase` and `/unmerge` — no base local
  // anywhere (all three expansions
  // spelled through the raw constant) and the third store merged below the arms through `var_r0`.
  {
    sym: 'dmascope1',
    src:
      'typedef volatile unsigned int vu32;\n' +
      '#define gTbl ((s32 *)0x03001000)\n' +
      '#define DmaSet(src, dest, control) { vu32 *dmaRegs = (vu32 *)0x040000D4;' +
      ' dmaRegs[0] = (vu32)(src); dmaRegs[1] = (vu32)(dest); dmaRegs[2] = (vu32)(control); }\n' +
      'void dmascope1(s32 n){ DmaSet(gTbl[n], gTbl[n + 1], 0x80000020); }',
    features: ['value-home', 'pointer', 'macro'],
    toolchains: ['agbcc'],
    ctx: 'void dmascope1(s32 n);',
    proto: { dmascope1: { params: ['s32'], returnsVoid: true } },
  },
  {
    sym: 'dmascope2',
    src:
      'typedef volatile unsigned int vu32;\n' +
      '#define gTbl ((s32 *)0x03001000)\n' +
      '#define DmaSet(src, dest, control) { vu32 *dmaRegs = (vu32 *)0x040000D4;' +
      ' dmaRegs[0] = (vu32)(src); dmaRegs[1] = (vu32)(dest); dmaRegs[2] = (vu32)(control); }\n' +
      'void dmascope2(s32 n){' +
      ' if (gTbl[n] != 0) { DmaSet(gTbl[n], gTbl[n + 1], 0x80000020); }' +
      ' else { DmaSet(gTbl[n + 2], gTbl[n + 3], 0x80000040); } }',
    features: ['value-home', 'pointer', 'macro'],
    toolchains: ['agbcc'],
    ctx: 'void dmascope2(s32 n);',
    proto: { dmascope2: { params: ['s32'], returnsVoid: true } },
  },
  // `dmascope` WITH ITS WRITE BASE IN ORDINARY RAM. The reading is the same — three regions,
  // one local each, bare `/regionbase` — and nothing in the function is a device: the base is
  // `(u32 *)0x03002000` and the reference declares no `volatile`. What the row pins is the
  // TIE-BREAK rather than the reach. The bare per-region spelling and its `/volatile` sibling
  // both reach the bytes, and the published winner must be the one that adds no `volatile` to
  // memory the reference never marked: a `volatile` on ordinary RAM is a spelling the reference
  // does not have, and a winner carrying it would be a wrong answer at score 0. Every other
  // row that reaches a bare `/regionbase` writes a device register, where the `/volatile` sibling
  // is the right answer, so without this row the tie-break is refereed on one side only.
  {
    sym: 'memscope',
    src:
      '#define gTbl ((s32 *)0x03001000)\n' +
      '#define MSet(src, dest, control) { u32 *regs = (u32 *)0x03002000;' +
      ' regs[0] = (u32)(src); regs[1] = (u32)(dest); regs[2] = (u32)(control); }\n' +
      'void memscope(s32 n){ s32 i;' +
      ' for (i = 0; i < n; i++) {' +
      ' if (gTbl[i] != 0) { MSet(gTbl[i], gTbl[i + 1], 0x80000020); }' +
      ' else { MSet(gTbl[i + 2], gTbl[i + 3], 0x80000040); } }' +
      ' MSet(gTbl[0], gTbl[1], 0x80000080); }',
    features: ['value-home', 'pointer', 'macro'],
    toolchains: ['agbcc'],
    ctx: 'void memscope(s32 n);',
    proto: { memscope: { params: ['s32'], returnsVoid: true } },
  },
  {
    sym: 'dmascope',
    src:
      'typedef volatile unsigned int vu32;\n' +
      '#define gTbl ((s32 *)0x03001000)\n' +
      '#define DmaSet(src, dest, control) { vu32 *dmaRegs = (vu32 *)0x040000D4;' +
      ' dmaRegs[0] = (vu32)(src); dmaRegs[1] = (vu32)(dest); dmaRegs[2] = (vu32)(control); }\n' +
      'void dmascope(s32 n){ s32 i;' +
      ' for (i = 0; i < n; i++) {' +
      ' if (gTbl[i] != 0) { DmaSet(gTbl[i], gTbl[i + 1], 0x80000020); }' +
      ' else { DmaSet(gTbl[i + 2], gTbl[i + 3], 0x80000040); } }' +
      ' DmaSet(gTbl[0], gTbl[1], 0x80000080); }',
    features: ['value-home', 'pointer', 'macro'],
    toolchains: ['agbcc'],
    ctx: 'void dmascope(s32 n);',
    proto: { dmascope: { params: ['s32'], returnsVoid: true } },
  },
  // TWO BASES IN ONE FUNCTION THAT WANT OPPOSITE HOMES: N REGION-LOCAL DEVICE BASES *AND* ONE
  // FUNCTION-SCOPE BASE THAT OUTLIVES THEM ALL. Two families each isolate one base and
  // one policy — `dmascope` (`/regionbase`) that a base spelled in N disjoint regions is N locals,
  // COUNT being the discriminator; `mixpoll` (`/livebase-block`) that one base bound at function
  // scope sits beside single-cell scalars that must stay inline, SELECTIVITY being the
  // discriminator. Real functions carry both at once, and asmlift's ranker admits a
  // pairing only where a row demands it. This pair is that row and its over-fire control.
  //
  // THE ENDPOINT AND THE LATTICE. Every point below is a real compile of a hand-written spelling
  // scored against `dmapoll`'s own object with this agbcc (`-O2 -mthumb-interwork -fhex-asm
  // -fprologue-bugfix`) — ABSOLUTE scores of whole spellings, no variation added or removed between
  // two cells, so no FIRST-IN/LAST-OUT/Shapley convention applies to any of them.
  //
  //     DMA base \ the 0x03004000 base     LEFT INLINE   ONE function-scope local   PER REGION
  //     bare cast at every use                  69                  --                  --
  //     N locals, one per region                41                   0  MATCH           18
  //     ONE function-scope local                --                  11                  --
  //
  // 69 with neither hoist, 18 for a per-region reading of BOTH bases, 11 for a function-scope
  // reading of both — 0 only where the two policies apply to DIFFERENT bases. The composed
  // spelling is not a third invention: it is asmlift's own emitted `signed/regionbase/volatile`
  // source under one substitution, the three per-region locals for 0x03004000 collapsed into the
  // single head-assigned local `/livebase-block` already mints.
  //
  // WHAT THE ROW DEMANDS IS A CONJUNCTION, AND NEITHER HALF IS SEPARATELY WORTH BUILDING. asmlift
  // ranked 11 here before the pairing below landed (`7e78d80c`; the pairing shipped in
  // `649dee56`), and is MATCH now. A per-base region reading ALONE — DMA split per region,
  // 0x03004000 left
  // inline — is the 41 cell. Today's whole-function region reading, composed with nothing, is the
  // 18 cell. Both LOSE to the 11 the ranker already finds, so a round that ships either half and
  // re-runs `dmapoll` reads 11 and cannot tell a wrong order from a wrong row. Only the pair
  // reaches 0. And no ORDER or PAIRING of the two variations AS THEY STAND can spell it: on this
  // function `/regionbase` splits both bases (its emitted source mints `p0/p1/p2` for 0x03004000
  // as well as `p3/p4/p5` for 0x040000D4) and `/livebase-block` binds both at the head, so the
  // region reading has to become per-BASE first — a third degree of freedom neither variation has.
  // THE PAIRING LANDED AND THE PREDICTION HELD: `dmapoll` is MATCH on
  // `signed/livebase-block/homesplit-0x40000d4.4s/volatile` (l3/homesplit.ts) — the variation names the
  // WITHHELD key, which is the device base — and the commit before it reads
  // diff:11 — the one-sided ablation, run rather than argued. `dmaflat` stays MATCH, which is what
  // the additive posture below buys. Every number in this block that is not marked PREDICTION is a
  // compile or a ranked run.
  //
  // A PER-BASE CHOICE OF REGION RULE IS NOT THE FREEDOM THIS ROW NEEDS, AND THE CENSUS IS WHY. The
  // obvious reading of "make the region reading per-base" is to let `hoistScopedBases` pick its
  // `RegionRule` per BASE KEY rather than per function. That choice has a ONE-ELEMENT DOMAIN here:
  // `SCOPEBASE_GATES`' `repeated-const-offset` is tallied over the KEY's uses, and both of this
  // function's bases repeat one — 0x03004000 reaches subscript 2 twice, 0x040000D4 reaches 0, 1 and
  // 2 three times each — so NEITHER key admits under `'whole'` and there is nothing to choose
  // between. Measured three ways that agree: `hoistScopedBases(sfn, { regions: 'whole' })` serves 0
  // keys on this row and on `dmaflat`; the ranked fan carries 0 `/scopebase` candidates on either;
  // and over 80 agbcc trees censused at the plan (11 synthetic — the nine core corpus fixtures plus
  // these two rows — and the 69 of 182 klonoa functions that lift map-less with no `--asm-data`),
  // the number of keys served under BOTH region rules is 0. Trees where `/livebase-block` homes two
  // or more keys, which is the population any pairing can reach: 3 of the 11 and 7 of the 69.
  //
  // AND EVEN WITH THAT GATE ABLATED THE PER-KEY READING CANNOT REACH 0, because WHERE the init
  // sits is a second question this pass has no knob for. `hoistScopedBases` splices a region's init at
  // `Math.min(...r.uses.map((u) => u.idx[r.depth]))` — the first statement that uses it — which on
  // this function is index 1, below `v0 = 0`. The endpoint needs it at index 0, and the difference
  // is compiled: the composed spelling scores 0 with the 0x03004000 assignment at the very head of
  // the body and 2 with it one statement lower. `HoistPlacement: 'head'` is where that lives
  // (rank.ts LIVEBASE_HOISTS), which is the OTHER variation — so the freedom that reaches 0 is not
  // which RULE a key gets, it is which key the head hoist WITHHOLDS.
  //
  // WHAT ASMLIFT DID BEFORE THE PAIRING (`7e78d80c`), AND WHAT EACH VARIATION WAS WORTH HERE — one
  // ranked run of the row's own
  // target per cell. The instrument is a reversible source edit at the ONE site that produces the
  // variation (core is browser-pure, so no env switch can live there): the variation's own thunk in
  // `rank.ts` for `/regionbase`, its hoist entry for `/livebase-block`, `ablateHeuristic` from
  // `l3/gates.ts` for `region-single-use`, and a `rejects: () => false` stub for `single-cell`.
  //
  //                                   dmapoll                          dmaflat
  //     baseline                 56 cands, livebase-block/volatile 11   56, 0 MATCH
  //     `/regionbase` off        48 cands, 11                          48, 0 MATCH
  //     `/livebase-block` off    32 cands, livebase/volatile/sinkinit 12   32, 10
  //     its `single-cell` gate   32 cands, 12                          32, 10
  //     `region-single-use` off  56 cands, 11                          56, 0 MATCH
  //
  // `single-cell` and the whole `/livebase-block` admission give identical numbers, and the site
  // that makes them identical is the SHADOW — `enumerateCandidates`' `shadowed`/`sameBases` test
  // in rank.ts — not the gate table: neutering the
  // one gate leaves `LIVEBASE_BLOCK_GATES` binding exactly what `LIVEBASE_GATES` binds, so the
  // admission is refused before `hoistBaseLocals` runs. Watched with the ablation applied, all 52
  // of `/livebase-block`'s admission contexts on `dmapoll` report `shadowed=true` and it emits 0
  // candidates, against 0 shadowed / 24 candidates at baseline.
  //
  // The pair's live gate before the pairing was the `/livebase-block` half, and it was the MATCH
  // FLIP on `dmaflat` (0 -> 10) rather than the single point on `dmapoll`. The `/regionbase` half is inert
  // on both rows until the pairing exists — nothing here can fail a `bench regression` on it.
  //
  // THE TWO-SIDED ABLATION THIS FAMILY CANNOT HAVE IS A THEOREM. Ablation only
  // REMOVES candidates; with no candidate carrying both variations the winner carries at most one, so
  // ablating the OTHER variation leaves the winner in the fan and the winner cannot move. On `dmapoll`
  // both variations genuinely reach — the fan loses 8 candidates one way and 24 the other — and the winner
  // still holds. The obligation the row carries INSTEAD is the compiled lattice above.
  //
  // THE OTHER VARIATION LEAVES THE EXISTING ROWS UNMOVED FOR TWO DIFFERENT REASONS, AND ONLY ONE OF
  // THEM IS ABSENCE. A fan with no candidate carrying `/livebase-block` is not evidence that variation did not
  // run: that same `shadowed` test refuses a hoist binding the same bases at the same
  // placement as an
  // earlier one, and `LIVEBASE_BLOCK_GATES` is `LIVEBASE_GATES` plus a REJECTS-ONLY gate, so
  // wherever `single-cell` rejects nothing the two tables admit the same set and the second is
  // shadowed. Watched at the two sites rather than read off candidates' variations: on `dmascope`/`dmascope2`
  // `/livebase-block` BINDS (104 admission contexts each) and is SHADOWED in every one — drop the
  // `/livebase` row from `LIVEBASE_HOISTS` and 136 / 48 candidates carrying it appear, so that is
  // REACH. On `mixpoll`/`onepoll`/`sizebound` `/regionbase` really does emit nothing:
  // `hoistScopedBases(sfn, { regions: 'per-region' })` returns null on all 18 / 18 / 48 of its
  // invocations. First blocker per key, printed from `firstRejection`: `region-repeated-const-
  // offset` on every key of `mixpoll` and `onepoll`; on `sizebound` that on two keys and
  // `region-single-use` on the third. `dmascope1` refuses on `region-single-use` too — not on
  // `regions-degenerate`, which `firstRejection` short-circuits before reaching.
  //
  // `dmaflat` IS THE OVER-FIRE CONTROL, AND WHAT IT CANNOT SEE MATTERS AS MUCH AS WHAT IT CAN.
  // Same body, same two bases, same three IWRAM cells; the DMA declaration is lifted out of the
  // macro to function scope, so the source spells ONE device base for the whole function. agbcc
  // distinguishes them: 9 pool words with 0x040000d4 twice for `dmapoll`, 8 with it once here.
  // Scored across the same spellings the table inverts exactly —
  //     both bases at function scope    11 vs dmapoll.o    0 vs dmaflat.o
  //     composed (DMA per region)        0 vs dmapoll.o   13 vs dmaflat.o
  //     both bases per region           18 vs dmapoll.o   18 vs dmaflat.o
  // — so a pairing firing on shape rather than on the source's declaration count costs it 13, BUT
  // ONLY IF THAT PAIRING IS NOT ADDITIVE. Shipped the way every variation in this repo ships, as one
  // more candidate in the fan, the composed spelling loses 13 to 0 and the MATCH survives: a green
  // `dmaflat` is NOT evidence a pairing did not over-fire. The row is live against a pairing
  // implemented as a REWRITE, or one that wins an equal-score tie, and against nothing else.
  //
  // WHAT THE PAIRING COSTS, AND WHERE. It is enumerated per ADMITTED KEY that survives the per-key
  // table (which key the source homed is not derivable), on the FIRST roster row binding those
  // bases at that placement — so the ceiling is three withholds, `homesplit-fan-cap`, and the floor
  // is 0. `synthetic:dmapoll` and `synthetic:dmaflat` sit at the ceiling for two bases: both
  // withholds admit, 16 of each row's 72 candidates under the roster at `7e78d80c` (the next block
  // re-enumerated that fan at 80 at `acd64605`; a fan count expires with every roster row — re-run
  // it). `synthetic:dmascope` is unmoved by the pairing (diff:9 when this was measured, MATCH now)
  // but
  // STOPS BEING a variation-clean control for `/regionbase`: the pairing pipes THROUGH that pass, so 36
  // of its 260 candidates there (the roster at `7e78d80c`; the next block's census re-enumerated
  // that fan at 544 at `acd64605`) bind the DMA base three times too — and they ride `/livebase`,
  // not
  // `/livebase-block`, whose identical census at the same placement makes it the second variation on
  // one program. Of the three bases bound there exactly ONE withhold admits: the region rule splits
  // neither of the others (`homesplit-no-region`). That is why test/regionbase.test.ts asks about
  // the PASS rather than the variations. `synthetic:dmascope2` (MATCH) stays variation-clean: its census
  // is one key, so the pairing is degenerate there and contributes no candidate at all.
  //
  // NEIGHBOURS THAT READ LIKE THIS AND ARE NOT. `armhomes` (MATCH) is per-region placement with
  // exactly ONE decision to get right; `sizebound` (8) has two bases but one question, WHERE one init
  // goes, not two policies. And `LIVEBASE_HOISTS` (rank.ts) gives `/livebase` and
  // `/livebase-block` the SAME
  // `placement: 'head'`: "block" is an eligibility gate, not a scope.
  //
  // NO EXISTING ROW COVERS THIS, censused at the SITES rather than off the candidates' variations. Building every
  // agbcc synthetic row's target and enumerating it, at `7e78d80c` over the 220 the tier then
  // carried (278 today — re-run it rather than reading it): 212 rows enumerate, 8 decline on
  // unrelated
  // links (`uhalf`/`utag` overlapping struct fields, three `preupdate_*` do-while pre-update,
  // `lladd`/`llsub` unmodelled `adc`/`sbc`, `stkarg` stack-as-data) and 0 targets fail to build,
  // the two failure modes counted apart. Fans carrying BOTH VARIATIONS: 2, these two
  // rows. Rows where BOTH HOISTS BIND: 4 — these two plus `dmascope` and `dmascope2`, where
  // `/livebase-block` is shadowed. So no existing row can change outcome when the pairing changes
  // TODAY. PREDICTION: `dmascope`/`dmascope2` are where the pairing's candidates
  // start enumerating the moment it exists, so re-run them with the pairing and stop reading
  // either as a variation-clean control after; falsified by their fans carrying no candidate with both
  // variations on the commit that ships it. On the `/regionbase` side the census is already a reach
  // count — no row in the tier holds a `/regionbase` tree whose candidates the source dedup eats.
  //
  // CUT FROM LoadBGTilemapData in the kleod checkout (agbcc), AND `dmapoll` DEMANDS STRICTLY MORE THAN IT DOES.
  // Enumerating all 117760 of that function's candidates: `/regionbase` splits 0x040000D4 into
  // three locals and leaves 0x03003430 at ONE, while `/livebase-block` binds each of the two at
  // one — so there the second base is one the first variation declines to split and the policies need
  // only not collide. On `dmapoll` `/regionbase` splits BOTH into three locals each, so they must
  // be ASSIGNED PER BASE. Of the 8 map-less klonoa functions inhabiting both variations, 6 carry the
  // shape — a base `/regionbase` splits AND a different base only `/livebase-block` binds —
  // `LoadBGTilemapData`, `InitLevelFromROMTable`, `TransitionGameplayInit`, `TransitionGameOver`,
  // `UpdateOamSortOrder`, `EntityHitReaction`; `UpdateMenuCursorInput` (`/regionbase` splits every
  // base the other binds) and `UpdateStageSelectScreen` (its plan mints one local, splitting
  // nothing) do not.
  // Name the CONFIGURATION whenever those counts are quoted: they are the MAP-LESS enumeration
  // (9 `/regionbase`, 45 `/livebase-block`, 8 both, none of them benchmark rows) over 258 lifting
  // functions, while the harness's real rows and the canonical ranked command run MAP-FUL, where
  // it is 24 / 49 / 16, and WHICH SET a row inhabits is itself configuration-dependent. Exactly ONE
  // of the 16 map-ful BOTH inhabitants is a benchmark row — `kleod:UpdateCameraScroll`, `noncompile`
  // with no `winnerVariations`, its whole fan failing to build, so it can express no winner. The only
  // other row anywhere in the map-ful census is `kleod:UpdateHUDCounterDisplay`, and it is a
  // `/regionbase`-ONLY inhabitant there (map-less it is in neither set); it MATCHes on
  // `unsigned/defsite/flip-join/derived-home/scopebase/coalesce-v2-v4`, so its WINNER carries
  // `/scopebase` and not `/regionbase` even though its fan holds one. Neither closes the hole. The
  // PRE-EXISTING row census this pair fills stays 2 / 4 / 0; with these two rows in it the
  // winner-carries counts read 2 `/regionbase` / 5 `/livebase-block` / 0 both
  // (`kleod:ProcessInputAndUpdateEntities` carried the sixth at `7e78d80c` and its winner no
  // longer does).
  //
  // The number to carry to LBG is a DEFICIT of 31, not a ceiling on available gain: `/regionbase`'s
  // own basin ceiling there is 417 against the 386 winner, so a composition must clear 417 before
  // it can tie. A price measured in one spelling basin does not cross into another.
  //
  // agbcc only, for the `dmascope` family's own reason and no new one: whether ido7.1,
  // gcc2.7.2kmc and mwcc_242_81 allocate N short-lived base pseudos differently from one
  // long-lived one was never measured (mwcc_242_81 also stays off per the `hipress` hazard policy
  // — a candidate compile has no timeout). Neither row carries a busy-wait poll, so the
  // branch-likely lift link the `mixpoll`/`onepoll` block cites is NOT this family's reason.
  //
  // m2c NONCOMPILES both on the identical `ctx` and `proto`, for the raw-address reason every such
  // row in this file records and not for anything in this family: `(void *)0x040000D4->unk0 = ...`
  // , `invalid type argument of '->'`, 1 compile error, 5 markers. It REACHES the construct in
  // both and homes NO base at all — and its output for `dmapoll` and for `dmaflat` is the SAME
  // text apart from the function name, so the distinction costing agbcc 13 bytes is one it does
  // not represent.
  {
    sym: 'dmapoll',
    src:
      'typedef volatile unsigned int vu32;\n' +
      '#define gRows (*(u16 *)0x03001048)\n' +
      '#define gCols (*(u16 *)0x03002048)\n' +
      '#define gTiles (*(u16 *)0x03003048)\n' +
      '#define DmaSet(src, dest, control) { vu32 *dmaRegs = (vu32 *)0x040000D4;' +
      ' dmaRegs[0] = (vu32)(src); dmaRegs[1] = (vu32)(dest); dmaRegs[2] = (vu32)(control); }\n' +
      'void dmapoll(s32 n){ volatile s32 *st = (volatile s32 *)0x03004000; s32 i; i = 0;\n' +
      ' do { gRows = gRows + 1; gCols = gCols + 2;\n' +
      '  if (st[0] != 0) { DmaSet(st[1], st[2], 0x80000020); }\n' +
      '  else { DmaSet(st[2], st[3], 0x80000040); gTiles = gTiles + 3; }\n' +
      '  i = i + 1; } while (i < n);\n' +
      ' DmaSet(st[4], st[5], 0x80000080); }',
    features: ['value-home', 'pointer', 'macro'],
    toolchains: ['agbcc'],
    ctx: 'void dmapoll(s32 n);',
    proto: { dmapoll: { params: ['s32'], returnsVoid: true } },
  },
  {
    sym: 'dmaflat',
    src:
      'typedef volatile unsigned int vu32;\n' +
      '#define gRows (*(u16 *)0x03001048)\n' +
      '#define gCols (*(u16 *)0x03002048)\n' +
      '#define gTiles (*(u16 *)0x03003048)\n' +
      'void dmaflat(s32 n){ volatile s32 *st = (volatile s32 *)0x03004000;' +
      ' vu32 *dmaRegs = (vu32 *)0x040000D4; s32 i; i = 0;\n' +
      ' do { gRows = gRows + 1; gCols = gCols + 2;\n' +
      '  if (st[0] != 0) { dmaRegs[0] = (vu32)st[1]; dmaRegs[1] = (vu32)st[2];' +
      ' dmaRegs[2] = 0x80000020; }\n' +
      '  else { dmaRegs[0] = (vu32)st[2]; dmaRegs[1] = (vu32)st[3]; dmaRegs[2] = 0x80000040;' +
      ' gTiles = gTiles + 3; }\n' +
      '  i = i + 1; } while (i < n);\n' +
      ' dmaRegs[0] = (vu32)st[4]; dmaRegs[1] = (vu32)st[5]; dmaRegs[2] = 0x80000080; }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void dmaflat(s32 n);',
    proto: { dmaflat: { params: ['s32'], returnsVoid: true } },
  },

  // WHICH BASE KEYS GET A LOCAL — A PER-KEY QUESTION THE ROSTER ANSWERS PER FUNCTION. l3/basecse.ts
  // hoists every key its gate table admits, so an admission is an ANSWER FOR THE WHOLE FUNCTION.
  // THE GAP THESE ROWS WERE AUTHORED FOR: with only `/livebase` (every key reached twice) and
  // `/livebase-block` (those minus the ones read at a single fixed offset, `single-cell`) on the
  // roster, a source that spelled ONE base as a pointer local and left a second one inline sat
  // between them with nothing on the roster between them. These three rows are that gap and its
  // two boundaries, one admission each. `/unfolded` (l3/basecse.ts, UNFOLDED_GATES) now fills it
  // and `unfoldpark` is a MATCH.
  //
  // THE DISCRIMINATOR IT TURNS ON WAS ALREADY IN THE VOCABULARY. `BaseKey`
  // (l3/basecse.ts) carries `unfoldedOffset`: agbcc folds a constant SUBSCRIPT into the literal it
  // materializes, so an offset that arrived in the MEMORY OPERAND instead got there because
  // something other than a subscript put it there — a named base local, or an aggregate member.
  // `((s32 *)0x0300343C)[0]` emits `.word 0x300343c` + `ldr [r0]`; `s32 *p = (s32 *)0x03003400;
  // p[15]` emits `.word 0x3003400` + `ldr [r0, #0x3c]`. The field now has TWO readers, and they ask
  // OPPOSITE questions of it: `BASEFOLD_GATES` EXEMPTS `single-use` on it (a base reached ONCE) and
  // keeps both placement heuristics, so it never reaches a key reached twice inside a loop, which
  // is why it did not close this gap; `UNFOLDED_GATES` keeps `single-use` and REQUIRES the field.
  // Requiring it instead of exempting on it is the gate `/unfolded` ships as — `/livebase`'s table
  // plus `folded-offset`.
  //
  // THE MATRIX, and it is why there are three rows and not one. Best score per admission over each
  // row's own fan, agbcc, candidate cache OFF.
  //         plain  /livebase  /livebase-block  /scopebase  /unfolded
  //  livepark   30     0             6              3           0
  //  foldpark   37     6             0              6           0
  //  unfoldpark 36     9             9              9           0
  // Each row is won by a DIFFERENT admission, and `/unfolded` is the one that wins all three —
  // which is what says the gap was SELECTION. It binds exactly what `/livebase` binds on
  // `livepark` and exactly what `/livebase-block` binds on `foldpark`, so on those two it is
  // offering an existing base set at its own placement rather than a set nothing else reaches.
  // What that costs is measured per row, not asserted: fan 28 → 32 on `livepark`, 34 → 34 on
  // `foldpark` and 36 → 44 on `unfoldpark`, ablated the way BASEFOLD_HOISTS' note describes
  // (a temporary env read filtering the roster at its one use site), cache off.
  // `foldpark`'s 34 → 34 is a RENAME and not a spelling: the same source that
  // won as `signed/livebase-block/volatile/sinkinit` wins as `signed/unfolded/volatile`, because
  // the roster loop runs before the `/livebase ×` product loops and `seen` keeps the first candidate's variations.
  //
  // WHAT EACH ROW ISOLATES.
  //   `livepark`   two bases, both wanted as locals, one of them read at a single fixed offset
  //                through a local (`cur[15]`). `single-cell` refuses that key, so the NARROW
  //                admission binds only the DMA base and lands at 6. MATCH under `/livebase`.
  //   `foldpark`   `unfoldpark` — NOT `livepark` — with that cell spelled INLINE at its folded
  //                address (`*(s32 *)0x0300343C`), the shape `single-cell` was written for. It is
  //                ONE edit from `unfoldpark` and TWO from `livepark`, because it keeps the
  //                `0x03002040` distractor line `livepark` does not have: asserted by command, not
  //                by eye — `sed 's/foldpark/unfoldpark/' | diff` against `unfoldpark`'s source
  //                shows only the fold, and against `livepark`'s it shows the fold AND the
  //                distractor. The WIDE admission binds the cell anyway and lands at 6. MATCH
  //                under `/livebase-block`.
  //   `unfoldpark` `livepark` plus ONE folded single-cell distractor the source left inline
  //                (`*(s32 *)0x03002040 = *(s32 *)0x03002040 + 1;`). Now the two wanted keys and
  //                the unwanted one are on opposite sides of no gate the roster has: wide binds all
  //                three, narrow binds one, and both land at 9. The row is `livepark` plus one line
  //                — `sed '/0x03002040/d'` on its own source, with the symbol renamed, is
  //                `livepark`'s source exactly, and that scores 0 today. That is the measurement
  //                which says the gap is SELECTION and not "bind more".
  //
  // WHAT `unfoldpark` CAN AND CANNOT GATE, because a green row is not automatically a guard.
  // It IS the guard on `/unfolded`: ablate that one admission and the row goes MATCH → diff:9 at
  // fan 44 → 36. It was a guard on nothing before that admission existed, and the ablation that
  // backs THAT is the whole-roster one — `/livebase`, `/livebase-block` and the `/basefold` pair
  // together left the row at diff:9, unchanged. SCOPE IT: the 9 that survived was not the bare
  // tree's, it was `/scopebase`'s. Under that ablation the row's fan was `9 signed/scopebase`,
  // `9 unsigned/scopebase` and 36 for all six remaining candidates (`signed`, `signed/offmember`,
  // `signed/vol-store` and the unsigned mirrors), so removing `/scopebase` on top of it took the
  // row 9 → 36.
  // AND THAT DOES NOT MAKE IT A GUARD ON `/scopebase`, which is the shape a deletion round is
  // likeliest to be misled by. A deletion only ever REMOVES candidates, so the question is what
  // the row's fan holds WITHOUT the roster ablation, and there the two `/scopebase` candidates are
  // ties, not winners: `unfoldpark`'s fan is 44 candidates, `9 signed/scopebase` and
  // `9 unsigned/scopebase` among them, and its best over the 42 candidates carrying no `scopebase`
  // token is 0 — its own winner, `signed/unfolded/volatile-p1`. Deleting the plain `/scopebase`
  // roster entry moves this row by 0. The guard exists only in a tree that has
  // already lost the base-admission roster, which is a configuration no round proposes and
  // `bench diff` cannot run.
  // NOR IS IT THE ONLY ROW REACHING THE PLAIN ADMISSION, censused rather than asserted: over every
  // agbcc synthetic row, FIVE carry a plain `/scopebase` candidate — `dmascope` 12 of 260,
  // `livepark` 2 of 28, `foldpark` 2 of 34, `unfoldpark` 2 of 36, `dmastride` 2 of 18 — and on
  // every one of the five the best candidate carrying no `scopebase` token equals the row's own
  // best (all five 0 at this commit; `dmascope` and `unfoldpark` read 9 when the counts above were
  // taken, under earlier rosters — re-run it rather than reading it). Measured
  // through the harness with the plain respell ablated, all five are UNMOVED — same outcome, same
  // score, same winner's variations.
  // A SIXTH ROW REACHES IT AND WINS: `synthetic:sbscope`, in this file, under
  // `unsigned/fresh-merge/scopebase` at 0, going NONMATCH 11 with the plain respell ablated. So
  // the reaching population is six and the plain admission wins one of them. A CENSUS SENTENCE IN
  // A COMMENT EXPIRES THE MOMENT A ROW IS ADDED BESIDE IT — re-run it rather than reading it.
  // AND A ROW ADDED TO THE ROSTER EXPIRES IT TOO, not only a row added to the dataset: a fan count
  // is a fact about the roster it was taken under. Re-enumerated at `acd64605`, candidates only:
  // `dmascope` 24 of 544, `livepark` 2 of 32, `foldpark` 2 of 34, `unfoldpark` 2 of 44,
  // `dmastride` 2 of 18 — the plain
  // admission is reached in the same five fans and the counts under it moved on two of them.
  // `sbscope` is NOT re-run here and its numbers above are the ones this file already carried: a
  // candidates-only rig that does not hand the row its `ctx` enumerates a fan of FOUR for it
  // against the harness's, so this rig cannot speak to that row. Quote the SCOPE with the number.
  // WHAT IS DELETABLE THERE IS THE ROSTER ENTRY, NOT THE PASS: rank.ts also enumerates COALESCED
  // results of the same `hoistScopedBases` through their own `respellEach` call, and one of those won a
  // match — `kleod:UpdateHUDCounterDisplay:agbcc` (retired 2026-09-13), MATCH on
  // `unsigned/defsite/flip-join/derived-home/scopebase/coalesce-v2-v4`.
  // A candidate's variations name what was applied, not a route a deletion must remove: deleting
  // `respell('/scopebase', …)` leaves those results in the fan, while a deletion aimed at
  // `l3/scopebase.ts` cost that match. A census keyed on the plain `/scopebase` variation and a
  // deletion of that one `respell` therefore answer different questions.
  // The two neighbour rows ARE guards on the roster, but on a CONFIGURATION and not on one variation
  // each, and naming one variation is what makes such a guard go vacuous. `/unfolded` binds the same
  // base on both, so a SINGLE-row ablation moves neither: `livepark` is MATCH with `/livebase`
  // alone removed and `foldpark` is MATCH with `/livebase-block` alone removed. It takes
  // `/livebase` + `/unfolded` to get `livepark` to diff:3 and `/livebase-block` + `/unfolded` to
  // get `foldpark` to diff:6, and under the whole-roster ablation both land on `/scopebase` at
  // those same 3 and 6. ADDING AN ADMISSION THAT REACHES A GUARD ROW CAN MAKE ITS ABLATION
  // VACUOUS WITHOUT CHANGING ANY PUBLISHED OUTCOME, which is why no gate in the order can see it:
  // re-run every ablation a comment quotes whenever the roster gains a row.
  //
  // WHAT THE ADMISSION REACHES AND WHAT IT COSTS, censused rather than argued: every agbcc row the
  // artifact carries, candidates only, no compiles, the entry off and on, comparing the md5 of
  // each row's sorted distinct-source set — and in BOTH symbol-map configurations, because with a
  // map every absolute pool constant lifts to a `gaddr` and a census run in one arm is blind to
  // the other. SEVEN rows gain candidates and ZERO lose one, the same seven in both arms:
  //   kleod:ProcessInputAndUpdateEntities  21120 → 23040 map-less   58752 → 62208 map-ful
  //   kleod:ConfigureEntityBehavior         1056 →  1248             1536 →  1728
  //   synthetic:dmascope                     496 →   544              496 →   544
  //   synthetic:dmaflat / synthetic:dmapoll   72 →    80               72 →    80
  //   synthetic:unfoldpark                    36 →    44               36 →    44
  //   synthetic:livepark                      28 →    32               28 →    32
  // Zero losses is the roster's additivity holding: the entry is appended, so no earlier row's
  // shadow decision moves and no source stops being emitted.
  // TWO SCOPES IN ONE TABLE, and the per-row figures are stable across them while the TOTALS are
  // not. The map-less arm was re-run at `acd64605` over the 363 agbcc rows the artifact then
  // carried (404 today; 23 throw identically, 333
  // hash identically, 7 gain): corpus fan 45223 → 47411 distinct sources, +4.84%. The map-ful
  // column and its total, 81747 → 85471 (+4.6%), were taken over the 358 agbcc rows the artifact
  // carried before this family's last rebase and are NOT re-run here; the seven rows and the zero
  // losses are what reproduced in both. Either way the cost is CONCENTRATED —
  // `ProcessInputAndUpdateEntities`, the corpus's slowest row, takes +3456 of the map-ful +3724.
  // A SECOND POPULATION MOVES WITHOUT THE FAN MOVING: 21 rows carry candidates named with
  // `/unfolded` whose source set is byte-identical to the ablated arm's, `synthetic:foldpark` (4)
  // and `kleod:UpdateCameraScroll` (1024) among them. Those are renames, not spellings, and the
  // only thing they can move is a published `winnerVariations` — which is why the gate on this entry
  // is `bench diff`'s `winnerVariations` field and not `bench regression`.
  // The one other guard that reads the field, `BASEFOLD_GATES`, reaches none of these keys: its
  // census is empty on all three rows here.
  //
  // CUT FROM LoadBGTilemapData in the kleod checkout (agbcc), where the same three-way split is 399 / 386 / 383 —
  // `/livebase` parks five bases, `/livebase-block` parks one, and parking exactly the two whose
  // offsets survived the fold is what a hand-compiled spelling reaches. NAME THE SET FROM THE FILE
  // AND NOT FROM THE SENTENCE: that hand-compiled 383 is the 386 winner plus one local, so it
  // carries THREE pointer-base inits — the two parked bases and the winner's own `/addr-home` walk
  // local — and a filter written from the two-base description measures a different set than the
  // spelling does. Both were counted, and the fan of 68,352 contained ZERO candidates with
  // EITHER, measured at both dedup sites over all 165,888 generated spellings. No stack of gate
  // ablations can produce it: `hoistBaseLocals` binds `admittedBases(sfn, gates)` wholesale and
  // the two tables are a chain, so ablation only ever widens. `unfoldpark` is that shape at
  // 15 lines.
  // BOTH TOTALS ABOVE ARE #138's (`84aa4222`) AND NEITHER WAS RE-RUN HERE: that function's fan was
  // 68,352 then and 112,896 at this commit, so the ZERO is a claim about generated spellings that
  // needs a fresh enumeration to restate. A total goes stale silently while the delta beside it
  // stays true — re-run one before budgeting against it, and stamp it when you cannot.
  // THE ADMISSION REACHES THAT FUNCTION, which is a census fact and not a score: on its default
  // structuring `UNFOLDED_GATES` admits exactly two keys, `0x040000D4` and `0x03003430`, where
  // `/livebase` admits five, `/livebase-block` one and `/basefold` none. Reaching and COMPOSING
  // are different facts and only the ranked command answers the second — that function is not a
  // benchmark row, so `regression` and `diff` are blind to it.
  //
  // agbcc only, and for a reason this family owns rather than the `dmascope` one it inherits:
  // `unfoldedOffset` is evidence only where the target declares
  // `compilerBehaviors.foldsConstAddrOffset`, and MIPS and PPC put the addend in the instruction by
  // construction (`lui`/`%lo`, `lis`/`ori`), so a surviving operand offset carries no information
  // there and rank.ts offers the row no such admission. The addresses are GBA absolute constants;
  // mwcc_242_81 also stays off per the `hipress` hazard policy (a candidate compile has no timeout).
  //
  // m2c NONCOMPILES all three, on the identical `ctx` and `proto`, for the raw-address reason every
  // such row in this file records and not for anything in this family: `(void *)0x040000D4->unk0 =`
  // , `invalid type argument of '->'`, 1 compile error. It does READ the discriminator — the folded
  // cell comes out as `*(s32 *)0x0300343C` and the unfolded one as `(void *)0x03003400->unk3C` —
  // and homes NO base at all, so its output for `livepark` and for `unfoldpark` is the same text
  // apart from the one distractor line, and the distinction costing agbcc 9 bytes is one it does
  // not represent.
  {
    sym: 'livepark',
    src:
      'typedef volatile unsigned int vu32;\n' +
      'void livepark(s32 n, s32 *out) {\n' +
      '  s32 i = 0;\n' +
      '  s32 *cur = (s32 *)0x03003400;\n' +
      '  vu32 *dmaRegs = (vu32 *)0x040000D4;\n' +
      '  do {\n' +
      '    *out = cur[15];\n' +
      '    if (cur[15] > 0) {\n' +
      '      dmaRegs[0] = (vu32)cur[15];\n' +
      '      dmaRegs[1] = (vu32)n;\n' +
      '      dmaRegs[2] = 32;\n' +
      '    }\n' +
      '    i = i + 1;\n' +
      '  } while (i < n);\n' +
      '}',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void livepark(s32 n, s32 *out);',
    proto: { livepark: { params: ['s32', 's32*'], returnsVoid: true } },
  },
  {
    sym: 'foldpark',
    src:
      'typedef volatile unsigned int vu32;\n' +
      'void foldpark(s32 n, s32 *out) {\n' +
      '  s32 i = 0;\n' +
      '  vu32 *dmaRegs = (vu32 *)0x040000D4;\n' +
      '  do {\n' +
      '    *(s32 *)0x03002040 = *(s32 *)0x03002040 + 1;\n' +
      '    *out = *(s32 *)0x0300343C;\n' +
      '    if (*(s32 *)0x0300343C > 0) {\n' +
      '      dmaRegs[0] = (vu32)*(s32 *)0x0300343C;\n' +
      '      dmaRegs[1] = (vu32)n;\n' +
      '      dmaRegs[2] = 32;\n' +
      '    }\n' +
      '    i = i + 1;\n' +
      '  } while (i < n);\n' +
      '}',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void foldpark(s32 n, s32 *out);',
    proto: { foldpark: { params: ['s32', 's32*'], returnsVoid: true } },
  },
  {
    sym: 'unfoldpark',
    src:
      'typedef volatile unsigned int vu32;\n' +
      'void unfoldpark(s32 n, s32 *out) {\n' +
      '  s32 i = 0;\n' +
      '  s32 *cur = (s32 *)0x03003400;\n' +
      '  vu32 *dmaRegs = (vu32 *)0x040000D4;\n' +
      '  do {\n' +
      '    *(s32 *)0x03002040 = *(s32 *)0x03002040 + 1;\n' +
      '    *out = cur[15];\n' +
      '    if (cur[15] > 0) {\n' +
      '      dmaRegs[0] = (vu32)cur[15];\n' +
      '      dmaRegs[1] = (vu32)n;\n' +
      '      dmaRegs[2] = 32;\n' +
      '    }\n' +
      '    i = i + 1;\n' +
      '  } while (i < n);\n' +
      '}',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void unfoldpark(s32 n, s32 *out);',
    proto: { unfoldpark: { params: ['s32', 's32*'], returnsVoid: true } },
  },

  // A DEVICE REGISTER WRITTEN INSIDE A LOOP, WITH NOTHING READING IT BACK. A store to a DMA
  // register is an EVENT: it must happen once per iteration, where the source put it. `volatile`
  // is what says so, and asmlift's rendering of a device address is a plain `*(s32 *)67109076 =`
  // — which at -O2 agbcc is free to promote. gcc's loop MEM-promotion keeps a loop-invariant
  // store's address in a register and writes it back ONCE after the loop; the four `str`/`strh`
  // the reference emits per iteration become one. Verified by compiling asmlift's own emitted
  // candidate: on `dmafill` the reference's loop body holds 4 stores and the candidate's holds 1
  // (the other three land after the `ble`), and on the `dmavolsrc` control both hold 4.
  //
  // WHY NO EXISTING ROW CATCHES IT, by a census of the artifact as it stood BEFORE the six rows
  // below existed: of its 200 distinct synthetic rows, 22
  // reference a device register and 14 of
  // those also contain a loop — but 11 of the 14 carry a `while (dma[2] & 0x80000000) {}` wait
  // poll, whose read of the register file blocks the promotion outright. Of the three that do not
  // poll, `dma_fill_uninit` writes its registers BEFORE its loop, and `swmulti` and `offloop` each
  // read other memory inside it (`gEnts[idx].w`, `p[i]`), which blocks it too. A DMA FILL with no
  // wait — the shape `DmaFill16` expands to — was not in the dataset at all, and neither was a
  // bare device read-back: zero of the 200.
  //
  // THE TWO GAP ROWS WERE CONJUNCTIONS, AND EACH TERM IS PRICED. Both now MATCH, through three
  // variations admitted together — `/vol-store` (pin a fixed-address device store `volatile`),
  // `/unreduce` (delete the loop-carried accumulator and spell each read as its closed form) and
  // `/ptr-field` (declare a recovered word field `void *`) — plus the two PAIRINGS that are the
  // whole point of the family: `/vol-store/unreduce` closes `dmafill` and the triple closes
  // `dmaptrsrc`. The lattices below are rooted at asmlift's OWN plain `unsigned` candidate,
  // byte-identical to what `decompileRanked` emits — an absolute-address base, so one spelling of the base
  // throughout. V = pin the three stores, R = un-reduce, T = the pointer field.
  //   `dmafill`   000 35 · V 19 · R 34 · VR 0        Shapley V +25.00, R +10.00 (sum 35)
  //   `dmaptrsrc` 000 42 · V 27 · R 35 · T 42        Shapley V +18.17, R +11.67, T +12.17 (sum 42)
  //               VR 35 · VT 27 · RT 32 · VRT 0      first-in +15/+7/+0 · last-out +32/+27/+35
  // R ALONE IS A REGRESSION on `dmafill` (34 against the 30 the row published), and T alone is
  // worth exactly ZERO. Read first-in, either variation looks not worth building; read last-out, each
  // is worth 27–35 of a 42-point row. Quote the convention with the number.
  //
  // THE PRICES ONLY HOLD IN THE ABSOLUTE-ADDRESS BASIN, which is why the three variations are offered
  // on the DEFAULT tree rather than on whatever the row wins with. Bolting V and R onto the
  // `/nearbase` spelling each row used to publish lands at 24 on `dmafill` and 22 on `dmaptrsrc` —
  // better than the 30 and 40 they published, and not a match. Same edits, same compiler,
  // different basin.
  //
  // WHAT THE ROWS ISOLATE.
  //   `dmafill`    MATCH at `/vol-store/unreduce` — the minimum: three register stores and a
  //                     `volatile u16` fill source, the destination a pure induction expression.
  //                     NOTHING is read in the loop, so the promotion is available; V and R above
  //                     were the whole residual.
  //   `dmaptrsrc`  MATCH at `/vol-store/unreduce/ptr-field` — the same loop with the destination's
  //                     base read from a POINTER-typed field of a plain global. That read is what
  //                     makes the loop promotable in the first place (below), so this is the shape
  //                     the real function has.
  //   `dmavolsrc`  MATCH — the family's control, and it is THREE-sided. All three variations now SHIP,
  //                     so it brackets live variations rather than hypothetical ones: `/vol-store`
  //                     ties it at 0 (the qualifier is free here, and the volatility tie-break
  //                     publishes the qualified twin), `/ptr-field` offers a 44 that loses, and
  //                     `/unreduce` declines outright — its loop has no accumulator, the field
  //                     read having never left it. A variation that MOVES this row has overreached.
  //   `dmastride`  MATCH — the ADVERSE control for R, and the positive control for V. Its
  //                     reference strides the destination itself (`p = p + 64`), so the
  //                     accumulator asmlift emits is the RIGHT spelling and a rewrite that always
  //                     un-reduced would break it (23, measured as a default). `/unreduce` DOES
  //                     fire here and offers exactly that spelling, at 33; the row keeps its
  //                     MATCH because the variation is an ADMISSION and `compareScored` orders by
  //                     score, so the worse spelling simply loses. That is what this row now
  //                     proves. asmlift still wins it at `unsigned/livebase/volatile`.
  //   `dmaback`    17 — `dmavolsrc` plus ONE statement: `gDma[2];`, the bare read-back the GBA
  //                     DMA macros end with. asmlift emits IDENTICAL C for the two rows (`diff`
  //                     of the two renderings, modulo the function name, is empty). Restoring the
  //                     read in the candidate closes it to 0, with or without `volatile` on it.
  //   `dmanest`  MATCH — `dmavolsrc` nested in an outer loop. Different residual entirely, kept
  //                     here because it is the same construct: see the last block below.
  //
  // WHY `/volatile` COULD NOT REACH THESE ROWS, attributed by instrumenting the refusal rather
  // than by reading it. `rank.ts`'s `/volatile` declares a pointer LOCAL holding a numeric address
  // as pointing at volatile data, and `volatilePtrLocals` (l3/volatileptr.ts) returns null when no
  // local qualifies. A `console.error` on that return prints `volatilePtrLocals NULL sym=dmafill
  // locals=v0, v1, sp0` on both rows and never prints OK: their default spelling has no pointer local
  // at all, so that variation has nothing to qualify, and hand-writing the local it would need
  // (`volatile u8 *p0` with volatile derefs) scores 25 on `dmafill` against a closing 0. The
  // capability was ABSENT from the fan rather than losing in it — the whole fan was four candidates,
  // `{signed, unsigned} × {plain, /nearbase}`, every one carrying `v0 = v0 + 64;` and none
  // carrying `volatile`. `/vol-store` is the answer, because it qualifies the ACCESS and needs no
  // local at all; what keeps it off ordinary memory is the target's own declared window
  // (`capabilities.deviceRegisters`), which is a REACH gate rather than a soundness one — over the
  // corpus it excludes a const-address store on 7 rows, and lifting it would move the fan on two
  // of them (`readarm` and `fieldbase`) with no score and no outcome moving either way. The
  // candidate counts that measurement quoted are gone — both fans have grown under later variations (12
  // and 20 today, `[ranked]`) — so re-measure before quoting a number here.
  // `synthetic:ucmp:agbcc` prices the DEVICE-READ side of the same question and belongs to it
  // rather than here: qualifying the 0x3001048 its loop test reads costs that match 15, and
  // `/vol-store` never reaches the row at all (its stores go through a runtime address).
  //
  // THE COMPILER FACT UNDER `dmaptrsrc`, verified in both directions on six compiled probes, each
  // differing from its partner in ONE token. agbcc's -O2 sets `flag_strict_aliasing` (gcc/toplev.c,
  // the `optimize >= 2` block), so `c_get_alias_set` (gcc/c-common.c) gives each main-variant type
  // its own set and loop-invariant motion may move a load past a store of a DIFFERENT type. Load
  // type vs the loop's store type, and whether the load left the loop:
  //     s32   field  / s32 store   → stays        void * field / s32 store    → HOISTED
  //     u16   field  / s32 store   → stays        s32 *  field / s32 store    → HOISTED
  //     void * field / void ** store → stays      void * volatile / s32 store → stays
  // So it is POINTER-ness, not width and not the cast: a no-op `(s32)` cast on an `s32` field and
  // `(u8 *)` arithmetic on one both compile to the same bytes as the plain spelling. That matters
  // here because a decompiler cannot see it — `ldr` is `ldr` whether the word is a pointer or an
  // int — while `ldrh` betrays a `u16`. The consequence is second-order and it is what `dmaptrsrc`
  // measures: the hoist makes the destination a strength-reduced accumulator, which leaves the
  // loop body with no LOAD at all, which is what lets the promotion fire. The
  // trap is that asmlift's own candidate has ALREADY hoisted the read by hand, so in that basin
  // the declaration has nothing left to decide and prices at zero — which is the T +0 first-in
  // above. It is +35 last-out.
  //
  // `dmaback`'S DECLINE, ATTRIBUTED BY INSTRUMENTATION rather than by reading: a temporary
  // `console.error` on the `deletableWhenDead` filter in `packages/core/src/pattern/engine.ts` fires
  // `dce DROPPED use-less load` on `dmaback` and does not fire on `dmavolsrc`, which drops the
  // same three other ops (`add`, `shl`, `undef`) and no load. The load is eligible because
  // `deletableWhenDead` (packages/core/src/ir/discipline.ts) admits any opcode with no `effects` flag,
  // and `load` has none — the flag set is exactly `astore call opaque store`. The read survives
  // the frontend (it is `%20: unk32 = load %13` in the raw IR dump) and is gone by the folded
  // one. The change this row gates is therefore a type-directed one, not a new pass: a read of an
  // address the target calls a device register is an execution, so it must reach
  // structure.ts's `sideEffects` walk, which already emits exactly this shape for `call` and
  // `opaque`. Cardinal-rule work: the reference's loop body carries one more instruction than the
  // candidate's (`ldr r0, [r3]` after `str r6, [r3]`), and 17 points is what one dropped
  // instruction costs in a 14-instruction loop body.
  //
  // `dmanest` IS A DIFFERENT MECHANISM and is deliberately the family's smallest row. Its two
  // objdiff rows were `ldr r0, [r4, #4]` vs `[r4, #0]` and `.word 50345008` vs `.word 50345012`:
  // under nesting asmlift stopped rendering the element as a struct view (`((struct Elem0 *)
  // 50345008)[a1].field_4`, what it emits for `dmavolsrc`) and folded the field offset into the
  // base instead (`((s32 *)((a1 << 3) + 50345008))[1]`). CLOSED, and NOT in the pass the residual
  // names. Struct-array recovery is present, correct and general; what was missing sits one level
  // below it. `raise/struct-arrays.ts` refuses an element pointer that reaches a successor arg,
  // and the nesting makes the frontend mint a ring of block params around that pointer which feed
  // only each other and which no op reads — a ring `ir/simplify.ts`'s per-round reader scan could
  // never retire, each half counting as the other's reader. Attributed by instrumenting the
  // refusal: `NOTCLEAN block-arg-use op=cond_br` with `accesses=1 [load@4w4]` here against
  // `ACCEPT stride=8 offs=4:4` on `dmavolsrc`. Least-fixpoint liveness retires the ring; the guard
  // is untouched, and ablating it INSTEAD reaches 0 too but fans the row 28 → 36 — while ablating
  // it AS WELL is inert (26 either way), because a retired ring leaves the guard nothing to trip
  // on. The two are not the same edit: one removes the cause, the other removes a real hazard's
  // refusal and buys 8 spurious candidates.
  //
  // WHAT MOVED IS THE WHOLE FAN, NOT ONE CANDIDATE. `dmanest` goes from 28 candidates carrying the
  // folded spelling 28/28 to 26 carrying the struct view 26/26: the folded spelling is no longer
  // ENUMERABLE, and nothing reports a candidate never enumerated. "No second spelling exists for
  // the differ to referee" is false — the differ referees these two at 0 against 2.
  //
  // AND THE WINNER'S VARIATIONS DID NOT MOVE AT ALL. `signed/vol-store/initfirst` before and after, at 2
  // and at 0, while the winning PROGRAM changed completely (615 → 559 source bytes, a folded pool
  // word for a struct view). `winnerVariations` names the VARIATIONS, not the program, so a check keyed on it
  // sees nothing here — the inverse of the #112 trap, where the winner gained `/vol-store` and
  // announced a change of winner. Only the `source` byte field caught it in `bench diff`. Print the
  // fan and diff the winner's text; a candidate's variations are not an identity of its program in either direction. The claim that
  // holds about the recovery is
  // stronger and is a property of the RECOVERY: it takes the base from the observed pool word and
  // the field offset from the observed load displacement, so it reproduces the target's own split
  // by construction. Verified by lifting all three splits and scoring each against ITS OWN target:
  // `.word 0x3003430`+`[r0,#4]` → `((struct Elem0 *)50345008)[a0].field_4` 0; `.word 0x3003434`
  // +`[r0]` → `((struct Elem0 *)50345012)[a0].field_0` 0; `.word 0x3003430`+`[r0]` → base
  // 50345008 `field_0` 0. Where the target folded, the recovery folds; the folded RENDERING was
  // the lossy one, which is why removing it costs nothing (894 rows, 0 lost).
  //
  // THE COMPILER FACT OUTLIVES THE ROW. It falsified a premise this repo held in two places —
  // that `->field_N` and `[idx]` compile identically, so the differ cannot referee between them —
  // and both citations have since been corrected (`raise/structs.ts` states the conditional form;
  // `rank.ts`'s copy was an orphaned docstring and is gone, its signedness half now on
  // `SIGNEDNESS`). On agbcc the two do not compile identically, and the two passes are nameable.
  // The fold is TREE-level reassociation,
  // `((VAR+C1)+C2) → VAR+(C1+C2)` in `fold`'s `associate:` block (gcc/fold-const.c:4959, via
  // `split_tree` at :1226); a COMPONENT_REF never enters that arithmetic, because
  // `get_inner_reference` (gcc/expr.c:3929, called at :5444) hands back the bit position
  // separately and `plus_constant` (:5631) applies it to the already-expanded address, where
  // Thumb's `[reg,#imm]` absorbs it. So an index moves the offset into the POOL LITERAL and a
  // field leaves it in the LOAD DISPLACEMENT. Compiled both ways at field offset 4 AND at offset
  // 0, with an 8-byte struct and a 32-byte one: at offset 0 the two are byte-identical, so the
  // discriminator is a NONZERO field offset. It reproduces at a cast symbol base (`.word gRaw`
  // plus `#0x4`) but NOT at a real array declaration — `extern struct E gTab[]; gTab[i].f4` emits
  // a third form, `.word gTab` + `add r1,r1,#0x4` + `ldr [r0]` — so the divergence is
  // decl-vs-cast, and a price measured here does not carry to a `gaddr` array declaration.
  //
  // NO ROW for the third gap this investigation named — a folded `symbol+k` pool literal against
  // the reference's single `symbol`. The reason given here was that a synthetic candidate has no
  // ELF, "so no symbol map is ever attached and a `gaddr` never forms", and that stopped being
  // true: `SynthSpec.symbols` now exists and rows in this file set it, so a synthetic row CAN be
  // handed a map and a `gaddr` CAN form. The rows in THIS family still carry none, so the gap is
  // unreached here — but it is reachable now by a synthetic row, not only by a real-tier one.
  //
  // NO ROW HERE for declaration order, because one already exists: permuting the 14 declarations
  // of asmlift's own winning `dma_fill_uninit` candidate and recompiling gave 0 / 6 / 9 / 12 over
  // 40 random orders — one of them a byte MATCH — and the order asmlift shipped sat at the worst
  // of the four. That measurement bought the per-target declaration-rank default, which now ships:
  // the row publishes MATCH at 0 (`unsigned/defsite/loop-entry/derived-home/indexed`), so it is a
  // second read of a LIVE capability rather than an open gap. The LAW behind it —
  // spill slots are handed out in declaration order — and the gate that isolates it from this
  // family's DMA machinery and from the undef envelope are the `spillorder` / `spillorder_rev`
  // pair in the uninit-local block; `dma_fill_uninit` is that capability's second read, not its
  // only gate, so a change here that moves it is attributed to whichever of the three machineries
  // the pair says.
  //
  // NO ROW for reusing ONE local across several disjoint loops, which is the largest single gap
  // the LoadBGTilemapData ladder priced. `coalesceCandidates` (l3/coalesce.ts) is documented as
  // "every legal SINGLE merge, each as its own tree", so a candidate carries at most one merge —
  // and it takes four to reach the reference's spelling there. The reason there is no row is
  // measured, not assumed. Two shapes reusing one counter across three and four disjoint
  // call-bearing loops both reach MATCH with EXACTLY ONE `coalesce-vN-vM` token, because
  // structure() already gives the loops fewer distinct locals than the reference has loops. A
  // third, writing arrays instead of calling, gets no `coalesce-` candidate offered at all —
  // agbcc strength-reduces its three loops apart, so the shared counter never survives into the
  // recovery. Two more, adding register pressure, decline on a pre-existing frontend link (`stack
  // pointer used as data`, in frontend/thumb.ts) that is not this family. Nothing under ~60
  // instructions needed a second merge. The gate is real-tier.
  //
  // m2c scores none of the six, on the identical `ctx` asmlift receives, and for two reasons
  // neither of which is this family and neither of which is context withheld. Five DECLINE: it
  // types the DMA source-address store as `*(? **)0x040000D4 = &unksp0;` and the `?` placeholder
  // is a gap. The `ctx` states the full prototype, parameter names and all, and the `?` is the
  // pointee type of a STACK slot, which no prototype supplies. `dmastride` instead NONCOMPILES,
  // because there its base is one recovered pointer rather than three absolute stores and it
  // renders the writes as `(void *)0x040000D4->unk0 = &unksp0;` — the `void *`-member spelling
  // every raw-address row in this file already records, and exactly what `dma_fill_uninit` (which
  // also writes `&tmp` to a DMA register) produces. Checked, because a family comment once rested
  // on a cross-reference nobody had opened.
  // It REACHES the construct in every case, and two of its renderings are worth recording. On
  // `dmafill` it recovers exactly the structure asmlift does, strength reduction included
  // (`var_r0 = (var_r2 << 6) + base;` … `var_r0 += 0x40;`), and spells the three register writes
  // through the same unpinned `*(s32 *)0x040000D8 =` — so BOTH terms of that row's conjunction
  // are shared exposure, it simply never gets scored. And on `dmaback` its output carries NO
  // read-back statement either — its whole `dmaback` rendering is character-for-character its
  // `dmavolsrc` rendering, modulo the function name. Both decompilers drop a device read whose
  // result nobody consumes.
  //
  // WHAT THE ADVERSARIAL ROUNDS FOUND, because the next round will build on these rows and the
  // premise the first one falsified was written in four files. `/unreduce` licensed moving a memory read into
  // a loop on the ground that "a write to a hardware register is not a write to any object a C
  // program declares, so such a loop cannot change what an ordinary read sees". The first clause
  // is true and the second does not follow: a DMA controller reads a control word and then WRITES
  // ORDINARY MEMORY itself. `dmaptrsrc`'s own reference ends every iteration with
  // `gDma[2] = 0x81000020` — bit 31 set, a 32-word transfer into `[DMA3DAD]` — so the loop this
  // family is ABOUT is exactly the loop the premise fails on. Modelled and executed, the admitted
  // candidate turned a clean destination walk into wild writes.
  //
  // The fix is not a bar, because barring costs this row's match and buys nothing: `dmaptrsrc`'s
  // reference really does read `gBg[bg].pTilemap` inside the loop, and the SOUND alternative —
  // the read hoisted into a local above the loop — compiles to 16, not 0, because a C statement
  // lands above the loop's ENTRY GUARD while the compiler's own invariant hoist lands below it
  // (both objects disassembled; the guard is the `cmp r2,#0x1f / bgt` the load moves across).
  // What ships instead is a target datum for the memory-model half (`deviceMemoryWriters`, the
  // four DMA channel-enable halfwords) and a PROOF requirement for what it cannot settle: the
  // spelling is published only at a byte-exact score and withheld everywhere else. On this row 4
  // of the 16 candidates are now withheld, all at 35, and the fan's two 0s are untouched — and
  // that count is in the row's own `withheldCandidates`, because a MATCH resting entirely on the
  // proof gate is not a thing an artifact should leave to prose.
  //
  // AND THE SECOND ROUND FOUND THE FIRST FIX'S SCOPE WRONG, which is the part to carry forward.
  // The premise was corrected and the GATES still asked about the loop, while the transform moves
  // the init across everything between where it stood and each read — plus the counter's start,
  // which is a second anchor and can stand on either side of the init. Three shapes were admitted
  // with no proof required and diverged on every input vector; the fuzz that reported zero could
  // not generate any of them, because its generator never emitted a statement between the two
  // inits. Neither row's spelling is affected — the region is empty on both — but a rewrite built on
  // these rows must state the span its gates range over, not the statement they happen to sit next
  // to.
  //
  // `/unreduce` CANNOT SEE `dmanest`'s LOOPS, and that is unrelated to what closed the row. They
  // are nested, and that pass walks TOP-LEVEL loops only (91 of the corpus's 189 loop-bearing
  // trees are in the same position), so a decline there names no gate. Widening the scan is a
  // prerequisite for any rewrite that wants those loops, not a side effect of one that does not.
  //
  // agbcc only, as the `read-once` family is (`uninit-local` and `value-home` are NOT — both span
  // all four toolchains, so neither is a precedent). Every claim
  // above is a pair of spellings compiled with THIS compiler; whether ido7.1, gcc2.7.2kmc and
  // mwcc_242_81 promote a loop-invariant device store, delete a use-less device read, or read a
  // field's pointer-ness in their alias analysis was NOT measured, so those lanes are left off
  // rather than assumed. What would earn one: the same compiled pair on that toolchain showing
  // the same divergence. `device-access` is on `dmaback` alone now — the one row left whose
  // residual turns on a device access. A row with no residual has nothing for a "the diff turns on
  // this" tag to be about (the rule that keeps `rereadctl` untagged in `read-once`), so `dmafill`
  // and `dmaptrsrc` carried it while they were gaps and lost it when they closed.
  //
  // Cut from LoadBGTilemapData in the kleod checkout (agbcc), whose inner loop is a `DmaFill16` with no wait and
  // whose reference source ends FIVE macro expansions in a bare read-back (`grep -c` over the
  // preprocessed reference: 5). SAID PLAINLY BECAUSE IT IS EASY TO ASSUME OTHERWISE: closing
  // these rows is not predicted to move that function. Its winner already declares the DMA base
  // `volatile s32 *p0` and its variations already carry `/volatile` — `/addr-home` makes the base a
  // local there, so the reach problem this family measures does not arise. And the read-back gap
  // points the OTHER way on it: over a 16-point spelling lattice on that function, restoring the
  // five dropped read-backs is worth +7…+19 in the eight points that keep the reference's shared
  // loop counters and −29…−48 in the eight that split them, and asmlift's spelling is the split
  // one. `dmaback` is a fidelity row, priced, and the price on that function is negative.
  {
    sym: 'dmafill',
    src:
      '#define gDma ((volatile u32 *)0x040000d4)\n' +
      'void dmafill(s32 lo, s32 base){ s32 i; volatile u16 tmp;\n' +
      ' for (i = lo; i < 32; i++) { tmp = 0; gDma[0] = (u32)&tmp;\n' +
      ' gDma[1] = (u32)(base + i * 64); gDma[2] = 0x81000020; } }',
    features: [],
    toolchains: ['agbcc'],
    ctx: 'void dmafill(s32 lo, s32 base);',
    proto: { dmafill: { params: ['s32', 's32'], returnsVoid: true } },
  },
  {
    sym: 'dmaptrsrc',
    src:
      'struct Bg { void *pTiles; void *pTilemap; };\n' +
      '#define gBg ((struct Bg *)0x03003430)\n' +
      '#define gDma ((volatile u32 *)0x040000d4)\n' +
      'void dmaptrsrc(s32 lo, s32 bg){ s32 i; volatile u16 tmp;\n' +
      ' for (i = lo; i < 32; i++) { tmp = 0; gDma[0] = (u32)&tmp;\n' +
      ' gDma[1] = (u32)((u8 *)gBg[bg].pTilemap + i * 64); gDma[2] = 0x81000020; } }',
    features: ['global'],
    toolchains: ['agbcc'],
    ctx: 'void dmaptrsrc(s32 lo, s32 bg);',
    proto: { dmaptrsrc: { params: ['s32', 's32'], returnsVoid: true } },
  },
  {
    sym: 'cpufill',
    src:
      'void CpuSet(const void *src, void *dest, u32 control);\n' +
      'void cpufill(u16 x, u32 y){ volatile u16 a; volatile u32 b;\n' +
      ' a = x; CpuSet((void *)(&a), (void *)0x03001000, 0x01000010);\n' +
      ' b = y; CpuSet((void *)(&b), (void *)0x03001040, 0x05000008); }',
    features: ['stack-addr'],
    toolchains: ['agbcc'],
    ctx: 'void CpuSet(const void *src, void *dest, u32 control); void cpufill(u16 x, u32 y);',
    proto: {
      CpuSet: { params: ['const void *', 'void *', 'u32'], returnsVoid: true },
      cpufill: { params: ['u16', 'u32'], returnsVoid: true },
    },
    note:
      "sa3's `CpuFill16` then `CpuFill32`: each hands the BIOS `CpuSet` the address of its own " +
      '`volatile` tmp as a fixed source, which it reads one unit of and never writes, so the two ' +
      'locals are two objects (target.ts `blockTransferCalls`)',
  },
  {
    sym: 'cpuclear',
    src:
      'void CpuSet(const void *src, void *dest, u32 control);\n' +
      'void cpuclear(void){ volatile u16 a; a = 0; CpuSet((void *)(&a), (void *)0x03001000, 0x01000800); }',
    features: ['stack-addr'],
    toolchains: ['agbcc'],
    ctx: 'void CpuSet(const void *src, void *dest, u32 control); void cpuclear(void);',
    proto: {
      CpuSet: { params: ['const void *', 'void *', 'u32'], returnsVoid: true },
      cpuclear: { params: [], returnsVoid: true },
    },
    note:
      "`CpuFill16(0, dest, size)`, the shape of pokeemerald's `ClearSav1`: sa3's and pokeemerald's fill " +
      'macros declare the tmp `vu16`, and a plain `u16` spelling of it recompiles with the zero and ' +
      "the frame address in each other's registers, so the fill source is stamped `volatile`",
  },
  {
    sym: 'dmavolsrc',
    src:
      'struct Bg { void *pTiles; void *pTilemap; };\n' +
      '#define gBgV ((volatile struct Bg *)0x03003430)\n' +
      '#define gDma ((volatile u32 *)0x040000d4)\n' +
      'void dmavolsrc(s32 lo, s32 bg){ s32 i; volatile u16 tmp;\n' +
      ' for (i = lo; i < 32; i++) { tmp = 0; gDma[0] = (u32)&tmp;\n' +
      ' gDma[1] = (u32)((u8 *)gBgV[bg].pTilemap + i * 64); gDma[2] = 0x81000020; } }',
    features: ['global'],
    toolchains: ['agbcc'],
    ctx: 'void dmavolsrc(s32 lo, s32 bg);',
    proto: { dmavolsrc: { params: ['s32', 's32'], returnsVoid: true } },
  },
  {
    sym: 'dmastride',
    src:
      'void dmastride(s32 lo, s32 base){ s32 i; volatile u16 tmp;\n' +
      ' volatile s32 *d = (volatile s32 *)0x040000d4; s32 p = base + lo * 64;\n' +
      ' for (i = lo; i < 32; i++) { tmp = 0; d[0] = (s32)&tmp;\n' +
      ' d[1] = p; d[2] = 0x81000020; p = p + 64; } }',
    features: ['value-home', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void dmastride(s32 lo, s32 base);',
    proto: { dmastride: { params: ['s32', 's32'], returnsVoid: true } },
  },
  {
    sym: 'dmaback',
    src:
      'struct Bg { void *pTiles; void *pTilemap; };\n' +
      '#define gBgV ((volatile struct Bg *)0x03003430)\n' +
      '#define gDma ((volatile u32 *)0x040000d4)\n' +
      'void dmaback(s32 lo, s32 bg){ s32 i; volatile u16 tmp;\n' +
      ' for (i = lo; i < 32; i++) { tmp = 0; gDma[0] = (u32)&tmp;\n' +
      ' gDma[1] = (u32)((u8 *)gBgV[bg].pTilemap + i * 64); gDma[2] = 0x81000020; gDma[2]; } }',
    features: ['device-access', 'global'],
    toolchains: ['agbcc'],
    ctx: 'void dmaback(s32 lo, s32 bg);',
    proto: { dmaback: { params: ['s32', 's32'], returnsVoid: true } },
  },
  {
    // THE ZERO-POINT ROW for the structurer's dead-DEVICE-READ rule (structure.ts
    // `volatileQualifiable`). Its neighbour `dmaback` carries the same `gDma[2];` read-back and
    // does NOT exercise that rule: a dead read in the MIDDLE of a function is reaped by DCE long
    // before the structurer walks it (`deletableWhenDead` is true of a plain `load`, correctly — nothing observes a
    // read nobody reads). The rule's whole population is the read that is LAST, whose result is
    // the suppressed phantom return value of a void function — analysis.ts drops the `ret` operand
    // from the use registry, so it arrives at the walk unread. That is why this row's read is the
    // final statement and why the loop is gone: without both, it tests a different thing.
    // The rule's only other corpus inhabitant is a real-tier row in a local project checkout,
    // which CI cannot run, so without this row nothing regress-detects the rule.
    sym: 'dmareadback',
    src:
      'void dmareadback(s32 src, s32 dst, s32 ctl){\n' +
      ' volatile u32 *d = (volatile u32 *)0x040000d4;\n' +
      ' d[0] = src; d[1] = dst; d[2] = ctl; d[2]; }',
    features: ['device-access', 'global'],
    toolchains: ['agbcc'],
    ctx: 'void dmareadback(s32 src, s32 dst, s32 ctl);',
    proto: { dmareadback: { params: ['s32', 's32', 's32'], returnsVoid: true } },
  },
  {
    sym: 'dmanest',
    src:
      'struct Bg { void *pTiles; void *pTilemap; };\n' +
      '#define gBgV ((volatile struct Bg *)0x03003430)\n' +
      '#define gDma ((volatile u32 *)0x040000d4)\n' +
      'void dmanest(s32 lo, s32 bg, s32 n){ s32 i, j; volatile u16 tmp;\n' +
      ' for (j = 0; j < n; j++) for (i = lo; i < 32; i++) { tmp = 0; gDma[0] = (u32)&tmp;\n' +
      ' gDma[1] = (u32)((u8 *)gBgV[bg].pTilemap + j * 2048 + i * 64); gDma[2] = 0x81000020; } }',
    features: ['value-home', 'global'],
    toolchains: ['agbcc'],
    ctx: 'void dmanest(s32 lo, s32 bg, s32 n);',
    proto: { dmanest: { params: ['s32', 's32', 's32'], returnsVoid: true } },
  },
  // A READ NOBODY USES SURVIVES ONLY QUALIFIED: every compiler here deletes a plain read whose
  // value nothing consumes, so a read still in the object was `volatile` in the source, and the lift
  // stamps it so (frontend/dead-reads.ts). Each read's register is overwritten by the next
  // statement's load — IDO reads into `$zero` instead — which is what `dmareadback`'s void return
  // does not cover. The address plays no part, so one row reads a literal and one a pointer
  // parameter, on every toolchain.
  {
    sym: 'deadreadback',
    src: 'void deadreadback(s32 b, s16 *x){ *(volatile s32 *)0x040000d8 = b; *(volatile s32 *)0x040000d8; x[0] = x[1] + 3; }',
    features: ['device-access', 'store'],
    toolchains: ALL,
    ctx: 'void deadreadback(s32 b, s16 *x);',
    proto: { deadreadback: { params: ['s32', 's16 *'], returnsVoid: true } },
  },
  {
    sym: 'deadreadparam',
    src: 'void deadreadparam(volatile s32 *p, s16 *x){ *p; x[0] = x[1] + 3; }',
    features: ['pointer', 'store'],
    toolchains: ALL,
    ctx: 'void deadreadparam(volatile s32 *p, s16 *x);',
    proto: { deadreadparam: { params: ['volatile s32 *', 's16 *'], returnsVoid: true } },
  },
  // …AND AT A LEVEL THAT KEEPS A PLAIN ONE, ONLY WHERE THE REGISTER SAYS SO. At -O0 (and IDO's
  // -O1) a plain dead local keeps its load too, so an unused read is evidence of `volatile` only
  // where the compiler puts it in the register it discards one into (target.ts
  // `discardsUnusedReadsInto`): `lwz r0` on the three CodeWarrior builds at -O0,p, `lw zero` /
  // `lbu zero` on IDO. `dvstmt` is the bare `*p;`, `dvmemb` Mario Party 4's WipeExecAlways
  // `wipe->type;` (a `volatile u8` member, the one dead r0 load in its 409 -O0,p units), `dvback`
  // a store read back, and `dvglob` an `extern volatile` read. `dvhome` is the control: its plain
  // `x = p[5]; x = 0;` keeps the load in a home (`lwz r31`; IDO `lw t6` and a frame store), which
  // stays unstamped — the row nonmatches for the dead local the lift drops, and a stamp would move
  // its score. On agbcc at -O0 a volatile `*p;` is an `ldr r0` nothing reads, the same code as a
  // `register` local, so `dvstmt:agbcc` DECLINES (`undecided-unused-read`) rather than drop it.
  // The IDO rows are written one statement per line: IDO schedules by source line. A level twin
  // takes its own sym, so IDO -O0 carries `dvglob` alone and -O1 the other four.
  ...(
    [
      ['mwcc', ['mwcc_242_81', 'mwcc_247_107', 'mwcc_233_163n'], MWCC_O0P],
      ['ido-O1', ['ido7.1'], ['-mips2', '-O1', '-32', '-non_shared', '-G', '0']],
    ] as const
  ).flatMap(([, toolchains, cflags]): SynthSpec[] => [
    {
      sym: 'dvstmt',
      src: 'void dvstmt(volatile s32 *p, s32 *q)\n{\n    *p;\n    *q = 0;\n}',
      features: ['pointer', 'store'],
      toolchains: [...toolchains],
      cflags,
      ctx: 'void dvstmt(volatile s32 *p, s32 *q);',
      proto: { dvstmt: { params: ['volatile s32 *', 's32 *'], returnsVoid: true } },
    },
    {
      sym: 'dvmemb',
      src: 'typedef struct { s32 a; volatile u8 type; } DvW;\nvoid dvmemb(DvW *w, s32 *q)\n{\n    w->type;\n    *q = 1;\n}',
      features: ['struct', 'store'],
      toolchains: [...toolchains],
      cflags,
      ctx: 'typedef struct { s32 a; volatile u8 type; } DvW; void dvmemb(DvW *w, s32 *q);',
      proto: { dvmemb: { params: ['DvW *', 's32 *'], returnsVoid: true } },
    },
    {
      sym: 'dvback',
      src: 'void dvback(volatile s32 *p, s32 b)\n{\n    *p = b;\n    *p;\n}',
      features: ['pointer', 'store'],
      toolchains: [...toolchains],
      cflags,
      ctx: 'void dvback(volatile s32 *p, s32 b);',
      proto: { dvback: { params: ['volatile s32 *', 's32'], returnsVoid: true } },
    },
    {
      sym: 'dvhome',
      src: 'void dvhome(s32 *p, s32 *q)\n{\n    s32 x;\n    x = p[5];\n    x = 0;\n    *q = x;\n}',
      features: ['pointer', 'store'],
      toolchains: [...toolchains],
      cflags,
      ctx: 'void dvhome(s32 *p, s32 *q);',
      proto: { dvhome: { params: ['s32 *', 's32 *'], returnsVoid: true } },
    },
  ]),
  ...(
    [
      [['mwcc_242_81', 'mwcc_247_107', 'mwcc_233_163n'], MWCC_O0P],
      [['ido7.1'], ['-mips2', '-O0', '-32', '-non_shared', '-G', '0']],
    ] as const
  ).map(([toolchains, cflags]): SynthSpec => ({
    sym: 'dvglob',
    src: 'extern volatile s32 gDvV;\nvoid dvglob(s32 *q)\n{\n    gDvV;\n    *q = 2;\n}',
    features: ['global', 'store'],
    toolchains: [...toolchains],
    cflags,
    ctx: 'void dvglob(s32 *q);',
    proto: { dvglob: { params: ['s32 *'], returnsVoid: true } },
  })),
  {
    sym: 'dvstmt',
    src: 'void dvstmt(volatile s32 *p, s32 *q)\n{\n    *p;\n    *q = 0;\n}',
    features: ['pointer', 'store'],
    toolchains: ['agbcc'],
    cflags: ['-mthumb-interwork', '-O0', '-fhex-asm', '-fprologue-bugfix'],
    ctx: 'void dvstmt(volatile s32 *p, s32 *q);',
    proto: { dvstmt: { params: ['volatile s32 *', 's32 *'], returnsVoid: true } },
  },
  // What the discard register does NOT say. `dvnarrow` is the control for a load that leaves it:
  // CodeWarrior at -O0,p reads the plain `s8 x; x = p[5];` as `lwz r0` + `extsb r31,r0`, a home,
  // which stays unstamped (the volatile twin is the same code). `dvdword` is IDO's doubleword
  // discard, `lw zero,0(a0)` + `lw at,4(a0)`: both words are read, so both are kept (as two word
  // reads, which recompile to two `lw zero`). `dvdwcall` is that discard with -O1's schedule between
  // its halves, `lw zero,0(t6); lw a0,28(sp); jal g; lw at,4(t6)`: the pair survives the reload and
  // the `at` word in the call's delay slot is still read (frontend/mips.ts `firstWords`). `dvif`
  // is agbcc -O0's `if (*p) {}`, the same `ldr; cmp; beq` as its plain twin, so it DECLINES
  // (`undecided-unused-read`) rather than drop the read. `dvifelse` (`if (*p) {} else {}`) and `dvtern` (`*p ? 1 : 2;`) are `beq .L4; b .L4`
  // there, whose two edges meet only through the forwarder the `b` sits in: they decline too.
  // `dvunarrow` is `dvnarrow`'s `u8` twin, `lwz r0` + `clrlwi r31,r0,24`: the write to r31 homes the
  // load whatever op it is (dead-reads.ts `leftInDiscardRegister`), so it stays unstamped.
  {
    sym: 'dvnarrow',
    src: 'void dvnarrow(s32 *p, s32 *q)\n{\n    s8 x;\n    x = p[5];\n    x = 0;\n    *q = x;\n}',
    features: ['pointer', 'store'],
    toolchains: ['mwcc_242_81', 'mwcc_247_107', 'mwcc_233_163n'],
    cflags: MWCC_O0P,
    ctx: 'void dvnarrow(s32 *p, s32 *q);',
    proto: { dvnarrow: { params: ['s32 *', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'dvunarrow',
    src: 'void dvunarrow(s32 *p, s32 *q)\n{\n    u8 x;\n    x = p[5];\n    x = 0;\n    *q = x;\n}',
    features: ['pointer', 'store'],
    toolchains: ['mwcc_242_81', 'mwcc_247_107', 'mwcc_233_163n'],
    cflags: MWCC_O0P,
    ctx: 'void dvunarrow(s32 *p, s32 *q);',
    proto: { dvunarrow: { params: ['s32 *', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'dvdword',
    src: 'void dvdword(volatile s64 *p, s32 *q)\n{\n    *p;\n    *q = 3;\n}',
    features: ['pointer', 'store'],
    toolchains: ['ido7.1'],
    cflags: ['-mips2', '-O1', '-32', '-non_shared', '-G', '0'],
    ctx: 'void dvdword(volatile s64 *p, s32 *q);',
    proto: { dvdword: { params: ['volatile s64 *', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'dvdwcall',
    src: 'void g(s32);\nvoid dvdwcall(volatile s64 *p, s32 x)\n{\n    *p;\n    g(x);\n}',
    features: ['pointer'],
    toolchains: ['ido7.1'],
    cflags: ['-mips2', '-O1', '-32', '-non_shared', '-G', '0'],
    ctx: 'void g(s32);\nvoid dvdwcall(volatile s64 *p, s32 x);',
    proto: {
      dvdwcall: { params: ['volatile s64 *', 's32'], returnsVoid: true },
      g: { params: ['s32'], returnsVoid: true },
    },
  },
  {
    sym: 'dvif',
    src: 'void dvif(volatile s32 *p, s32 *q)\n{\n    if (*p) {\n    }\n    *q = 0;\n}',
    features: ['pointer', 'branch', 'store'],
    toolchains: ['agbcc'],
    cflags: ['-mthumb-interwork', '-O0', '-fhex-asm', '-fprologue-bugfix'],
    ctx: 'void dvif(volatile s32 *p, s32 *q);',
    proto: { dvif: { params: ['volatile s32 *', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'dvifelse',
    src: 'void dvifelse(volatile s32 *p, s32 *q)\n{\n    if (*p) {\n    } else {\n    }\n    *q = 0;\n}',
    features: ['pointer', 'branch', 'store'],
    toolchains: ['agbcc'],
    cflags: ['-mthumb-interwork', '-O0', '-fhex-asm', '-fprologue-bugfix'],
    ctx: 'void dvifelse(volatile s32 *p, s32 *q);',
    proto: { dvifelse: { params: ['volatile s32 *', 's32 *'], returnsVoid: true } },
  },
  {
    sym: 'dvtern',
    src: 'void dvtern(volatile s32 *p, s32 *q)\n{\n    *p ? 1 : 2;\n    *q = 0;\n}',
    features: ['pointer', 'branch', 'store'],
    toolchains: ['agbcc'],
    cflags: ['-mthumb-interwork', '-O0', '-fhex-asm', '-fprologue-bugfix'],
    ctx: 'void dvtern(volatile s32 *p, s32 *q);',
    proto: { dvtern: { params: ['volatile s32 *', 's32 *'], returnsVoid: true } },
  },

  // ── THE MAP-ASKING VARIATIONS, and the synthetic rows that carry a map ─────────────────────
  //
  // `/no-bitfield` keeps the honest shift spelling where the map would name a bitfield member.
  // Its enumeration gate (rank.ts, `mapHasBitfields`) reads `opts.symbols`, so a MAP-LESS row is
  // structurally incapable of producing one candidate for it, and a census over a map-less tier
  // measures the CORPUS rather than the variation.
  // What the corpus does contain is the fold's own five reach rows, all kleod rows on agbcc, and
  // on all
  // five the fold ON wins — so a census reads the OFF spelling as dead. These two rows are the shapes
  // the variation was built for, where it is the ONLY spelling that matches.
  //
  // WHY BOTH DIRECTIONS, AND WHAT EACH ROW ACTUALLY BRACKETS — two different things, and keeping
  // them apart is the point. The switch (`spellBitfieldMembers`) gates the READ fold (the
  // `(x << a) >> b` extract → `gPacked.dreamStones`) and the WRITE fold (the mask-and-insert →
  // `gPacked.dreamStones = v`) together.
  //
  // AT MATCH LEVEL, BOTH ROWS BRACKET THE SAME ONE-LINE DELETION: the `/no-bitfield` entry in
  // `bitfieldSettings`. Delete it and `bfwordread` goes 0 → 1 and `bfwordwrite` goes 0 → 8. Both
  // numbers are read off THESE ROWS through the harness itself (`bench run --tier synthetic --only
  // <sym> --toolchain agbcc --serial`, `ASMLIFT_CANDCACHE=0`), control re-run beside each. TAKE
  // THEM OFF THE ROW AND NOT OFF A STANDALONE CLI PROBE: a probe of the write shape scores that
  // ablation 19, which is a different rig and not this row. So the second row buys no second
  // DELETION bracket — one row per direction is not what brackets the arm.
  //
  // AT THE LEVEL OF THE WINNER'S VARIATIONS THEY DO SPLIT, and that is what the second row is for. Guard the WRITE fold's
  // `bitfieldStore.set` alone and `bfwordwrite` stays MATCH at 0 while its variations move
  // `unsigned/no-bitfield` → `unsigned`, with `bfwordread` untouched; guard the READ fold's
  // `bitfieldSpelling.set` alone and exactly the mirror happens. So each row responds to its own
  // direction and to nothing else — measured, one direction at a time, control beside each.
  //
  // THE CONSEQUENCE, stated because it is a gap and not a reassurance: deleting either FOLD is a
  // variations-only change on these rows. `bench regression` reports 0 lost and would green-light it;
  // only `bench diff`'s `winnerVariations` field catches it. The folds' match-level cost is on the
  // REAL tier — PR #136 measured the write fold alone at `kleod:ProcessInputAndUpdateEntities`
  // 284 → 248, and that row is 211 in the artifact under later unrelated changes, so RE-DERIVE the
  // fold's own value rather than quoting either number — and nothing here brackets it. A row where
  // the fold ON is the only spelling that matches would,
  // and none is authored: on a source that really writes the member, both spellings compile to the
  // same bytes and the differ has nothing to referee.
  //
  // WHY AN `extern` GLOBAL RATHER THAN AN ADDRESS MACRO, which is the usual synthetic idiom here.
  // Measured both ways: build `bfwordread`'s body against `#define gPacked 0x03005220` and the
  // target's pool word is NUMERIC, so `/raw-globals` spells the same bytes through a plain
  // dereference-and-shift and takes the row outright — 3 candidates, `/raw-globals` 0,
  // `/no-bitfield` 1, the plain spelling 2. Not a tie-break and not a near miss: the fold spelling does not
  // reach 0 at all there, so the macro row would pin nothing about this variation. An `extern` makes
  // the pool word a RELOCATION, which only a map-fed spelling can emit, and the two map spellings then
  // differ exactly on the fold. The price is one loud drop per SIGNEDNESS ARM the row enumerates
  // — `/raw-globals` fails candidate compilation, having no declaration to emit, so `bfwordread`
  // publishes 1 dropped candidate and `bfwordwrite` (which keeps both arms) 2 — the brief's
  // extern-data-global constraint biting the raw arm alone rather than the row.
  //
  // THE MECHANISM, on compiled objects rather than on a theory: for `u32 dreamStones : 7` seated
  // in the first u16, agbcc compiles the named read `gPacked.dreamStones` to `ldrh` at the
  // DECLARATION's access width; the source that loaded the whole WORD and shifted by hand emits
  // `ldr`. One instruction differs, and the differ referees it.
  //
  // THE m2c HALF OF BOTH ROWS IS A NONCOMPILE, AND THE MAP IS WHY. Told only the prototype, m2c
  // self-declares `extern s32 gPacked;` and its integer arithmetic compiles against that — a
  // MATCH. Handed the map — the same facts asmlift gets — m2c omits the declaration, as a
  // decompiler told about a symbol should, and emits the same integer arithmetic against the
  // struct: `invalid operands to binary <<` and `invalid operands to binary &`.
  // The counterfactual is measured and is in `eval/evaluate.ts`'s note beside the rung that
  // supplies the declarations: the SAME emitted body under m2c's own `extern s32 gPacked;` scores
  // 0 and matches. So the loss is m2c's output not compiling against the context m2c was given,
  // and it is the honest price of closing the channel rather than a capability claim.
  {
    sym: 'bfwordread',
    src:
      'struct Packed { unsigned hearts : 2; unsigned stars : 3; unsigned dreamStones : 7; unsigned pad : 20; unsigned unk4; };\n' +
      'extern struct Packed gPacked;\n' +
      'unsigned bfwordread(void){ return (*(unsigned *)&gPacked << 20) >> 25; }',
    features: ['cast', 'global'],
    toolchains: ['agbcc'],
    ctx: 'unsigned bfwordread(void);',
    symbols: PACKED_MAP,
  },
  {
    sym: 'bfwordwrite',
    src:
      'struct Packed { unsigned hearts : 2; unsigned stars : 3; unsigned dreamStones : 7; unsigned pad : 20; unsigned unk4; };\n' +
      'extern struct Packed gPacked;\n' +
      'void bfwordwrite(unsigned v){ unsigned *p = (unsigned *)&gPacked; *p = (*p & ~0xFE0u) | ((v & 0x7Fu) << 5); }',
    features: ['mask', 'cast', 'global', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'void bfwordwrite(unsigned v);',
    proto: { bfwordwrite: { returnsVoid: true } },
    symbols: PACKED_MAP,
  },

  // `/scopebase` — WHICH SCOPE the hoisted base local is declared in. `l3/basecse.ts` hoists to
  // the function top, which for a base used only inside one `if` arm makes it live across
  // everything before that arm and allocates differently; `l3/scopebase.ts` declares it in the arm
  // instead. The variation also fixes an ELIGIBILITY hole, and this row exercises both at once: with
  // the map's array RANK the access renders as the bare `gBgTilemapBufs[0][i]`, whose base is a
  // `var` rather than an address expression, so `isHoistableBase` never offers it to `basecse` at
  // all and the scoped pass is the only route to a named base here.
  // TWO-SIDED, and the second side is why the row is worth its compile: the SAME source with the
  // declaration moved to the function top is a DIFFERENT object, and it is won by a candidate with different
  // variations — so the two placements bracket each other rather than one dominating. Measured on this
  // row's own fan with `ASMLIFT_CANDCACHE=0`: `/scopebase` matches at 0 and the best spelling
  // without it is 11.
  // Like `bfwordread`/`bfwordwrite` this row carries a MAP, and for the same structural reason: run
  // map-less the fan carries zero `/scopebase` candidates, because the primary already hoists
  // `p0 = (u16 *)&gBgTilemapBufs;` to the function top and there is no `var` base to scope.
  {
    sym: 'sbscope',
    src:
      'extern unsigned short gBgTilemapBufs[4][1024];\n' +
      'void sbscope(int flag, int v){\n' +
      '  if (flag != 0) {\n' +
      '    unsigned short *p = gBgTilemapBufs[0];\n' +
      '    p[0x252] = v;\n' +
      '    p[0x272] = v + 1;\n' +
      '    p[0x292] = v + 2;\n' +
      '  }\n' +
      '}',
    features: ['array', 'global', 'pointer', 'branch', 'value-home'],
    toolchains: ['agbcc'],
    ctx: 'void sbscope(int flag, int v);',
    proto: { sbscope: { returnsVoid: true } },
    symbols: TILEMAP_MAP,
  },

  // `/no-ptr-elem` — the OFF arm of `structure.ts`'s `ptrMemberElement`, which rewrites byte
  // arithmetic through a map-declared sized pointer member into the element spelling
  // (`((u16 *)gBgPtrs.pMap)[i + 157]`). IT IS A VARIATION AND NOT A DEFAULT, because the rewrite is
  // not free: compiled, the two spellings are the same address and the same instruction count and
  // DIFFERENT objects at a nonzero element offset, so the differ has to referee them. This row is
  // the side of it no corpus row exercises.
  // Measured on this row's own fan with `ASMLIFT_CANDCACHE=0`: the byte-arithmetic target is
  // matched at 0 by `/no-ptr-elem` and by nothing else. The map is required for the same reason
  // `bfwordread`/`bfwordwrite` need one — the variation is enumerated only where the map declares a
  // pointer member with a pointee width of 1/2/4, so a map-less tier produces zero candidates.
  //
  // IT PAYS TWO LOUD DROPS OF ITS OWN, for the reason the bitfield rows pay theirs — this row also
  // relocates against a named `extern` global, so `/raw-globals` has no declaration to emit and
  // fails candidate compilation on each signedness arm it enumerates. `synthetic:ptrelem`
  // therefore publishes 2 `droppedCandidates` (`unsigned/raw-globals`, `signed/raw-globals`)
  // permanently. The price is per SIGNEDNESS ARM and not per row, which is why `bfwordread` and
  // `bfwordwrite` publish 1 and 2 rather than two each. Read off the artifact: 1, 2, 2.
  // Stated here because it is stated there: an undocumented pair of standing compile failures in
  // the corpus is one nobody can tell from a new regression, and nothing in `apps/benchmark` gates
  // a corpus-wide drop count.
  //
  // ITS m2c HALF IS A STANDING NONCOMPILE, before the map channel and after it, so this row is no
  // part of that channel's price. Measured through `evaluate()` with both caches off. Told only
  // the prototype, m2c emitted `(gBgPtrs + (i * 2))->unk13A` and failed with `invalid type
  // argument of '->'`; told the map, it emits `gBgPtrs.pMap[i].unk13A` — better, and the member
  // selection is now on the right object — and fails with `request for member 'unk13A' in
  // something not a structure or union`, `pMap` being a `u16 *`. Recorded to keep this row out of
  // the map channel's price: `invalid operands to binary <<` is `bfwordread`'s error, and not one
  // this row has ever produced.
  {
    sym: 'ptrelem',
    src:
      'struct BgPtrs { unsigned short *pMap; unsigned pad; };\n' +
      'extern struct BgPtrs gBgPtrs;\n' +
      'unsigned short ptrelem(int i){ return *(unsigned short *)((i << 1) + (unsigned char *)gBgPtrs.pMap + 314); }',
    features: ['pointer', 'global', 'cast'],
    toolchains: ['agbcc'],
    ctx: 'unsigned short ptrelem(int i);',
    symbols: BGPTRS_MAP,
  },
  // ── GLOBAL ARRAY SHAPE — the base local, the array-typed subscript, and the pool addend ────────
  // 2026-09-02 — WHAT THIS FAMILY NOW MEASURES, because everything below it is the state at
  // AUTHORING TIME and three of the scores have moved. `raise/globalshape.ts` derives a global's
  // array shape from the assembly's own stride evidence (the ORDER of the pool load against the
  // index scale, or a constant on the INDEX against a zero relocation addend) and routes it to the
  // structurer and to the declaration synthesis:
  //
  //   harr      2 → MATCH      harridx  5 → MATCH      tblrank2  3 → MATCH
  //   arrbias   MATCH held     arrcast  MATCH held
  //
  // 2026-09-03 — AND THE LAST TWO CLOSED, both by capabilities this block predicted wrongly:
  //
  //   bgarr     8 → MATCH   outparam   declined → MATCH
  //
  // `bgarr`'s attribution above is REFUTED and kept here rather than deleted, because it is the
  // hypothesis a later round would otherwise rebuild. The row does NOT need an element type. What
  // closed it is `/orderbase` (rank.ts) — a value HOME for the base, `struct Elem0 *p = (struct
  // Elem0 *)&gBgInfo; return p[a0].field_16;` — licensed by the ORDER half of this same
  // derivation, split out for a second consumer that asks only "was the base materialized before
  // the index was scaled" and needs no declaration to answer. Priced as a lattice of whole
  // spellings compiled through this row's own command, over two dimensions (HOME inline/local × ELEM
  // flat/struct) whose worst corner scores 10 and whose best scores 0: Shapley gives the base HOME
  // 9 of those 10 points and the element TYPE 1, because `u8 *p = (u8 *)&gBgInfo; return
  // *(u16 *)(p + a0*28 + 16);` already scores 0 with no struct and no array declaration at all.
  // `declare.ts`'s array branch
  // is never even reached on this row — the emitter prints the scalar `extern u32 gBgInfo;` — and
  // the flat `extern u8 gBgInfo[]` spelling the element-type fork would need scores 10, WORSE than
  // the 8 it would replace, and is out of bounds against the project's own header. The home keeps
  // the cast, so it adds nothing to `assumedSymbols`.
  //
  // `outparam` closed on the CALLEE's declared return type: a function declared `void` owns no
  // hidden struct-return pointer, whatever sits in r0. The refusal survives narrowed — an
  // undeclared or non-void callee still declines — and the price is stated at
  // `FnProto.returnsVoid`, since nothing in the assembly distinguishes the two frames and a wrong
  // manifest entry therefore buys a wrong program.
  //
  // BOTH CONTROLS HELD AT THE ENUMERATION, which is the only place they bind (their fans are 2
  // with both candidates at 0, so the published score cannot see an over-fire): enumerated,
  // 0 of 2 candidates on `arrbias` and 0 of 2 on `arrcast` carry the bare subscript, and both
  // keep the `extern u32 gTbl;` declaration of the cast spelling.
  //
  // FAN COST IS ZERO ON FOUR OF THE SEVEN AND 2 -> 4 ON `bgarr` AND `tblrank2`. The derivation
  // REPLACES the default spelling rather than adding a candidate, so where the shape is rank-1 and
  // no base home is licensed the fan does not move: `harr`, `harridx`, `arrbias` and `arrcast`
  // enumerate `unsigned, signed`. `bgarr` is one exception — the ORDER half licenses `/orderbase`,
  // so it enumerates `unsigned/orderbase, signed/orderbase, unsigned, signed` (0, 0, 8, 8). A
  // DERIVED RANK is the other exception, and it
  // is a variation this branch deliberately re-opened: `dims` satisfies the enumeration gate of
  // `/flat-rank`, a variation that map-less had nothing to turn off, so `tblrank2` enumerates
  // `unsigned, unsigned/flat-rank, signed, signed/flat-rank`. The variation exists because the asm
  // underdetermines `g[r][i]` against the flat byte arithmetic, and it is pinned by
  // `packages/core/test/global-array-shape.test.ts` ("a derived rank enumerates `/flat-rank`").
  // Corpus-wide that is +2 candidates on ONE function: `tblrank2` is the only row of the 1022
  // measured at #144, and unre-checked since, whose derived shape carries `dims` at all.
  //
  // The AUTHORING-TIME figures below are kept verbatim rather than rewritten: they are what the
  // rows were cut to measure, and the "today"s in them mean that day, not this one.
  //
  // Seven rows. FIVE — `harr`, `harridx`, `bgarr`, `tblrank2`, `arrbias` — are modelled on array
  // shapes the same graphics translation unit the `value-home` and DMA families above were cut
  // from actually indexes, which is why they are modelled rather than invented: a bare extern
  // scalar array read at a variable index (the TU's is `u8` — `harridx` keeps that width, `harr`
  // takes the `u16` one so the ordering question below is observable at all), a global array of
  // 28-byte structs read at a variable index for one `u16` member at offset 0x10 (`bgarr`), a
  // rank-2 table of pointers (`tblrank2`), and a CONSTANT BYTE BIAS on a global byte table — the
  // TU's rank-3 ROM table is read at a CONSTANT final subscript, which is the shape `arrbias`
  // isolates (that form was not compiled here, so this is a shape correspondence, not a claim
  // that it too folds to a pool addend). TWO are CONSTRUCTED PROBES with no counterpart, labelled
  // as such rather than passed off as found code:
  //  • `arrcast` guards a direction the other rows leave open (question 2 below).
  //  • `outparam` pins the out-parameter idiom `T v; callee(&v); use(v);`, which has ZERO
  //    INHABITANTS in that TU. Measured: across its 956 lines the ONLY address-taken LOCAL is a
  //    `u16` written before use and handed to a DMA register — never to a callee as argument 0 —
  //    and every other `&x` in the file is a global. The near-match reference for the family's own
  //    source function contains no `&local` call argument at all. A round pricing this decline by
  //    counting inhabitants in that function will find none: the row is here because the idiom is
  //    general, not because the source TU needs it.
  //
  // asmlift spells the base as a CAST over the symbol's address — `((u16 *)&gTbl)[i]` — on four of
  // the six scored rows, and as flat pointer arithmetic on the other two. Whether that candidate
  // then SCALES THE INDEX FIRST is a separate question that does not follow from the cast.
  // Disassembled, candidate against target:
  //
  //                candidate asmlift ranks today          candidate obj   target obj
  //     harr       `((u16 *)&gTbl)[a0]`                   index-first     base-first
  //     harridx    `((u8 *)&gTbl)[a0 + 1]`                BASE-first      base-first
  //     bgarr      `((struct Elem0 *)&gBgInfo)[a0].f_16`  index-first     base-first
  //     tblrank2   `*(s32 *)((a1<<2) + (a0<<3) + &gPtrTbl)`  index-first  base-first
  //     arrbias    `*(u8 *)(a0 + ((u32)&gTbl + 1))`       BASE-first      base-first
  //     arrcast    `((u16 *)&gTbl)[a0]`                   index-first     INDEX-first
  //
  // Five of the six scored TARGETS load the base first (`arrcast` is the one that does not), and
  // asmlift's candidate mismatches that order on THREE of those five — `harr`, `bgarr`, `tblrank2`.
  //
  // WHY `harridx` AND `arrbias` ARE ALREADY BASE-FIRST, and it is NOT the addend. Both are u8
  // rows, and AT ELEMENT WIDTH 1 THERE IS NO INDEX SCALING TO EMIT, so the base `ldr` is first
  // whatever else is going on. Measured, cast base, `+1` present and absent:
  //
  //     ((u8 *)&gTbl)[a0]       ldr ; adds ; ldrb          ((u16 *)&gTbl)[a0]      lsls ; ldr ; …
  //     ((u8 *)&gTbl)[a0 + 1]   ldr ; adds ; ldrb          ((u16 *)&gTbl)[a0 + 1]  lsls ; ldr ; …
  //
  // The constant term moves the pool word's ADDEND (question 1) and does not touch the ORDER; the
  // width decides the order. So instruction order is only OBSERVABLE at width > 1, which is why
  // the question-2 minimal pair below is `harr`/`arrcast` (both u16) and why no u8 row can referee it.
  // `arrbias` being a MATCH is this, not an ordering win — do not read it as a row exposed to an
  // index-first default.
  //
  // THE ATTRIBUTION: TWO sufficient causes, not one. agbcc's `c-typeck.c` does fork the subscript
  // on `TREE_CODE (TREE_TYPE (array)) == ARRAY_TYPE && TREE_CODE (array) != INDIRECT_REF`, so a
  // bare `gTbl[i]` over a declared array loads the base first. But so does an ordinary POINTER
  // LOCAL holding the base, which has no array type at all. Measured object-vs-object against
  // these rows' own targets, with `arm-none-eabi-objdump` confirming instruction-identical output:
  //
  //   extern u16 gTbl[]; u32 harr(u32 i){ u16 *p = (u16 *)&gTbl; return p[i]; }          -> 0
  //   struct Elem0 {...}; u32 bgarr(u32 i){ struct Elem0 *p = (struct Elem0 *)&gBgInfo;
  //                                         return p[i].field_16; }                      -> 0
  //   the same base-local shape against `harridx` (with or without the cast)              -> 6
  //   a RANK-PRESERVING base local against `tblrank2`
  //     `const s32 *(*p)[2] = (const s32 *(*)[2])&gPtrTbl; return (s32)p[i][j];`          -> 2
  //   a FLAT base local against `tblrank2` (base local AND the rank flattened)            -> 6
  //
  // So `harr` and `bgarr` DO NOT isolate the array-typed subscript: a base local reaches their
  // targets byte-for-byte, and that is the CHEAPER of two sufficient answers — a value home over a
  // named symbol, the family asmlift already has (`value-home` above). In the event `bgarr` closed
  // on the base local (`/orderbase`) and `harr` on the array fork — both sufficient answers were
  // real, and which one the ranker reached for differed per row.
  //
  // `harridx` and `tblrank2` are the rows where the base local is NOT sufficient, and they fail it
  // differently. On `harridx` the base local is simply wrong (6, against asmlift's 5 today) — the
  // addend decides and no spelling of the base reaches it. On `tblrank2` it is a PARTIAL: rank-preserving
  // it scores 2, BETTER than the 3 asmlift ranks today, so a base-local variation alone would move
  // that row without matching it. Only the array-typed subscript with the rank preserved reaches
  // 0. The two `tblrank2` figures differ by whether the RANK survives, not by the spelling of the base —
  // flattening the rank costs 4 points on its own, the same dimension the additivity gate measures.
  //
  // Today, agbcc only, map-less, fan 2 on every scored row, BOTH candidates of every fan scoring
  // identically, winner `unsigned` on every scored row, one declaration synthesized on
  // each. THOSE FIGURES COME FROM THREE DIFFERENT COMMANDS, and the row's score is the only one
  // `bench run` prints:
  //   • THE SCORE — `pnpm bench run --tier synthetic --only <sym> --toolchain agbcc --serial`.
  //     Note `--only` is a SUBSTRING filter. Run for all seven syms, `harr` is the ONE that does
  //     not isolate — it also runs `harridx`, printing `[1/2]` and `[2/2]`; the other six each
  //     print `[1/1]`.
  //   • FAN SIZE, WINNER'S VARIATIONS, SYNTHESIZED COUNT — the CLI against a built target:
  //     `asmlift <sym>.s --config apps/benchmark/dataset/toolchains/agbcc/decomp.yaml
  //      --score-against <sym>.o`, with `$ASMLIFT_AGBCC` and `$ASMLIFT_ARM_AS` both exported.
  //     THE `--config` IS NOT OPTIONAL and a bare `--target agbcc` is not a substitute: run that
  //     way it prints no figures at all, only `--score-against needs tools.asmlift.compiler in
  //     decomp.yaml`. That yaml is the one the benchmark itself scores through; `--target` then
  //     comes from it. Its `[declared]` line reads `1 declaration(s) synthesized from the target
  //     asm`; its `[ranked]` line reads `2 candidate(s) scored, 0 dropped, 0 withheld,
  //     1 synthesized, winner unsigned: <score>` followed by a source stamp.
  //   • EVERY CANDIDATE'S SCORE — `[ranked]` prints only the WINNER, so this needs a third call:
  //     `decompileRanked(sym, asm, c.codegen.target, obj, { compile: benchCompilerFor('agbcc', c.codegen.cflags) })`,
  //     walking `.candidates` (NOT `.results`, which does not exist — `rankBy` returns
  //     `{ best, candidates, dropped, withheld }`). Measured, `unsigned` and `signed` tie on all
  //     six scored rows — 2/2, 5/5, 8/8, 3/3, 0/0, 0/0. THIS is the enumeration both controls
  //     below require, and no `bench` subcommand substitutes for it.
  //
  // The scores those commands report today, and what each row is for:
  //
  //   harr      2      width > 1, no constant term. Base local OR array subscript reaches it
  //   harridx   5      a constant term at width 1 — target pool word `.word gTbl` plus
  //                    `add r0,r0,#0x1`, asmlift `((u8 *)&gTbl)[a0 + 1]`, which agbcc folds
  //                    into a pool word of `.word gTbl+0x1` and no `add`. Base local scores 6
  //   bgarr     8      the struct-array member read. Base local OR array subscript reaches it
  //   tblrank2  3      the declared rank — AND the additivity gate, below. A rank-preserving
  //                    base local scores 2 here: better than today, still not a match
  //   arrbias   0      MATCH. OVER-FIRE CONTROL, addend direction — see below
  //   arrcast   0      MATCH. OVER-FIRE CONTROL, zero-addend direction — see below
  //   outparam  none   no score at all: a whole-function DECLINE
  //
  // WHY THESE SEVEN RELOCATE AGAINST A NAMED DATA GLOBAL rather than using the address-macro form
  // most synthetic globals here use (`#define gTbl ((u16 *)0x03003430)`): respelled that way the
  // family MEASURES NOTHING — all of them score 0 today. An array-typed OBJECT requires a SYMBOL,
  // so at a literal address every available C spelling is a pointer cast or an INDIRECT_REF and
  // takes the pointer path — bare `gTbl[i]`, `((u16 *)LIT)[i]` and `(*(u16 (*)[])LIT)[i]` compile
  // to ONE object (md5 61b257461c93f452d7ea79e0778da534 for all three). The addend goes the same
  // way: respelled, `harridx` and `arrbias` constant-fold to the same `.word 0x3003431` and become
  // the same row, destroying the control. The rows compile because asmlift synthesizes the
  // declaration itself off the target asm (`[declared] 1 declaration(s) synthesized`), `as`
  // accepts an undefined `R_ARM_ABS32` in a `.o`, and objdiff pairs relocations BY SYMBOL NAME.
  // These are NOT the first synthetic rows to do it: `bfwordread`, `bfwordwrite` and `ptrelem`
  // (`gPacked`, `gBgPtrs`) and the `value-home` row `sbscope`
  // (`extern unsigned short gBgTilemapBufs[4][1024]`) already relocate against named data globals,
  // so the named-symbol base is established here and this family neither introduces nor pioneers
  // it. Three family headers far above this block state that a synthetic candidate cannot declare
  // an extern global; that is false and all three are corrected in place.
  //
  // NONE OF THE SEVEN CARRIES A SYMBOL MAP, and that is deliberate rather than incidental.
  // `SynthSpec.symbols` exists and rows above set it (`ptrelem` does), so a folded `gaddr` pool
  // literal CAN form on a synthetic row. Measured, handing `harr` a map that declares `gTbl` an
  // array flips asmlift's own winner from `((u16 *)&gTbl)[a0]` to the bare `gTbl[a0]` — the very
  // spelling this family exists to measure the absence of — so a mapped row would measure nothing
  // here. asmlift's synthesized `extern u32 gTbl;` is a third thing again: the DECLARE path, which
  // names the symbol without typing it.
  //
  // THE SOUNDNESS RULE THE FAMILY ENCODES: TWO INDEPENDENT QUESTIONS. Both are measured; neither is a
  // licence for the other.
  //
  // QUESTION 1 — WHERE THE CONSTANT TERM GOES. The full 2×4 cross, every spelling of `gTbl[i+1]`
  // against both `+1` targets (`harridx`'s pool word is a bare `.word gTbl` plus a runtime
  // `adds r0,#1`; `arrbias`'s is `.word gTbl+0x1` with no add — `R_ARM_ABS32 gTbl`, in-place
  // addend `01 00 00 00` at 0x8, against `harridx`'s `00 00 00 00`):
  //
  //                                                        vs harridx   vs arrbias
  //     gTbl[i + 1]                     (array, on index)      0 MATCH      5
  //     const u8 *p = &gTbl[1]; p[i]    (array, in base)       5            0 MATCH
  //     ((u8 *)&gTbl)[i + 1]            (cast,  on index)      5            0 MATCH
  //     *(u8 *)(i + ((u32)&gTbl + 1))   (cast,  in base)       5            0 MATCH
  //
  // Read the columns, because they are NOT symmetric and that asymmetry is the whole rule.
  // Against `arrbias` THREE spellings tie at 0 — anything that folds the constant into the base
  // reaches a pool addend, cast or not — so `arrbias` does not discriminate cast from array at
  // all; it discriminates BASE-FOLDED from ON-INDEX. Against `harridx` exactly ONE spelling works,
  // and it is the only one that is BOTH array-typed AND index-side: agbcc constant-folds
  // `&gTbl + 1` into the pool word for every pointer/cast base, so keeping the `+1` on the index
  // is not enough — `((u8 *)&gTbl)[i + 1]` still scores 5. So:
  //
  //     A pool addend means the constant belongs in the BASE, and three spellings all reach it.
  //     A bare pool word plus a runtime add means the constant belongs on the INDEX, and there
  //     only the DECLARED-ARRAY subscript survives, because every cast base folds it away.
  //
  // QUESTION 2 — INSTRUCTION ORDER, which is what decides when there is no constant term at all. It
  // has a PRECONDITION: order is only observable at ELEMENT WIDTH > 1, because at width 1 there is
  // no scaling to order against the base `ldr` (measured above). So the question has exactly TWO
  // instances here, both u16: `harr`, whose base-first target is reached by a declared array OR a
  // base local (0 and 0), and `arrcast`, whose index-first target wants the cast and where BOTH
  // base-first spellings score 2. A zero addend does NOT license base-first, and `arrcast` is the
  // row that catches a rule which assumes it does.
  //
  // THE OTHER ROWS ARE NOT INSTANCES OF THIS QUESTION. Each fails the predicate for its own reason:
  //  • `bgarr` is zero-addend and base-first and a base local or a declared array does reach it
  //    (0 and 0) — but its 28-byte element is a second moving part, so it is not a minimal pair
  //    with anything and cannot referee an ordering rule on its own.
  //  • `tblrank2` is zero-addend and base-first, but a base local does NOT reach it: the
  //    rank-preserving one scores 2. It is a PARTIAL on this question, not an instance.
  //  • `arrbias` fails the precondition — it is u8, so it CANNOT discriminate instruction order at
  //    all — and it is not zero-addend either (its pool word carries addend 1). It is a QUESTION 1
  //    row. It also does not want a declared array or a base local: asmlift already MATCHES it
  //    with a cast, `*(u8 *)(a0 + ((u32)&gTbl + 1))`, and question 1's cross shows three spellings
  //    tying at 0 there, so the row does not discriminate cast from array in either direction.
  //    Reading it as a question-2 over-fire control is wrong three times over.
  //
  // TWO ROWS GUARD THIS, one per question, and BOTH are authored as matches:
  //  • `arrbias` — QUESTION 1, the addend direction. Applying the index-side spelling unconditionally
  //    — `extern u8 gTbl[]; return gTbl[a0 + 1];`, which is exactly what wins `harridx` — scores 5
  //    here, i.e. it loses the match. The mirror is byte-level: asmlift's `harridx` candidate
  //    `((u8 *)&gTbl)[a0 + 1]` assembles to `.text` bytes IDENTICAL to `arrbias`'s target
  //    (`01 49 40 18 00 78 70 47 01 00 00 00`, one `R_ARM_ABS32 gTbl`), and the two 5s are
  //    mirror-image breakdowns — `delete: 2` one way, `insert: 2` the other. One symbol, two
  //    opposite right answers, separated only by the addend.
  //  • `arrcast` — QUESTION 2, the zero-addend direction. It is a MINIMAL PAIR with `harr`: same
  //    symbol, same `u16` width, same single `R_ARM_ABS32 gTbl` at an in-place addend of
  //    `00 00 00 00`, same index — the sources differ by nothing but a cast, and the objects
  //    differ by nothing but instruction order:
  //        harr     `gTbl[i]`            ldr r1,.L / lsl r0,#1 / add / ldrh
  //        arrcast  `((u16 *)gTbl)[i]`   lsl r0,#1 / ldr r1,.L / add / ldrh
  //    So the two rows are each other's over-fire control on this question, and nothing else varies.
  //    Both base-first spellings lose `arrcast` — bare `gTbl[i]` scores 2 and the base local
  //    `const u16 *p = gTbl; p[i]` scores 2 (they are the same object). A rule implemented as
  //    "addend zero, therefore base-first" over-fires on exactly this shape.
  //
  // HOW BOTH CONTROLS ACTUALLY BIND, because their fans make the obvious reading wrong. `rankBy`
  // sorts and returns `results[0]` (`packages/core/src/rank.ts`), so the published score is the
  // MINIMUM over the fan. `arrbias`'s fan is 2 and BOTH candidates score 0; `arrcast`'s likewise.
  // A variation that merely ADDS a base-first candidate therefore CANNOT move either row — the
  // 0-scoring cast candidate still wins, and the control reports green while the variation over-fires.
  // BOTH CONTROLS BIND ONLY ON A CHANGE THAT REPLACES OR WITHHOLDS THE CURRENT WINNER. A variation
  // shipped additively must be checked by enumerating the fan (every candidate's score), not by
  // reading the row's published score.
  //
  // THE ADDITIVITY GATE — `tblrank2`, and it shipped as predicted: both halves landed together in
  // #143 and the row matches at 0 as `gPtrTbl[a0][a1]` off a synthesized
  // `extern s32 gPtrTbl[][2]`. What follows is the pre-ship measurement, kept because it is the
  // reason the two halves could not be shipped separately. Endpoint-scored object-vs-object, half
  // A alone (the array-typed subscript with
  // a flat index, in asmlift's own operand order) `extern s32 gPtrTbl[]; return gPtrTbl[j + i*2];`
  // scores 4 — WORSE than the 3 asmlift ranks today; the other operand order `gPtrTbl[i*2 + j]`
  // scores 6; both halves together, which is the row's own spelling, score 0. So the subscript and
  // the declared rank must ship TOGETHER or this row pays for the half. FALSIFYING COMMAND, and it
  // is an ENDPOINT check for the same reason the controls are: ship half A alone, then score the
  // half-A candidate against `tblrank2`'s target directly. Anything other than a score strictly
  // worse than 3 falsifies the claim. Do NOT read this off `pnpm bench run` — `tblrank2`'s fan WAS
  // 2 with both candidates at 3, so an additively-shipped half A would have left the published 3
  // standing and the gate would have reported a falsification for a variation behaving exactly as
  // predicted.
  //
  // TWO THINGS THE ROWS FALSIFIED, said here because it is easy to assume otherwise:
  //  • `bgarr` needs NO new element-layout capability. asmlift ALREADY synthesizes a correct
  //    28-byte element and the right member — `struct Elem0 { u8 _pad0[16]; u16 field_16;
  //    u8 _pad1[10]; }` reached as `((struct Elem0 *)&gBgInfo)[a0].field_16`. Feeding asmlift's
  //    OWN `Elem0` back through a DECLARED array (`extern struct Elem0 gBgInfo[];
  //    return gBgInfo[a0].field_16;`) scores 0, and through a BASE LOCAL scores 0 as well. The
  //    whole 8 is where the base is materialized, not what the element looks like; a round that
  //    closes it by inventing element layouts is aiming at the wrong gap.
  //  • `tblrank2`'s rank ARITHMETIC is already recovered. asmlift emits
  //    `*(s32 *)((a1 << 2) + (a0 << 3) + (u32)&gPtrTbl)` — the rank-preserving scaling, not the
  //    flat `(i * 2 + j) * 4`. The flat index is a symbol-side SPELLING, not an arithmetic gap.
  //
  // `outparam` pins the out-parameter idiom `T v; callee(&v); use(v);`. On the TARGET side,
  // agbcc's `expand_decl` refuses a register to a local whose address is taken, so the local
  // becomes a one-word frame and its address becomes argument 0. That is not what asmlift used
  // to refuse on: the perturbation `s32 v = 0; fill(&v); return v;` is equally address-taken and
  // lifts cleanly. The discriminator is the STORE-LESS slot — the frame word is never written
  // before the call, which is also how a hidden struct-return pointer looks.
  // THE ROW'S GATE IS ITS `proto` ENTRY, and it is load-bearing rather than inert. Measured, one
  // candidate, `[ranked] 1 candidate(s) scored, 0 dropped, 0 withheld, 0 synthesized, best
  // unsigned: 0 (match)`; run the same command with `--proto` dropped and the whole function
  // declines again, at the `hiddenReturnPointerStands` guard in
  // `packages/core/src/frontend/thumb.ts`:
  //     cannot lift 'outparam': address-taken stack local — the one-word frame is never written
  //     here, and `fill` takes it at argument 0 and nothing says what that callee returns — a
  //     struct returned through a hidden pointer is handed this same frame
  // So a `returnsVoid` regression on this row is detectable, and the refusal survives narrowed:
  // a callee whose return nothing describes still declines.
  //
  // `stkext` and `stkextsret` are the same idiom one size up, where the frame is a BUFFER and no
  // access in the function types it. Nothing dereferences the captured address, so nothing pins a
  // TYPE; the frame reservation pins the EXTENT, and an extent is all a block copy needs. They are
  // a two-sided pair over the one thing that separates a filled buffer from a struct-return
  // temporary, which the asm does not say:
  //
  //   stkext      push {lr} / add sp,#-0x40 / ldr r1,.L3 / mov r0,sp / mov r2,#0x40 / bl memcpy
  //   stkextsret  push {lr} / add sp,#-0x40 / ldr r1,.L3 / mov r0,sp /               bl makeblob
  //
  // `stkext` calls a function whose RETURN the C standard fixes — `memcpy` returns `void *`, in a
  // register (`proto.ts` STANDARD_SIGNATURES), so there is no hidden pointer for argument 0 to be
  // carrying and the frame is this function's: **MATCH**, one candidate. `stkextsret` calls one
  // declared to return `struct Blob64`, which agbcc hands back through memory (thumb.c:1423-1493),
  // so the frame is the storage that return lands in — a local of that struct, which the call
  // fills: `struct Blob64 sp0; sp0 = makeblob(&gBlob);`.
  // THE ARGUMENT REGISTERS ARE NOT THE WITNESS, though the pair looks like they might be: three
  // set against three declared on one side, two against one on the other. They are not, because a
  // register already holding an incoming parameter is written by nobody — compiled,
  // `void f(const void *a, const void *b){ struct Blob64 s = makeblob(b); }` sets exactly ONE
  // register for a one-parameter declaration and is still a struct return. What the pair measures
  // is a statement about the RETURN.
  //
  // EACH SIDE'S WITNESS IS A DECLARED RETURN. `stkext`'s comes from the STANDARD table rather than
  // from anything the row says: rename its callee to `blockcopy` and the row declines in the
  // out-parameter refusal's words; declare `blockcopy` `returnsVoid` and it lifts again.
  // `stkextsret`'s is its own `proto`, which states the struct and its members as the `ctx` does.
  // An arity is not one: told only `params: 1`, the same frame declines —
  //     cannot lift 'stkextsret': address-taken stack local — the captured address is never
  //     dereferenced in this function, so nothing pins the local object type — and `makeblob`
  //     takes it at argument 0 and nothing says what that callee returns — a struct returned
  //     through a hidden pointer is handed this same frame
  // — and a lift of this frame WITHOUT the declared return would be a regression: nothing in the
  // asm tells it from `stkext`'s, so whatever accepted it would accept a callee's own storage as a
  // local. `packages/core/test/struct-return.test.ts` pins that refusal.
  //
  // BOTH DECLARE THEIR CALLEE TO BOTH DECOMPILERS, the same declaration through each tool's own
  // channel, which is what makes this a measurement of the witness rather than of who was told
  // what: the pair differs in the ASM, not in the context. m2c, told the same return, spells the
  // call `makeblob(/* return */ &sp0, &gBlob);`.
  //
  // THE SIZE IS NOT LOAD-BEARING ON `stkext`, which is worth stating because the number looks
  // chosen. Compiled at the row's own flags over 1, 4, 8, 12, 16, 20, 32, 33, 48, 64 and 128
  // bytes, agbcc emits `bl memcpy` at EVERY size, with the declaration present or absent: the
  // builtin does not expand a `memcpy` CALL inline here at all. The inline `ldmia`/`stmia`
  // expansion belongs to a DIFFERENT construct — a struct ASSIGNMENT (`struct S b = gS;`), which
  // agbcc moves in registers at 4 and 8 bytes, expands inline at 16 and 32, and turns into
  // `bl memcpy` at 64.
  //
  // WHAT IS LOAD-BEARING IS ON THE OTHER SIDE OF THE PAIR, and it is the struct's LAYOUT, not its
  // size. Compiled: a one-member struct of a word comes back from `makeblob` in r0 with no frame
  // reserved at all, while a word of four `u8` members, and 8, 16 and 64 bytes, each reserve the
  // frame and hand its address over at argument 0 (thumb.c:1423-1493). 64 is simply the size the
  // PAIR shares, so that its two targets differ in the call and in nothing else.
  //
  // THE m2c SIDE. Every row here but `outparam` is `declined` for m2c on its OWN self-reported
  // gap — it emits `extern ? gTbl;`, or `extern ? gBlob;` on the two extent rows, and the
  // `? placeholder` is what the classifier reads. `outparam` is the exception in the other
  // direction: read off the artifact, m2c MATCHES it at score 0. The out-parameter idiom is one
  // m2c already spells byte-exactly, so nothing in that row's m2c column is a handicap.
  // MEASURED over the six array rows — m2c run with `--context` carrying THE ROW'S OWN
  // declaration, its `src` header verbatim, and its output scored with that same context
  // prepended:
  //
  //   harr      `return (u32) gTbl[i];`                          score 0, MATCH
  //   arrbias   `return (u32) (gTbl + 1)[i];`                    score 0, MATCH
  //   bgarr     `return (u32) gBgInfo[i].hLength;`               score 0, MATCH
  //   arrcast   `return (u32) gTbl[i];`                          score 2
  //   tblrank2  `return *((j * 4) + (i * 8) + gPtrTbl);`         score 10
  //   harridx   `return (u32) gTbl[i].unk1;`                     noncompile
  //
  // So the withheld declaration costs m2c THREE BYTE-EXACT MATCHES. Note `bgarr` must be measured
  // with an element of the row's own WIDTH: `extern u32 gBgInfo[]` declares a 4-byte element for
  // an array whose elements are 28 bytes, naming the SYMBOL without naming the row's ARRAY, and it
  // is the one cell that moves when that is fixed. `bgarr`'s match does NOT rest on handing m2c a
  // struct layout this file's prototypes-only rule withholds: fed instead asmlift's OWN synthesized
  // element — the padded, member-name-free `struct Elem0 { u8 _pad0[16]; u16 field_16;
  // u8 _pad1[10]; }` that asmlift derives from the target asm unaided — m2c emits
  // `gBgInfo[i].field_16` and scores 0 as well. What it needs is the DECLARATION, not the field
  // names, so the layout rule does not rescue this cell. It is not uniformly a gift either: on
  // `arrcast` m2c emits the same base-first `gTbl[i]` it emits for `harr`, the WRONG spelling for
  // that target, so the declaration would move it to 2 rather than to a match — m2c has no more of
  // the question-2 distinction than asmlift does.
  //
  // This is a ONE-SIDED HANDICAP and it should be read that way: asmlift does not need the `ctx`
  // because it synthesizes the declaration off the target asm itself, and m2c cannot. It is NOT
  // introduced by these rows — `bfwordread`, `bfwordwrite` and `ptrelem` already relocate against
  // named data globals and already pay it (all three `noncompile` for m2c on this base). What
  // these seven add is its PRICE on array shapes: three byte-exact matches. The rows are published
  // anyway, with the cost stated, because BOTH ways of paying it measure less. Route one, `ctx`
  // alone: the SYNTHETIC tier does not prepend `ctx` to m2c's candidate at scoring time the way the
  // real tier does (`makeRealScorer`, `apps/benchmark/src/compile/real.ts`, vs `scoreM2c`,
  // `apps/benchmark/src/eval/evaluate.ts`), and measured, an array in `ctx` with nothing prepended
  // is a NONCOMPILE on all six scored rows. Route two is a DATASET change, not a harness one: a
  // synthetic row that sets `symbols` already gets the map's declarations rendered into `ctx`
  // (`withMapDeclarations`, `src/cases/synthetic.ts`) AND prepended to m2c's candidate at scoring
  // time (`m2cDeclarationsFor`, `src/eval/evaluate.ts`). It is refused here for the reason given
  // above: the same map reaches asmlift and flips its winner to the bare subscript, so it would
  // buy m2c a fair column by deleting the gap the rows measure. Prototypes-only — the file
  // header's rule, whose one stated exception is exactly a row carrying `symbols` — is what ships;
  // the m2c column on these seven rows is NOT a fair read of m2c's array-shape ability, and the
  // row that closes it is a real-tier row where both sides get the project's own declarations.
  //
  // agbcc only. The nearest precedent is `read-once`, genuinely agbcc-only (4 dataset entries, 4
  // rows, all agbcc); `uninit-local` and `value-home` are NOT — they span all four toolchains, so
  // no appeal to them justifies anything here. COUNTED IN ROWS, which is what `bench` reports and
  // what "rows" means everywhere else in this file, and read off THE ARTIFACT THIS BRANCH
  // PUBLISHES: `uninit-local` is 16 rows (agbcc 7, ido7.1 3, gcc2.7.2kmc 3, mwcc_242_81 3) and
  // `value-home` is 82 (agbcc 61, gcc2.7.2kmc 8, ido7.1 7, mwcc_242_81 6 — 77 synthetic plus 5
  // real). A cross-family census in a comment is a fact about the whole file, so it goes stale on
  // someone ELSE's merge: re-run it after every rebase, from the artifact and not from a `grep`
  // over this file, which counts prose lines. The reason these stay agbcc-only is direct: whether
  // ido7.1, gcc2.7.2kmc and mwcc_242_81 fork the subscript on the operand's array-ness at all was
  // NOT measured, so those lanes are left off rather than assumed; what would earn one is the same
  // compiled pair on that toolchain showing the same divergence.
  {
    sym: 'harr',
    src: 'extern u16 gTbl[];\nu32 harr(u32 i){ return gTbl[i]; }',
    features: ['global', 'array', 'variable-index'],
    toolchains: ['agbcc'],
    ctx: 'u32 harr(u32 i);',
  },
  {
    sym: 'harridx',
    src: 'extern u8 gTbl[];\nu32 harridx(u32 i){ return gTbl[i+1]; }',
    features: ['global', 'array', 'variable-index'],
    toolchains: ['agbcc'],
    ctx: 'u32 harridx(u32 i);',
  },
  {
    sym: 'bgarr',
    src:
      'struct BgInfo { void *pTiles; void *pTilemap; u16 hOfs; u16 vOfs; u16 tileCol; u16 tileRow;\n' +
      '                u16 hLength; u16 vLength; u16 unk14; u16 unk16; u8 unk18; u8 pad19[3]; };\n' +
      'extern struct BgInfo gBgInfo[4];\n' +
      'u32 bgarr(u32 i){ return gBgInfo[i].hLength; }',
    features: ['global', 'array', 'variable-index', 'struct', 'field'],
    toolchains: ['agbcc'],
    ctx: 'u32 bgarr(u32 i);',
  },
  {
    sym: 'tblrank2',
    src: 'extern const s32 *gPtrTbl[][2];\ns32 tblrank2(u32 i, u32 j){ return (s32)gPtrTbl[i][j]; }',
    features: ['global', 'array', 'variable-index', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 's32 tblrank2(u32 i, u32 j);',
  },
  {
    sym: 'arrbias',
    src: 'extern u8 gTbl[];\nu32 arrbias(u32 i){ const u8 *p = &gTbl[1]; return p[i]; }',
    features: ['global', 'array', 'variable-index', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'u32 arrbias(u32 i);',
  },
  {
    sym: 'arrcast',
    src: 'extern u16 gTbl[];\nu32 arrcast(u32 i){ return ((u16 *)gTbl)[i]; }',
    // NO `variable-index` tag, though the index IS variable: that tag's floor is
    // `/\w+\s*\[\s*[^\]\d\s]/`, an identifier immediately before the `[`, and this row's
    // subscript sits on a parenthesized cast (`)[i]`) so the floor rejects it. Widening a shared
    // floor for one row is the wrong trade; the tag is dropped and the omission recorded here.
    features: ['global', 'array', 'pointer'],
    toolchains: ['agbcc'],
    ctx: 'u32 arrcast(u32 i);',
  },
  {
    sym: 'outparam',
    src: 'extern void fill(s32 *p);\ns32 outparam(void){ s32 v; fill(&v); return v; }',
    features: ['stack-addr', 'uninit-local'],
    toolchains: ['agbcc'],
    ctx: 'void fill(s32 *p); s32 outparam(void);',
    proto: { fill: { params: 1, returnsVoid: true } },
  },
  {
    sym: 'stkext',
    // The size is not doing work here — agbcc emits `bl memcpy` at every size from 1 to 128 at
    // these flags (family comment above). Sixty-four is the size `stkextsret` needs, and the two
    // rows share it so their targets differ in the call alone.
    //
    // THE THIRD PARAMETER IS `unsigned long`, which is what agbcc's builtin declares: spelling it
    // `u32` makes every build of this target emit `warning: conflicting types for built-in
    // function 'memcpy'`. Compiled both ways, the object is identical — the warning is the whole
    // difference.
    src:
      'void *memcpy(void *, const void *, unsigned long);\nextern const u8 gBlob[64];\n' +
      'void stkext(void){ u8 b[64]; memcpy(&b[0], gBlob, sizeof b); }',
    features: ['stack-addr'],
    toolchains: ['agbcc'],
    ctx: 'void *memcpy(void *, const void *, unsigned long);\nvoid stkext(void);',
  },
  {
    sym: 'stkidx',
    // `stkext`'s buffer, read back through a RUNTIME index: `mov r1, sp / add r0, r1, r4 /
    // ldrb r0, [r0]`. The index names no offset, so no access types the buffer, and the byte it
    // reads is one element of the storage the reservation sizes. `sa3:sa2__sub_8004418` is this
    // shape in a real project. Sixty-four bytes for the reason `stkext` gives, and one more: the
    // table is fitted from the asm as a word, and gcc open-codes a copy of 32 bytes or fewer from
    // an aligned source as `ldmia`/`stmia` — a different function around the same index.
    src:
      'void *memcpy(void *, const void *, unsigned long);\nextern const u8 gBlob[64];\n' +
      'u32 stkidx(u32 i){ u8 a[64]; memcpy(&a[0], gBlob, sizeof a); return a[i]; }',
    features: ['stack-addr', 'array', 'variable-index'],
    toolchains: ['agbcc'],
    ctx: 'void *memcpy(void *, const void *, unsigned long);\nu32 stkidx(u32 i);',
  },
  {
    sym: 'stkoff',
    // A local ABOVE an outgoing argument block, so agbcc spells its address `add r0, sp, #0x4`
    // rather than `mov r0, sp`: `five`'s fifth argument owns [sp,#0]. Both callees are declared,
    // so the block is licensed and the capture names the one object left in the frame.
    src:
      'extern void five(s32, s32, s32, s32, s32);\nextern void geth(u16 *);\n' +
      's32 stkoff(s32 a, s32 b){ u16 h; five(a, b, a, b, a); geth(&h); return h; }',
    features: ['stack-addr', 'multi-arg'],
    toolchains: ['agbcc'],
    ctx: 'void five(s32, s32, s32, s32, s32);\nvoid geth(u16 *);\ns32 stkoff(s32 a, s32 b);',
    proto: {
      five: { params: ['s32', 's32', 's32', 's32', 's32'], returnsVoid: true },
      geth: { params: ['u16 *'], returnsVoid: true },
    },
  },
  {
    sym: 'stkslot',
    // `stkoff` with a WORD local: `str r5, [sp, #0x4]` is a store the slot model would key and the
    // outgoing-argument analysis would read as a staged argument, and `add r0, sp, #0x4` names it
    // as the object `getw` is handed, so it is that object at every access.
    src:
      'extern void five(s32, s32, s32, s32, s32);\nextern void getw(s32 *);\n' +
      'void stkslot(s32 a, s32 b){ s32 w; five(a, b, a, b, a); w = b; getw(&w); five(w, a, a, a, a); }',
    features: ['stack-addr', 'multi-arg'],
    toolchains: ['agbcc'],
    ctx: 'void five(s32, s32, s32, s32, s32);\nvoid getw(s32 *);\nvoid stkslot(s32 a, s32 b);',
    proto: {
      five: { params: ['s32', 's32', 's32', 's32', 's32'], returnsVoid: true },
      getw: { params: ['s32 *'], returnsVoid: true },
    },
  },
  {
    sym: 'stkextsret',
    // NO `stack-addr` TAG, and that is the floor holding rather than an omission: the tag's floor
    // is the `&`, and this source never writes one. The address is taken by the ABI, not by the
    // programmer — which is exactly the thing that makes the row hard.
    src:
      'struct Blob64 { u32 w[16]; };\nextern struct Blob64 makeblob(const void *);\n' +
      'extern const u8 gBlob[64];\nvoid stkextsret(void){ struct Blob64 b = makeblob(gBlob); }',
    features: [],
    toolchains: ['agbcc'],
    ctx: 'struct Blob64 { u32 w[16]; };\nstruct Blob64 makeblob(const void *);\nvoid stkextsret(void);',
    // The `ctx`'s declaration of `makeblob` as asmlift reads one out of a header
    // (`prototypesFromContext`): its parameter, and the struct it returns with that struct's members.
    proto: {
      makeblob: {
        params: ['const void *'],
        returns: 'struct Blob64',
        returnLayout: { kind: 'struct', members: [{ name: 'w', type: 'u32', dims: [16] }] },
      },
    },
  },

  // ═══ CountCollectedGems attribution rows (attr/countgems) ═══════════════════════════════════
  // Fourteen agbcc-only rows pinning the six capability gaps the CountCollectedGems attribution
  // names, plus one class that fell out of `nestacc`, each with its two-sided control where one
  // exists. `kleod:CountCollectedGems:agbcc` (retired 2026-09-13) was the highest-scoring non-matching kleod row —
  // `asmlift=diff:290 m2c=noncompile(1)`, 319 target lines against an 85-line reference — and a
  // cumulative ablation chain that walks its winner to the reference one spelling at a time reads
  // 290 → 184 → 159 → 58 → 40 → 36 → 50 → 0, the last step byte-exact. These rows are that chain's
  // links at minimal size. Scores are `pnpm bench run` numbers on this tree, not CLI predictions:
  //
  //   G4  gPtr->member[expr], VARIABLE index   pmarr1 5 → MATCH · pmarr2 9 → MATCH (CLOSED)
  //                                            pmarrrow MATCH   control pmarrfix MATCH
  //   G5  a named bitfield store of ZERO       bfzero 5             control bfconstn MATCH
  //   G2  loop accumulators as per-arm copies  nestacc 58 → 40 (per-arm half closed)
  //   G3  an accumulator's cross-loop home     sinkacc 17 → 4 (CLOSED; residual is width, not home)
  //   G6  the merged-tail store, LADDER form   armcb 32 → MATCH (CLOSED)  control armcb2 MATCH
  //   G1  branch sense per SITE, divergent     mixsense 20 → 10     control calad MATCH
  //   G1  branch sense per SITE, JOINED        joinsense 4 → MATCH  control joinsame MATCH
  //   --  switch recovered from a comparison LADDER   swladder 7  (m2c MATCH — a deficit row)
  //
  // THE FIRST BLOCKER OF EVERY ROW THAT DOES NOT MATCH. Each was named by INSTRUMENTING the site
  // (a temporary `console.error` in core, reverted — `git diff --quiet packages/core` before every
  // commit that carries a number from it) or by ABLATING it, never by reading and inferring, and a
  // gap whose first blocker turned out to be a pre-existing link says so rather than crediting it
  // to this family. That revert is also a COST gate, not only an honesty one: a full `pnpm bench
  // run` launched while core is instrumented burns one of the round's two ~1800 s runs and can
  // never be published (`provenance.ts:78-95` sticks a `dirty` flag on it), so assert the empty
  // `git status --short` immediately BEFORE the run, not at `bench:merge` time where the stamp
  // catches it too late to save the wall clock.
  //
  //  • `pmarr1` 5 — CLOSED: **MATCH**. The first blocker was `pointeeAccess`'s
  //    `if (pg.idx !== null) return null`, a VARIABLE index declining whatever it lands on (81
  //    firings on this row; 0 on `pmarrfix`, whose constant index never reaches that arm). It
  //    was never a ranked variation and a candidate cannot referee it: the asm SAYS which spelling
  //    produced it, because the member form materialises the member's base where the cast form
  //    folds the constant into the load's displacement. `structure/structure.ts` `pointeeElement`
  //    reads that channel (`off === 0`) as a per-site DEFAULT. `raise/globalshape.ts:679`'s
  //    `gaddr` root is NOT this row's blocker — it explains why the per-symbol stride licence
  //    (#143) never applies, which is a separate and here non-load-bearing fact.
  //  • `pmarr2` 9 — CLOSED: **MATCH**, and it took TWO links, not the one this note named.
  //    `ptrGlobalBase`'s `if (idx !== null) { ok = false; }` was the first (a second index term
  //    failed the base recognizer, 81 firings; terms now re-associate in visit order). The second
  //    is the RANK: this row's own header declares `u8 unk8[6][8]`, and the flat member spelling
  //    against it is not a fidelity nicety but a different program — agbcc strides the row a
  //    second time and truncates the resulting pointer to u8. That is why `SymbolStructField`
  //    gained `dims` inside this gap rather than in the symbol-map family; see below.
  //  • `bfzero` 5 — `structure/bitfields.ts`, the named-bitfield-store recognizer's `or`-only
  //    guard. It was looking for `or(and(load, keepMask), insert)`; agbcc compiles a ZERO insert to
  //    a bare `and` (`expmed.c:557-558`, `606-608` skip the `orr` when `all_zero`), so the guard
  //    refused before any field lookup: **89 firings on `bfzero`, 0 on `bfconstn`.** L2→L3
  //    recognizer. The all-zero form now folds, under the mask-evidence rule `bfzerohi` pins.
  //  • `nestacc` 58 → **40**, and the residual is a SECOND gap this row holds. G2 is two halves and
  //    the first is closed: the merge-param naming walk refused every carrier on the deciding
  //    liveness clause (`PARAMNAME REFUSE carrier=v6/v7/v8 preUpdate=false canTake=false
  //    why=write-pred`, 754·754·377 firings), and that clause was edge-blind — the edge it fired
  //    on hands the slot the merge itself, which under a shared name is `name = name`. The
  //    refusals are now `CARRIER_NAME_GATES` (`structure/structure.ts`), per
  //    `docs/level-tower.md:484-518`, so the ablation is a test and not a claim, and the exempted
  //    clause is `carrier-write`. Fan 20 → 10 (`/flip-join` stops producing a distinct tree).
  //    The 18 are the PER-ARM copies. The remaining 29 are the LOOP-CARRIED ones — `v6 = v2` at
  //    the outer-loop head and `v2 = v6` at its tail, three accumulators — and the source spelling
  //    that scores 11 is asmlift's own winner with `v6`/`v7`/`v8` deleted. Its first blocker is
  //    NOT this walk: with the interference rule made edge-aware the same way, `/merge-names`
  //    refuses one gate later on `loop-escape` (`structure/namecoalesce.ts`), which that file
  //    called blunter than the hazard it restates and which is in fact LOAD-BEARING — dropping it
  //    lets an inner loop's variable adopt the enclosing loop's carrier and overwrite it every
  //    iteration, so the function computes something else — frozen as IR in
  //    `core/test/loop-escape-witnesses.ts`, because the differential sweep cannot reach it. Taking
  //    the second half needs `carriesPreUpdate` lifted to name classes, which `namecoalesce.ts`
  //    already names as the work.
  //    The other door — waiving `enclosingNames` in the loop-header seeding — reaches 11 under a
  //    probe and would be a new ranked variation with the same soundness question.
  //  • `swladder` 7 — `structure/switch-recover.ts` recovers a `switch` from a comparison ladder
  //    with no gate on which the source wrote, though the target's own layout records it: a ladder
  //    interleaves test and body (`cmp #0x64; bne .L3` … body … `.L3: cmp #0x1e; bne`), a real
  //    `switch` front-loads both tests and sorts them ascending, and the two are DIFFERENT objects.
  //    No dual exists in the fan — 2 candidates, `unsigned: 7` and `signed: 7` — and `rank.ts:2261`
  //    says why in its own words: `/connective` is "NOT for the shared-arm spelling". The shipped
  //    model to copy is `StructureOptions.switchArmsFollowLayout` (`structure.ts:1024`,
  //    `target.ts:238`, set for agbcc at `:333`), which already reads exactly this evidence one
  //    question later — which ORDER the recovered arms go in.
  //  • `armcb` 32 — a TWO-LINK chain in `l3/unmerge.ts`, and the first link is the merge-temp
  //    count. `unmergeAt` is entered twice on this row and returns both times at `:203-204`
  //    (`else if (written.has(n)) return null`) on `v0`, because `v0` fails `:201`'s
  //    `m.assigns === 2` with FIVE assignments: instrumenting every `return null` in the file
  //    reads `AUDIT_AT_CALL armcb` ×2 and `AUDIT_WRITTEN armcb v0 assigns=5 reads=1 addrTaken=0`
  //    ×2, against 0 firings of `armDefs`' `:142`. So `armDefs` is never called here at all, and
  //    the SECOND link only becomes reachable once `:201` is widened: with `m.assigns >= 2` the
  //    same instrumentation reads `AUDIT_142_ATSIZE armcb 0 1` in each arm — `armDefs` refusing
  //    at `if (at.size !== names.size)` with `at.size` 0 against `names.size` 1, because a
  //    ladder's else-arm is a single nested `if` and the arm scan does not search it. Widening
  //    `:201` ALONE therefore leaves the fan byte-identical (`diff:32` unchanged, `armcb2` still
  //    MATCH) — which is a fact about the SECOND link, not evidence that `:201` is innocent. The
  //    variation exists and the control `armcb2` MATCHes THROUGH it, so this 32 is the LADDER
  //    admission and not a missing rewrite. L3 pre-respell variation (`/unmerge`, `PRE_RESPELL_VARIATIONS`).
  //    The row's own winner is `unsigned/flip-join` at 32 in a fan of 8 — see the G1 watch below.
  //    **CLOSED: MATCH on `unsigned/unmerge/offmember`**, fan 8 → 14. `pushJoin` recurses into
  //    every TERMINAL arm of the ladder and the arity gate becomes "at least twice", carried by
  //    totality (every assignment in the function is one of the arms just rewritten) plus a fresh
  //    re-read of the result — because `localMentions` is sampled before any rewriting and this
  //    pass duplicates statements, so a stale count and the arm count can agree by coincidence.
  //    Corpus REACH is four rows and only four — `armcb`, `maskchain`, `sxparam` and
  //    `kleod:CountCollectedGems:agbcc`. THE PRICE IS PER-ROW. Measured at the CLI's own
  //    `enumerate` wrapper, both sides, with `origin/main`'s `unmerge.ts` swapped in for the
  //    before:
  //      armcb 8 → 14 · armcb2 (the control) 14 → 14 · maskchain 24 → 32 · sxparam 2 → 4
  //      kleod:CountCollectedGems:agbcc 3072 → 5952 (+2880, +94 %), 58.3 s → 81.5 s wall (+40 %)
  //    AN OFFLINE CENSUS DOES REPRODUCE THE REAL TIER, but only with the row's own provisioning:
  //    hand `enumerateCandidates` the case's `symbols` (the vendored map, `asIfUndecompiled`), its
  //    `proto`, and the `asmData` side table off the built target's object, exactly as
  //    `eval/asmlift.ts` does. Under-provision any of the three and the census reads 2.6× low.
  //    The pole, same rig, enumeration only (no candidate compiles, so this is NOT the 1549 s
  //    benchmark row): `kleod:ProcessInputAndUpdateEntities:agbcc` enumerates **77760 either
  //    way** — unmoved by the variation, which is the claim that matters. So the honest price is
  //    per-row: the corpus's second-heaviest agbcc row pays +94 % candidates for a candidate that
  //    correctly loses.
  //    AND THE REAL ROW DOES NOT MOVE, which is this gap's pass: G6 alone makes the source WORSE
  //    (the winning spelling plus `/unmerge` costs more than the winner), so its candidate is
  //    enumerated and correctly loses. `kleod:CountCollectedGems:agbcc` 171 → 171, same winner's
  //    variations.
  //  • `sinkacc` 17 → **4, CLOSED**, and the L3 attribution above it was a true observation with a
  //    false conclusion attached. The fan dump was right — 36 candidates, winner
  //    `unsigned/reread-globals/uns-cmp` at 17, not one of the 36 carrying `sinkinit` or
  //    `basefold` — and `l3/sinkinit.ts:37` does report `moved=1` here. But that pass moves only
  //    POINTER-BASE inits and emits no candidate on this row either way, so it never owned the
  //    gap. The site is two levels up: `raise/const.ts` `recognizeConsts`, the always-on L1 fold
  //    for a RISC two-instruction 32-bit literal, folding `add(%s = const 0, const 1)` to
  //    `const 1` and deleting the accumulator. The machinery to spell the hoisted init was already
  //    SHIPPED — the `/merge-home` variation — and simply never enumerated: `hasMergeFeedHome` reads
  //    false at baseline and true the moment the fold is refused, so the whole sub-fan was absent
  //    (NO REACH, not LOSES). Refusing it: fan 36 → 54 with the top six all `/merge-home`, and the
  //    winner becomes the reference spelling. `/defsite` and `/loop-entry` ride along on the real
  //    row, unreachable for the same upstream reason and never attributed to it.
  //    The residual 4 is the DECLARATION, not the home: the reference declares `u8 s` where the
  //    winner declares `s32` and casts at each update — the `#154` width/rank family.
  //    Two-sided control, and it is not an agbcc row: `synthetic:fib:gcc2.7.2kmc` fires the same
  //    refusal and reads `diff:12` either way, so the rule is compiler-neutral rather than an
  //    agbcc special case. Corpus reach, censused before any row was measured: 4 rows of the 806
  //    that lift.
  //    WHAT THE REACH CENSUS DOES NOT SAY IS THE COST. THREE of those rows now enumerate variations they
  //    could not before, and pay for them: `sinkacc` enumerates 36 → 54 candidates and
  //    `kleod:CheckWorldCompletion:agbcc` 2.69x as many (312 → 840 through a bare
  //    `enumerateCandidates`, 624 → 1680 through the runner, which sees more options — the RATIO is
  //    what reproduces), roughly 2x the wall clock on each real row. The fourth reached row, the
  //    `fib` control above, pays NOTHING — 8 → 8 candidates, the same eight names, winner already
  //    `signed/defsite/loop-entry` at 12 on main (measured on both trees) — so it is a reached row
  //    and not a paying one. Bounded to 4 rows today, but the triggering shape is
  //    `s = 0; ... if (c) s += 1;`, which is ordinary C, so a dogfooded project function is likely
  //    to hit it — and candidate compiles have no timeout. `l3/hoist.ts`'s `isBaseInit` is still NOT
  //    the place to widen — level-tower names that exact widening as the trap, since it is the sole
  //    definition of where the base-init run ends and `l3/basecse.ts` re-orders off it.
  //    Two things the refusal cannot be read without. (1) It carves out the pass's OWN clientele:
  //    mwcc shares a `lis` across a branch, so a genuine hi/lo pair arrives edge-carried and
  //    `raise/const.ts` recognises the pair positively and folds it anyway. (2) A refused pair
  //    would otherwise PRINT as `v = 0 + 1;` in every candidate that did not take `/merge-home` —
  //    score-neutral, so no gate sees it — and is re-folded at the structurer's rendering site.
  //  • `mixsense` 20 — `preserveDivergentBranchSense`: ONE boolean per FUNCTION, so the variation flips
  //    every divergent `if` at once. Fan of literally two, `unsigned: 20` and
  //    `unsigned/flip-branch: 27`; the row's REFERENCE SOURCE, compiled against this row's own
  //    target, is 0 — byte-exact, as a reference must be. So no per-function value of the boolean
  //    can reach the target.
  //    CLOSED, and the residual re-attributed: `/site-sense` takes it to **10**, and 10 is the
  //    floor of the whole 2^4 per-site enumeration (`ASMLIFT_PERSITE_SENSE=4`, whose 16 candidates
  //    run 10 · 14 · 16 · 18 · 19 · 20 · 22 · 23 · 23 · 24 · 27 · 27 · 28 · 29 · 31 · 33). So the
  //    sense is spent here. The 10 is the spelling of the BASE: asmlift's winner hoists
  //    `p0 = (u8 *)&gGrid; p0[6]` where the reference writes `gGrid[0][6]`, and the same control
  //    structure hand-written with the subscripts scores 0 — a `basecse`/`hoistBaseLocals`
  //    question, and note that `calad` MATCHES with the identical hoist, so it is not the hoist
  //    itself.
  //  • `joinsense` 4 — the JOINED twin, `negateJoinedBranchSense`. The boolean scores 4 at EITHER
  //    value (`unsigned/unmerge: 4` and `unsigned/flip-join/unmerge: 4`) — right at one site
  //    whichever way it goes — and hand-writing asmlift's own winner with only the second site
  //    dualized is byte-exact. The real row wins on `/flip-join`, the boolean `mixsense` never
  //    enumerates, so a family filed against `/flip-branch` alone would gate half of G1.
  //    CLOSED: **MATCH** on `unsigned/site-sense/unmerge`.
  //
  // THE FIVE CONTROLS, and what each one proves. Every one MATCHes, and every one was aggravated
  // until the score moved, which is the only reason its partner's number means anything:
  // `pmarrfix` (the same member at a CONSTANT index — so G4 is the variable index, not the member
  // spelling; it carries the rank-2 map too and stayed MATCH through the whole change, which is
  // what says the rank did not move the constant-offset spelling), `bfconstn` (the same store with
  // a NONZERO value — so G5 is the mask materialisation,
  // not "a named bitfield store"), `armcb2` (the same store with TWO arms — so G6 is the ladder,
  // not the rewrite; now that G6 is closed it controls for the TWO-ARM path staying byte-identical
  // through the recursion that generalised it — `unsigned/unmerge/offmember`, unmoved), `calad`
  // (ONE ladder — so G1 is the MIX of senses, not the ladder), and
  // `joinsame` (the same two joined `if`s in the SAME sense).
  //
  // WHAT GOT NO ROW, AND WHY — as much a part of this family as the rows:
  //  • G6's leaf-sharing half. Duplicating the fall-through leaf into the last `else` is
  //    BYTE-IDENTICAL at every minimal size measured (agbcc cross-jumps it back together), so the
  //    store-placement term carries the whole cost and a one-term row measures the right sign.
  //    Falsifier: grow the arm bodies until agbcc stops cross-jumping; if the duplicated leaf ever
  //    costs rows, that size is the row.
  //  • G3's SECOND half — placing the synthesised `s = 0` among the other scalar inits. Worth 8 of
  //    `sinkacc`'s 17 (four hand-written orders of the hoisted form score 4 · 12 · 4 · 6, and the
  //    first two have IDENTICAL declarations), and it cannot have a row today: where the target HAS
  //    instructions for its inits, asmlift already reproduces their order (three orders of three
  //    live scalar inits → three distinct agbcc objects, asmlift emits each target's own). The
  //    unowned question is the position of an init the target contains NO instruction for, which
  //    only exists once G3's first half is built. A G3 change's acceptance must NAME the order it
  //    emits. NAMED, now that the first half is built: the winner emits `v0 = 0; v2 = 0; v1 = 0;`
  //    — the accumulator, then the sum, then the loop counter, which is the reference's own
  //    `s = 0; t = 0;` with the `for`'s `i = 0` last. So the position of the synthesised init is
  //    already right and no second change is owed; the whole residual 4 is the width family.
  //  • Rank-2 array recovery / `SymbolStructField`'s missing `dims`. **THIS ENTRY WAS WRONG AND IS
  //    RETRACTED.** It said the two spellings are one object and the rank is a fidelity item for
  //    the symbol-map family that no row here can gate. `gBlob->unk8[j + (i * 8)]` and
  //    `gBlob->unk8[i][j]` are byte-identical only when the DECLARATION FOLLOWS THE SPELLING —
  //    which it does here, because the candidate self-declares from the map, and does NOT in the
  //    real tier, which compiles it against the project's own header. Measured against a FIXED
  //    `u8 unk8[6][8]` header, the flat spelling strides the row a second time and truncates a
  //    pointer to `u8`: a different program that happens to compile. So the rank is INSIDE this
  //    gap, `pmarr2` gates it (its map now states `[6, 8]`), and shipping the member spelling
  //    without it makes candidates stop compiling wholesale rather than score worse.
  //    (Both riders stand: `(i * 8) + j` is a DIFFERENT object, and no base-home spelling reaches
  //    the rank-2 target.)
  //  • Register allocation (58 of the real row's 117 `arg-mismatch` rows are register-only, and the
  //    chain reaches 0 without touching one), `/reread-globals`, a `u8` local declared `s32` with a
  //    cast at each use, a function pointer stored through a struct member array, and `x &= 0x80`
  //    against `x = 128 & x` — every one REFUTED at 0 rows by compiled pairs, in the full function
  //    and standalone.
  //  • The short-circuit fold / tail-duplication class belongs to the `llcmp` family, not here.
  //    Predicted from a file swap while that work was unmerged, and now CONFIRMED against the
  //    merged pass: rebased onto it, `kleod:CountCollectedGems:agbcc` reads diff:290 exactly and
  //    all fourteen rows below read their published scores unmoved, while `synthetic:llcmp:agbcc`
  //    is the MATCH that work bought. The fold is a connected channel that pays nothing here.
  //
  // ACCEPTANCE, so a later change is not scored against a bar these rows do not set. Measured by
  // hand-editing asmlift's own winner, one capability at a time, and RE-TAKEN through the row's
  // own scorer (the harness's `Toolchain.score` against the row's own target object, which
  // reproduces the published `diff:58` exactly on asmlift's unedited winner): closing G2 takes
  // `nestacc` to **11**, NOT to 0. G2 therefore owns 47 of the 58, and the residual 11 is 7 +
  // 4 — deleting `v6`–`v11` and nothing else scores 11 (`rows 54, none 43`), and additionally
  // replacing asmlift's recovered `switch` with the source's `if/else if` ladder scores 4
  // (`rows 52, none 48`, every differing row an `arg-mismatch`). So 7 is `swladder`'s class and
  // 4 is register/operand noise. Hoisting `sinkacc`'s init takes it to 4 across four declaration
  // orders, the residual an r5/r6 swap. `pmarr1` could be closed from either end — at rank 1
  // `gBlob->unk8[i]`, `p = (u8 *)gBlob + 8; p[i]` and `p = gBlob->unk8; p[i]` are ONE object — but
  // `pmarr2` only by the member spelling. Both are CLOSED, by the member spelling.
  // PREDICTIONS, each with the command that falsifies it, and the G1 pair was
  // RUN: a per-SITE sense takes `mixsense`'s fan from 2 to 16 (`ASMLIFT_PERSITE_SENSE=4`) and
  // `joinsense` to 0 — both held — while `mixsense`'s score prediction of 0 was WRONG at 10, the
  // whole enumeration's floor, and the 10 is the spelling of the base (see the row above). A recursive arm
  // search in `armDefs` taking `armcb` to MATCH is still unrun. Read by
  // `ASMLIFT_CANDCACHE=0 pnpm bench run --tier synthetic --only <sym> --toolchain agbcc --serial`
  // on the branch carrying the change. ZERO-FLIP WATCH for whoever builds G1. Of the fourteen rows this family
  // adds, `armcb` also wins on `/flip-join`
  // (fan of 8, the top three all `/flip-join` at 32 against 35 for the non-flip ones), so a G1
  // change must re-check `armcb` even though it is filed under G6 — re-checked when `/site-sense`
  // shipped, and it holds at 32 on `unsigned/flip-join`. No other new row wins
  // on a flip variation — `joinsense`/`joinsame` win on `/unmerge` and `mixsense` on plain `unsigned`.
  // Over the committed artifact: 17 rows have a winner
  // carrying `flip-join`/`flip-branch`, on FOUR toolchains, and 5 of the 17 MATCH — TWO of
  // those five REAL (`kleod:ProcessHBlankWait:agbcc`, `kleod:UpdateHUDCounterDisplay:agbcc`), the
  // other three `synthetic:ifand_far:agbcc`, `synthetic:ifor_near:agbcc` and
  // `synthetic:ifor_near:mwcc_242_81`. Recompute the set by filtering `results.json` on
  // `asmlift.winnerVariations` matching `(^|/)(flip-join|flip-branch)(/|$)`. For G2 the exposure is
  // the 9 MATCHing `nested-loop` rows — all synthetic, all agbcc, all the DMA/`livebase` poll
  // family — plus `fib`, `nestedloop` and `sumto`.
  //
  // M2C, and the deficit stated rather than avoided. Both tools get the SAME information — `ctx`
  // with named parameters, `proto` for `returnsVoid` and callee arities, and the same symbol map
  // where a row has one. m2c was AHEAD on three rows; it is now ahead on ONE. `pmarr1` and
  // `pmarr2` are TIES (both tools MATCH) and `swladder` is the remaining deficit (m2c emits the
  // ladder). Worth recording HOW m2c matched `pmarr2`: off the flat map it emitted
  // `gBlob->unk8[j + (i * 8)]`, byte-exact and type-checking only because the candidate
  // self-declares — the same spelling against this row's real `u8 unk8[6][8]` header is a
  // different program. That is exactly the trap the rank gate exists to stop, and m2c walked into
  // it and got away with it because the synthetic harness lets a candidate bring its own
  // declaration.
  // The two `noncompile(1)`s are m2c's own and NOT context withheld from it: on the identical
  // rendered ctx, which names every bitfield (`struct Flags { u32 unk0_0 : 4; u32 unk0_4 : 4; … }`),
  // m2c emits `gFlags &= -0x10;` for `bfzero` and `gFlags = (-0x10 & gFlags) | 4;` for `bfconstn`
  // — word arithmetic applied to a struct OBJECT, which no C compiler accepts — while asmlift
  // spells `gFlags.unk0_0 = 4;` from the same map. The map is what makes m2c noncompile there —
  // map-LESS it compiles `bfconstn` at diff:5, and asmlift's CONTROL drops to diff:5 with it — so
  // both configurations were measured and the trade is recorded at `PROBE_FLAG_MAP` itself rather
  // than left for a reader to discover. `pmarrfix` is a TIE — m2c matches it too, off the same
  // rendered map. Everything else is `declined(1 gap(s))`.
  //
  // Every row's authored `features` carries JUDGEMENT tags only — `loop`, `nested-loop`,
  // `short-circuit` and `call` are DERIVED per row by the evaluator and authoring them fails
  // `apps/benchmark/test/features.test.ts`. `armcb` does NOT claim `fnptr`: the tag's floor
  // (apps/benchmark/src/cases/features.ts) wants an indirect CALL in the row's assembly and this
  // row only STORES a code address, the way `arrcast` records its dropped `variable-index`.
  // `swladder` carries `branch` alone for the same reason — `switch-arms`' floor is `/\bswitch\s*\(/`
  // over the BODY, which an if/else ladder fails by construction. No new `FeatureDef` was needed.
  //
  // ALL FOURTEEN ARE agbcc-ONLY, and the MEASURED reason is narrower than "every target is agbcc
  // codegen": each row was smoked on agbcc alone, and a candidate compile has no timeout, so no
  // row gets a toolchain nobody individually smoked. Three of the six gaps are named at
  // toolchain-GENERIC sites — `structure/structure.ts:440` (`pointeeAccess`, G4), the merge-param
  // naming walk at `structure/structure.ts:2190-2250` (G2) and `structure/switch-recover.ts` (the
  // ladder class) — none of them gated the way `target.ts:333/:335` gates
  // `switchArmsFollowLayout` and `arrayShapeFromStride` for agbcc. So "agbcc-only" is a SMOKE
  // decision on those three, not a claim that the capability is agbcc-shaped, and whether they
  // move on another backend is an UNTESTED question.
  //
  // The cheapest twin was authored and smoked rather than argued about, and it DOES NOT EARN A
  // ROW: `nestacc` on `mwcc_242_81` (the most toolchain-neutral of the six blockers) runs in
  // 0.8 s with no hang and reads `asmlift=declined(1 gap(s)) m2c=declined(1 gap(s))`, the gap
  // being `lift: cannot lift 'nestacc': 'lis' at 0x0 carries a data relocation ('gGrid') — the
  // printed immediate is a link-time placeholder, not the value`. That is a PPC-frontend
  // relocation gap and a pre-existing link, so committing the twin would credit this family with
  // a decline it does not own and gate nothing about G2. Re-run it with
  // `--tier synthetic --only nestacc --toolchain mwcc_242_81 --serial` on a branch that closes
  // that frontend gap, and the twin becomes worth authoring.
  //
  // SMOKE RECIPE for one row, and what `ASMLIFT_CANDCACHE=0` is actually for:
  //
  //   ASMLIFT_CANDCACHE=0 pnpm bench run --tier synthetic --only <sym> --toolchain agbcc --serial
  //
  // It makes a one-row smoke DETERMINISTIC and independent of whatever a neighbouring worktree
  // has left in the shared store — that is the whole reason, and it is not a correctness
  // requirement: all fourteen rows were re-run on the DEFAULT cache-ON path and every score
  // reproduced identically, with no stall. The store's own prune is bounded at its site:
  // `packages/cli/src/candcache.ts` gives `pruneOnce` a wall-clock budget and prints one line
  // before it starts, so an over-cap store is not mistaken for a hang. Before a full `pnpm bench run`, check the store with `du -sh
  // $TMPDIR/asmlift-candcache` rather than pre-emptively disabling the cache.
  //
  // `--only armcb` runs TWO cases: the filter is a SUBSTRING match
  // (`apps/benchmark/src/cases/synthetic.ts:50`, `s.sym.includes(filter.only)`), so it takes
  // `armcb2` with it.
  {
    sym: 'pmarr1',
    src:
      'struct Blob { u8 unk0; u8 unk1; u8 unk2; u8 unk3; u8 unk4; u8 unk5; u8 unk6; u8 unk7; u8 unk8[48]; s32 unk38; };\n' +
      'extern struct Blob *gBlob;\n' +
      'u8 pmarr1(s32 i){ return gBlob->unk8[i]; }',
    features: ['global', 'pointer', 'array', 'struct', 'variable-index'],
    toolchains: ['agbcc'],
    ctx: 'u8 pmarr1(s32 i);',
    symbols: PROBE_BLOB_MAP,
  },
  {
    // TWO facts in one row, and they are an ordered pair. The base decomposition has to admit a
    // SECOND variable index term (agbcc computes `j + (i * 8)` into one register before adding it
    // to the pointee's base), and the member spelling has to split that residual back along the
    // rank `PROBE_GRID_MAP` states — `gBlob->unk8[i][j]`. The flattened spelling
    // `gBlob->unk8[j + (i * 8)]` is byte-exact against this target and is how m2c matches it off a
    // flat map, but it does not type-check against this row's own `u8 unk8[6][8]` header, which is
    // the difference the real tier charges for. `(i * 8) + j` is a different object again, so the
    // term ORDER is load-bearing on top of both.
    sym: 'pmarr2',
    src:
      'struct Blob2 { u8 unk0; u8 unk1; u8 unk2; u8 unk3; u8 unk4; u8 unk5; u8 unk6; u8 unk7; u8 unk8[6][8]; s32 unk38; };\n' +
      'extern struct Blob2 *gBlob;\n' +
      'u8 pmarr2(s32 i, s32 j){ return gBlob->unk8[i][j]; }',
    features: ['global', 'pointer', 'array', 'struct', 'variable-index'],
    toolchains: ['agbcc'],
    ctx: 'u8 pmarr2(s32 i, s32 j);',
    symbols: PROBE_GRID_MAP,
  },
  {
    sym: 'pmarrfix',
    src:
      'struct Blob3 { u8 unk0; u8 unk1; u8 unk2; u8 unk3; u8 unk4; u8 unk5; u8 unk6; u8 unk7; u8 unk8[6][8]; s32 unk38; };\n' +
      'extern struct Blob3 *gBlob;\n' +
      'u8 pmarrfix(void){ return gBlob->unk8[5][7]; }',
    features: ['global', 'pointer', 'array', 'struct'],
    toolchains: ['agbcc'],
    ctx: 'u8 pmarrfix(void);',
    symbols: PROBE_GRID_MAP,
  },
  {
    // The rank-2 member reached by ONE flat counter — the arm `pmarr1` and `pmarr2` between them
    // do not enter. `pmarr1`'s member is rank 1, so its residual never meets the subscript split
    // at all; `pmarr2`'s residual carries a term at the row stride, so the split RECOVERS a row.
    // Here nothing rides the 8-byte stride and the leading subscript comes out the literal `0`
    // (`subscriptsFromExtents`, `needRecovered = false`) — the one behaviour where the member path
    // and the global path deliberately differ, and until this row it was pinned only by a unit
    // assertion. A global with no term to recover already spells the same address flat and refuses
    // the split; a MEMBER of a rank its project's header declares has no flat form to fall back
    // to, so `->unk8[0][k]` is spelled or the honest cast form stands.
    //
    // The differ is what makes it a referee: the two spellings are NOT one object. `->unk8[0][k]`
    // materialises the member's base (`add r1, r1, #0x8` · `add r1, r1, r0` · `ldrb r0, [r1]`)
    // where the cast form `*((u8 *)gBlob + 8 + k)` folds the constant into the load's displacement
    // (`add r0, r0, r1` · `ldrb r0, [r0, #0x8]`). Ablate the `needRecovered = false` and the row
    // takes the cast form and scores diff:5 — measured, by making the member path refuse exactly
    // as the global path does and re-running.
    //
    // Its real-tier inhabitant was `kleod:CheckWorldCompletion:agbcc` (retired 2026-09-13), whose reference spells a
    // nested `gUnk_03004670->unk8[var_r0][var_r2]` that agbcc collapsed into one flat counter
    // before the add. `k` there runs 0..47 through a declared row of 8, which is out of bounds and
    // byte-identical — the same object, as this row's own MATCH shows, and the only spelling that
    // type-checks against the project's `u8 unk8[6][8]`.
    sym: 'pmarrrow',
    src:
      'struct Blob2 { u8 unk0; u8 unk1; u8 unk2; u8 unk3; u8 unk4; u8 unk5; u8 unk6; u8 unk7; u8 unk8[6][8]; s32 unk38; };\n' +
      'extern struct Blob2 *gBlob;\n' +
      'u8 pmarrrow(s32 k){ return gBlob->unk8[0][k]; }',
    features: ['global', 'pointer', 'array', 'struct', 'variable-index'],
    toolchains: ['agbcc'],
    ctx: 'u8 pmarrrow(s32 k);',
    symbols: PROBE_GRID_MAP,
  },
  {
    sym: 'bfconstn',
    src:
      'struct Flags { u8 unk0_0 : 4; u8 unk0_4 : 4; s8 unk1; u8 unk2; u8 pad3; };\n' +
      'extern struct Flags gFlags;\n' +
      'void bfconstn(void){ gFlags.unk0_0 = 4; }',
    features: ['global', 'struct', 'bitfield'],
    toolchains: ['agbcc'],
    ctx: 'void bfconstn(void);',
    proto: { bfconstn: { returnsVoid: true } },
    symbols: PROBE_FLAG_MAP,
  },
  {
    // The LOW nibble deliberately: the DECLARED store's keep mask is computed in the 32-bit
    // domain as -16 (0xFFFFFFF0), which no Thumb `mov` encodes, so agbcc materialises it with
    // `mov #0x10; neg` — every BYTE-domain spelling narrows the same mask to one encodable
    // `mov #0xF0`, so no raw spelling reaches this target. The HIGH nibble's twin
    // (`gFlags.unk0_4 = 0;` vs `*(u8 *)&gFlags = 15 & *(u8 *)&gFlags;`) is BYTE-IDENTICAL, so the
    // gap is the mask materialisation and not "a named bitfield store of zero" as such.
    sym: 'bfzero',
    src:
      'struct Flags { u8 unk0_0 : 4; u8 unk0_4 : 4; s8 unk1; u8 unk2; u8 pad3; };\n' +
      'extern struct Flags gFlags;\n' +
      'void bfzero(void){ gFlags.unk0_0 = 0; }',
    features: ['global', 'struct', 'bitfield'],
    toolchains: ['agbcc'],
    ctx: 'void bfzero(void);',
    proto: { bfzero: { returnsVoid: true } },
    symbols: PROBE_FLAG_MAP,
  },
  {
    // THE HIGH NIBBLE, and its VALUE IS THE GATE, NOT THE SCORE — it MATCHes either way. `bfzero`
    // is the row the all-zero bitfield-store fold closed; this is the population that fold must
    // REFUSE. Here the declared store's complement is `~0xF0` narrowed to the byte, one encodable
    // `mov r0,#0xf` — exactly what the raw `*(u8 *)&gFlags = 15 & *(u8 *)&gFlags;` compiles to, so
    // the two spellings are ONE OBJECT and the raw spelling matches. A recognizer keyed on "the
    // assigned value is 0" rather than on the keep mask's materialisation would name the member
    // here with no byte evidence, over half the population of 4/4-split cells, and would still
    // show MATCH; the refusal itself is pinned by `bitfield-members.test.ts` ('REFUSES the HIGH
    // nibble') and this row is what holds it against a real compile.
    // (`--only bfzero` matches this row too, by substring: expect [1/2].)
    sym: 'bfzerohi',
    src:
      'struct Flags { u8 unk0_0 : 4; u8 unk0_4 : 4; s8 unk1; u8 unk2; u8 pad3; };\n' +
      'extern struct Flags gFlags;\n' +
      'void bfzerohi(void){ gFlags.unk0_4 = 0; }',
    features: ['global', 'struct', 'bitfield'],
    toolchains: ['agbcc'],
    ctx: 'void bfzerohi(void);',
    proto: { bfzerohi: { returnsVoid: true } },
    symbols: PROBE_FLAG_MAP,
  },
  {
    // THE STRADDLING FIELD, a WIDTH row rather than a mask row. `unk0_c` occupies bits 12-19 of
    // the word: no aligned halfword contains them, so agbcc reaches the field with a WORD
    // read-modify-write even though the field's byte SPAN is 2. The recognizer's store-width rule
    // is therefore expressed in the field's bit WINDOW — "the narrowest aligned cell that holds
    // it" — and not in the map's `size`, which for this field names an access the machine does not
    // have. `bfzerohi` pins what the fold must REFUSE; this one pins the width it must ADMIT.
    sym: 'bfstraddle',
    src:
      'struct Span { u32 unk0_0 : 12; u32 unk0_c : 8; u32 unk0_14 : 12; };\n' +
      'extern struct Span gSpan;\n' +
      'void bfstraddle(u32 v){ gSpan.unk0_c = v; }',
    features: ['global', 'struct', 'bitfield'],
    toolchains: ['agbcc'],
    ctx: 'void bfstraddle(u32 v);',
    proto: { bfstraddle: { returnsVoid: true } },
    symbols: PROBE_SPAN_MAP,
  },
  {
    sym: 'nestacc',
    src:
      'extern u8 gGrid[5][7];\n' +
      's32 nestacc(void){\n' +
      '  u8 a; u8 b; u8 c; u8 i; u8 j;\n' +
      '  a = 0; b = 0; c = 0;\n' +
      '  for (i = 0; i < 5; i++) {\n' +
      '    for (j = 0; j < 7; j++) {\n' +
      '      if ((gGrid[i][j] & 0x7F) == 0x64) { a += 1; }\n' +
      '      else if ((gGrid[i][j] & 0x7F) == 0x1E) { b += 1; }\n' +
      '      if (gGrid[i][j] & 0x80) { c += 1; }\n' +
      '    }\n' +
      '  }\n' +
      '  return a + b + c;\n' +
      '}',
    features: ['array', 'global', 'branch', 'mask', 'value-home'],
    toolchains: ['agbcc'],
    ctx: 's32 nestacc(void);',
  },
  {
    // `nestacc` does NOT isolate G2: 7 of its 58 rows are a SECOND gap, and this row is it.
    // Re-scoring the attribution's own two hand-written ablations — identical but for the
    // dispatch spelling — gives 11 for the `switch` and 4 for the `if`/`else if` ladder. This row
    // is that difference alone: agbcc lays the ladder's test and body out interleaved
    // (`cmp #0x64; bne .L3` … body … `.L3: cmp #0x1e; bne .L4`) while the same source spelled as a
    // real `switch` front-loads both tests and sorts them ascending — so the target's own
    // assembly records which one was written.
    //
    // CLOSED, and not by a ranked candidate: no alternative spelling was ever enumerated here (the
    // fan was 2, both the `switch`, and `/connective` in rank.ts is explicitly "NOT for the
    // shared-arm spelling"), so there was nothing for the differ to referee. What closed it is
    // `switch-recover.ts`'s PRE5 / `TargetDescription.switchRequiresFrontLoadedTests`, reading the
    // layout back per SITE — the model this comment already named, `switchArmsFollowLayout`, one
    // question earlier. `swmixed` below is the per-site guard, and `nestacc` above collects the 6
    // of its own that this row isolates.
    sym: 'swladder',
    src:
      's32 swladder(s32 x){\n' +
      '  s32 a;\n' +
      '  a = 0;\n' +
      '  if (x == 100) { a = 1; }\n' +
      '  else if (x == 30) { a = 2; }\n' +
      '  return a;\n' +
      '}',
    features: ['branch'],
    toolchains: ['agbcc'],
    ctx: 's32 swladder(s32 x);',
  },
  {
    // ONE FUNCTION, BOTH SPELLINGS — the row that pins the reading as PER SITE. PR #120 paid for
    // the general form of this: a per-FUNCTION predicate cannot decide a per-SITE question, and a
    // function-wide OR would spell both dispatches the same way and be wrong on one of them by
    // construction. Here the `switch` on `y` is front-loaded and the ladder on `x` is interleaved,
    // so the two sites must come back differently spelled from one lift.
    //
    // IT IS ALSO THE OVER-FIRING CONTROL. A gate that declined every comparison tree would
    // close `swladder` and take this row's `switch (y)` with it, so the row stops matching the
    // moment the reading widens past the sites whose layout earns it. (A row whose whole body
    // is one front-loaded `switch` cannot serve: with two or three arms this small agbcc folds
    // `case k: a = 1` into `a = x == k` and Regime A never runs — both spellings then score 8,
    // measured, and the row would be a control over nothing.)
    sym: 'swmixed',
    src:
      's32 swmixed(s32 x, s32 y){\n' +
      '  s32 a;\n' +
      '  a = 0;\n' +
      '  switch (y) { case 1: a = 10; break; case 2: a = 20; break; case 3: a = 30; break; }\n' +
      '  if (x == 100) { a = 1; }\n' +
      '  else if (x == 30) { a = 2; }\n' +
      '  return a;\n' +
      '}',
    features: ['branch'],
    toolchains: ['agbcc'],
    ctx: 's32 swmixed(s32 x, s32 y);',
  },
  {
    sym: 'armcb',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'extern u8 gGrid[5][7];\n' +
      'extern void (*gSlot[10])(void);\n' +
      'void armcb(void){\n' +
      '  if (gGrid[0][0] == 0x7F) { gSlot[1] = fnA; return; }\n' +
      '  else if (gGrid[0][1] == 0x7F) { gSlot[1] = fnA; return; }\n' +
      '  else if (gGrid[0][2] == 0x7F) { gSlot[1] = fnA; return; }\n' +
      '  else if (gGrid[0][3] == 0x7F) { gSlot[1] = fnA; return; }\n' +
      '  gSlot[1] = fnB;\n' +
      '}',
    features: ['array', 'global', 'branch', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void armcb(void);',
    proto: {
      armcb: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
  },
  {
    // The CONTROL for `armcb`: the same per-arm store with TWO arms instead of a five-arm ladder.
    // `l3/unmerge.ts` enumerates and MATCHes here, so `armcb`'s 32 is the LADDER admission and not
    // a missing rewrite. agbcc cross-jumps both arms' stores into one, so each target has exactly
    // one `str` and the per-arm evidence survives only in the literal-pool islands.
    sym: 'armcb2',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'extern u8 gGrid[5][7];\n' +
      'extern void (*gSlot[10])(void);\n' +
      'void armcb2(void){\n' +
      '  if (gGrid[0][0] == 0x7F) { gSlot[1] = fnA; return; }\n' +
      '  gSlot[1] = fnB;\n' +
      '}',
    features: ['array', 'global', 'branch', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void armcb2(void);',
    proto: {
      armcb2: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
  },
  {
    sym: 'sinkacc',
    src:
      'extern u8 gGrid[5][7];\n' +
      's32 sinkacc(void){\n' +
      '  u8 s; u8 i; s32 t;\n' +
      '  s = 0; t = 0;\n' +
      '  for (i = 0; i < 20; i++) { t += gGrid[0][i & 6]; }\n' +
      '  if ((gGrid[0][0] & 0x7F) == 0x1E) { s += 1; }\n' +
      '  if ((gGrid[0][1] & 0x7F) == 0x1E) { s += 1; }\n' +
      '  return s + t;\n' +
      '}',
    features: ['array', 'global', 'branch', 'mask', 'value-home'],
    toolchains: ['agbcc'],
    ctx: 's32 sinkacc(void);',
  },
  {
    // THE ESCAPING NARROW (rank.ts `/escape-home`): a `u16` local assigned a call's result inside
    // the inner loop, then read by the outer latch and by the return — two blocks, neither the one
    // that narrowed. agbcc narrows at the assignment (`lsls`/`lsrs` into a register, inside the
    // loop) and both later blocks read that register; the default spelling has no name there and
    // writes `(u16)` out again at each reader, for 5/23.
    //
    // THE NARROW LOCAL IS WHAT PUTS THE SHAPE HERE, measured rather than assumed: spelled `s32 v`
    // with the casts at the two readers, the same function compiles with the `lsls`/`lsrs` AFTER
    // the loop, in the latch block that also tests it — consumed at home, and out of this scope.
    // The corpus's other inhabitants are all real rows, so without this one a refactor that loses
    // the scope fails nothing local.
    sym: 'esccast',
    src:
      'extern s32 poll(u16 i);\n' +
      's32 esccast(void){\n' +
      '  u16 v; u32 n; u32 i;\n' +
      '  n = 0;\n' +
      '  do { i = 0; do { v = poll((u16)i); i = i + 1; } while (i <= 63); } while (v != 0 && n++ <= 9);\n' +
      '  return v;\n' +
      '}',
    features: ['value-home'],
    toolchains: ['agbcc'],
    ctx: 's32 poll(u16 i); s32 esccast(void);',
    proto: { poll: { params: 1 } },
  },
  {
    sym: 'calad',
    src:
      'extern u8 gGrid[5][7];\n' +
      'extern void fn0(void); extern void fn1(void); extern void fn2(void); extern void fn9(void);\n' +
      'void calad(void){\n' +
      '  if ((gGrid[0][6] & 0x80) != 0 && (gGrid[1][0] & 0x7F) == 0x7F) { fn0(); return; }\n' +
      '  else if ((gGrid[1][6] & 0x80) != 0 && (gGrid[2][0] & 0x7F) == 0x7F) { fn1(); return; }\n' +
      '  else if ((gGrid[2][6] & 0x80) != 0 && (gGrid[3][0] & 0x7F) == 0x7F) { fn2(); return; }\n' +
      '  fn9();\n' +
      '}',
    features: ['array', 'global', 'branch', 'mask'],
    toolchains: ['agbcc'],
    ctx: 'void fn0(void); void fn1(void); void fn2(void); void fn9(void); void calad(void);',
    proto: {
      calad: { returnsVoid: true },
      fn0: { params: 0, returnsVoid: true },
      fn1: { params: 0, returnsVoid: true },
      fn2: { params: 0, returnsVoid: true },
      fn9: { params: 0, returnsVoid: true },
    },
  },
  {
    sym: 'mixsense',
    src:
      'extern u8 gGrid[5][7];\n' +
      'extern void fn0(void); extern void fn1(void); extern void fn2(void);\n' +
      'extern void fn3(void); extern void fn9(void);\n' +
      'void mixsense(void){\n' +
      '  if ((gGrid[0][6] & 0x80) != 0 && (gGrid[1][0] & 0x7F) == 0x7F) { fn0(); return; }\n' +
      '  else if ((gGrid[1][6] & 0x80) != 0 && (gGrid[2][0] & 0x7F) == 0x7F) { fn1(); return; }\n' +
      '  if ((gGrid[2][6] & 0x80) == 0 || (gGrid[3][0] & 0x7F) != 0x7F) {\n' +
      '    if ((gGrid[3][6] & 0x80) == 0 || (gGrid[4][0] & 0x7F) != 0x7F) { fn9(); }\n' +
      '    else { fn3(); }\n' +
      '  } else { fn2(); }\n' +
      '}',
    features: ['array', 'global', 'branch', 'mask'],
    toolchains: ['agbcc'],
    ctx: 'void fn0(void); void fn1(void); void fn2(void); void fn3(void); void fn9(void); void mixsense(void);',
    proto: {
      mixsense: { returnsVoid: true },
      fn0: { params: 0, returnsVoid: true },
      fn1: { params: 0, returnsVoid: true },
      fn2: { params: 0, returnsVoid: true },
      fn3: { params: 0, returnsVoid: true },
      fn9: { params: 0, returnsVoid: true },
    },
  },
  {
    // G1's JOINED half — `mixsense` forces the mixed sense at DIVERGENT sites (every arm returns)
    // and the real row wins on `/flip-join`, the joined boolean, which `mixsense` never
    // enumerates. Here both `if`s RECONVERGE and the second is spelled as its dual, so no single
    // value of `negateJoinedBranchSense` is right at both: the fan scores 4 with the variation OFF and
    // 4 with it ON. Hand-writing asmlift's own winner with only the second site dualized is
    // byte-exact, so the whole residual is the sense — and `/site-sense` (rank-variations.ts) now spells
    // exactly that mix and MATCHES.
    sym: 'joinsense',
    src:
      'extern u8 gGrid[5][7];\n' +
      'extern s32 gOut; extern s32 gOut2; extern s32 gOut3;\n' +
      'void joinsense(void){\n' +
      '  if ((gGrid[0][0] & 0x80) != 0 && (gGrid[1][0] & 0x7F) == 0x7F) { gOut = 1; } else { gOut = 2; }\n' +
      '  if ((gGrid[2][0] & 0x80) == 0 || (gGrid[3][0] & 0x7F) != 0x7F) { gOut2 = 3; } else { gOut2 = 4; }\n' +
      '  gOut3 = 5;\n' +
      '}',
    features: ['array', 'global', 'branch', 'mask'],
    toolchains: ['agbcc'],
    ctx: 'void joinsense(void);',
    proto: { joinsense: { returnsVoid: true } },
  },
  {
    // The CONTROL for `joinsense`: the same two joined `if`s with both sites spelled in the SAME
    // sense. MATCH — so the gap is the MIX, not the joined shape.
    sym: 'joinsame',
    src:
      'extern u8 gGrid[5][7];\n' +
      'extern s32 gOut; extern s32 gOut2; extern s32 gOut3;\n' +
      'void joinsame(void){\n' +
      '  if ((gGrid[0][0] & 0x80) != 0 && (gGrid[1][0] & 0x7F) == 0x7F) { gOut = 1; } else { gOut = 2; }\n' +
      '  if ((gGrid[2][0] & 0x80) != 0 && (gGrid[3][0] & 0x7F) == 0x7F) { gOut2 = 4; } else { gOut2 = 3; }\n' +
      '  gOut3 = 5;\n' +
      '}',
    features: ['array', 'global', 'branch', 'mask'],
    toolchains: ['agbcc'],
    ctx: 'void joinsame(void);',
    proto: { joinsame: { returnsVoid: true } },
  },
  {
    // C3 of `kleod:CountCollectedGems:agbcc`'s second decomposition (#172): the site-sense reading
    // itself, on a CHAINED condition. Both `if`s here are written in the SAME positive sense, so
    // this is not `joinsense`'s mix and no value of `negateJoinedBranchSense` is being defeated by
    // one. The second condition is `(a == K1 || a == K2) && b == K3`, which folds TWICE: the outer
    // fold's `^g` is the head's TAKEN edge rather than its fall, so the arm both tests reach lands
    // in the FALL successor slot. A reading that consults only WHICH SOURCE ARM is shared
    // (`scSharedOnFall`) negates a site already spelled the source's way. The first `if` is the
    // unchained control — one fold, shared arm in the taken slot — where that reading is right.
    // 4/44 on the one-stamp reading, MATCH once the fold also stamps the SLOT.
    sym: 'chainsense',
    src:
      'extern u8 gGrid[5][7];\n' +
      'extern s32 gOut; extern s32 gOut2; extern s32 gOut3;\n' +
      'void chainsense(void){\n' +
      '  if ((gGrid[0][0] & 0x80) != 0 && (gGrid[1][0] & 0x7F) == 0x7F) { gOut = 1; } else { gOut = 2; }\n' +
      '  if ((gGrid[2][0] == 3 || gGrid[2][0] == 5) && (gGrid[3][0] & 0x7F) == 100) { gOut2 = 3; }\n' +
      '  else { gOut2 = 4; }\n' +
      '  gOut3 = 5;\n' +
      '}',
    features: ['array', 'global', 'branch', 'mask'],
    toolchains: ['agbcc'],
    ctx: 'void chainsense(void);',
    proto: { chainsense: { returnsVoid: true } },
  },

  // ── THE ELSE-LADDER ARM CLIFF, and the nested-loop accumulator copy (attr2/CountCollectedGems) ─
  // The SECOND attribution round on `kleod:CountCollectedGems:agbcc`. The first one (#156)
  // partitioned that row's 290 into seven gaps by a byte-exact ablation, all seven shipped
  // (#163-#170), every row they owned closed — `pmarr1`, `pmarr2`, `bfzero`, `armcb`, `swladder`
  // all MATCH above — and the real row went 290 -> 171 rather than to 0. These nine rows are what
  // the 171 turned out to be, re-decomposed from the differ's own rows and verified against agbcc
  // instead of inferred: an ELSE-LADDER whose CONJUNCTIVE guard splits and duplicates an arm
  // body (68 of the 171), and a LOOP-CARRIED ACCUMULATOR that asmlift copies in and out of a
  // local the target never spills (28 of the 171). The remaining 75 get no row here, and why is
  // at the end.
  //
  // WHICH BASE EVERY NUMBER BELOW WAS TAKEN AT — read this before quoting any of them. The
  // partition above (171 = 68+33+28+15+11+16), the CLIFF census, the per-edit table and the
  // ablation figures were all measured at #172's base, i.e. BEFORE #184 (`raise/shortcircuit.ts`'s
  // arm re-read) and #185 (`enclosingCarrierName`). Both have since shipped, and on the tree that
  // carries them `ladder5`, `ladidx2` and `nestacc1` are all MATCH and the real row is 39/352, not
  // 171/387. Numbers written here in the PRESENT tense are therefore the measurement that
  // JUSTIFIED the build and are kept for that reason; every one the committed artifact contradicts
  // is marked `[pre-#184]` inline. A bare score in this block with no such mark is current.
  // (#161's rule: every census the artifact contradicts gets dated. It is a rule with no gate —
  // `citations.test.ts` checks that a cited row still EXISTS and deliberately does not scan
  // `apps/benchmark` — so it is kept by hand, here, and the dating token is what a future scanner
  // would key on.)
  //
  // THREE NECESSARY TERMS, NONE OF THEM SUFFICIENT. Neither the arm count nor the `&&` is on its
  // own the variable: `ladder4` and `calad` both pass WITH a conjunction, and a pure arm-count
  // edit flips the row in both directions. Measured on `ladder5`'s source, ONE EDIT AT A TIME:
  //
  //   ladder5    5 conjunctive arms, per-arm four-statement STORE body        41  [pre-#184]
  //   revlad5s   the same five arms and bodies, guards DE-CONJUNCTED       MATCH  (committed)
  //   ladder4    the same guards and store bodies, FOUR arms               MATCH  (committed)
  //   ladcall5   the same five conjunctive guards, body = ONE DISTINCT CALL MATCH (committed)
  //
  // THREE different single edits each take 41 to MATCH, so all three are terms of one conjunction
  // and none is "the variable" — the two-sided shape [conjunctive-rows-two-sided] warns about.
  // Stated no more strongly than measured:
  //   • THE CONJUNCTION is necessary. `revlad5s` (five de-conjuncted arms) MATCHes; so does
  //     `ladidx2` de-conjuncted (measured, not committed: MATCH against its 36 [pre-#184]). Six
  //     de-conjuncted arms MATCH and six conjunctive arms score 159 [pre-#184].
  //   • THE ARM COUNT is necessary, and it is a CLIFF whose position is SHAPE-DEPENDENT, not a
  //     price that scales. In the `ladder` body the price is ZERO at three arms (measured, not
  //     committed: the same shape at 3 conjunctive store arms MATCHes) and at four (`ladder4`),
  //     then 41 at five [pre-#184]. In the `ladidx` body — arms identical UP TO the member index —
  //     the cliff is at TWO: `ladidx1` MATCH, `ladidx2` 36 [pre-#184]. `ladder4` and `ladidx1` are
  //     the rows that pin the cliff FROM BELOW, and they are the regression gate on the
  //     flattening side.
  //   • THE ARM BODY is necessary, and it is the term the other two edits leave untouched.
  //     `ladcall5` keeps `ladder5`'s five conjunctive guards verbatim and replaces each arm's
  //     store body with one DISTINCT call: MATCH. Distinct on purpose, so this is not `armcb`'s
  //     cross-jump of identical arms (identical calls also MATCH, measured). WHICH part of the
  //     body carries it — the `gQ.cur = fnA` callback store, the `gC.a = N` distinguisher, or the
  //     read-modify-write — is NOT measured here and must not be inferred from this row. Removing
  //     the store body also removes `gQ` and `gC` from the row and so from its map, which is a
  //     CONSEQUENCE of the edit and not a second variable: the map is inert for asmlift here
  //     (map-less `ladcall5` is still MATCH), so the control is not bought by its declarations.
  //     `calad` (3 conjunctive arms, distinct calls, MATCH) is the same fact at three arms.
  //
  // The author of a change is therefore NOT sent to the conjunction-splitting site alone: the gate is the
  // interaction of that split with a per-arm store the ladder cannot merge, above a shape-
  // dependent arm count. `revlad5s`, `ladder4`, `ladidx1` and `ladcall5` are the four MATCH
  // controls such a change must not regress; `ladder4` is the sharpest of them, because its 93/93
  // candidates [pre-#184] already emit the source's own four store sites (census below) while `revlad5s`'s
  // guards are conjunction-free and a conjunction-triggered change cannot fire on it at all.
  //
  // WHY THE CORPUS COULD NOT SEE EITHER, MEASURED RATHER THAN ASSUMED. The dataset already has
  // five else-if ladders and every one of them MATCHes on agbcc today: `calad` (3 arms, each
  // guarded by a conjunction, arms that CALL), `armcb` (4 arms, bodies byte-identical), `armcb2`
  // (1 arm), `swladder` and `swmixed` (2 arms, no conjunction), `joinsense`/`joinsame` (joined,
  // not chained). A capability whose every inhabitant is green cannot be regressed OR advanced by
  // a row — the measure of coverage is whether a ROW MOVES when the capability moves, and none of
  // those can. The corpus's one open accumulator row, `nestacc` (34) [pre-#185; 4/52 today], is not a substitute either:
  // it carries three accumulators AND an if/else ladder inside the inner loop, so its 34 is a sum
  // over at least two classes. `sinkacc` (4) has no nest at all.
  //
  // THE CLIFF. `ladder4` and `ladder5` differ by ONE LINE — a fifth `else if` arm — and the fan
  // is the same size on both sides of it:
  //
  //   ladder4   93 candidate(s) scored, 0 dropped, 0 withheld   best unsigned/reread-globals/unmerge: 0 (match)
  //   ladder5   93 candidate(s) scored, 0 dropped, 0 withheld   best unsigned/reread-globals/unmerge: 41
  //
  // [pre-#184] BOTH LINES, IN SIZE AS WELL AS OUTCOME. Re-run at `981bb0b9`,
  // `ASMLIFT_CANDCACHE=0 pnpm bench fan synthetic:ladder5:agbcc --force` reports `62 candidate(s)
  // scored, 0 dropped, 0 withheld, 0 synthesized, best unsigned/reread-globals/unmerge: 0/152
  // (match)` — the fan is 62, not 93, and its best is a MATCH, not 41. The paragraph below already
  // says the guard shape moves the fan SIZE, which is exactly why the 93 needed a date: the equal
  // sizes were the observation that motivated the census, not a standing fact.
  //
  // Those two lines are reproducible from the row's own `src` — `pnpm bench target` this row
  // `--out D`, compile `src` with the `decomp.yaml` compiler line to get
  // `l5.s`, then `asmlift D/l5.s --name ladder5 --config D/decomp.yaml --score-against D/target.o
  // --proto '{"ladder5":{"returnsVoid":true},…}'`. `pnpm bench run` prints no `[ranked]` line.
  //
  // EQUAL FAN SIZES ARE NOT EVIDENCE OF SELECTION. A CENSUS of both fans says the opposite.
  // Counting `&fnA` store sites in every enumerated candidate source [pre-#184 throughout — this
  // is the measurement that justified #184's build, and it is kept in that voice]:
  //
  //   ladder4   93/93 candidates emit 4 sites — the source's 4. No duplication anywhere in the fan.
  //   ladder5   93/93 candidates emit 6 sites — the source has 5. 0 OF 93 spell the flat ladder.
  //   ladidx2   38/38 candidates emit 3 sites — the source has 2. 0 OF 38.
  //   revlad5s  62/62 candidates emit 5 sites — the source's 5 (and the fan is 62, not 93: the
  //             guard shape moves the fan SIZE too, so 93/93 was never a fixed fan either).
  //
  // By this project's vocabulary that is NO REACH, not LOSES and not mis-ranking: the wanted
  // spelling is absent from the fan, so the blocker is a STRUCTURING decision upstream of
  // enumeration and the author of a change must not be sent to the ranker. What the winner emitted at five
  // arms [pre-#184] (`--score-against` the row's own cached target): arms 1-3 stay flat, arm 4's
  // conjunction splits into a nested `if`, and ARM 5'S WHOLE BODY IS DUPLICATED INTO BOTH NEGATIVE
  // BRANCHES of that split. The real function's ladder has exactly five arms and failed exactly
  // there. A second consequence rode along and is NOT the class: past the split the member spelling
  // degraded from `((u8 *)gP)[32]` to `*((u8 *)gP + 32)`. #184's arm re-read removed the split, and
  // with it both.
  //
  // `ladidx1`/`ladidx2` are the same cliff at ONE TENTH the size, and they move it from arm 5 to
  // arm 2 by deleting the per-arm counter store: with the arms then identical UP TO THE MEMBER
  // INDEX, the second arm is already duplicated. Fan 38 on both, 0 dropped, 0 withheld [pre-#184].
  // `ladidx2` is five lines of C and WAS the row a change should be developed against [pre-#184 — it
  // MATCHes today, so it is now a regression gate, not a development target]; `ladder5` is the row
  // that proves the real function needs it. `armcb` is the neighbouring control that keeps
  // the two apart: its four arms are byte-IDENTICAL, agbcc cross-jumps them into one store, and
  // `l3/unmerge.ts` MATCHes it. One index of difference per arm is what defeats that.
  //
  // `revacc1`/`nestacc1` isolate the accumulator copies from everything `nestacc` bundles with
  // them: same struct, same pointer global, same accumulator, same masked compare, same `sink`
  // call — `revacc1` runs ONE loop over `f[0][j]` and MATCHes, `nestacc1` wraps it in an outer
  // loop over `i` and scored 15 [pre-#185]. It is TWO edits, not one (the outer loop AND the subscript), so
  // they are DECOMPOSED rather than asserted: `nestacc1` with the subscript pinned to `f[0][j]`
  // and THE OUTER LOOP KEPT scores 14 (measured, not committed). The outer loop carries 14 of the
  // 15 and the runtime row index carries 1, so the aggravating factor is the OUTER LOOP — which
  // is the opposite of what a reader of `nestacc` would guess. `flatacc` (one
  // loop, THREE accumulators, an inner ladder, MATCH) is the second control, but it is NOT the
  // control that establishes this: it differs from `nestacc1` in four ways at once (loop depth,
  // accumulator count, ladder, subscript). `revacc1` is the pair the conclusion rests on.
  // The emitted C introduces a copy pair the target does not contain:
  // `v3 = v1; do { ... } while (v2 <= 6); v1 = v3;` around the outer loop, with the inner loop
  // accumulating into `v3`. Its fan was FOUR candidates against `flatacc`'s sixteen, all four
  // carrying the copies [pre-#185].
  //
  // ATTRIBUTION — the first blocker for each row, and none of them is a decline. All nine lift,
  // structure and rank; there is no gap marker on any of them:
  //   • `ladder5` (41) and `ladidx2` (36) [both pre-#184] — NO REACH, by the census above: 0 of 93 and 0 of 38
  //     candidates spell the flat ladder past the duplicating arm. The 93/38 differ by ranked VARIATIONS
  //     (`/unmerge`,
  //     `/reread-globals`, `/offmember`, `/raw-globals`), which vary the SPELLING of a fixed
  //     structure; the structure itself comes from one structuring decision upstream of the fan.
  //     Naming the site that makes it is the CHANGE THIS ROW GATES and is deliberately NOT claimed
  //     here — #156's own G3 attribution named a file two levels up from the real one, and the
  //     rule this project keeps is to instrument or ablate, never to read and infer. BOTH CLOSED
  //     (41 -> MATCH, 36 -> MATCH) by the arm re-read in `raise/shortcircuit.ts`, which is that
  //     site: the fold refused whenever the second test's block defined a value the arm read past
  //     it, so the connective split into a nest and the structurer duplicated the next arm into
  //     both negative branches. The (41) and (36) above predate it.
  //   • `nestacc1` (15) [pre-#185] — same shape of answer with a much smaller fan: 4 candidates, every one
  //     carrying the copy pair, best `unsigned/uns-cmp`. CLOSED (15/38 -> MATCH) by
  //     `enclosingCarrierName` (structure/structure.ts): two refusals in the loop seeding had to
  //     lift together — the forward-edge adoption ran only under `coalesceLoopInit`, and
  //     `enclosingNames` excluded the enclosing header's name — and the write-order record
  //     decides it per site. `nestacc` went 34/64 -> 4/52 with it; its (34) above predates that.
  //   • `nestacc1`'s 15 is mostly NOT the apparatus it is spelled with: the same nest and
  //     accumulator over a bare `extern u8 gG2[8][8]` — no pointer, no struct, no map — scores 13
  //     of the 15. The pointer-into-struct spelling is kept for fidelity to the real function and
  //     because m2c needs the map to compile at all, not because the class needs it.
  //   • `ladder4`, `ladidx1`, `ladcall5`, `flatacc`, `revlad5s`, `revacc1` — controls, MATCH,
  //     nothing to attribute.
  //
  // WHAT `/unmerge` DOES HERE. ITS SIGN IS A PROPERTY OF THE BASE, NOT OF THE VARIATION, and the base
  // has since moved twice. Against the 171-era winner the variation COST +44 (that winner's own
  // `/unmerge` sibling scored 215, and the best `/unmerge`-carrying candidate in the fan was 192);
  // #169 published +24 against a third base. With the ladder flat (`arm-reread`) and the
  // accumulator copies gone (`enclosingCarrierName`) it PAYS −17 on the real row and is in the
  // WINNER'S variations — `unsigned/connective/defsite/loop-entry/flip-join/reread-globals/derived-home/
  // merge-home/uns-cmp/site-sense/unmerge/livebase`, 39/352. Two independent routes agree, both at
  // `d6b21ba`: `pnpm bench fan kleod:CountCollectedGems:agbcc --force` (5952 scored, 0 dropped)
  // gives best-WITH 39/352 against best-WITHOUT 56/352, the two candidates' variations differing only in the
  // trailing home variation; and emptying `PRE_RESPELL_VARIATIONS` (packages/core/src/rank-variations.ts), then
  // `ASMLIFT_CANDCACHE=0 pnpm bench run --tier real --only CountCollectedGems`, lands the row on
  // that same 56/352. So the variation is neither missing nor mis-ranked: where the ladder duplicates an
  // arm, the duplicated copies must re-materialise their own pool operands and the merged spelling
  // wins on price. It is downstream of the ladder and cannot be attributed on its own, which is why
  // no row here carries it as its subject.
  //
  // WHICH DIRECTION `/unmerge` IS, because the variations alone do not say: the variation FIRING
  // duplicates the merged join statement back into
  // the arms, so a `/unmerge` winner spells the store PER ARM; REFUSING leaves the structurer's
  // merged tail (`l3/unmerge.ts`'s own REFUSES list). The real row's published winner emits
  // `p0[1] = &UpdateWorldMapNodeAnim;` at SEVEN separate arm sites (nine `p0[1] = &…` stores in
  // all, the other two `&GameplayMainLoop`), and its `refSource` writes
  // `gCallbackQueue.current[1] = UpdateWorldMapNodeAnim;` seven times, once per arm — per-arm on
  // both sides, which is why firing PAYS here. (Both counts are `python3` over
  // `results/results.json`, not a reading of the C.)
  //
  // AND THE WHOLE-ROW NUMBER IS A VARIATION'S NUMBER, WHICH BUYS LESS THAN "ENUMERATED, THEREFORE
  // IMMUNE". −17/352 is a per-FUNCTION delta, and enumeration means the differ picks rather than a
  // predicate guessing — so the number cannot be WRONG. What it is NOT is per-site REACH.
  // `unmergeJoins`
  // (`l3/unmerge.ts`, the `list`/`rewrite` walk) rewrites EVERY site that clears its gates and
  // returns one `SFn | null`, and `rank.ts` calls it once per structured tree — so the fan carries
  // TWO points, all-merged and all-un-merged, never 2^k. A function wanting site A un-merged and
  // site B merged has no candidate anywhere in the fan. Priced rather than asserted, by counting
  // `unmergeAt`'s SUCCESSFUL returns per call under an instrumented `unmergeJoins` — a temporary
  // print, because `bench gates --pass unmerge` tallies each rule's REFUSALS and never a success —
  // over the whole synthetic agbcc tier and `bench fan kleod:CountCollectedGems:agbcc
  // --enumerate`: k = 1 on 23 of the 25
  // firing rows AND on the real row (576 calls, `sites=1` every one), k = 2 on `synthetic:joinsame`
  // and `synthetic:joinsense`. So the refusal is real and inhabited at k = 2, its cost today is
  // ZERO — both k = 2 rows MATCH, and the real row's k = 1 means the mixed partition is no part of
  // its 39/352 — and the honest statement is PR #120's, a stated price rather than an immunity.
  // Converting any of this to a per-function PREDICATE is the separate and worse move that
  // [joined-branch-sense-decidable] records.
  //
  // On the ladder rows it is among the winner's variations throughout, and FLATTENING THE LADDER WIDENED
  // WHAT DEPENDS ON IT. Same ablation, same cache-off re-run, all at `981bb0b9`: `ladder4`
  // MATCH -> 25/121, `ladder5` MATCH -> 38/152, `ladidx1` MATCH -> 10/29, `ladidx2`
  // MATCH -> 11/51, `revlad5s` MATCH -> 37/118, `armcb` MATCH -> 32/43, `armcb2` MATCH -> 18/21;
  // only `ladcall5`, `swladder` and `calad` are INERT. `ladidx2` measured exactly INERT (36 both
  // ways) while the ladder still duplicated an arm [pre-#184] and is load-bearing now.
  //
  // THE FULL BLAST RADIUS IS TWELVE MATCH ROWS, NOT SEVEN, AND ONE OF THEM IS REAL-TIER. Only
  // FIVE of the seven above belong to this family (`ladder4`, `ladder5`, `ladidx1`, `ladidx2`,
  // `revlad5s`) — `armcb` and `armcb2` are `l3/unmerge.ts`'s own rows and are cited there
  // (`armcb2` at `:22`, `armcb` at `:525`), while `ladcall5`, which IS one of this block's nine,
  // is INERT. Read the
  // sentence as "how much coverage this block buys" and the answer is five, not seven. The same
  // ablation also takes `sa3:numToASCII:agbcc` MATCH -> 8/31,
  // `synthetic:dmascope` MATCH -> 9/56, `synthetic:dmascope2` MATCH -> 13/33, `synthetic:joinsame`
  // MATCH -> 22/46 and `synthetic:joinsense` MATCH -> 18/46 (each measured alone, cache off, at
  // `981bb0b9`). `sa3:numToASCII:agbcc` is the one that matters to the author of a change: it is REAL-TIER
  // — a shipped decomp's own function, not a probe written for this family — and until this block
  // named it, it was cited NOWHERE, so nothing warned an author developing here that they could
  // break it. Naming it here is enough: `dataset-symmetry.test.ts` ("the dataset cites only
  // benchmark rows that exist") pins every `project:sym` in this tree against `results.json`, in
  // the same CI step as `citations.test.ts` — verified by renaming this citation and watching that
  // suite go red, which is also why it should NOT be added to `citations.test.ts`'s `SCANNED`.
  // (Every one of the twelve turns `pnpm bench regression` red, which is an OUTCOME gate over all
  // tiers — `report/regression.ts`, "any match→non-match flip" — but `benchmark.yml` is
  // `workflow_dispatch` with no cron, so that gate runs when a human dispatches the benchmark, not
  // on a PR. The real row is the expensive one to discover, not the only one.) A non-MATCH row the ablation also worsens, so the variation is
  // load-bearing past this family: `synthetic:mergeldcast:gcc2.7.2kmc` 4/9 -> 5/9. That figure and
  // the five real non-MATCH rows that also worsen — `kleod:EntityItemDrop`,
  // `kleod:UpdateWorldMapNodeTile`, `sa3:GetInput`, `sa3:sa2__sub_8083504`,
  // `marioparty3:func_800600C0_60CC0`, all five carrying `/unmerge` among their published winner's variations —
  // were measured at `981bb0b9` and are NOT in #172, which names none of the five and no
  // `mergeldcast`; quote them from here, not from that PR. They have not been re-measured since. `kleod:ProcessInputAndUpdateEntities:agbcc` carries the variation and was NOT
  // measured either (~2700 s): assume it at risk, not safe.
  //
  // Rows that carry `/unmerge` among their winner's variations and are nevertheless INERT under the
  // ablation — `armshare`, `readshare`, `mergeloop`, `mergecast`, `mergecastu`, `mergeu16`,
  // `mergenarrow` — are why the winner's variations are a PRE-CHECK and not the evidence. The mechanism is NOT
  // `applyStacked` (never called on the pre-respell path — both its call sites in rank.ts are
  // `STACKED_SUBSETS` loops; `/unmerge` is applied by rank.ts's `PRE_RESPELL_VARIATIONS` loop) and NOT the
  // source dedup (the default fan's spellings are pushed FIRST, so an identical source keeps the
  // default fan's variations and never surfaces as a carrier). Measured on `synthetic:armshare:agbcc`, cache
  // off, one row each way: base MATCH 0/26 on `unsigned/unmerge`, ablated MATCH 0/26 on
  // `unsigned` — SAME SCORE, DIFFERENT SOURCE (the carrier spells `*(s32 *)50345024 = v1 << 3;` per
  // arm, the ablated winner hoists `v2`/`v3` and stores once after the join). So a carrier is a
  // DISTINCT spelling that ties on score and wins on `compareScored`'s within-tie quality keys
  // (rank.ts: `preference`, `deviceVolatile`, `castCount`, `lineCount`, enumeration order) —
  // which makes these rows outcome-inert but NOT publication-inert: the variation changes the C they
  // ship, the `bench diff` source-byte field this project has already paid for twice (#112/#113).
  // The cheap route is `grep`ping `winnerVariations` in `results/results.json` (27 rows carry it, 18
  // of them MATCH); the ablation is what decides which of those 18 actually depend on it.
  //
  // WHAT EACH MAP BUYS, MEASURED (`symbols:` deleted, re-run, cache off):
  //   PROBE_SLOTC_MAP  ladder4 MATCH->27 · ladder5 MATCH->30/157 · revlad5s MATCH->45 —
  //     LOAD-BEARING, and on BOTH CONTROLS first, which is the point: a control that scores
  //     map-less pins nothing. The 27 and the 45 are struct SYNTHESIS, not this family — a
  //     synthesized `struct Off0 { u8 _pad0[4]; s32 m4; }` for `gQ` plus a hoisted
  //     `p0 = (u8 *)&gC` base local. (`ladder5` read `41->77` here [pre-#184] and was wrong at
  //     BOTH ends by the time the row MATCHed; re-measured at `981bb0b9` it is MATCH->30/157. The
  //     CONCLUSION — SLOTC load-bearing — is the part that survived, which is why the figure and
  //     not the verdict needed replacing.)
  //   PROBE_SLOT_MAP   ladidx1 MATCH->MATCH · ladidx2 MATCH->MATCH — INERT for asmlift,
  //     LOAD-BEARING for m2c: map-less it emits `extern ? gQ;` and the row publishes a DECLINE.
  //     (`ladidx2` read `36->36` here [pre-#184]: both numbers are dead, the INERT verdict is not.)
  //   PROBE_CALLS_MAP  ladcall5 MATCH->MATCH — INERT for asmlift, LOAD-BEARING for m2c
  //     (MATCH -> noncompile: `fn0`..`fn4` are CALLED, but m2c spells the call through a pointer
  //     the candidate compile cannot type without the map). So the control's MATCH is not bought
  //     by its map, which is the only way a MATCH control pins anything.
  //   PROBE_NEST_MAP   flatacc MATCH->MATCH · nestacc1 MATCH->MATCH (read `15->15` here
  //     [pre-#185]) · revacc1 MATCH->MATCH — INERT for
  //     asmlift on all three, LOAD-BEARING for m2c, which goes noncompile -> MATCH, 18 and MATCH.
  //   `fnA`/`fnB` are in PROBE_SLOT_MAP as `kind: 'code'` for a reason worth stating, since it is
  //     a trap for the next author: the m2c candidate is compiled against the declarations
  //     rendered from `symbols` ALONE (`m2cDeclarationsFor`, src/eval/evaluate.ts) — `ctx` reaches
  //     m2c's DECOMPILE (as `--context`) and never its candidate compile. With the two names only
  //     in `ctx`, all four ladder rows published `m2c=noncompile(1)` reading ``fnA' undeclared`,
  //     which is a harness artifact wearing the costume of a decompiler failure. In the map they
  //     render as `void fnA(void);` and m2c scores. They are inert for asmlift (MATCH/41/MATCH/36
  //     either way [pre-#184]; all four MATCH either way today).
  //   AND `sink` IS DELIBERATELY NOT IN PROBE_NEST_MAP, which looks like an inconsistency and is
  //     not. `fnA` is used as a VALUE (`gQ.cur = fnA`), which C89 will not accept undeclared;
  //     `sink` is only CALLED, so the candidate compile takes it by C89 IMPLICIT DECLARATION and
  //     needs no map entry. Adding one is not free and was measured rather than argued: a
  //     `kind: 'code'` entry renders as `void sink(void);` — the map has nowhere to carry an
  //     arity — and all three PROBE_NEST_MAP rows then go m2c MATCH/MATCH/18 -> NONCOMPILE on
  //     ``too many arguments to function `sink'``. The asymmetry is the C89 rule, not an
  //     oversight.
  //
  // M2C. THE DEFICIT THIS PARAGRAPH RECORDED IS GONE, AND THE RECORD IS KEPT BECAUSE IT WAS THE
  // ARGUMENT FOR THE BUILD. It read [pre-#184]: "`ladder5` is m2c 38 against asmlift 41 and
  // `ladidx2` is m2c 19 against asmlift 36 — m2c is AHEAD on both gap rows … the first rows in
  // this dataset where m2c wins on the class being attributed". That was true and it is now false
  // in every clause. On the committed artifact, agbcc: `ladder5` asmlift MATCH against m2c 38/152,
  // `ladidx2` asmlift MATCH against m2c 19/51, `nestacc1` asmlift MATCH against m2c 18/39. m2c did
  // not move; #184 and #185 did. What DID hold is the mechanism the paragraph named: m2c's
  // `ladder5` output is the flat five-arm ladder, sunk into one merged tail through a
  // `void (*var_r0)()` local, and a flat ladder is exactly what asmlift had to reach before it
  // could MATCH. asmlift is ahead on all six controls or ties them
  // (`ladder4` MATCH against 25/121, `ladidx1` MATCH against 12/29, `revlad5s` MATCH against 37/118;
  // `ladcall5`, `flatacc`, `revacc1` MATCH both). Anyone quoting this file for the m2c comparison
  // must quote the artifact, not this paragraph.
  //
  // WHAT GOT NO ROW, and why — from Phase 2's partition of the 171 (68 + 33 + 28 + 15 + 11 + 16)
  // [pre-#184; the row is 39/352 today, and #184 + #185 are what took the 68 and the 28]:
  //   • the 33-row register-pressure class is FALLOUT of the ladder duplication (the frame slot,
  //     the `sl` global base, pool remat), so it has no independent fix and a row would
  //     double-count the 68.
  //   • the 15-row connective-polarity class is CONFOUNDED: its loop-free control MATCHes, and
  //     its in-loop residual is emitted WITH the accumulator copies above. Re-measure it after
  //     `nestacc1` moves; opening a row now would credit one class with the other's cause.
  //     (`nestacc1` HAS moved — #185, MATCH — so the precondition this bullet set is met and the
  //     re-measurement it asks for is owed. It is #172's C3.)
  //   • the 11-row `u8`-locals/`for`-form class is UNATTRIBUTED. The byte-identity probe on it
  //     reproduces (both spellings compile to the same 0x58 bytes) — but it is a 2-loop,
  //     no-ladder, no-pressure function, and the inference from it does not survive the shape it
  //     was generalised over. On the real function the same two edits moved 36 -> 24 together
  //     [pre-#184], and APART they moved −3 (`u8` locals alone) and +23 (`for` form alone): a conjunctive pair, the
  //     two-sided shape this project has been caught by before. It gets no row because no change is
  //     named for it, not because there is nothing to gate.
  //   • the 16-row per-arm-store class is G6's, and it wanted no row of its own. It was recorded
  //     here as a PREDICTION — blocked behind the ladder rows above, its spelling reachable only
  //     once the ladder stops duplicating an arm — with the falsifier being the real row's
  //     `/unmerge` probe re-run after a ladder change lands. That probe has now run at `d6b21ba`
  //     and the prediction HELD: with the ladder flat the real row selects the UN-merged, PER-ARM
  //     tail — the variation FIRES among the winner's variations, which is the direction that duplicates the
  //     join back into the arms — and `/unmerge` is worth −17/352 to it (the paragraph above). So
  //     the class is not independent, and it is no longer ungated either — ablating `/unmerge`
  //     moves the real row 39/352 -> 56/352 and takes TWELVE MATCH rows out of MATCH, FIVE of
  //     them here and one of them real-tier (`sa3:numToASCII:agbcc`) — the blast radius above has
  //     the twelve and says which five — which is the standard this family is built on.
  //
  // ALL NINE ARE agbcc-ONLY, on the same terms as the family above: each was smoked alone
  // (`ASMLIFT_CANDCACHE=0 pnpm bench run --tier synthetic --only <sym> --toolchain agbcc
  // --serial`), a candidate compile has no timeout, and no row gets a toolchain nobody
  // individually smoked. THE `--only` FILTER IS A SUBSTRING MATCH (`sym.includes(only)`,
  // src/cases/synthetic.ts) and collides more widely than it looks: `--only lad` takes NINE rows —
  // `lladd`, `swladder`, `calad`, `ladder4`, `ladder5`, `ladidx1`, `ladidx2`, `revlad5s`,
  // `ladcall5` — and `--only acc` takes five. `--only nestacc` takes `nestacc1` with `nestacc`;
  // `--only revlad`, `--only ladcall` and `--only revacc` take one row each.
  {
    sym: 'ladder4',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'struct C { u8 a; u8 b; };\n' +
      'extern struct C gC;\n' +
      'void ladder4(void){\n' +
      '  if ((gP->f[7] & 0x80) != 0 && (gP->f[8] & 0x7F) == 0x7F) { gC.a = 0; gC.b = 0; gP->f[8] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  else if ((gP->f[15] & 0x80) != 0 && (gP->f[16] & 0x7F) == 0x7F) { gC.a = 1; gC.b = 0; gP->f[16] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  else if ((gP->f[23] & 0x80) != 0 && (gP->f[24] & 0x7F) == 0x7F) { gC.a = 2; gC.b = 0; gP->f[24] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  else if ((gP->f[31] & 0x80) != 0 && (gP->f[32] & 0x7F) == 0x7F) { gC.a = 3; gC.b = 0; gP->f[32] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  gQ.cur = fnB;\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'mask', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void ladder4(void);',
    proto: {
      ladder4: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOTC_MAP,
  },
  {
    sym: 'ladder5',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'struct C { u8 a; u8 b; };\n' +
      'extern struct C gC;\n' +
      'void ladder5(void){\n' +
      '  if ((gP->f[7] & 0x80) != 0 && (gP->f[8] & 0x7F) == 0x7F) { gC.a = 0; gC.b = 0; gP->f[8] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  else if ((gP->f[15] & 0x80) != 0 && (gP->f[16] & 0x7F) == 0x7F) { gC.a = 1; gC.b = 0; gP->f[16] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  else if ((gP->f[23] & 0x80) != 0 && (gP->f[24] & 0x7F) == 0x7F) { gC.a = 2; gC.b = 0; gP->f[24] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  else if ((gP->f[31] & 0x80) != 0 && (gP->f[32] & 0x7F) == 0x7F) { gC.a = 3; gC.b = 0; gP->f[32] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  else if ((gP->f[39] & 0x80) != 0 && (gP->f[40] & 0x7F) == 0x7F) { gC.a = 4; gC.b = 0; gP->f[40] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  gQ.cur = fnB;\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'mask', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void ladder5(void);',
    proto: {
      ladder5: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOTC_MAP,
  },
  {
    sym: 'ladidx1',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void ladidx1(void){\n' +
      '  if ((gP->f[7] & 0x80) != 0 && (gP->f[8] & 0x7F) == 0x7F) { gP->f[8] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  gQ.cur = fnB;\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'mask', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void ladidx1(void);',
    proto: {
      ladidx1: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOT_MAP,
  },
  {
    sym: 'ladidx2',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void ladidx2(void){\n' +
      '  if ((gP->f[7] & 0x80) != 0 && (gP->f[8] & 0x7F) == 0x7F) { gP->f[8] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  else if ((gP->f[15] & 0x80) != 0 && (gP->f[16] & 0x7F) == 0x7F) { gP->f[16] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  gQ.cur = fnB;\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'mask', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void ladidx2(void);',
    proto: {
      ladidx2: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOT_MAP,
  },
  {
    // The CONJUNCTION control for `ladder5`: identical arms, identical bodies, guards DE-CONJUNCTED
    // to one test. MATCH. It says the conjunction is a NECESSARY term — not that it is the only
    // one: `ladder4` (drop an arm) and `ladcall5` (change the arm body) each take the same 41 to
    // MATCH too. One of the four MATCH controls a ladder-flattening change must not regress, and
    // the weakest of them as a gate: with no conjunction left, a conjunction-triggered change never
    // fires here. Its MATCH also depends on `/unmerge` (ablated: 37). (Measured alongside,
    // uncommitted: the same shape at SIX arms also MATCHes, and six CONJUNCTIVE arms score 159.)
    sym: 'revlad5s',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'struct C { u8 a; u8 b; };\n' +
      'extern struct C gC;\n' +
      'void revlad5s(void){\n' +
      '  if ((gP->f[8] & 0x7F) == 0x7F) { gC.a = 0; gC.b = 0; gP->f[8] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  else if ((gP->f[16] & 0x7F) == 0x7F) { gC.a = 1; gC.b = 0; gP->f[16] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  else if ((gP->f[24] & 0x7F) == 0x7F) { gC.a = 2; gC.b = 0; gP->f[24] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  else if ((gP->f[32] & 0x7F) == 0x7F) { gC.a = 3; gC.b = 0; gP->f[32] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  else if ((gP->f[40] & 0x7F) == 0x7F) { gC.a = 4; gC.b = 0; gP->f[40] &= 0x80; gQ.cur = fnA; return; }\n' +
      '  gQ.cur = fnB;\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'mask', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void revlad5s(void);',
    proto: {
      revlad5s: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOTC_MAP,
  },
  {
    // The ARM-BODY control for `ladder5`: its five CONJUNCTIVE guards verbatim, with each arm's
    // four-statement global-store body replaced by ONE DISTINCT call. MATCH. The calls are
    // distinct on purpose — identical ones would MATCH through `armcb`'s cross-jump instead and
    // prove nothing. It is the term the other two edits leave untouched, and the one MATCH control
    // in this family that does NOT depend on `/unmerge` (ablated: still MATCH).
    sym: 'ladcall5',
    src:
      'extern void fn0(void); extern void fn1(void); extern void fn2(void);\n' +
      'extern void fn3(void); extern void fn4(void); extern void fnB(void);\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void ladcall5(void){\n' +
      '  if ((gP->f[7] & 0x80) != 0 && (gP->f[8] & 0x7F) == 0x7F) { fn0(); return; }\n' +
      '  else if ((gP->f[15] & 0x80) != 0 && (gP->f[16] & 0x7F) == 0x7F) { fn1(); return; }\n' +
      '  else if ((gP->f[23] & 0x80) != 0 && (gP->f[24] & 0x7F) == 0x7F) { fn2(); return; }\n' +
      '  else if ((gP->f[31] & 0x80) != 0 && (gP->f[32] & 0x7F) == 0x7F) { fn3(); return; }\n' +
      '  else if ((gP->f[39] & 0x80) != 0 && (gP->f[40] & 0x7F) == 0x7F) { fn4(); return; }\n' +
      '  fnB();\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'mask'],
    toolchains: ['agbcc'],
    ctx: 'void fn0(void); void fn1(void); void fn2(void); void fn3(void); void fn4(void); void fnB(void); void ladcall5(void);',
    proto: {
      ladcall5: { returnsVoid: true },
      fn0: { params: 0, returnsVoid: true },
      fn1: { params: 0, returnsVoid: true },
      fn2: { params: 0, returnsVoid: true },
      fn3: { params: 0, returnsVoid: true },
      fn4: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_CALLS_MAP,
  },
  {
    // The one-edit control for `nestacc1`: the same struct, pointer global, accumulator, masked
    // compare and `sink` call, with the OUTER loop removed and the subscript pinned to `f[0][j]`.
    // MATCH. `flatacc` below is a second control but varies four things at once, so this is the
    // row the "the outer loop is the aggravating factor" claim rests on.
    sym: 'revacc1',
    src:
      'struct Grid { u8 f[8][8]; };\n' +
      'extern struct Grid *gP;\n' +
      'extern void sink(int, int, int);\n' +
      'void revacc1(void){\n' +
      '  u8 a = 0, j;\n' +
      '  for (j = 0; j < 7; j++) {\n' +
      '    if ((gP->f[0][j] & 0x7F) == 0x64) a += 1;\n' +
      '  }\n' +
      '  sink(a, 0, 0);\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'mask', 'value-home'],
    toolchains: ['agbcc'],
    ctx: 'void sink(int a, int b, int c); void revacc1(void);',
    proto: { revacc1: { returnsVoid: true }, sink: { params: 3, returnsVoid: true } },
    symbols: PROBE_NEST_MAP,
  },
  {
    sym: 'flatacc',
    src:
      'struct Grid { u8 f[8][8]; };\n' +
      'extern struct Grid *gP;\n' +
      'extern void sink(int, int, int);\n' +
      'void flatacc(void){\n' +
      '  u8 a = 0, b = 0, c = 0, j;\n' +
      '  for (j = 0; j < 7; j++) {\n' +
      '    if ((gP->f[0][j] & 0x7F) == 0x64) a += 1;\n' +
      '    else if ((gP->f[0][j] & 0x7F) == 0x1E) b += 1;\n' +
      '    if (gP->f[0][j] & 0x80) c += 1;\n' +
      '  }\n' +
      '  sink(a, b, c);\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'mask', 'value-home'],
    toolchains: ['agbcc'],
    ctx: 'void sink(int a, int b, int c); void flatacc(void);',
    proto: { flatacc: { returnsVoid: true }, sink: { params: 3, returnsVoid: true } },
    symbols: PROBE_NEST_MAP,
  },
  {
    sym: 'nestacc1',
    src:
      'struct Grid { u8 f[8][8]; };\n' +
      'extern struct Grid *gP;\n' +
      'extern void sink(int, int, int);\n' +
      'void nestacc1(void){\n' +
      '  u8 a = 0, i, j;\n' +
      '  for (i = 0; i < 5; i++) {\n' +
      '    for (j = 0; j < 7; j++) {\n' +
      '      if ((gP->f[i][j] & 0x7F) == 0x64) a += 1;\n' +
      '    }\n' +
      '  }\n' +
      '  sink(a, 0, 0);\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'mask', 'value-home'],
    toolchains: ['agbcc'],
    ctx: 'void sink(int a, int b, int c); void nestacc1(void);',
    proto: { nestacc1: { returnsVoid: true }, sink: { params: 3, returnsVoid: true } },
    symbols: PROBE_NEST_MAP,
  },
  // `nestcnt` — A CORRECTNESS PIN, not a gap row: the nest where `enclosingCarrierName` and
  // `latchInnerSub` (structure/structure.ts) have to hold TOGETHER. The inner count-down loop
  // leaves the accumulator in the outer loop's variable, and the outer latch reads it
  // (`gO[i] = n + a`). Before both rules, BOTH candidates in its fan re-derived that value at the
  // latch — the last `a += n` counted twice — and the winner published 26/34 while computing
  // another program (3000 of 3000 native inputs wrong; the same source as a standalone probe,
  // agbcc, on this branch's merge-base).
  //
  // WHY A ROW AND NOT ONLY A UNIT TEST. The failure this family produces is a WRONG candidate
  // scoring BETTER, which a byte score reads as an improvement — so the wave-1 review declined to
  // author one. A MATCH is the exception: it cannot become a wrong spelling silently, because any
  // wrong spelling scores worse and `bench regression` reports the lost match. Measured on the
  // same source, ablating one rule at a time: with `latchInnerSub` emptied it is 23/32 and both
  // candidates are wrong; with the exemption for the name `enclosingCarrierName` shares removed,
  // the latch can read the value under neither name and the function DECLINES.
  //
  // The unit fixtures for the two rules are `latch-inner-sub.test.ts` and `nested-carrier.test.ts`;
  // this row is what makes a regression visible in the artifact as well.
  {
    sym: 'nestcnt',
    src:
      'extern s32 gT[5][8];\n' +
      'extern s32 gO[5];\n' +
      's32 nestcnt(void){\n' +
      '  s32 a = 0, i, n;\n' +
      '  for (i = 0; i < 5; i++) {\n' +
      '    n = (gT[i][0] & 7) + 1;\n' +
      '    do { a += n; n--; } while (n > 0);\n' +
      '    gO[i] = n + a;\n' +
      '  }\n' +
      '  return a;\n' +
      '}',
    features: ['global', 'array', 'mask', 'value-home'],
    toolchains: ['agbcc'],
  },
  // ── THE SHARED DEFAULT TAIL (attr3/CountCollectedGems) ──────────────────────────────────────
  // The THIRD attribution round on `kleod:CountCollectedGems:agbcc`, at the 18/344 the C1a, C2 and
  // C3 builds (#184, #185, #187) left it at, and the build that CLOSED it. Eleven rows: eight
  // gaps, all MATCH, and three controls.
  //
  // THE CAPABILITY, in one line: spell a tail the compiler shares ONCE, after the `if`, and write
  // every other path into it as an early `return;`. The rest of this comment is evidence for that
  // line. The IR mechanics further down are one way to build it, not its definition.
  //
  // THE RESIDUAL IS A CONJUNCTION, shown by a byte-exact ablation rather than by reading the diff.
  // All 5952 candidates in the fan write the ladders' shared default store
  // (`gCallbackQueue.current[1] = GameplayMainLoop`) TWICE, once in each innermost `else`. The
  // source writes each arm as `store; return;` and the default store ONCE, after both ladders. No
  // candidate spells it the source's way, so this is NO REACH. Rewriting only that in the fan's
  // `…/uns-cmp/site-sense/unmerge/offmember` candidate takes it from 40/358 to 0/344, byte-exact.
  // The same rewrite leaves the published winner (`…/unmerge/livebase`) at 18/344. The winner's 18
  // differing rows are where the else-ladder's arms 1–3 reach the tail store: each of those arms
  // loads `&gCallbackQueue` itself and branches past the shared base reload. That is 3 per-arm
  // loads the winner lacks, 3 branch targets, 3 pool words, the pool shifts that follow, and 2
  // register rows. Those three arms are exactly the ones the pure forwarder in front of the tail
  // separates from the rest, and the C tail spelling cannot produce them while `/livebase` holds
  // the base in a local. The residual is {the shared tail} AND {`/offmember` in place of
  // `/livebase`}, and only the first term is missing from the fan. The rewrite is a regex. It
  // applied to 1440 of the fan's 2880 `/unmerge` candidates: the `/site-sense` half, which spells
  // the arm first. After it, 2 of those candidates reach MATCH, and both are `/offmember` without
  // `/livebase`. None of the 384 rewritten `/livebase` candidates reaches MATCH (best 18/344). 132
  // of them do change: 104 get better, 24 get worse, and 4 change only in denominator. "The edit is
  // inert under `/livebase`" is true of the winner, not the variation.
  //
  // #172's OTHER TWO CLASSES carry 0 rows at this base: C1b (33 rows at maxScore 387, "register-
  // pressure fallout of C1a") and C4 (11 at 387, "`u8` locals + `for` form"). The 0/344 candidate
  // above declares its counters `u32` and writes its loops as `do`/`while`. Its frame, its `sl`
  // global base and its pool shape all match the target's.
  //
  // THE COMPILER FACT is a SAMPLE, not a law. Take the row's own pair: `gcsetail` against the same
  // function with the default store duplicated. agbcc's `.gcse` dump shows gcse.c's PRE pass, which
  // runs at -O2 whenever `optimize_size` is off. PRE finds the store's base address partially
  // redundant and INSERTS it at the end of both of the join's predecessors (`PRE/HOIST: end of bb
  // 1 … end of bb 4, copying expression 15`), so the arm's store merges into the one tail store.
  // With `-fno-gcse` the pair compiles byte-identical. The real function's dump agrees: its source
  // spelling gets two more `&gCallbackQueue` insertions (ends of bb 36 and 37) than its duplicated
  // twin. Four more pairs (`gcseinner`, `gcseflat`, `gcsefwd` and `gcsearms6`, each against
  // its duplicated twin) behave the same way: they DIFFER at -O2 and are identical under
  // `-fno-gcse` up to label numbers. But a loop before the join is neither necessary nor
  // sufficient. Here are 10 pairs compiled at the benchmark's flags, varying only the loop side's
  // body:
  //   - the row's `for` over `gP->f[i]`, alone or plus one more store: DIFFER at -O2, identical
  //     under `-fno-gcse`.
  //   - three byte stores (a register swap) or one `gQ.prev = fnA` (block layout): DIFFER with NO
  //     loop, and still DIFFER under `-fno-gcse`, so a second, non-PRE mechanism exists.
  //   - a call before the loop, a call inside it, one or two byte stores, a call, or an empty side:
  //     IDENTICAL.
  // A loop BEFORE the `if`, dominating both sides (`gcsepre`), also DIFFERS. So a gate on "a loop
  // before the join" is unsound twice over: it misses both the loop-free divergences and `gcsepre`.
  //
  // WHERE asmlift STOPS, instrumented. agbcc's shared-tail source reaches the structurer in two
  // spellings. CROSS-JUMPED: the real function, `gcsetail`, `gcsepre`, `gcsearms` and `gcsefwd` end
  // in one merged `store; ret` block with ≥2 `br` predecessors, behind a pure forwarder block in
  // the real function and in `gcsefwd`. `sinkReturns` (raise/retsink.ts) tail-duplicates only
  // RETURN-ONLY merges, so it skips this one at its first test (`m.ops.length !== 1`). NOT
  // CROSS-JUMPED: `gcseinner`'s arm keeps its own `store; store; ret`, so the default's `ret` block
  // has one `br` and one `cond_br` predecessor and nothing is merged. `gcseflat` has one arm of
  // each kind. `gcsearms6` has a SECOND merged tail: two loop-free arms cross-jumped into their
  // own `store; store; ret`. Those three lift with one bare `ret`: their separate `ret`s are
  // `sinkReturns`' tail-duplicates. In every spelling each path ends in a `ret` and the outer `if`
  // has no post-dominator, so WITHOUT a follow over the early-returning paths the structurer copies
  // the default store into both arms.
  //
  // THE IR CANNOT DECIDE IT, and that is why `gcsepredup` exists. `gcsepre` and `gcsepredup`
  // compile to different objects (an r4/r5 swap of the two globals' bases), but their lifted IR is
  // byte-identical, so asmlift emits byte-identical C for both. One target needs the shared tail
  // and the other does not, so any DEFAULT keyed on the IR loses one of the two. `gcsedup` cannot
  // catch that: no `ret` of its own is reached from both sides of the outer `if`, before the sink
  // or after it, so both twins' gates are false there and its fan carries neither. `gcsepredup`
  // carries the sunk twin and is the row that scores the trade.
  //
  // THE BUILD, MEASURED. ROUTE A SHIPPED, at the IR level: a store-tail sink
  // (`raise/tailsink.ts`) and a follow over the paths that do not return early
  // (`StructureOptions.followEarlyReturns`), which rank.ts enumerates as two lift variations —
  // `/shared-ret`, the follow on the fn as raised, and `/shared-tail`, the follow after the sink.
  // All eleven rows below MATCH. #189's third step, threading a pure parameter forwarder into the
  // tail, was NOT needed: the sink's source walk sees through `^f(v): br ^t(v)` by construction,
  // and `gcsefwd` and CountCollectedGems MATCH with no threading step.
  //
  // ROUTE B WAS REJECTED, and the claim that recommended it is REFUTED. An L3 `PRE_RESPELL_VARIATIONS`
  // entry that hoists one leaf statement out of the `if` does NOT reach every inhabitant: on
  // `gcseflat` and `gcsearms6` the `fnB` default is carried by ONE merge temp read at TWO join
  // sites, `/unmerge`'s totality refuses, and no tree the fan emits has the duplicated leaves to
  // hoist from. The 0/49 and 0/84 credited to Route B on those two rows were hand grafts that also
  // un-merged that temp. Enumerated, Route B costs +5760 candidates on CountCollectedGems (k = 2:
  // `UpdateWorldMapNodeAnim` ×7 and `GameplayMainLoop` ×2 both end ≥2 leaves), 1.8× what shipped.
  // And nothing at L3 decides WHICH leaf is the default: on `gcsearms` `fnA` ends three leaves and
  // `fnB` two, both in both top-level arms, and the tree has lost that the `fnB` copies were one IR
  // block. The IR has not — it is the source reached from both successors — which is why the sink
  // substitutes edge arguments before any merge temp exists.
  //
  // THE PRICE, enumerated. CountCollectedGems 5952 → 9192 (+3240: +1440 on the default lift's shared-tail variations
  // and +1800 on `/connective`'s, which the winner needs; #189's "≤ +1800" priced one lift, not
  // the cross). Real +5078 over 7 rows and concentrated — `CheckWorldCompletion` 840 → 2520 buys
  // one point. Synthetic 7330 → 7782. `ProcessInputAndUpdateEntities`, which is 97% of the real
  // tier's wall clock, enumerates a byte-identical fan, so the tier's clock does not move.
  //
  // NEITHER TWIN CAN BE A DEFAULT, and the two halves fail differently. The follow as a default
  // costs `sw_fallguard:ido7.1` 13/19 → 19/23 and `gcseflat` 19/53 → 22/54 (`findfirst:agbcc`
  // 12/25 → 10/25 gains). The sink as a default takes `gcsepredup` MATCH → 5/45 and `gcseinnerdup`
  // MATCH → 16/57 — the paragraph above, from the other side: their IR is the gap rows' IR.
  // Ranked, `gcsepredup`'s fan carries 20 `/shared-tail` candidates and the un-sunk spelling still
  // wins, which is the control doing its work rather than a gate refusing the shape.
  //
  // TWO TWINS, NOT ONE, because the sink can DELETE the follow: a store tail that is itself the
  // `ret` both sides of the `if` reach is copied into its `br` sources and no shared `ret` is left.
  // `gcsejoin` is that shape and scored 7/37 while the follow was tried only behind the sink. No
  // per-tail predicate on this IR picks between them — refusing to sink a tail that is already a
  // follow costs `gcseflat` 19/53 and `gcsearms6` 23/87, and both need a tail that is BOTH — so the
  // follow is enumerated on the fn as raised as well, at +76 candidates on exactly those two rows
  // (`gcseflat` +32, `gcsearms6` +44) and +0 real.
  //
  // PER SITE, with inhabitants. The follow's deletion set is keyed on each `if`'s own shared-`ret`
  // set, not on one function-wide set: `maskchain` carries two follow sites and `gcsearms6` two
  // sunk tails, both MATCH, and a function-wide memo fails `shared-tail.test.ts`'s two-`if` test.
  //
  // DO NOT BREAK, and all fourteen MATCH as shipped: `gcsedup`, `gcsepredup` and `gcseinnerdup`
  // above; `armexpr`, `maskchain` and `mergeu16`, which a sink that copied a tail into arms no `if`
  // shares takes to 37/40, 37/69 and 2/13; `mergenarrow`, `mergeldcast` and `mergepool`, which a
  // tail kept for the wrong path takes to 2/15, 4/10 and 1/16. Those last three are out of the
  // rewrite's reach by shape — none has a store-only tail (`sext`/`zext` precede the store, and
  // `mergeldcast` returns a value) — and their fans carry no twin. `maskchain`'s does, 32 of 64,
  // and it MATCHes on a non-twin candidate. The ladder rows (`armcb`, `armcb2`, `ladder4`,
  // `ladidx1`, `ladidx2`) MATCH under every form measured.
  //
  // THE BOUNDARY. These shapes were measured and got NO row:
  //   - Loop-free, with the kept path not a join. The three-byte-store body scores 6/31. Grafting
  //     the shared tail onto its winner matches, and onto its duplicated twin's (identical) winner
  //     costs 6/31. The `gQ.prev = fnA` body scores asmlift 8/29 against m2c's MATCH, and 0/28
  //     grafted. Neither was re-measured against the shipped shared-tail variations: build the row to move them.
  //   - Low-pressure shapes with a SECOND `ret` block. Three `gcsearms` shapes with two or more
  //     arms on the loop-free side MATCH under the sink plus the both-sides follow, so they are
  //     inhabitants of the same rule rather than a separate gap. The third is booked as
  //     `gcsearms6`; the first two keep an arm's own `ret`, which `gcseflat` already gates. Four
  //     CountCollectedGems-like low-pressure shapes were never hand-marked, so that they are
  //     inhabitants too is a PREDICTION — falsify it by building one and scoring its fan.
  //   - Three duplicated twins that gate nothing: `gcseflat`'s and `gcsefwd`'s MATCH under every
  //     form measured, and `gcsejoin`'s lifts with no shared `ret` at all, so it enumerates no twin
  //     either way.
  //   - Why `gcsefwd` subtracts. Summing (`a += gP->f[i]`) gives the same forwarder, but both
  //     twins then keep a 4-row residual: the operand order of the add (`adds r0, r6, r0` in the
  //     target). That is a commutative operand-order gap, not this family's. With three
  //     accumulators instead of four there is no forwarder at all (30/82), so register pressure is
  //     what produces it, on one ablation.
  //
  //   gcsetail   A loop on one side, one `store; return;` arm on the other, and the default store
  //              once after the join. Was 15/44 with 0 of its 36 candidates sharing the tail;
  //              CLOSED: **MATCH** on `unsigned/shared-tail`, fan 36 → 52 (16 twin).
  //              m2c 13/41: it shares the default BLOCK through a `goto` into the else and stores
  //              a merged `void (*)()` local.
  //   gcsedup    CONTROL: `gcsetail` written the way asmlift writes it. MATCH on
  //              `unsigned/unmerge`, fan 64 and no twin — neither twin's gate fires, since
  //              no `ret` is reached from both sides of its outer `if`. It guards against a rewrite
  //              keyed on the lifted C: the shared tail costs 18/44 here, grafted. m2c 14/45.
  //   gcsepre    The loop BEFORE the `if`, one arm on each side. Was 5/45 with 0 of its 40
  //              candidates sharing the tail; CLOSED: **MATCH** on `unsigned/shared-tail`,
  //              fan 40 → 60 (20 twin). m2c 12/47.
  //   gcsepredup CONTROL: `gcsepre` with the default duplicated. MATCH on
  //              `unsigned/unmerge`, with the same IR and the same C as `gcsepre`. The
  //              sunk twin IS in its fan — 20 of 60 — and loses on score; as a DEFAULT it would
  //              take the row to 5/45. That pair is why the sink is ranked. m2c 16/47.
  //   gcsearms   Three arms, two of them after the loop, and one join kept. Was 18/63 with 0 of
  //              its 36 candidates sharing the tail; CLOSED: **MATCH** on
  //              `unsigned/shared-tail`, fan 36 → 68 (32 twin). m2c 8/59.
  //   gcseinner  THE FOLLOW ALONE: `gcsetail` with an inner `if`/`else` in the arm. agbcc does NOT
  //              cross-jump it, so the arm keeps its own `ret` and the sink has nothing to copy.
  //              Was 21/55 with 0 of its 76 candidates sharing the tail; CLOSED: **MATCH** on
  //              `unsigned/shared-ret/unmerge`, fan 76 → 114 (38 `/shared-ret`, 0
  //              `/shared-tail`). m2c 13/51.
  //   gcseinnerdup CONTROL: `gcseinner` with the default duplicated. MATCH on
  //              `unsigned/unmerge`, fan 76 and no twin, and the shared tail grafted onto
  //              its winner costs 23/55. Its IR IS cross-jumped (instrumented), which is why a
  //              sink run as a DEFAULT takes it to 16/57. m2c 14/52.
  //   gcseflat   BOTH TERMS: two arms in the else-ladder, storing `fnA` and `fnC`. One is
  //              cross-jumped into the tail and the other keeps its own `ret`, so its tail is both
  //              a follow and a sink target. Was 19/53 with 0 of its 32 candidates sharing the
  //              tail; CLOSED: **MATCH** on `unsigned/shared-tail`, fan 32 → 96, the one
  //              row besides `gcsearms6` carrying both twins (32 each). m2c 13/51 with
  //              `PROBE_SLOTFNC_MAP`.
  //   gcsefwd    THE FORWARDER: four `u8` accumulators live across the loop, two arms on each
  //              side. The target reaches the tail store through a base reload (`mov r1, ip`) that
  //              the loop-side arms branch to and the else-side arms skip, and it lifts as a
  //              forwarder. Was 30/96 with 0 of its 108 candidates sharing the tail; CLOSED:
  //              **MATCH** on `unsigned/shared-tail/reread-globals`, fan 108 → 204 (96
  //              twin), with no threading step — the sink's source walk sees through the
  //              forwarder. m2c is `noncompile(1)` on its own output, which indexes `gP` as
  //              `*(gP + (i + 5))` against the `struct Slots` the ctx declares ("invalid operands
  //              to binary -").
  //   gcsearms6  BOTH TERMS, and TWO sunk tails: three arms on each side, the closest synthetic to
  //              the real function's seven. agbcc cross-jumps two of the loop-free arms into a
  //              second tail of their own. Was 29/89 with 0 of its 44 candidates sharing the tail;
  //              CLOSED: **MATCH** on `unsigned/shared-tail`, fan 44 → 120 (32
  //              `/shared-tail`, 44 `/shared-ret`). m2c 23/86.
  //   gcsejoin   THE FOLLOW THE SINK DELETES, loop-free. The store after the join writes a
  //              PARAMETER (`p[20] = a`), so the tail block is stores-only and the sink sees a tail
  //              — but that tail is ALREADY the `ret` both sides of the outer `if` reach, and the
  //              `fnA` arm keeps its own. Copying it into its `br` source leaves no shared `ret`,
  //              so a follow enumerated only BEHIND the sink never runs: it was 7/37 (8 candidates,
  //              0 twin) both before this family's build and under a twin that bundled the follow
  //              behind the sink. CLOSED by
  //              enumerating the follow on the fn as raised too: **MATCH** on
  //              `unsigned/shared-ret`, fan 24 (16 twin). No other row has this shape, which is
  //              why the other ten MATCH under the bundled twin as well. m2c is `noncompile(1)` on
  //              its own output, which spells the parameter store as `p->unk14 = a` against the
  //              `u8 *p` the ctx declares ("request for member `unk14' in something not a
  //              structure or union").
  //
  // agbcc ONLY. The other columns were measured on `gcsetail`, `gcsedup`, `gcsepre`, `gcsepredup`
  // and `gcsearms`:
  //   - `ido7.1`: asmlift DECLINES on a branch-likely `beqzl`, the frontend's own gap.
  //   - `mwcc_242_81`: asmlift DECLINES on an SDA-relative `0(0)` base, and m2c noncompiles on
  //     `NULL`.
  //   - `gcc2.7.2kmc`: both decompilers are `noncompile(1)` on all five rows. m2c's error is
  //     ``gP' undeclared`, so the declarations the map carries never reached that compile.
  //   - `gcc2.7.2`: the same, except that asmlift compiles `gcsetail` (32/42).
  //   The MIPS noncompiles are undiagnosed, and they are not this family's link. The other rows
  //   vary the same bodies and were NOT measured off agbcc; they are pinned for the same reason.
  // Every one of those columns measures a different link.
  {
    sym: 'gcsetail',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void gcsetail(void){\n' +
      '  u8 i;\n' +
      '  if ((gP->f[55] & 0x80) != 0) {\n' +
      '    for (i = 0; i < 5; i++) gP->f[i] = 0;\n' +
      '  } else {\n' +
      '    if (gP->f[8] == 0x7F) { gQ.cur = fnA; return; }\n' +
      '  }\n' +
      '  gQ.cur = fnB;\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void gcsetail(void);',
    proto: {
      gcsetail: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOT_MAP,
  },
  {
    sym: 'gcsedup',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void gcsedup(void){\n' +
      '  u8 i;\n' +
      '  if ((gP->f[55] & 0x80) != 0) {\n' +
      '    for (i = 0; i < 5; i++) gP->f[i] = 0;\n' +
      '    gQ.cur = fnB;\n' +
      '  } else {\n' +
      '    if (gP->f[8] == 0x7F) { gQ.cur = fnA; } else { gQ.cur = fnB; }\n' +
      '  }\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void gcsedup(void);',
    proto: {
      gcsedup: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOT_MAP,
  },
  {
    sym: 'gcsepre',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void gcsepre(void){\n' +
      '  u8 i;\n' +
      '  for (i = 0; i < 5; i++) gP->f[i] = 0;\n' +
      '  if ((gP->f[55] & 0x80) != 0) {\n' +
      '    if (gP->f[9] == 0x7F) { gQ.cur = fnA; return; }\n' +
      '  } else {\n' +
      '    if (gP->f[8] == 0x7F) { gQ.cur = fnA; return; }\n' +
      '  }\n' +
      '  gQ.cur = fnB;\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void gcsepre(void);',
    proto: {
      gcsepre: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOT_MAP,
  },
  {
    sym: 'gcsepredup',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void gcsepredup(void){\n' +
      '  u8 i;\n' +
      '  for (i = 0; i < 5; i++) gP->f[i] = 0;\n' +
      '  if ((gP->f[55] & 0x80) != 0) {\n' +
      '    if (gP->f[9] == 0x7F) { gQ.cur = fnA; } else { gQ.cur = fnB; }\n' +
      '  } else {\n' +
      '    if (gP->f[8] == 0x7F) { gQ.cur = fnA; } else { gQ.cur = fnB; }\n' +
      '  }\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void gcsepredup(void);',
    proto: {
      gcsepredup: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOT_MAP,
  },
  {
    sym: 'gcsearms',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void gcsearms(void){\n' +
      '  u8 i;\n' +
      '  if ((gP->f[55] & 0x80) != 0) {\n' +
      '    for (i = 0; i < 5; i++) gP->f[i] = 0;\n' +
      '    if (gP->f[9] == 0x7F) { gP->f[10] = 1; gQ.cur = fnA; return; }\n' +
      '    else if (gP->f[11] == 0x7F) { gP->f[10] = 2; gQ.cur = fnA; return; }\n' +
      '  } else {\n' +
      '    if (gP->f[8] == 0x7F) { gP->f[10] = 3; gQ.cur = fnA; return; }\n' +
      '  }\n' +
      '  gQ.cur = fnB;\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void gcsearms(void);',
    proto: {
      gcsearms: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOT_MAP,
  },
  {
    sym: 'gcseinner',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void gcseinner(void){\n' +
      '  u8 i;\n' +
      '  if ((gP->f[55] & 0x80) != 0) {\n' +
      '    for (i = 0; i < 5; i++) gP->f[i] = 0;\n' +
      '  } else {\n' +
      '    if (gP->f[8] == 0x7F) { if (gP->f[9] != 0) gP->f[10] = 1; else gP->f[10] = 2; gQ.cur = fnA; return; }\n' +
      '  }\n' +
      '  gQ.cur = fnB;\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void gcseinner(void);',
    proto: {
      gcseinner: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOT_MAP,
  },
  {
    sym: 'gcseinnerdup',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void gcseinnerdup(void){\n' +
      '  u8 i;\n' +
      '  if ((gP->f[55] & 0x80) != 0) {\n' +
      '    for (i = 0; i < 5; i++) gP->f[i] = 0;\n' +
      '    gQ.cur = fnB;\n' +
      '  } else {\n' +
      '    if (gP->f[8] == 0x7F) { if (gP->f[9] != 0) gP->f[10] = 1; else gP->f[10] = 2; gQ.cur = fnA; } else { gQ.cur = fnB; }\n' +
      '  }\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void gcseinnerdup(void);',
    proto: {
      gcseinnerdup: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOT_MAP,
  },
  {
    sym: 'gcseflat',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'extern void fnC(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void gcseflat(void){\n' +
      '  u8 i;\n' +
      '  if ((gP->f[55] & 0x80) != 0) {\n' +
      '    for (i = 0; i < 5; i++) gP->f[i] = 0;\n' +
      '  } else {\n' +
      '    if (gP->f[8] == 0x7F) { gQ.cur = fnA; return; }\n' +
      '    if (gP->f[9] == 0x7F) { gQ.cur = fnC; return; }\n' +
      '  }\n' +
      '  gQ.cur = fnB;\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void fnC(void); void gcseflat(void);',
    proto: {
      gcseflat: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
      fnC: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOTFNC_MAP,
  },
  {
    sym: 'gcsefwd',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void gcsefwd(void){\n' +
      '  u8 i, a, b, c, d;\n' +
      '  if ((gP->f[55] & 0x80) != 0) {\n' +
      '    a = 0; b = 0; c = 0; d = 0;\n' +
      '    for (i = 0; i < 5; i++) { a -= gP->f[i]; b -= gP->f[i + 5]; c -= gP->f[i + 10]; d -= gP->f[i + 15]; }\n' +
      '    if (a == b) { gQ.cur = fnA; return; }\n' +
      '    else if (c == d) { gQ.cur = fnA; return; }\n' +
      '  } else {\n' +
      '    if (gP->f[16] == 0x7F) { gQ.cur = fnA; return; }\n' +
      '    if (gP->f[24] == 0x7F) { gQ.cur = fnA; return; }\n' +
      '  }\n' +
      '  gQ.cur = fnB;\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void gcsefwd(void);',
    proto: {
      gcsefwd: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOT_MAP,
  },
  {
    sym: 'gcsearms6',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void gcsearms6(void){\n' +
      '  u8 i;\n' +
      '  if ((gP->f[55] & 0x80) != 0) {\n' +
      '    for (i = 0; i < 5; i++) gP->f[i] = 0;\n' +
      '    if (gP->f[9] == 0x7F) { gP->f[10] = 1; gQ.cur = fnA; return; }\n' +
      '    else if (gP->f[11] == 0x7F) { gP->f[10] = 2; gQ.cur = fnA; return; }\n' +
      '    else if (gP->f[13] == 0x7F) { gP->f[10] = 5; gQ.cur = fnA; return; }\n' +
      '  } else {\n' +
      '    if (gP->f[8] == 0x7F) { gP->f[10] = 3; gQ.cur = fnA; return; }\n' +
      '    else if (gP->f[12] == 0x7F) { gP->f[10] = 4; gQ.cur = fnA; return; }\n' +
      '    else if (gP->f[14] == 0x7F) { gP->f[10] = 6; gQ.cur = fnA; return; }\n' +
      '  }\n' +
      '  gQ.cur = fnB;\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void gcsearms6(void);',
    proto: {
      gcsearms6: { returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOT_MAP,
  },
  {
    sym: 'gcsejoin',
    src:
      'extern void fnA(void);\n' +
      'extern void fnB(void);\n' +
      'struct Q { void (*prev)(void); void (*cur)(void); };\n' +
      'extern struct Q gQ;\n' +
      'struct Slots { u8 f[64]; };\n' +
      'extern struct Slots *gP;\n' +
      'void gcsejoin(u8 *p, u8 a){\n' +
      '  if ((gP->f[55] & 0x80) != 0) {\n' +
      '    gP->f[1] = 7;\n' +
      '  } else {\n' +
      '    if (gP->f[8] == 0x7F) { gP->f[10] = 2; gQ.cur = fnA; return; }\n' +
      '    gP->f[12] = 3;\n' +
      '  }\n' +
      '  p[20] = a;\n' +
      '}',
    features: ['global', 'pointer', 'struct', 'array', 'branch', 'store'],
    toolchains: ['agbcc'],
    ctx: 'void fnA(void); void fnB(void); void gcsejoin(u8 *p, u8 a);',
    proto: {
      gcsejoin: { params: 2, returnsVoid: true },
      fnA: { params: 0, returnsVoid: true },
      fnB: { params: 0, returnsVoid: true },
    },
    symbols: PROBE_SLOT_MAP,
  },
  // THE ADVANCED DEVICE REGISTER — a pointer the source MOVED between two writes, which the target
  // records as `ldr r2,=X; strh [r2]; add r2,#2; strh [r2]`. The `add` is the whole row: it is the
  // only thing separating this source from `reg[1] = b`, which agbcc compiles to `strh [r2, #2]`,
  // and it survives only because the pointee is `volatile`. asmlift's `/advance` variation
  // (l3/advance.ts) reads the lift's own `add` and spells it back.
  //
  // IT EXISTS BECAUSE IT IS THE ONLY PRE-EXISTING ROW THAT WOULD BE ONLY THIS — and none is.
  // `pnpm bench sweep --fan --base origin/main` (2026-09-12: 10 record(s) moved, 0 base-only,
  // 2 head-only, 2114 identical, and not one row whose DEFAULT spelling moved) reaches five rows
  // that already existed — `kleod:StreamCmd_SetWindowRegs` fan 16 -> 17 map-ful and 10 -> 11
  // map-less, `kleod:SetupBG3WindowOverlay` 1024 -> 1048 and 720 -> 744,
  // `synthetic:dma_fill_uninit` 66 -> 78, `synthetic:offhi_split` and `offhi_fused` 12 -> 16 each
  // — plus this row, which is the head-only pair. Every one of the five carries something else the
  // variation does not own (a DMA block, an uninitialised slot, a fused offset), so a regression in the
  // advance alone would surface there as one term of a conjunction. This row is the shape with
  // nothing else in it.
  //
  // …AND ONE OF THE FIVE CANNOT SCORE AT ALL. `kleod:SetupBG3WindowOverlay:agbcc` is a
  // `noncompile` row for a reason this variation does not touch: every one of its 1,048 candidates is
  // `[dropped] agbcc failed: too many arguments to function 'm4aSoundVSyncOff'`, a declaration the
  // row's own context gets wrong (`pnpm bench fan kleod:SetupBG3WindowOverlay:agbcc`, 2026-09-12,
  // prints the 1,048 drops and no ranking). It prices the variation's REACH and buys nothing else: the
  // +24 candidates there are 24 more compiles of a translation unit that cannot compile.
  {
    sym: 'volwalk',
    src:
      '#define REG_WININ (*(volatile u16 *)0x04000048)\n' +
      'void volwalk(s32 a, s32 b){ volatile u16 *reg = &REG_WININ; *reg = a; reg++; *reg = b; }',
    features: [],
    toolchains: ['agbcc'],
    ctx: 'void volwalk(s32 a, s32 b);',
    proto: { volwalk: { params: ['s32', 's32'], returnsVoid: true } },
  },
  // ── O32 and mwcc frame objects and incoming stack arguments (frontend/mips.ts, ppc.ts) ─────
  // An address-taken local and an incoming stack word on the two MIPS lanes the synthetic tier
  // covers; gcc2.7.2 shares gcc2.7.2kmc's description and is pinned by
  // `packages/cli/test/matching/mips-frame.test.ts`. Where the local sits is the compiler's
  // (`compilerBehaviors.o32LocalArea`): right above the home of a0..a3 on gcc, at the frame top
  // above `ra` on IDO. Both lanes take calls here: ido7.1's canonical `-non_shared` build emits a
  // `jal` with an R_MIPS_26 record, which the MIPS frontend lowers like gcc's.
  //
  // `escarr`, `in9e` and `in9` run on mwcc_242_81 too, where the local area is past the back chain
  // and the link-register save word and under the saves (`compilerBehaviors.linkageLocalArea`), and
  // argument word k >= 8 arrives at entry r1 + 8 + 4(k - 8); the mwcc-only rows follow the list.
  //
  // `escarr` is the array handed to a callee and read back, kept as one object; `escaddu` reads it
  // through `addu rD,sp,rX`, whose access displacement names the array (IDO `addu v0,sp,t6` /
  // `lw v0,24(v0)`); `escstr` fills a struct before handing it over.
  {
    sym: 'escarr',
    src: 'void fill(s32 *p);\ns32 escarr(void){ s32 a[4]; fill(a); return a[0] + a[3]; }',
    features: ['stack-addr', 'array'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'],
    ctx: 'void fill(s32 *p); s32 escarr(void);',
    proto: { fill: { params: ['s32 *'], returnsVoid: true } },
  },
  {
    sym: 'escaddu',
    src: 'void k(void *p);\ns32 escaddu(s32 i){ s32 a[8]; k(a); return *(s32 *)((u8 *)a + i); }',
    features: ['stack-addr', 'array', 'pointer'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc'],
    ctx: 'void k(void *p); s32 escaddu(s32 i);',
    proto: { k: { params: ['void *'], returnsVoid: true } },
  },
  {
    sym: 'escstr',
    src: 'struct P { s32 x, y; };\nvoid gp(struct P *p);\ns32 escstr(s32 v){ struct P p; p.x = v; p.y = 2; gp(&p); return p.x; }',
    features: ['stack-addr', 'struct'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc'],
    ctx: 'struct P { s32 x, y; }; void gp(struct P *p); s32 escstr(s32 v);',
    proto: { gp: { params: ['struct P *'], returnsVoid: true } },
  },
  // Incoming stack arguments: O32 passes argument word k >= 4 at entry sp + 4k, so `in9e` reads `e`
  // and `i` at 16(sp) and 32(sp) in a frameless leaf, and `in9` reads them past its own frame, one
  // of them in a block after the branch.
  {
    sym: 'in9e',
    src: 's32 in9e(s32 a, s32 b, s32 c, s32 d, s32 e, s32 f, s32 g, s32 h, s32 i){ return e + i; }',
    features: ['multi-arg'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'],
  },
  {
    sym: 'in9',
    src:
      's32 k1(s32 x);\n' +
      's32 in9(s32 a, s32 b, s32 c, s32 d, s32 e, s32 f, s32 g, s32 h, s32 i){ if (a) return k1(i) + e; return b; }',
    features: ['multi-arg', 'branch'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'mwcc_242_81'],
    ctx: 's32 k1(s32 x); s32 in9(s32 a, s32 b, s32 c, s32 d, s32 e, s32 f, s32 g, s32 h, s32 i);',
    proto: { k1: { params: 1 } },
  },
  // `inasgn` assigns its stack parameter on one path before a call: IDO stores `e` back in place
  // (`beqz a0; sw a1,40(sp); lw a0,40(sp)`), so the read after the join is the caller's word on one
  // path and the stored one on the other — one variable, `@sarg4`, for the load and the store.
  {
    sym: 'inasgn',
    src: 'void g1(s32 x);\ns32 inasgn(s32 a, s32 b, s32 c, s32 d, s32 e){ if (a) e = b; g1(e); return e + b; }',
    features: ['multi-arg', 'branch'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc'],
    ctx: 'void g1(s32 x); s32 inasgn(s32 a, s32 b, s32 c, s32 d, s32 e);',
    proto: { g1: { params: ['s32'], returnsVoid: true } },
  },
  // A VOLATILE STRUCT GLOBAL ONLY THE DECLARATION CONTEXT DESCRIBES, polled in a loop: no `symbols`,
  // so the ctx is the only channel that says `gV` is a struct and that it is volatile. Read
  // through a cast (`*(T *)&gV`, the aggregate spelling), the read must carry the qualifier, or every
  // compiler here loads `gV.a` once and spins on the register; spelled bare (`gV == 0`) it does not
  // compile against the struct. `volpollb` reads the member at byte 2, which takes a subscript on
  // the cast rather than a dereference.
  {
    sym: 'volpoll',
    src: 'struct V { u16 a; u16 b; };\nextern volatile struct V gV;\nvoid volpoll(void){ while (gV.a == 0) ; }',
    features: ['global', 'struct'],
    toolchains: ALL,
    ctx: 'struct V { u16 a; u16 b; }; extern volatile struct V gV; void volpoll(void);',
    proto: { volpoll: { returnsVoid: true } },
  },
  {
    sym: 'volpollb',
    src: 'struct V { u16 a; u16 b; };\nextern volatile struct V gV;\nvoid volpollb(void){ while (gV.b == 0) ; }',
    features: ['global', 'struct'],
    toolchains: ALL,
    ctx: 'struct V { u16 a; u16 b; }; extern volatile struct V gV; void volpollb(void);',
    proto: { volpollb: { returnsVoid: true } },
  },
  // …and through a POINTER the context declares to point at a volatile struct: the pointer itself is
  // plain, read once ahead of the loop, while the member read through its value must keep the
  // qualifier the context states on the pointee (`((volatile u16 *)gQ)[1]`), or the poll is hoisted.
  {
    sym: 'volpollp',
    src: 'struct V { u16 a; u16 b; };\nextern volatile struct V *gQ;\nvoid volpollp(void){ while (gQ->b == 0) ; }',
    features: ['global', 'struct', 'pointer'],
    toolchains: ALL,
    ctx: 'struct V { u16 a; u16 b; }; extern volatile struct V *gQ; void volpollp(void);',
    proto: { volpollp: { returnsVoid: true } },
  },
  // …and through a JOIN of two different volatiles the context declares, the pointer's pointee on
  // one edge and an object on the other: the poll may read either, and each declares it volatile, so
  // it keeps the qualifier, or the read is hoisted out of the loop.
  {
    sym: 'volpollj',
    src:
      'extern volatile u16 *gP;\nextern volatile u16 gW;\n' +
      'void volpollj(int c){ volatile u16 *q = c ? gP : &gW; while (*q == 0) ; }',
    features: ['global', 'pointer'],
    toolchains: ALL,
    ctx: 'extern volatile u16 *gP; extern volatile u16 gW; void volpollj(int c);',
    proto: { volpollj: { params: ['int'], returnsVoid: true } },
  },
  // A FUNCTION-SCOPE TABLE OF ADDRESSES ONLY HANDED TO A CALLEE: nothing reads an element, so only
  // the relocations in it say how wide its elements are, which matters where the compiler writes no
  // directive that would (mwcc). Not on MIPS, which addresses a function-scope static
  // section-relative.
  {
    sym: 'tabesc',
    src:
      'extern s32 ga, gb, gc;\nvoid take(const void *p);\n' +
      'void tabesc(void) { static s32 *const tbl[3] = { &ga, &gb, &gc }; take(tbl); }',
    features: ['pointer'],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx: 'extern s32 ga, gb, gc; void take(const void *p); void tabesc(void);',
    proto: { take: { params: ['const void *'], returnsVoid: true }, tabesc: { returnsVoid: true } },
  },
  // …handed to a callee taking a STRUCT pointer: the bytes type the static `u32 s[2]`, which mwcc's C
  // will not pass as a `struct S *` implicitly, and the prelude cannot print that type, so the
  // argument is cast through `void *`.
  {
    sym: 'tabstr',
    src:
      'struct S { u8 k; void (*p)(void); };\nvoid use2(struct S *);\nvoid f0(void);\n' +
      'void tabstr(void) { static struct S s = { 1, f0 }; use2(&s); }',
    features: ['pointer', 'struct'],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx: 'struct S { u8 k; void (*p)(void); }; void use2(struct S *); void f0(void); void tabstr(void);',
    proto: {
      use2: { params: ['struct S *'], returnsVoid: true },
      f0: { returnsVoid: true },
      tabstr: { returnsVoid: true },
    },
  },
  // mwcc_242_81 only. The other two CodeWarrior builds are pinned by
  // packages/cli/test/matching/ppc-frame.test.ts. `framelist` is marioparty4's CharRandomize shape at
  // its -O0,p: an array indexed through `addi r3,r1,8; stwx`, re-made at each use, under three saved
  // registers. `subslot` is a halfword array, every access to it below a word. `u64loc` hands a
  // 64-bit local to a callee and reads both of its words back, as SLSerialNoCheck does. `deadloc` is
  // fn_1_3994's: a local written in a loop and never read, in a function that makes no call, which
  // -O0,p keeps; the lift keeps it as a local assigned a load, which no dead-store pass drops (a
  // scalar assigned a value it can drop, `int v; v = x;`, lifts to an empty body).
  {
    sym: 'framelist',
    src:
      's32 r8(void);\nvoid framelist(s16 *pro, s16 *out){ s32 i, j, n; s32 list[8]; for (i = 0; i < 4; i++) { n = 0; ' +
      'for (j = 0; j < 8; j++) { if (pro[j]) continue; list[n++] = j; } out[i] = list[r8() % n]; } }',
    features: ['array', 'variable-index', 'continue'],
    toolchains: ['mwcc_242_81'],
    cflags: ['-proc', 'gekko', '-O0,p', '-enum', 'int', '-inline', 'auto', '-fp', 'hard', '-Cpp_exceptions', 'off'],
    ctx: 's32 r8(void); void framelist(s16 *pro, s16 *out);',
    proto: { r8: { params: [] }, framelist: { params: ['s16 *', 's16 *'], returnsVoid: true } },
  },
  {
    sym: 'subslot',
    src: 'void k(void *p);\ns32 subslot(s32 x){ s16 h[2]; h[0] = x; h[1] = x + 1; k(h); return h[1]; }',
    features: ['stack-addr', 'array'],
    toolchains: ['mwcc_242_81'],
    ctx: 'void k(void *p); s32 subslot(s32 x);',
    proto: { k: { params: ['void *'], returnsVoid: true } },
  },
  {
    sym: 'u64loc',
    src:
      's32 gsn(s32 s, u64 *v);\ns32 u64loc(s32 s, u64 *want){ u64 v; if (gsn(s, &v) < 0) return 1; ' +
      'if (v != *want) return 0; return 1; }',
    features: ['stack-addr', 'branch'],
    toolchains: ['mwcc_242_81'],
    ctx: 's32 gsn(s32 s, u64 *v); s32 u64loc(s32 s, u64 *want);',
    proto: { gsn: { params: ['s32', 'u64 *'] } },
  },
  {
    sym: 'deadloc',
    src: 'void deadloc(s32 **p){ s32 *v; s32 **q = p; while (q) { v = *(s32 **)q; q = (s32 **)q[2]; } }',
    features: ['pointer'],
    toolchains: ['mwcc_242_81'],
    cflags: ['-proc', 'gekko', '-O0,p', '-enum', 'int', '-inline', 'auto', '-fp', 'hard', '-Cpp_exceptions', 'off'],
    ctx: 'void deadloc(s32 **p);',
    proto: { deadloc: { params: ['s32 **'], returnsVoid: true } },
  },
  // `homecall` is Mario Party 4's -O0,p homing beside a captured local: the parameter's home at r1+8
  // lies below the array the callee is handed, reaches the call unread and is reloaded after it,
  // which proves it a local's (`compilerBehaviors.localsAboveOutgoingArea`) rather than the call's
  // stack argument. `tbval` hands a struct, spelled through a typedef as decomp headers spell
  // GXColor and Vec, to a callee by value: mwcc passes the address of a copy it builds in the local
  // area, which the lift declines rather than pass the copy where the callee takes the struct.
  {
    sym: 'homecall',
    src: 'void fill(s32 *p);\ns32 homecall(s32 q){ s32 a[2]; fill(a); return a[0] + q; }',
    features: ['stack-addr', 'array'],
    toolchains: ['mwcc_242_81'],
    cflags: ['-proc', 'gekko', '-O0,p', '-enum', 'int', '-inline', 'auto', '-fp', 'hard', '-Cpp_exceptions', 'off'],
    ctx: 'void fill(s32 *p); s32 homecall(s32 q);',
    proto: { fill: { params: ['s32 *'], returnsVoid: true } },
  },
  {
    sym: 'tbval',
    src: 'typedef struct { s32 x, y; } B_t;\ns32 tbT(s32 k, B_t b);\ns32 tbval(B_t *p){ B_t b; b = *p; return tbT(p->x, b); }',
    features: ['struct', 'struct-copy'],
    toolchains: ['mwcc_242_81'],
    ctx: 'typedef struct { s32 x, y; } B_t; s32 tbT(s32 k, B_t b); s32 tbval(B_t *p);',
    proto: { tbT: { params: ['s32', 'B_t'], byValueParams: [1] } },
  },
  // `enumarg` hands an enum, spelled through a typedef as GXTexFmt is, to a seven-parameter callee
  // beside a captured array. The declaration states the enum one word (`wordParams`, as a context
  // reads it), and the call lowering and the local area read that one fact: the call is lowered at
  // its declared arity rather than refused as one nothing declares.
  {
    sym: 'enumarg',
    src:
      'typedef enum { A, B } Fmt;\nvoid use(s32 *p);\ns32 h8(Fmt f, s32 a, s32 b, s32 c, s32 d, s32 e, s32 g);\n' +
      's32 enumarg(s32 k){ s32 buf[2]; use(buf); return h8(A, k, buf[0], buf[1], 4, 5, 6); }',
    features: ['stack-addr', 'array', 'multi-arg'],
    toolchains: ['mwcc_242_81'],
    ctx:
      'typedef enum { A, B } Fmt; void use(s32 *p); s32 h8(Fmt f, s32 a, s32 b, s32 c, s32 d, s32 e, s32 g); ' +
      's32 enumarg(s32 k);',
    proto: {
      use: { params: ['s32 *'], returnsVoid: true },
      h8: { params: ['Fmt', 's32', 's32', 's32', 's32', 's32', 's32'], wordParams: [0] },
    },
  },
  // ── kleod decline census: the ten most common causes a kleod function still declines ──────
  // Every function in kleod's eighteen agbcc units (396; m4a and eeprom build with old_agbcc
  // and are left out) was lifted from agbcc's own `.s` with the project's ELF symbol map and its
  // unit's preprocessed `.i` as `--context`. 39 still decline at f882946. Each one's FIRST blocker
  // was pinned by instrumenting or ablating the refusing site, never by its message: the message
  // names where asmlift stopped, not why, and the census proved the two far apart. Three
  // different messages are ONE cause (the far jump below), and one loop-recovery message is six
  // different causes. None of the 39 is a row, and no row exercised any of these shapes before.
  // Ranked by how many of the 39 each cause blocks first:
  //   1. farjump_cond / farjump_pool / farjump_sealed (17). agbcc spells a branch past Thumb's
  //      ±2 KB reach as `bl .Lx @far jump` (thumb.md `*cond_branch` and `jump`) and pushes lr in
  //      any function that does (thumb.c far_jump_used_p), so lr is dead there. asmlift drops the
  //      `@` comment that says so before decoding, reads the `bl` as a call, and refuses three
  //      different ways depending on what follows it: a `bl` to a label of this function
  //      (_cond), an unsealed `.align` after the relay that base 0 and base 2 decode differently
  //      (_pool), or, when an earlier pool already fixed the parity, a block that runs into the
  //      pool (_sealed). Lowering the relay to `b` in the probes' `.s` lifts and MATCHes them.
  //      Thumb only: no other synthetic toolchain has a branch this short.
  //   2. sret4two / sret4mem (3). A struct of four bytes or less returned by value comes back
  //      through a hidden pointer to a frame temp on agbcc. With one word of frame, the read of a
  //      member is what is not modelled (sret4mem); with two temps, the offset-0 capture is not an
  //      object at all and the load is `sp` read as data (sret4two). O32 returns every aggregate
  //      through a hidden pointer in a0, so both lift on gcc2.7.2; sret4two declines on ido7.1
  //      (IDO re-reads the u16 argument's home half) and gcc2.7.2kmc (v0 read past the call), the
  //      same as its void out-pointer twin, so neither is the struct return. mwcc_242_81 declines
  //      on r3 read after the call destroyed it.
  //      sret1w, sret2h, sret8 and sret12 pin the O32 rule at {u32}, {u16}, 8 and 12 bytes, and
  //      sretglob a struct returned straight into a global, which declines. sretloop calls one in a
  //      loop gcc rotates, so a0 is set ahead of the loop and in the back branch's delay slot and
  //      reaches the jal as a merge naming one local; ido7.1 does not rotate it. A u32 member read
  //      whole spells through an s32 cast (structure.ts `spellsAccessType`), which is what keeps
  //      sret1w off a match on gcc and sret8/sret12 on ido7.1. On agbcc {u32} and {u16} come back
  //      in r0 and are read off the local the call assigns (frontend/register-struct-call.ts), 8
  //      and 12 bytes decline on the temp overlapping an SSA slot; mwcc returns 8 bytes or less in
  //      r3/r3:r4, reads up to four the same way, folds the frame home it stores r3 to into that
  //      local, declines on the pair r3:r4 (sret8), and lowers no hidden pointer for 12.
  //      sret1b and sret2b add {u8} (r0/r3 on both) and {u8, u8} (memory on agbcc, r3 on mwcc,
  //      read back off its home); sretun a union and sretbf a bitfield, which have no local type
  //      and decline wherever they come back in a register; sretfwd a function returning such a
  //      struct straight from such a callee, which returns the call (`return sg(1);`), and
  //      sretname the same through a named local, which mwcc gives a home the bare call has not;
  //      sret2fwd the {u16} forwarded the same way, and sret2mod a {u16} modified before it is
  //      returned, which declines where it comes back in a register (agbcc keeps the pad's bits,
  //      no member copy says so); sretfl a {float}, which has no local here and declines on agbcc
  //      (r0 read as `*(s32 *)&s` would convert the bits), on mwcc's lfs and ido's lwc1, and where
  //      gcc reads the member back through memory as a word (the same cast). A callee declared
  //      without its struct return stays a scalar call, as the same bytes from a scalar callee do;
  //      that control is a core test
  //      (packages/core/test/register-struct-call.test.ts), since as a row it would be sret1w
  //      alpha-renamed. So is sret2h with no declaration of its own, which mwcc lifts void, since
  //      its guessed return would read r3 below the {u16}: as a row it would be sret2h.
  //   3. break_value (2). A `break` that carries a different value than the normal exit gets its
  //      own empty edge block, so the loop has two exit targets and none is a return. agbcc only:
  //      ido7.1 and gcc2.7.2kmc decline first on a `%hi` half read as a value, so the row would
  //      measure that link there instead. Its CodeWarrior twins, whose -O4,p unrolls the loop into
  //      a chain of `lbzu`, are in the update-form section.
  //   4. spilldead (2). A spilled loop local whose last store reaches `bl done` unread read as
  //      that call's outgoing stack argument, although `done` is declared with one parameter and
  //      the slot is reloaded inside the loop. agbcc lifts it since a word the function loads
  //      anywhere bounds the area (`frontend/stackargs.ts` `loadedWordBound`). gcc2.7.2kmc and
  //      mwcc_242_81 lift it (controls); ido7.1 is off because it declines first on a pre-update
  //      loop variable.
  //   5. break_code (1, plus one that pairs it with a `goto`). The break arm runs code, so it is
  //      outside the natural loop and becomes a second live exit. agbcc also peels the first test
  //      into the entry, which it does only for a top-tested source (stmt.c expand_end_loop, jump.c
  //      duplicate_loop_exit_test), so the re-rolled loop gets its folded top test back
  //      (raise/reroll.ts `restoreTopTest`). The loop's shape decides the bytes on agbcc and the
  //      CodeWarrior builds only; ido7.1 walks a pointer to a separately built end, and mwcc counts
  //      down `ctr`. gcc2.7.2kmc and gcc2.7.2 are controls. `dowbreak_code` is its do-while twin, a
  //      bottom-tested source with no peel, which keeps its bottom test on every toolchain.
  //      `breakret_code` ends in a `return`, which the arm must not copy; `breakidx_code` reads the
  //      counter after the loop, a value the head and the arm hand the exit alike. `breakn_code`
  //      bounds the loop by a parameter, so agbcc keeps the copied test as a guard rather than fold
  //      it, which the restore then deletes; on gcc2.7.2kmc and gcc2.7.2 the same source is a guard
  //      and a bottom test with no peel, which the default lift keeps and a ranked candidate
  //      matches. `breaknend_code` exits straight into the epilogue, where the arm's sunk `return`
  //      is the `break` it fell from. `breakretarm_code` can return from the arm as well as break:
  //      the `while` writes the arm's own `return` inside it, ahead of the `break` (structure.ts
  //      `codeBreakArm`). `breakinv_code`'s arm reads a value computed ahead of the loop, which
  //      crosses it in a register and is named there (structure/analysis.ts, a pure value carried
  //      across a loop), not inlined into the arm. `breakretinc_code` is `breakretarm_code` with
  //      `gHit += 1`: mwcc leaves r3 holding gHit's value on one exit and the walked pointer on the
  //      other, a join only the void function's `ret` reads, which must not type gHit as a pointer
  //      (pipeline.ts `dropVoidReturnOperands`).
  // The last five are one-function causes, picked from the twelve such causes for being real gaps
  // whose shape is not Thumb-specific, so each row measures more than one compiler:
  //   6. forever_noexit: `while (1)` with no exit edge. The forever classifier iterates over exit
  //      targets and finds none. Declines on all four toolchains.
  //   7. loop_elsebreak: an `else break` one level inside an if/else-if chain makes the branch's
  //      post-dominator the loop exit, so the if joins outside the body. Declines on agbcc,
  //      ido7.1 and gcc2.7.2kmc; mwcc_242_81 lifts it (a control).
  //   8. sw_jtholeif: a jump table with holes and no `default`, two of whose arms hold an if
  //      that leaves the switch. Only the early-end retry gives that switch an end, at the default
  //      block, which the holes also make an arm, so the retry must not refuse it as a case arm.
  //      agbcc and ido7.1 reach the retry; gcc2.7.2kmc and mwcc_242_81 do not (controls).
  //   9. uninitfirst: uninit_spill's local read BEFORE any store, so no store reaches the slot on
  //      any path. agbcc lifts it, reading the word as the uninitialised local (`frontend/thumb.ts`'s
  //      own-frame load arm); ido7.1 declines on a never-stored slot, and mwcc_242_81 on r1 used
  //      as data (not instrumented there, so that attribution is a prediction).
  //      gcc2.7.2kmc lifts it to a nonmatch.
  //  10. byvalregs: a by-value struct argument built in the frame and passed in registers.
  //      Declines on all four: agbcc reads the frame words as `sp` data, the MIPS frontends refuse
  //      the frame, and mwcc_242_81 refuses the by-value parameter itself (it passes a copy's
  //      address, `tbval`).
  //  11. bvwg, bvqg, bvtg, bvqp, bvcg: a struct passed by value straight from a global (one, two and
  //      three words), through a pointer, and a `u8[4]` struct. O32 passes the words in argument
  //      registers (kmc through one `lui`/`lw` pair per word, IDO storing each into its home slot),
  //      which the call plan folds into the global passed whole. Through a pointer declines on every
  //      toolchain, and the `u8[4]` struct on both MIPS ones (IDO copies it with `lwl`/`swl`, gcc
  //      packs its bytes into a register). mwcc_242_81 passes a copy's address and declines; agbcc
  //      is the control. One statement per line: IDO schedules by source line. gcc2.7.2 is pinned
  //      in packages/cli/test/matching/mips-calls.test.ts.
  // Set aside, each one kleod function: a `goto` into a shared tail (sound under the no-goto
  // rule), a jump-threaded break, a struct return inside a loop, a table case aliasing `default`,
  // a cross-jumped case `break`, `ldrsb` through a zero offset register, two indexed local tables,
  // and a straddling u8 bitfield.
  {
    sym: 'farjump_cond',
    src:
      'extern void h(void);\n' +
      '#define H4 h(); h(); h(); h();\n' +
      '#define H32 H4 H4 H4 H4 H4 H4 H4 H4\n' +
      '#define H512 H32 H32 H32 H32 H32 H32 H32 H32 H32 H32 H32 H32 H32 H32 H32 H32\n' +
      'void farjump_cond(s32 a)\n{\n    if (a > 5)\n        return;\n    H512\n}',
    features: ['branch', 'macro'],
    toolchains: ['agbcc'],
    ctx: 'void h(void); void farjump_cond(s32 a);',
    proto: { h: { params: 0, returnsVoid: true }, farjump_cond: { returnsVoid: true } },
  },
  {
    sym: 'farjump_pool',
    src:
      'extern void f(s32 n);\n' +
      '#define A(n) f(n); f(n + 0x10000); f(n + 0x20000); f(n + 0x30000);\n' +
      '#define B(n) A(n) A(n + 1) A(n + 2) A(n + 3)\n' +
      '#define C(n) B(n) B(n + 4) B(n + 8) B(n + 12)\n' +
      'void farjump_pool(s32 x)\n{\n    if (x) {\n        f(0x12345);\n    } else {\n' +
      '        C(0x1000) C(0x1100) C(0x1200) C(0x1300) C(0x1400)\n    }\n    f(2);\n}',
    features: ['branch', 'macro'],
    toolchains: ['agbcc'],
    ctx: 'void f(s32 n); void farjump_pool(s32 x);',
    proto: { f: { params: 1, returnsVoid: true }, farjump_pool: { returnsVoid: true } },
  },
  {
    sym: 'farjump_sealed',
    src:
      'extern void f(s32 n);\n' +
      '#define A(n) f(n); f(n + 0x10000); f(n + 0x20000); f(n + 0x30000);\n' +
      '#define B(n) A(n) A(n + 1) A(n + 2) A(n + 3)\n' +
      '#define C(n) B(n) B(n + 4) B(n + 8) B(n + 12)\n' +
      'void farjump_sealed(s32 x, s32 y)\n{\n    if (y) {\n        f(0x54321);\n    } else {\n        f(3);\n    }\n' +
      '    if (x) {\n        f(0x12345);\n    } else {\n' +
      '        C(0x1000) C(0x1100) C(0x1200) C(0x1300) C(0x1400)\n    }\n    f(2);\n}',
    features: ['branch', 'macro'],
    toolchains: ['agbcc'],
    ctx: 'void f(s32 n); void farjump_sealed(s32 x, s32 y);',
    proto: { f: { params: 1, returnsVoid: true }, farjump_sealed: { returnsVoid: true } },
  },
  {
    sym: 'sret4two',
    src:
      'struct S4 { u16 a; u8 b; u8 pad; };\nextern struct S4 mk(u16 x, u16 y, u8 z);\nextern u16 gOut, gOut2;\n' +
      'void sret4two(u16 x)\n{\n    struct S4 s;\n    s = mk(x, 0, 0x10);\n' +
      '    if (s.a != 0xFFFF) {\n        gOut = s.a;\n        gOut2 = s.b;\n    }\n' +
      '    s = mk(x + 4, 0, 0x10);\n    if (s.a != 0xFFFF) {\n        gOut = s.a;\n        gOut2 = s.b;\n    }\n}',
    features: ['struct-return', 'field'],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 'struct S4 { u16 a; u8 b; u8 pad; };\nstruct S4 mk(u16 x, u16 y, u8 z);\nvoid sret4two(u16 x);',
    proto: {
      mk: {
        params: ['u16', 'u16', 'u8'],
        returns: 'struct S4',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u16' },
            { name: 'b', type: 'u8' },
            { name: 'pad', type: 'u8' },
          ],
        },
      },
      sret4two: { returnsVoid: true },
    },
  },
  {
    sym: 'sret4mem',
    src:
      'struct S4 { u16 a; u8 b; u8 pad; };\nextern struct S4 mk(u16 x, u16 y, u8 z);\nextern u16 gOut;\n' +
      'void sret4mem(u16 x)\n{\n    struct S4 s = mk(x, 0, 0x10);\n    gOut = s.a;\n}',
    features: ['struct-return', 'field'],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 'struct S4 { u16 a; u8 b; u8 pad; };\nstruct S4 mk(u16 x, u16 y, u8 z);\nvoid sret4mem(u16 x);',
    proto: {
      mk: {
        params: ['u16', 'u16', 'u8'],
        returns: 'struct S4',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u16' },
            { name: 'b', type: 'u8' },
            { name: 'pad', type: 'u8' },
          ],
        },
      },
      sret4mem: { returnsVoid: true },
    },
  },
  {
    sym: 'sret1w',
    src:
      'struct S1w { u32 x; };\nextern struct S1w mk1(s32 x);\nextern u32 gW;\n' +
      'void sret1w(s32 x)\n{\n    struct S1w s = mk1(x);\n    gW = s.x;\n}',
    features: ['struct-return', 'field'],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 'struct S1w { u32 x; };\nstruct S1w mk1(s32 x);\nvoid sret1w(s32 x);',
    proto: {
      mk1: {
        params: ['s32'],
        returns: 'struct S1w',
        returnLayout: { kind: 'struct', members: [{ name: 'x', type: 'u32' }] },
      },
      sret1w: { returnsVoid: true },
    },
  },
  {
    sym: 'sret2h',
    src:
      'struct S2 { u16 h; };\nextern struct S2 mk2(s32 x);\nextern u16 gOut;\n' +
      'void sret2h(s32 x)\n{\n    struct S2 s = mk2(x);\n    gOut = s.h;\n}',
    features: ['struct-return', 'field'],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 'struct S2 { u16 h; };\nstruct S2 mk2(s32 x);\nvoid sret2h(s32 x);',
    proto: {
      mk2: {
        params: ['s32'],
        returns: 'struct S2',
        returnLayout: { kind: 'struct', members: [{ name: 'h', type: 'u16' }] },
      },
      sret2h: { returnsVoid: true },
    },
  },
  {
    sym: 'sret8',
    src:
      'struct S8 { u32 a, b; };\nextern struct S8 mk8(s32 x);\nextern u32 gW, gW2;\n' +
      'void sret8(s32 x)\n{\n    struct S8 s = mk8(x);\n    gW = s.a;\n    gW2 = s.b;\n}',
    features: ['struct-return', 'field'],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 'struct S8 { u32 a, b; };\nstruct S8 mk8(s32 x);\nvoid sret8(s32 x);',
    proto: {
      mk8: {
        params: ['s32'],
        returns: 'struct S8',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u32' },
            { name: 'b', type: 'u32' },
          ],
        },
      },
      sret8: { returnsVoid: true },
    },
  },
  {
    sym: 'sret12',
    src:
      'struct S12 { u32 a, b, c; };\nextern struct S12 mk12(s32 x);\nextern u32 gW, gW2;\n' +
      'void sret12(s32 x)\n{\n    struct S12 s = mk12(x);\n    gW = s.a;\n    gW2 = s.c;\n}',
    features: ['struct-return', 'field'],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 'struct S12 { u32 a, b, c; };\nstruct S12 mk12(s32 x);\nvoid sret12(s32 x);',
    proto: {
      mk12: {
        params: ['s32'],
        returns: 'struct S12',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u32' },
            { name: 'b', type: 'u32' },
            { name: 'c', type: 'u32' },
          ],
        },
      },
      sret12: { returnsVoid: true },
    },
  },
  {
    sym: 'sretglob',
    src:
      'struct S8 { u32 a, b; };\nextern struct S8 mk8(s32 x);\nextern struct S8 gS8;\n' +
      'void sretglob(s32 x)\n{\n    gS8 = mk8(x);\n}',
    features: ['struct-return', 'global'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'struct S8 { u32 a, b; };\nstruct S8 mk8(s32 x);\nextern struct S8 gS8;\nvoid sretglob(s32 x);',
    proto: {
      mk8: {
        params: ['s32'],
        returns: 'struct S8',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u32' },
            { name: 'b', type: 'u32' },
          ],
        },
      },
      sretglob: { returnsVoid: true },
    },
  },
  {
    sym: 'sretloop',
    src:
      'struct QR { s32 quot, rem; };\nextern struct QR qdiv(s32 n, s32 d);\n' +
      'void sretloop(u8 *p, s32 lo)\n{\n    struct QR qr;\n    while (lo > 0) {\n' +
      "        qr = qdiv(lo, 10);\n        *--p = qr.rem + '0';\n        lo = qr.quot;\n    }\n}",
    features: ['struct-return', 'field'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'struct QR { s32 quot, rem; };\nstruct QR qdiv(s32 n, s32 d);\nvoid sretloop(u8 *p, s32 lo);',
    proto: {
      qdiv: {
        params: ['s32', 's32'],
        returns: 'struct QR',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'quot', type: 's32' },
            { name: 'rem', type: 's32' },
          ],
        },
      },
      sretloop: { returnsVoid: true },
    },
  },
  // The register-returned shapes above on every toolchain they compile on, and on the two mwcc
  // builds that need their own flags.
  ...(
    [
      [[...ALL, 'gcc2.7.2'], undefined],
      [['mwcc_233_163n', 'mwcc_247_107'], MWCC_O4P],
    ] as const
  ).flatMap(([toolchains, cflags]): SynthSpec[] => {
    const at = { toolchains: [...toolchains], ...(cflags === undefined ? {} : { cflags: [...cflags] }) };
    const one = (name: string, type: string) => ({ kind: 'struct' as const, members: [{ name, type }] });
    return [
      {
        sym: 'sret1b',
        src:
          'struct S1b { u8 b; };\nextern struct S1b mk1b(s32 x);\nextern u8 gB;\n' +
          'void sret1b(s32 x)\n{\n    struct S1b s = mk1b(x);\n    gB = s.b;\n}',
        features: ['struct-return', 'field'],
        ...at,
        ctx: 'struct S1b { u8 b; };\nstruct S1b mk1b(s32 x);\nvoid sret1b(s32 x);',
        proto: {
          mk1b: { params: ['s32'], returns: 'struct S1b', returnLayout: one('b', 'u8') },
          sret1b: { returnsVoid: true },
        },
      },
      {
        sym: 'sret2b',
        src:
          'struct S2b { u8 a; u8 b; };\nextern struct S2b mk2b(s32 x);\nextern u8 gB;\n' +
          'void sret2b(s32 x)\n{\n    struct S2b s = mk2b(x);\n    gB = s.b;\n}',
        features: ['struct-return', 'field'],
        ...at,
        ctx: 'struct S2b { u8 a; u8 b; };\nstruct S2b mk2b(s32 x);\nvoid sret2b(s32 x);',
        proto: {
          mk2b: {
            params: ['s32'],
            returns: 'struct S2b',
            returnLayout: {
              kind: 'struct',
              members: [
                { name: 'a', type: 'u8' },
                { name: 'b', type: 'u8' },
              ],
            },
          },
          sret2b: { returnsVoid: true },
        },
      },
      {
        sym: 'sretun',
        src:
          'union Un { u32 w; u16 h; };\nextern union Un mkun(s32 x);\nextern u16 gOut;\n' +
          'void sretun(s32 x)\n{\n    union Un u = mkun(x);\n    gOut = u.h;\n}',
        features: ['struct-return', 'union'],
        ...at,
        ctx: 'union Un { u32 w; u16 h; };\nunion Un mkun(s32 x);\nvoid sretun(s32 x);',
        proto: {
          mkun: {
            params: ['s32'],
            returns: 'union Un',
            returnLayout: {
              kind: 'union',
              members: [
                { name: 'w', type: 'u32' },
                { name: 'h', type: 'u16' },
              ],
            },
          },
          sretun: { returnsVoid: true },
        },
      },
      {
        sym: 'sretbf',
        src:
          'struct Bf { u32 a : 4; u32 b : 4; };\nextern struct Bf mkbf(s32 x);\nextern u32 gW;\n' +
          'void sretbf(s32 x)\n{\n    struct Bf s = mkbf(x);\n    gW = s.b;\n}',
        features: ['struct-return', 'bitfield'],
        ...at,
        ctx: 'struct Bf { u32 a : 4; u32 b : 4; };\nstruct Bf mkbf(s32 x);\nvoid sretbf(s32 x);',
        proto: {
          mkbf: {
            params: ['s32'],
            returns: 'struct Bf',
            returnLayout: {
              kind: 'struct',
              members: [
                { name: 'a', type: 'u32', bits: 4 },
                { name: 'b', type: 'u32', bits: 4 },
              ],
            },
          },
          sretbf: { returnsVoid: true },
        },
      },
      {
        sym: 'sretfwd',
        src: 'struct S1f { u32 x; };\nextern struct S1f sg(s32 x);\nstruct S1f sretfwd(void)\n{\n    return sg(1);\n}',
        features: ['struct-return'],
        ...at,
        ctx: 'struct S1f { u32 x; };\nstruct S1f sg(s32 x);\nstruct S1f sretfwd(void);',
        proto: {
          sg: { params: ['s32'], returns: 'struct S1f', returnLayout: one('x', 'u32') },
          sretfwd: { params: [], returns: 'struct S1f', returnLayout: one('x', 'u32') },
        },
      },
      {
        sym: 'sretname',
        src:
          'struct S1n { u32 x; };\nextern struct S1n sn(s32 x);\nstruct S1n sretname(void)\n{\n' +
          '    struct S1n s = sn(2);\n    return s;\n}',
        features: ['struct-return', 'value-home'],
        ...at,
        ctx: 'struct S1n { u32 x; };\nstruct S1n sn(s32 x);\nstruct S1n sretname(void);',
        proto: {
          sn: { params: ['s32'], returns: 'struct S1n', returnLayout: one('x', 'u32') },
          sretname: { params: [], returns: 'struct S1n', returnLayout: one('x', 'u32') },
        },
      },
      {
        sym: 'sret2fwd',
        src: 'struct S2f { u16 h; };\nextern struct S2f sh(s32 x);\nstruct S2f sret2fwd(s32 x)\n{\n    return sh(x + 3);\n}',
        features: ['struct-return', 'narrow'],
        ...at,
        ctx: 'struct S2f { u16 h; };\nstruct S2f sh(s32 x);\nstruct S2f sret2fwd(s32 x);',
        proto: {
          sh: { params: ['s32'], returns: 'struct S2f', returnLayout: one('h', 'u16') },
          sret2fwd: { params: ['s32'], returns: 'struct S2f', returnLayout: one('h', 'u16') },
        },
      },
      {
        sym: 'sret2mod',
        src:
          'struct S2m { u16 h; };\nextern struct S2m sm(s32 x);\nstruct S2m sret2mod(s32 x)\n{\n' +
          '    struct S2m s = sm(x);\n    s.h += 1;\n    return s;\n}',
        features: ['struct-return', 'field'],
        ...at,
        ctx: 'struct S2m { u16 h; };\nstruct S2m sm(s32 x);\nstruct S2m sret2mod(s32 x);',
        proto: {
          sm: { params: ['s32'], returns: 'struct S2m', returnLayout: one('h', 'u16') },
          sret2mod: { params: ['s32'], returns: 'struct S2m', returnLayout: one('h', 'u16') },
        },
      },
      {
        sym: 'sretfl',
        src:
          'struct Fl { float f; };\nextern struct Fl mkfl(s32 x);\nextern float gF;\n' +
          'void sretfl(s32 x)\n{\n    struct Fl s = mkfl(x);\n    gF = s.f;\n}',
        features: ['struct-return', 'float'],
        ...at,
        ctx: 'struct Fl { float f; };\nstruct Fl mkfl(s32 x);\nvoid sretfl(s32 x);',
        proto: {
          mkfl: { params: ['s32'], returns: 'struct Fl', returnLayout: one('f', 'float') },
          sretfl: { returnsVoid: true },
        },
      },
      // a member stored through a POINTER global's value: the element is the pointee's, never the
      // pointer variable's own storage (`&gIP`), which an array global's cast cell would address
      {
        sym: 'sretpidx',
        src:
          'struct S1p { u32 x; };\nextern struct S1p mkp(s32 x);\nextern s32 *gIP;\n' +
          'void sretpidx(s32 x, s32 i)\n{\n    struct S1p s = mkp(x);\n    gIP[i] = s.x;\n}',
        features: ['struct-return', 'pointer'],
        ...at,
        ctx: 'struct S1p { u32 x; };\nstruct S1p mkp(s32 x);\nvoid sretpidx(s32 x, s32 i);',
        proto: {
          mkp: { params: ['s32'], returns: 'struct S1p', returnLayout: one('x', 'u32') },
          sretpidx: { returnsVoid: true },
        },
      },
    ];
  }),
  // sret1w and sret2h on the two mwcc builds that need their own flags.
  {
    sym: 'sret1w',
    src:
      'struct S1w { u32 x; };\nextern struct S1w mk1(s32 x);\nextern u32 gW;\n' +
      'void sret1w(s32 x)\n{\n    struct S1w s = mk1(x);\n    gW = s.x;\n}',
    features: ['struct-return', 'field'],
    toolchains: ['mwcc_233_163n', 'mwcc_247_107'],
    cflags: MWCC_O4P,
    ctx: 'struct S1w { u32 x; };\nstruct S1w mk1(s32 x);\nvoid sret1w(s32 x);',
    proto: {
      mk1: {
        params: ['s32'],
        returns: 'struct S1w',
        returnLayout: { kind: 'struct', members: [{ name: 'x', type: 'u32' }] },
      },
      sret1w: { returnsVoid: true },
    },
  },
  {
    sym: 'sret2h',
    src:
      'struct S2 { u16 h; };\nextern struct S2 mk2(s32 x);\nextern u16 gOut;\n' +
      'void sret2h(s32 x)\n{\n    struct S2 s = mk2(x);\n    gOut = s.h;\n}',
    features: ['struct-return', 'field'],
    toolchains: ['mwcc_233_163n', 'mwcc_247_107'],
    cflags: MWCC_O4P,
    ctx: 'struct S2 { u16 h; };\nstruct S2 mk2(s32 x);\nvoid sret2h(s32 x);',
    proto: {
      mk2: {
        params: ['s32'],
        returns: 'struct S2',
        returnLayout: { kind: 'struct', members: [{ name: 'h', type: 'u16' }] },
      },
      sret2h: { returnsVoid: true },
    },
  },
  {
    sym: 'break_value',
    src:
      'extern u8 gTab[16];\nextern u8 gVal[16];\nextern s32 gOut;\n' +
      'void break_value(void)\n{\n    u32 i;\n    u32 r = 1;\n    for (i = 1; i < 9; i++) {\n' +
      '        if (gTab[i] == 0x1C) {\n            r = i;\n            break;\n        }\n    }\n    gOut = gVal[r];\n}',
    features: ['break', 'array'],
    toolchains: ['agbcc'],
    ctx: 'void break_value(void);',
    proto: { break_value: { returnsVoid: true } },
  },
  {
    sym: 'break_code',
    src:
      'extern u8 gTab[16];\nextern s32 gHit;\nextern s32 gOut;\n' +
      'void break_code(void)\n{\n    u32 i;\n    for (i = 0; i < 16; i++) {\n' +
      '        if (gTab[i] == 7) {\n            gHit = 1;\n            break;\n        }\n    }\n    gOut = 0;\n}',
    features: ['break', 'array'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    ctx: 'void break_code(void);',
    proto: { break_code: { returnsVoid: true } },
  },
  {
    sym: 'break_code',
    src:
      'extern u8 gTab[16];\nextern s32 gHit;\nextern s32 gOut;\n' +
      'void break_code(void)\n{\n    u32 i;\n    for (i = 0; i < 16; i++) {\n' +
      '        if (gTab[i] == 7) {\n            gHit = 1;\n            break;\n        }\n    }\n    gOut = 0;\n}',
    features: ['break', 'array'],
    toolchains: ['mwcc_233_163n', 'mwcc_247_107'],
    cflags: MWCC_O4P,
    ctx: 'void break_code(void);',
    proto: { break_code: { returnsVoid: true } },
  },
  ...(
    [
      [['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'], undefined],
      [['mwcc_233_163n', 'mwcc_247_107'], MWCC_O4P],
    ] as const
  ).map(([toolchains, cflags]) => ({
    sym: 'dowbreak_code',
    src:
      'extern u8 gTab[16];\nextern s32 gHit;\nextern s32 gOut;\n' +
      'void dowbreak_code(void)\n{\n    u32 i;\n    i = 0;\n    do {\n' +
      '        if (gTab[i] == 7) {\n            gHit = 1;\n            break;\n        }\n        i++;\n    } while (i < 16);\n' +
      '    gOut = 0;\n}',
    features: ['break', 'array'],
    toolchains: [...toolchains],
    ...(cflags ? { cflags } : {}),
    ctx: 'void dowbreak_code(void);',
    proto: { dowbreak_code: { returnsVoid: true } },
  })),
  ...(
    [
      [['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'], undefined],
      [['mwcc_233_163n', 'mwcc_247_107'], MWCC_O4P],
    ] as const
  ).flatMap(([toolchains, cflags]) => [
    {
      sym: 'breakret_code',
      src:
        'extern u8 gTab[16];\nextern s32 gHit;\nextern s32 gOut;\n' +
        's32 breakret_code(void)\n{\n    u32 i;\n    for (i = 0; i < 16; i++) {\n' +
        '        if (gTab[i] == 7) {\n            gHit = 1;\n            break;\n        }\n    }\n    return gOut;\n}',
      features: ['break', 'array'],
      toolchains: [...toolchains],
      ...(cflags ? { cflags } : {}),
      ctx: 's32 breakret_code(void);',
    },
    {
      sym: 'breakidx_code',
      src:
        'extern u8 gTab[16];\nextern s32 gHit;\nextern s32 gOut;\n' +
        'void breakidx_code(void)\n{\n    u32 i;\n    for (i = 0; i < 16; i++) {\n' +
        '        if (gTab[i] == 7) {\n            gHit = 1;\n            break;\n        }\n    }\n    gOut = i;\n}',
      features: ['break', 'array'],
      toolchains: [...toolchains],
      ...(cflags ? { cflags } : {}),
      ctx: 'void breakidx_code(void);',
      proto: { breakidx_code: { returnsVoid: true } },
    },
    {
      sym: 'breakn_code',
      src:
        'extern u8 gTab[128];\nextern s32 gHit;\nextern s32 gOut;\n' +
        'void breakn_code(s32 n)\n{\n    s32 i;\n    for (i = 0; i < n; i++) {\n' +
        '        if (gTab[i] == 7) {\n            gHit = 1;\n            break;\n        }\n    }\n    gOut = 0;\n}',
      features: ['break', 'array'],
      toolchains: [...toolchains],
      ...(cflags ? { cflags } : {}),
      ctx: 'void breakn_code(s32 n);',
      proto: { breakn_code: { returnsVoid: true } },
    },
    {
      sym: 'breaknend_code',
      src:
        'extern u8 gTab[128];\nextern s32 gHit;\n' +
        'void breaknend_code(s32 n)\n{\n    s32 i;\n    for (i = 0; i < n; i++) {\n' +
        '        if (gTab[i] == 7) {\n            gHit = 1;\n            break;\n        }\n    }\n}',
      features: ['break', 'array'],
      toolchains: [...toolchains],
      ...(cflags ? { cflags } : {}),
      ctx: 'void breaknend_code(s32 n);',
      proto: { breaknend_code: { returnsVoid: true } },
    },
    {
      sym: 'breakretarm_code',
      src:
        'extern u8 gTab[16];\nextern s32 gHit;\nextern s32 gOut;\nextern s32 gKey;\n' +
        'void breakretarm_code(void)\n{\n    u32 i;\n    for (i = 0; i < 16; i++) {\n' +
        '        if (gTab[i] == 7) {\n            if (gKey)\n                return;\n            gHit = 1;\n            break;\n        }\n    }\n    gOut = 0;\n}',
      features: ['break', 'array'],
      toolchains: [...toolchains],
      ...(cflags ? { cflags } : {}),
      ctx: 'void breakretarm_code(void);',
      proto: { breakretarm_code: { returnsVoid: true } },
    },
    {
      sym: 'breakinv_code',
      src:
        'extern u8 gTab[16];\nextern s32 gHit;\nextern s32 gOut;\n' +
        'void breakinv_code(s32 n)\n{\n    s32 i, j;\n    j = n * 3;\n    for (i = 0; i < 16; i++) {\n' +
        '        if (gTab[i] == 7) {\n            gHit = j;\n            break;\n        }\n    }\n    gOut = 0;\n}',
      features: ['break', 'array'],
      toolchains: [...toolchains],
      ...(cflags ? { cflags } : {}),
      ctx: 'void breakinv_code(s32 n);',
      proto: { breakinv_code: { returnsVoid: true } },
    },
    {
      sym: 'breakretinc_code',
      src:
        'extern u8 gTab[16];\nextern s32 gHit;\nextern s32 gOut;\nextern s32 gKey;\n' +
        'void breakretinc_code(void)\n{\n    u32 i;\n    for (i = 0; i < 16; i++) {\n' +
        '        if (gTab[i] == 7) {\n            if (gKey)\n                return;\n            gHit += 1;\n            break;\n        }\n    }\n    gOut = 0;\n}',
      features: ['break', 'array'],
      toolchains: [...toolchains],
      ...(cflags ? { cflags } : {}),
      ctx: 'void breakretinc_code(void);',
      proto: { breakretinc_code: { returnsVoid: true } },
    },
  ]),
  {
    sym: 'spilldead',
    src:
      'void done(s32 s);\n' +
      'void spilldead(s32 k, s32 *p)\n{\n    s32 v0, v1, v2, v3, v4, v5, v6, v7, v8, v9;\n    s32 i, s = 0;\n' +
      '    v0 = p[0]; v1 = p[1]; v2 = p[2]; v3 = p[3]; v4 = p[4]; v5 = p[5]; v6 = p[6]; v7 = p[7]; v8 = p[8]; v9 = p[9];\n' +
      '    for (i = 0; i < k; i++) {\n' +
      '        s += p[i] * v0 + v1 * v2 + v3 * v4 + v5 * v6 + v7 * v8 + v9 * i;\n    }\n    done(s);\n}',
    features: ['value-home', 'array'],
    toolchains: ['agbcc', 'gcc2.7.2kmc', 'mwcc_242_81'],
    ctx: 'void done(s32 s); void spilldead(s32 k, s32 *p);',
    proto: { done: { params: 1, returnsVoid: true }, spilldead: { returnsVoid: true } },
  },
  {
    sym: 'forever_noexit',
    src: 'extern s32 gCount;\nvoid step(void);\nvoid forever_noexit(void)\n{\n    while (1) {\n        step();\n        gCount = 0;\n    }\n}',
    features: [],
    toolchains: ALL,
    ctx: 'void step(void); void forever_noexit(void);',
    proto: { step: { params: 0, returnsVoid: true }, forever_noexit: { returnsVoid: true } },
  },
  {
    sym: 'loop_elsebreak',
    src:
      'extern u16 gBuf[64];\nextern u32 gBits;\n' +
      'void loop_elsebreak(void)\n{\n    u32 off = -1;\n    u32 bits = gBits;\n    u32 k;\n' +
      '    for (k = 0; k < 3; k++) {\n        if (bits & 1) {\n            off += 1;\n            bits &= ~1;\n' +
      '        } else if (bits & 2) {\n            off += 1;\n            bits &= ~2;\n        } else {\n            break;\n        }\n' +
      '        gBuf[off * 2] = gBuf[off * 2 + 1];\n    }\n}',
    features: ['break', 'array'],
    toolchains: ALL,
    ctx: 'void loop_elsebreak(void);',
    proto: { loop_elsebreak: { returnsVoid: true } },
  },
  {
    sym: 'sw_jtholeif',
    src:
      'void sw_jtholeif(s32 x, s32 *p)\n{\n    switch (x) {\n    case 0: p[0] = 1; break;\n    case 2: p[1] = 2; break;\n' +
      '    case 5: p[3] += 2; if (p[3] > 9) { p[4] = 7; p[5] = 0; } break;\n    case 6: p[6] = 4; break;\n' +
      '    case 7: p[3] -= 2; if (p[3] > 8) { p[4] = 3; p[5] = 1; } break;\n    }\n}',
    features: ['sparse', 'branch'],
    toolchains: ALL,
    ctx: 'void sw_jtholeif(s32 x, s32 *p);',
    proto: { sw_jtholeif: { returnsVoid: true } },
  },
  {
    sym: 'uninitfirst',
    src:
      'extern s32 gOut;\n' +
      's32 uninitfirst(s32 k, s32 *p)\n{\n    s32 v0, v1, v2, v3, v4, v5, v6, v7, v8, v9;\n    s32 i, s = 0;\n' +
      '    if (k > 5)\n        gOut = v0 + v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8 + v9;\n' +
      '    switch (k) {\n' +
      '    case 0: v0 = p[0]; v1 = p[1]; v2 = p[2]; v3 = p[3]; v4 = p[4]; v5 = p[5]; v6 = p[6]; v7 = p[7]; v8 = p[8]; v9 = p[9]; break;\n' +
      '    case 1: v0 = p[10]; v1 = p[11]; v2 = p[12]; v3 = p[13]; v4 = p[14]; v5 = p[15]; v6 = p[16]; v7 = p[17]; v8 = p[18]; v9 = p[19]; break;\n' +
      '    }\n    for (i = 0; i < 8; i++)\n        s += p[i] * v0 + v1 * v2 + v3 * v4 + v5 * v6 + v7 * v8 + v9;\n    return s;\n}',
    features: ['uninit-local', 'array'],
    toolchains: ALL,
  },
  // THE FUNCTION'S OWN DECLARATION BOUNDS ITS ARGUMENT REGISTERS (proto.ts `ownArgumentWords`, read
  // by frontend/ssa.ts `registerLiveIns`). `uninit_spill` and `uninitfirst` above state no
  // prototype, so nothing can tell a local KMC and gcc 2.7.2 home in a2/a3 — agbcc in r3, mwcc
  // 2.3.3 in r5..r10 — from an argument, and each such read lifts as a made-up parameter. These
  // rows are the same shapes handed their own declaration, as a project's header hands it (a loop
  // bound or a constant changed, so no row is another alpha-renamed): the registers past its words
  // are uninitialised locals. IDO homes the locals in frame words and mwcc 2.4.2 in saved or
  // scratch registers, so those cells pin that nothing else moves. mwcc 2.3.3, which homes them in
  // r5..r10, has no canonical flags to carry a row; packages/core/test/ppc-frontend.test.ts pins it.
  // `ownar_read` and `ownar_join` are agbcc's r3 and r1 homes (read as parameters: `gOut = a3`). The
  // controls keep what the declaration fills: `ownar_hole` a declared register the body never
  // reads, which still holds a2 in its slot, and `ownar_dbl` O32's `(int, double)`, whose double
  // takes a2:a3 past an empty a1.
  {
    sym: 'ownar_spill',
    src:
      'int ownar_spill(int k,int *p){ int v0,v1,v2,v3,v4,v5,v6,v7,v8,v9; int i,s=0;' +
      ' switch(k){ case 0: v0=p[0];v1=p[1];v2=p[2];v3=p[3];v4=p[4];v5=p[5];v6=p[6];v7=p[7];v8=p[8];v9=p[9]; break;' +
      ' case 1: v0=p[10];v1=p[11];v2=p[12];v3=p[13];v4=p[14];v5=p[15];v6=p[16];v7=p[17];v8=p[18];v9=p[19]; break; }' +
      ' for(i=0;i<6;i++) s+=p[i]*v0+v1*v2+v3*v4+v5*v6+v7*v8+v9; return s; }',
    features: ['uninit-local', 'array'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    ctx: 'int ownar_spill(int, int *);',
    proto: { ownar_spill: { params: ['int', 'int *'], returns: 'int' } },
  },
  // A BARE COUNT BOUNDS NOTHING on the function's own entry: it may count argument registers or C
  // parameters, and a C parameter may span any number of words. This row is the witness that a
  // count lifts exactly as with no declaration: KMC's and gcc 2.7.2's a2 home stays a made-up
  // parameter. The typed `ownar_spill` above is the row the bound pins.
  {
    sym: 'ownar_count',
    src:
      'int ownar_count(int k,int *p){ int v0,v1,v2,v3,v4,v5,v6,v7,v8,v9; int i,s=0;' +
      ' switch(k){ case 0: v0=p[0];v1=p[1];v2=p[2];v3=p[3];v4=p[4];v5=p[5];v6=p[6];v7=p[7];v8=p[8];v9=p[9]; break;' +
      ' case 1: v0=p[10];v1=p[11];v2=p[12];v3=p[13];v4=p[14];v5=p[15];v6=p[16];v7=p[17];v8=p[18];v9=p[19]; break; }' +
      ' for(i=0;i<5;i++) s+=p[i]*v0+v1*v2+v3*v4+v5*v6+v7*v8+v9; return s; }',
    features: ['uninit-local', 'array'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    ctx: 'int ownar_count(int, int *);',
    proto: { ownar_count: { params: 2 } },
  },
  {
    sym: 'ownar_first',
    src:
      'extern s32 gOut;\n' +
      's32 ownar_first(s32 k, s32 *p)\n{\n    s32 v0, v1, v2, v3, v4, v5, v6, v7, v8, v9;\n    s32 i, s = 0;\n' +
      '    if (k > 4)\n        gOut = v0 + v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8 + v9;\n' +
      '    switch (k) {\n' +
      '    case 0: v0 = p[0]; v1 = p[1]; v2 = p[2]; v3 = p[3]; v4 = p[4]; v5 = p[5]; v6 = p[6]; v7 = p[7]; v8 = p[8]; v9 = p[9]; break;\n' +
      '    case 1: v0 = p[10]; v1 = p[11]; v2 = p[12]; v3 = p[13]; v4 = p[14]; v5 = p[15]; v6 = p[16]; v7 = p[17]; v8 = p[18]; v9 = p[19]; break;\n' +
      '    }\n    for (i = 0; i < 6; i++)\n        s += p[i] * v0 + v1 * v2 + v3 * v4 + v5 * v6 + v7 * v8 + v9;\n    return s;\n}',
    features: ['uninit-local', 'array'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    ctx: 'extern s32 gOut;\ns32 ownar_first(s32, s32 *);',
    proto: { ownar_first: { params: ['s32', 's32 *'], returns: 's32' } },
  },
  {
    sym: 'ownar_read',
    src: 'extern int gOut;\nint ownar_read(int k, int *p){ int v; if (k > 5) gOut = v; v = p[0]; return v + k; }',
    features: ['uninit-local'],
    toolchains: ['agbcc'],
    ctx: 'extern int gOut;\nint ownar_read(int, int *);',
    proto: { ownar_read: { params: ['int', 'int *'], returns: 'int' } },
  },
  {
    sym: 'ownar_join',
    src: 'int ownar_join(int a){ int r; if (a > 0) r = a * 3; return r + 1; }',
    features: ['uninit-local', 'branch'],
    toolchains: ['agbcc'],
    ctx: 'int ownar_join(int);',
    proto: { ownar_join: { params: ['int'], returns: 'int' } },
  },
  {
    sym: 'ownar_hole',
    src: 'int ownar_hole(int a, int b, int c){ return a + c; }',
    features: ['arithmetic'],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 'int ownar_hole(int, int, int);',
    proto: { ownar_hole: { params: ['int', 'int', 'int'], returns: 'int' } },
  },
  {
    sym: 'ownar_dbl',
    src: 'extern double gD;\nextern int gK;\nvoid ownar_dbl(int k, double d){ gK = k; gD = d; }',
    features: ['float'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'extern double gD;\nextern int gK;\nvoid ownar_dbl(int, double);',
    proto: { ownar_dbl: { params: ['int', 'double'], returnsVoid: true } },
  },
  // A declaration that lists the parameters and not the return leaves room for a struct's hidden
  // return pointer in argument 0, which pushes every parameter one register up: bounded from
  // argument 0, `z` (r3, a3, r6) would read as an uninitialised local.
  {
    sym: 'ownar_sret',
    src: 'struct P { int a, b, c; };\nstruct P ownar_sret(int x, int y, int z){ struct P p; p.a = z; p.b = x; p.c = y + 1; return p; }',
    features: ['struct-return', 'multi-arg'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    ctx: 'struct P { int a, b, c; };\nstruct P ownar_sret(int, int, int);',
    proto: { ownar_sret: { params: ['int', 'int', 'int'] } },
  },
  // The same shape declared by a count with a typedef return: a witness that the count lifts as
  // with no declaration, so `z` stays a parameter (a count read as 3 registers from argument 0 made
  // it an uninitialised local).
  {
    sym: 'ownar_sretcnt',
    src:
      'typedef struct P { int a, b, c; } Pt;\n' +
      'Pt ownar_sretcnt(int x, int y, int z){ Pt p; p.a = z; p.b = x; p.c = y + 1; return p; }',
    features: ['struct-return', 'multi-arg'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    ctx: 'typedef struct P { int a, b, c; } Pt;\nPt ownar_sretcnt(int, int, int);',
    proto: { ownar_sretcnt: { params: 3, returns: 'Pt' } },
  },
  // The hidden return pointer comes FIRST, so O32's even-word rule counts it: `x` skips a1 and
  // takes a2:a3. Laid out after the declared words, the bound would be 3 and a3 (half of x) an
  // uninitialised local. agbcc aligns nothing and passes x in r1:r2.
  {
    sym: 'ownar_sretdbl',
    src:
      'struct P { int a, b, c; };\n' +
      'struct P ownar_sretdbl(double x){ struct P p; int *q = (int *)&x; p.a = q[0]; p.b = q[1]; p.c = 7; return p; }',
    features: ['struct-return', 'float'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'struct P { int a, b, c; };\nstruct P ownar_sretdbl(double);',
    proto: { ownar_sretdbl: { params: ['double'] } },
  },
  // A COUNT DOES NOT SAY WHERE ITS PAIRS FALL: O32 and the PowerPC EABI put a 64-bit parameter at
  // an even word, so `(int, long long, int)` fills 4 registers and spans 5 words, and O32's `(int,
  // double)` fills 3 and spans 4. A bound read off the count turned mwcc's c in r7 and O32's low half
  // of b in a3 into uninitialised locals. A count bounds nothing, and these rows are the witnesses
  // that they lift exactly as with no declaration. A typed list of the same parameters refuses on the
  // 64-bit split (raise/pairparams.ts). agbcc aligns nothing and is the control.
  {
    sym: 'ownar_cntll',
    src: 'int ownar_cntll(int a, long long b, int c){ return a * 3 + (int)b - c; }',
    features: ['int64', 'multi-arg'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    ctx: 'int ownar_cntll(int, long long, int);',
    proto: { ownar_cntll: { params: 4, returns: 'int' } },
  },
  {
    sym: 'ownar_cntdbl',
    src: 'int ownar_cntdbl(int a, double b){ return ((int *)&b)[1] + a * 5; }',
    features: ['float', 'multi-arg'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'int ownar_cntdbl(int, double);',
    proto: { ownar_cntdbl: { params: 3, returns: 'int' } },
  },
  // A FUNCTION'S OWN CONTEXT ENTRY BOUNDS ITS ARGUMENT REGISTERS SOFTLY (core pipeline.ts
  // `liftWithinContextBound`). These rows state no own `proto`: the harness hands the lift the ctx's
  // own entry as a `--context` lift reads it (`withOwnContextMark`). `ownctx_phantom`'s a2/a3 reach
  // only the arity guesses of `zq` and `sl`, which trim them, so `(short, int)` drops them as
  // parameters. `ownctx_cb` is sbk2's task-callback shape: a `(void)` header ahead of a definition
  // that reads a0, which stays the parameter it is (with an `[own-arity]` note), never `uninit_a0`.
  {
    sym: 'ownctx_phantom',
    src:
      'extern int gOcY;\nextern void k4(int, int, int, int);\nextern int zq();\nextern void sl();\n' +
      'int ownctx_phantom(short a, int b){ if (gOcY) k4(b, a, 3, 1); while (zq(a) != 7) sl(); return gOcY + 1; }',
    features: ['branch', 'global'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    ctx: 'extern int gOcY;\nextern void k4(int, int, int, int);\nint ownctx_phantom(short, int);',
    proto: { k4: { params: ['int', 'int', 'int', 'int'], returnsVoid: true } },
  },
  {
    sym: 'ownctx_cb',
    src:
      'struct OcT { int a; int b; int c; };\nextern void g2(int *, int);\n' +
      'void ownctx_cb(struct OcT *t){ g2(&t->c, t->a - 3); }',
    features: ['struct', 'field', 'pointer'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    ctx: 'struct OcT { int a; int b; int c; };\nextern void g2(int *, int);\nvoid ownctx_cb(void);',
    proto: { g2: { params: ['int *', 'int'], returnsVoid: true } },
  },
  // `ownctx_home`: IDO at -g3 (and -O0) homes every argument register its definition declares
  // (`sw a0,0(sp); sw a1,4(sp)`), read back or not. Those stores are the asm reading a0 and a1, so a
  // `(void)` header past them keeps both as parameters, with a note: lifted `(void)`, the candidate
  // compiles without the two stores. The canonical -O2 drops the homes, so this row sets its flags.
  {
    sym: 'ownctx_home',
    src: 'extern int gOcH;\nvoid ownctx_home(int a, int b){ gOcH = 1; }',
    cflags: ['-mips2', '-O2', '-g3', '-32', '-non_shared', '-G', '0'],
    features: ['global'],
    toolchains: ['ido7.1'],
    ctx: 'extern int gOcH;\nvoid ownctx_home(void);',
  },
  // A FUNCTION WHOSE OWN CONTEXT DECLARATION RETURNS A STRUCT (core frontend/own-struct-return.ts).
  // No struct row states its own `proto`: the harness hands the lift the ctx's own entry, as a
  // `--context` lift reads it. Through memory, the caller's storage arrives in argument 0 (and
  // comes back in the return register on agbcc and O32), so with nothing declared each lifts as the
  // pointer function `s32 *f(s32 *a0, …)`; the declaration
  // makes it the struct return, with the hidden pointer the returned local. `ownsret_ctx` is 12
  // bytes, which every toolchain returns through memory — IDO copies it out of a frame object word
  // by word, agbcc with `ldmia`/`stmia`, kmc and gcc 2.7.2 through a frame temp the lift forwards,
  // and mwcc builds it in place. `ownsret_cond` builds it on two arms before one copy.
  {
    sym: 'ownsret_ctx',
    src:
      'struct T3 { int a, b, c; };\n' +
      'struct T3 ownsret_ctx(int x, int y){ struct T3 t; t.a = y; t.b = x * 3; t.c = x + y; return t; }',
    features: ['struct-return', 'multi-arg'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    ctx: 'struct T3 { int a, b, c; };\nstruct T3 ownsret_ctx(int x, int y);',
  },
  {
    sym: 'ownsret_cond',
    src:
      'struct T3 { int a, b, c; };\n' +
      'struct T3 ownsret_cond(int x, int y){ struct T3 t; if (x > y) { t.a = x; t.b = 1; } else { t.a = y; t.b = 2; }' +
      ' t.c = x - y; return t; }',
    features: ['struct-return', 'branch'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    ctx: 'struct T3 { int a, b, c; };\nstruct T3 ownsret_cond(int x, int y);',
  },
  // Two `return t;`s: IDO copies the frame object out once at each, so each copy is a return of
  // the struct (core frontend/own-struct-return.ts `returnAtEachCopy`); kmc and gcc 2.7.2 merge
  // the member stores past the join, which the lift spells through three variables. Not on agbcc
  // or mwcc, whose frame audits decline the call's frame.
  {
    sym: 'ownsret_tworet',
    src:
      'struct T3 { int a, b, c; };\nextern int gOtr(int);\n' +
      'struct T3 ownsret_tworet(int x){ struct T3 t; if (x) { t.a = 1; t.b = 2; t.c = 3; return t; }' +
      ' t.a = gOtr(x); t.b = 0; t.c = 0; return t; }',
    features: ['struct-return', 'branch'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    proto: { gOtr: { params: ['int'], returns: 'int' } },
    ctx: 'struct T3 { int a, b, c; };\nextern int gOtr(int);\nstruct T3 ownsret_tworet(int x);',
  },
  // Eight bytes: agbcc returns any struct whose second member is not a bitfield through memory
  // (thumb.c:1423-1493), so it lifts as the struct return; mwcc's svr4 rule hands it back in
  // r3:r4, a register pair the lift returns one word of, so the declaration refuses it there.
  {
    sym: 'ownsret_pair',
    src: 'struct T2 { int a, b; };\nstruct T2 ownsret_pair(int x){ struct T2 p; p.a = x - 1; p.b = x << 2; return p; }',
    features: ['struct-return'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    ctx: 'struct T2 { int a, b; };\nstruct T2 ownsret_pair(int x);',
  },
  // A call between the member stores. mwcc does not hand the hidden pointer back: at the blr r3
  // holds what the last call left there (core target.ts `structReturnHandsBackPointer`), so only
  // the declaration says the stores are the result; O32 `move v0,a0`. Not on agbcc, which builds
  // the struct in a frame temp across the calls and copies it out with ldmia/stmia: the frame
  // audit declines that (`stack pointer used as data`), a gap of its own; agbcc's hand-back is
  // ownsret_pairnl's.
  {
    sym: 'ownsret_call',
    src:
      'struct T3 { int a, b, c; };\nextern int gOsc(int);\n' +
      'struct T3 ownsret_call(int x, int y){ struct T3 t; t.a = gOsc(x); t.b = gOsc(y); t.c = 0; return t; }',
    features: ['struct-return', 'multi-arg'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    proto: { gOsc: { params: ['int'], returns: 'int' } },
    ctx: 'struct T3 { int a, b, c; };\nextern int gOsc(int);\nstruct T3 ownsret_call(int x, int y);',
  },
  // Eight bytes again, in a function that makes a call: agbcc gives the struct DImode, so its
  // epilogue is `pop {r2}; bx r2`, the one a `long long` return takes, which the declaration
  // explains (core frontend/thumb.ts `refuseWordReturns`). mwcc's r3:r4 pair is ownsret_pair's.
  {
    sym: 'ownsret_pairnl',
    src:
      'struct T2 { int a, b; };\nextern int gOsp(int);\n' +
      'struct T2 ownsret_pairnl(int x){ struct T2 p; p.a = gOsp(x); p.b = x; return p; }',
    features: ['struct-return'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    proto: { gOsp: { params: ['int'], returns: 'int' } },
    ctx: 'struct T2 { int a, b; };\nextern int gOsp(int);\nstruct T2 ownsret_pairnl(int x);',
  },
  // One word of one member: agbcc and mwcc hand it back in r0/r3, which holds the member, and the
  // O32 toolchains through memory, as any struct.
  {
    sym: 'ownsret_r0',
    src: 'struct W1 { unsigned int x; };\nstruct W1 ownsret_r0(int a){ struct W1 w; w.x = a + 5; return w; }',
    features: ['struct-return'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'],
    ctx: 'struct W1 { unsigned int x; };\nstruct W1 ownsret_r0(int a);',
  },
  // mwcc_242_81 compiles `int f(int a){ return a; }` to a bare `blr`: no path writes r3, and the
  // stated `int` return is what says the function returns the argument it was handed there.
  {
    sym: 'ownsret_bare',
    src: 'int ownsret_bare(int a){ return a; }',
    features: ['baseline'],
    toolchains: ['mwcc_242_81'],
    proto: { ownsret_bare: { params: ['int'], returns: 'int' } },
  },
  {
    sym: 'byvalregs',
    src:
      'struct A { u16 a, b, c, d; s8 e, f; };\nvoid take2(struct A a);\n' +
      'void byvalregs(u16 x, u16 y)\n{\n    struct A a;\n    a.a = x;\n    a.b = y;\n    a.c = 0xF0;\n    a.d = 0x78;\n' +
      '    a.e = a.f = 4;\n    take2(a);\n}',
    features: ['struct', 'field'],
    toolchains: ALL,
    ctx: 'struct A { u16 a, b, c, d; s8 e, f; };\nvoid take2(struct A a);\nvoid byvalregs(u16 x, u16 y);',
    // the members of `struct A` as the ctx defines them, which is what sizes the argument, the way
    // the sret rows state `returnLayout`
    proto: {
      take2: {
        params: ['struct A'],
        byValueLayouts: {
          0: {
            kind: 'struct',
            members: [
              { name: 'a', type: 'u16' },
              { name: 'b', type: 'u16' },
              { name: 'c', type: 'u16' },
              { name: 'd', type: 'u16' },
              { name: 'e', type: 's8' },
              { name: 'f', type: 's8' },
            ],
          },
        },
        returnsVoid: true,
      },
      byvalregs: { returnsVoid: true },
    },
  },
  {
    sym: 'bvwg',
    src:
      'struct W { u32 x; };\nstruct Q { u32 a, b; };\nstruct T { u32 a, b, c; };\nstruct C { u8 b[4]; };\n' +
      'void takeW(struct W w);\nvoid takeQ(s32 k, struct Q q);\nvoid takeT(struct T t);\nvoid takeC(struct C c);\n' +
      'extern struct W gW;\nextern struct Q gQ;\nextern struct T gT;\nextern struct C gC;\n' +
      'void bvwg(void)\n{\n    takeW(gW);\n}',
    features: ['global'],
    toolchains: ALL,
    ctx: 'struct W { u32 x; };\nstruct Q { u32 a, b; };\nstruct T { u32 a, b, c; };\nstruct C { u8 b[4]; };\nvoid takeW(struct W w);\nvoid takeQ(s32 k, struct Q q);\nvoid takeT(struct T t);\nvoid takeC(struct C c);\nvoid bvwg(void);',
    proto: {
      takeW: {
        params: ['struct W'],
        byValueLayouts: { 0: { kind: 'struct', members: [{ name: 'x', type: 'u32' }] } },
        returnsVoid: true,
      },
      takeQ: {
        params: ['s32', 'struct Q'],
        byValueLayouts: {
          1: {
            kind: 'struct',
            members: [
              { name: 'a', type: 'u32' },
              { name: 'b', type: 'u32' },
            ],
          },
        },
        returnsVoid: true,
      },
      takeT: {
        params: ['struct T'],
        byValueLayouts: {
          0: {
            kind: 'struct',
            members: [
              { name: 'a', type: 'u32' },
              { name: 'b', type: 'u32' },
              { name: 'c', type: 'u32' },
            ],
          },
        },
        returnsVoid: true,
      },
      takeC: {
        params: ['struct C'],
        byValueLayouts: { 0: { kind: 'struct', members: [{ name: 'b', type: 'u8', dims: [4] }] } },
        returnsVoid: true,
      },
      bvwg: { returnsVoid: true },
    },
  },
  {
    sym: 'bvqg',
    src:
      'struct W { u32 x; };\nstruct Q { u32 a, b; };\nstruct T { u32 a, b, c; };\nstruct C { u8 b[4]; };\n' +
      'void takeW(struct W w);\nvoid takeQ(s32 k, struct Q q);\nvoid takeT(struct T t);\nvoid takeC(struct C c);\n' +
      'extern struct W gW;\nextern struct Q gQ;\nextern struct T gT;\nextern struct C gC;\n' +
      'void bvqg(s32 k)\n{\n    takeQ(k, gQ);\n}',
    features: ['global', 'multi-arg'],
    toolchains: ALL,
    ctx: 'struct W { u32 x; };\nstruct Q { u32 a, b; };\nstruct T { u32 a, b, c; };\nstruct C { u8 b[4]; };\nvoid takeW(struct W w);\nvoid takeQ(s32 k, struct Q q);\nvoid takeT(struct T t);\nvoid takeC(struct C c);\nvoid bvqg(s32 k);',
    proto: {
      takeW: {
        params: ['struct W'],
        byValueLayouts: { 0: { kind: 'struct', members: [{ name: 'x', type: 'u32' }] } },
        returnsVoid: true,
      },
      takeQ: {
        params: ['s32', 'struct Q'],
        byValueLayouts: {
          1: {
            kind: 'struct',
            members: [
              { name: 'a', type: 'u32' },
              { name: 'b', type: 'u32' },
            ],
          },
        },
        returnsVoid: true,
      },
      takeT: {
        params: ['struct T'],
        byValueLayouts: {
          0: {
            kind: 'struct',
            members: [
              { name: 'a', type: 'u32' },
              { name: 'b', type: 'u32' },
              { name: 'c', type: 'u32' },
            ],
          },
        },
        returnsVoid: true,
      },
      takeC: {
        params: ['struct C'],
        byValueLayouts: { 0: { kind: 'struct', members: [{ name: 'b', type: 'u8', dims: [4] }] } },
        returnsVoid: true,
      },
      bvqg: { returnsVoid: true },
    },
  },
  {
    sym: 'bvtg',
    src:
      'struct W { u32 x; };\nstruct Q { u32 a, b; };\nstruct T { u32 a, b, c; };\nstruct C { u8 b[4]; };\n' +
      'void takeW(struct W w);\nvoid takeQ(s32 k, struct Q q);\nvoid takeT(struct T t);\nvoid takeC(struct C c);\n' +
      'extern struct W gW;\nextern struct Q gQ;\nextern struct T gT;\nextern struct C gC;\n' +
      'void bvtg(void)\n{\n    takeT(gT);\n}',
    features: ['global'],
    toolchains: ALL,
    ctx: 'struct W { u32 x; };\nstruct Q { u32 a, b; };\nstruct T { u32 a, b, c; };\nstruct C { u8 b[4]; };\nvoid takeW(struct W w);\nvoid takeQ(s32 k, struct Q q);\nvoid takeT(struct T t);\nvoid takeC(struct C c);\nvoid bvtg(void);',
    proto: {
      takeW: {
        params: ['struct W'],
        byValueLayouts: { 0: { kind: 'struct', members: [{ name: 'x', type: 'u32' }] } },
        returnsVoid: true,
      },
      takeQ: {
        params: ['s32', 'struct Q'],
        byValueLayouts: {
          1: {
            kind: 'struct',
            members: [
              { name: 'a', type: 'u32' },
              { name: 'b', type: 'u32' },
            ],
          },
        },
        returnsVoid: true,
      },
      takeT: {
        params: ['struct T'],
        byValueLayouts: {
          0: {
            kind: 'struct',
            members: [
              { name: 'a', type: 'u32' },
              { name: 'b', type: 'u32' },
              { name: 'c', type: 'u32' },
            ],
          },
        },
        returnsVoid: true,
      },
      takeC: {
        params: ['struct C'],
        byValueLayouts: { 0: { kind: 'struct', members: [{ name: 'b', type: 'u8', dims: [4] }] } },
        returnsVoid: true,
      },
      bvtg: { returnsVoid: true },
    },
  },
  {
    sym: 'bvqp',
    src:
      'struct W { u32 x; };\nstruct Q { u32 a, b; };\nstruct T { u32 a, b, c; };\nstruct C { u8 b[4]; };\n' +
      'void takeW(struct W w);\nvoid takeQ(s32 k, struct Q q);\nvoid takeT(struct T t);\nvoid takeC(struct C c);\n' +
      'extern struct W gW;\nextern struct Q gQ;\nextern struct T gT;\nextern struct C gC;\n' +
      'void bvqp(s32 k, struct Q *p)\n{\n    takeQ(k, *p);\n}',
    features: ['pointer', 'multi-arg'],
    toolchains: ALL,
    ctx: 'struct W { u32 x; };\nstruct Q { u32 a, b; };\nstruct T { u32 a, b, c; };\nstruct C { u8 b[4]; };\nvoid takeW(struct W w);\nvoid takeQ(s32 k, struct Q q);\nvoid takeT(struct T t);\nvoid takeC(struct C c);\nvoid bvqp(s32 k, struct Q *p);',
    proto: {
      takeW: {
        params: ['struct W'],
        byValueLayouts: { 0: { kind: 'struct', members: [{ name: 'x', type: 'u32' }] } },
        returnsVoid: true,
      },
      takeQ: {
        params: ['s32', 'struct Q'],
        byValueLayouts: {
          1: {
            kind: 'struct',
            members: [
              { name: 'a', type: 'u32' },
              { name: 'b', type: 'u32' },
            ],
          },
        },
        returnsVoid: true,
      },
      takeT: {
        params: ['struct T'],
        byValueLayouts: {
          0: {
            kind: 'struct',
            members: [
              { name: 'a', type: 'u32' },
              { name: 'b', type: 'u32' },
              { name: 'c', type: 'u32' },
            ],
          },
        },
        returnsVoid: true,
      },
      takeC: {
        params: ['struct C'],
        byValueLayouts: { 0: { kind: 'struct', members: [{ name: 'b', type: 'u8', dims: [4] }] } },
        returnsVoid: true,
      },
      bvqp: { returnsVoid: true },
    },
  },
  {
    sym: 'bvcg',
    src:
      'struct W { u32 x; };\nstruct Q { u32 a, b; };\nstruct T { u32 a, b, c; };\nstruct C { u8 b[4]; };\n' +
      'void takeW(struct W w);\nvoid takeQ(s32 k, struct Q q);\nvoid takeT(struct T t);\nvoid takeC(struct C c);\n' +
      'extern struct W gW;\nextern struct Q gQ;\nextern struct T gT;\nextern struct C gC;\n' +
      'void bvcg(void)\n{\n    takeC(gC);\n}',
    features: ['global'],
    toolchains: ALL,
    ctx: 'struct W { u32 x; };\nstruct Q { u32 a, b; };\nstruct T { u32 a, b, c; };\nstruct C { u8 b[4]; };\nvoid takeW(struct W w);\nvoid takeQ(s32 k, struct Q q);\nvoid takeT(struct T t);\nvoid takeC(struct C c);\nvoid bvcg(void);',
    proto: {
      takeW: {
        params: ['struct W'],
        byValueLayouts: { 0: { kind: 'struct', members: [{ name: 'x', type: 'u32' }] } },
        returnsVoid: true,
      },
      takeQ: {
        params: ['s32', 'struct Q'],
        byValueLayouts: {
          1: {
            kind: 'struct',
            members: [
              { name: 'a', type: 'u32' },
              { name: 'b', type: 'u32' },
            ],
          },
        },
        returnsVoid: true,
      },
      takeT: {
        params: ['struct T'],
        byValueLayouts: {
          0: {
            kind: 'struct',
            members: [
              { name: 'a', type: 'u32' },
              { name: 'b', type: 'u32' },
              { name: 'c', type: 'u32' },
            ],
          },
        },
        returnsVoid: true,
      },
      takeC: {
        params: ['struct C'],
        byValueLayouts: { 0: { kind: 'struct', members: [{ name: 'b', type: 'u8', dims: [4] }] } },
        returnsVoid: true,
      },
      bvcg: { returnsVoid: true },
    },
  },

  // ── CodeWarrior's branch-free compares, on all three builds at -O4,p ──
  // mwcc materialises a 0/1 compare with no branch: 2.4.2/2.4.7 with bit tricks (`xor; cntlzw; slw`
  // for `<u`, `subf; orc; srwi; subf` for `>=u`, `xor; srawi; and; subf` for `<s`), and through the
  // carry bit (`subfc` then `subfe`/`subfze`/`addze`/`adde`) for `>=s` and `-(a <u b)` there and
  // for every relation on 2.3.3. Each relation is a row, `>`/`<=` being the swapped code; the `k`
  // rows put the constant where the code distinguishes it (`ulek` subtracts it with `subfic`,
  // `ugek` with `addi -K`). `nbceq`/`nbcne` are the controls spelled by neither trick but by
  // `cntlzw; srwi 5`, `subf; subf; or` and 2.3.3's `addic -1; subfe`. `nbcaddult`, `nbcnegult`,
  // `nbcselult` and `nbcstult` use the boolean as a value: `nbcselult`'s `(a < b) ? 5 : 0` is `subfe; and` on 2.4.x, which lifts as
  // `5 & -(a < b)` and recompiles to `andi.`. `nbcne0` is 2.3.3's `neg; addic -1; subfe`, whose
  // carry tests the NEGATION, and `nbcshlult` the 2.4.x extract merged with its shift into one
  // `rlwinm r3,r0,4,28,28`. Folded in pattern/engine.ts MWCC_COMPARE_PATTERNS, over
  // frontend/ppc.ts `readCarry`.
  ...(
    [
      ['nbcult', 'unsigned a, unsigned b', 'a < b'],
      ['nbcule', 'unsigned a, unsigned b', 'a <= b'],
      ['nbcugt', 'unsigned a, unsigned b', 'a > b'],
      ['nbcuge', 'unsigned a, unsigned b', 'a >= b'],
      ['nbcultk', 'unsigned a', 'a < 10'],
      ['nbculek', 'unsigned a', 'a <= 10'],
      ['nbcugek', 'unsigned a', 'a >= 10'],
      ['nbcslt', 'int a, int b', 'a < b'],
      ['nbcsle', 'int a, int b', 'a <= b'],
      ['nbcsgt', 'int a, int b', 'a > b'],
      ['nbcsge', 'int a, int b', 'a >= b'],
      ['nbcsltk', 'int a', 'a < 10'],
      ['nbcsgek', 'int a', 'a >= 10'],
      ['nbceq', 'unsigned a, unsigned b', 'a == b'],
      ['nbcne', 'unsigned a, unsigned b', 'a != b'],
      ['nbcaddult', 'unsigned a, unsigned b, int c', 'c + (a < b)'],
      ['nbcnegult', 'unsigned a, unsigned b', '-(a < b)'],
      ['nbcselult', 'unsigned a, unsigned b', '(a < b) ? 5 : 0'],
      ['nbcne0', 'int a', 'a != 0'],
      ['nbcshlult', 'unsigned a, unsigned b', '(a < b) << 3'],
    ] as const
  ).map(([sym, params, expr]): SynthSpec => ({
    sym,
    src: `int ${sym}(${params}) { return ${expr}; }`,
    cflags: ['-proc', 'gekko', '-O4,p', '-fp', 'hard'],
    features: params.startsWith('unsigned') ? ['compare', 'unsigned'] : ['compare'],
    toolchains: ['mwcc_242_81', 'mwcc_247_107', 'mwcc_233_163n'],
    ctx: `int ${sym}(${params});`,
  })),
  {
    sym: 'nbcstult',
    src: 'void nbcstult(unsigned a, unsigned b, int *p) { *p = a < b; }',
    cflags: ['-proc', 'gekko', '-O4,p', '-fp', 'hard'],
    features: ['compare', 'unsigned', 'store'],
    toolchains: ['mwcc_242_81', 'mwcc_247_107', 'mwcc_233_163n'],
    ctx: 'void nbcstult(unsigned a, unsigned b, int *p);',
    proto: { nbcstult: { returnsVoid: true } },
  },
  {
    // 2.3.3 loads the `li r6,-1` its `>=u` subfzes read once, in the entry block, and reads it in
    // the blocks below the branches (frontend/ppc.ts `resolveJoinedCarryConsts`). 2.4.x spells the
    // same compares with `orc`, which this row pins as well.
    sym: 'nbcbruge',
    src: 'unsigned nbcbruge(unsigned a, unsigned b, unsigned c) { unsigned r = a >= b; if (c) r += b >= c; if (c > 5) r += a >= c; return r; }',
    cflags: ['-proc', 'gekko', '-O4,p', '-fp', 'hard'],
    features: ['compare', 'unsigned', 'branch'],
    toolchains: ['mwcc_242_81', 'mwcc_247_107', 'mwcc_233_163n'],
    ctx: 'unsigned nbcbruge(unsigned a, unsigned b, unsigned c);',
  },

  // ── THE OUTGOING-AREA LOADED-WORD BOUND on O32 and mwcc (`compilerBehaviors.outgoingAreaNeverLoadedFrom`) ──
  // From a start offset up — 16(sp) on ido7.1, gcc2.7.2kmc and gcc2.7.2, past the a0..a3 home their
  // compilers load by-value staging words back from; 8(r1) on mwcc, the parameter area — a caller
  // never loads a word of its outgoing area, so a frame word it loads there is a local's and so is
  // every word above it (`packages/core/test/outgoing-area-probes.test.ts` reads the compiled
  // probes). The rows are `bigdead`: twenty-eight values spilled to the frame, reloaded only inside
  // a loop the first test may skip, then one call, so a spill's store reaches the call unread on the
  // zero-trip path. Each row names the refusal it reaches without the bound, measured with the CLI
  // from source:
  //   1. oa_bigdead: `done4` UNDECLARED. A guess that fills a0..a3 cannot say where the list ends,
  //      so a spill reaching the jal refuses as a possible argument 5 ("the word stored to 20(sp)
  //      reaches it", 68(sp) on ido7.1); the bound (24 on ido7.1, 20 on the gcc builds) clears it
  //      (frontend/mips.ts `lowerJal`). Not on mwcc: there the guess counts r7..r10, which the loop
  //      leaves written, and lifts a call of eight whatever the bound (the guessed-arity gap).
  //   2. oa_bigdead8 / oa_bigdead8p: `done8` UNDECLARED, eight arguments. On O32 (oa_bigdead8) the
  //      words at 16..28(sp) ARE arguments 5..8, beneath the bound, and the row stays declined
  //      naming 16(sp) — the witness that the bound clears only locals. On mwcc (oa_bigdead8p, at
  //      mwcc_242_81's canonical flags on all three builds) the eight fill r3..r10, and on
  //      mwcc_242_81 and mwcc_247_107 the spill at 8(r1) refuses at the guess ("reaches it in the
  //      callee's parameter area"); the bound (8) clears it (frontend/ppc.ts `bl`). mwcc_233_163n
  //      keeps nothing there and lifts without the bound (a control).
  //   3. oa_bigdeadd: `done4` DECLARED. mwcc_242_81 and mwcc_247_107 refuse at the end-of-lift
  //      check for a store nobody reloads ("'20(r1)' is stored ... and never read back"); 20 is above
  //      the lowest word they load, so it is a dead spill (frontend/ppc.ts). mwcc_233_163n lifts
  //      without the bound (a control).
  //   4. oa_deadb: `char b[8]; b[0] = x; b[4] = y; x = b[0]; g(); return x;` at -O0,p, where the
  //      array is memory: `b[4]` reaches `g` unread on every path through a captured address, and no
  //      load after a call proves it a local's, so it refuses on all three builds (frame-objects.ts
  //      `storedNeverRead`). `b[0]` and `y`'s home at 8(r1) are LOADED before the call, which bounds
  //      it under the strong form.
  // The rows all declare their own `returnsVoid` and declare (or withhold) the callee the same way in
  // `ctx` and `proto`, so m2c is told exactly what asmlift is.
  {
    sym: 'oa_bigdead',
    src:
      'void done4(int s, int a, int b, int c);\n' +
      'void oa_bigdead(int k, int *p)\n{\n' +
      BIGDEAD_BODY +
      '    done4(s, k, s + 1, s + 2);\n}',
    features: ['value-home', 'array'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'void oa_bigdead(int k, int *p);',
    proto: { oa_bigdead: { returnsVoid: true } },
  },
  {
    sym: 'oa_bigdead8',
    src:
      'void done8(int s, int a, int b, int c, int d, int e, int f, int g);\n' +
      'void oa_bigdead8(int k, int *p)\n{\n' +
      BIGDEAD_BODY +
      '    done8(s, k, s + 1, s + 2, s + 3, s + 4, s + 5, s + 6);\n}',
    features: ['value-home', 'array'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'void oa_bigdead8(int k, int *p);',
    proto: { oa_bigdead8: { returnsVoid: true } },
  },
  {
    sym: 'oa_bigdead8p',
    src:
      'void done8(int s, int a, int b, int c, int d, int e, int f, int g);\n' +
      'void oa_bigdead8p(int k, int *p)\n{\n' +
      BIGDEAD_BODY +
      '    done8(s, k, s + 1, s + 2, s + 3, s + 4, s + 5, s + 6);\n}',
    cflags: MWCC_O4P,
    features: ['value-home', 'array'],
    toolchains: ['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'],
    ctx: 'void oa_bigdead8p(int k, int *p);',
    proto: { oa_bigdead8p: { returnsVoid: true } },
  },
  {
    sym: 'oa_bigdeadd',
    src:
      'void done4(int s, int a, int b, int c);\n' +
      'void oa_bigdeadd(int k, int *p)\n{\n' +
      BIGDEAD_BODY +
      '    done4(s, k, s + 1, s + 2);\n}',
    cflags: MWCC_O4P,
    features: ['value-home', 'array'],
    toolchains: ['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'],
    ctx: 'void done4(int s, int a, int b, int c); void oa_bigdeadd(int k, int *p);',
    proto: { done4: { params: 4, returnsVoid: true }, oa_bigdeadd: { returnsVoid: true } },
  },
  {
    sym: 'oa_deadb',
    src: 'int g(void);\nint oa_deadb(int x, int y)\n{\n    char b[8];\n    b[0] = x;\n    b[4] = y;\n    x = b[0];\n    g();\n    return x;\n}',
    cflags: MWCC_O0P,
    features: ['array'],
    toolchains: ['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'],
    ctx: 'int g(void); int oa_deadb(int x, int y);',
    proto: { g: { params: 0 } },
  },

  // ── THE RETURN PROOF: hand-written asm whose return jumps somewhere other than the caller ──
  // `retmtlr` and `retjr` exist to be DECLINED, as `tax_gprel` does. `blr` and `jr ra` are returns by
  // their name alone, so a function that first puts something else in the link register or in `ra`
  // would read as a C `return 7;` that, compiled, returns to the caller instead of to the address the
  // function chose (frontend/ppc.ts `linkRegisterProof`, frontend/mips.ts
  // `refuseReturnsNotThroughCallersRa`). No compiler emits the shape, so only `asm` can carry it
  // into the tier: an `asm` function on CodeWarrior, and on GCC an `__asm__` statement before the
  // `return` (gcc 2.7.2 does not know the statement writes `ra`, so its own `jr ra` follows it:
  // `move ra,a1; jr ra; li v0,7` on both GCC builds, measured).
  //
  // The mwcc row sets its own `cflags` because two of its three builds have no canonical set; an
  // `asm` function is the same object at any level. IDO 7.1 has no inline `asm`, so `ido7.1` is
  // pinned by core's unit tests only (`packages/core/test/mips-return-proof.test.ts`).
  {
    sym: 'retmtlr',
    src: 'asm int retmtlr(int a, int b)\n{\n    nofralloc\n    li r3, 7\n    mtlr r4\n    blr\n}',
    cflags: ['-proc', 'gekko', '-O4,p', '-fp', 'hard'],
    features: ['baseline'],
    toolchains: ['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'],
    ctx: 'int retmtlr(int a, int b);',
  },
  {
    sym: 'retjr',
    src: 'int retjr(int a, int b)\n{\n    __asm__("move $31,$5");\n    return 7;\n}',
    features: ['baseline'],
    toolchains: ['gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'int retjr(int a, int b);',
  },
  // `bllocal` and `k0read` are declined witnesses of the same kind, one per toolchain family. A `bl`
  // into the function's own body carries no relocation, so it has no callee to name (lifting it as a
  // call to an invented `func` is wrong C); a read of k0, which an exception handler may overwrite at
  // any instruction, is not the value written there (`return a0;` is wrong C). Each declines
  // (frontend/ppc.ts `case 'bl'`, frontend/mips.ts `read` with `TargetDescription.kernelRegs`).
  {
    sym: 'bllocal',
    src: 'asm int bllocal(int a)\n{\n    nofralloc\n    mflr r31\n    bl next\nnext:\n    mtlr r31\n    li r3, 7\n    blr\n}',
    cflags: ['-proc', 'gekko', '-O4,p', '-fp', 'hard'],
    features: ['baseline'],
    toolchains: ['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'],
    ctx: 'int bllocal(int a);',
  },
  {
    sym: 'k0read',
    src: 'int k0read(int a)\n{\n    int r;\n    __asm__("move $26,%1\\n\\tmove %0,$26" : "=r"(r) : "r"(a));\n    return r;\n}',
    features: ['baseline'],
    toolchains: ['gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'int k0read(int a);',
  },
  // A GLOBAL INDEXED BETWEEN ITS RELOCATED HALVES. ido 7.1, KMC GCC and GCC 2.7.2 address `S[i]` as
  // `lui rH,%hi(S); addu rH,rH,idx; l*/s* x,%lo(S)(rH)` — the scaled index added to the HIGH half,
  // the constant element or field offset riding the %lo immediate (negative for `S[i - k]`), and a
  // store's half in `at` (measured by compiling each body below on all three). agbcc and
  // mwcc_242_81 are controls: agbcc adds the index to a pooled address and mwcc to an `@ha/@l` pair
  // completed first, neither of which is this shape.
  {
    sym: 'hidx_ld',
    src: 'extern u8 gTab[16];\nu32 hidx_ld(u32 i)\n{\n    return gTab[i];\n}',
    features: ['global', 'array', 'variable-index'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'agbcc', 'mwcc_242_81'],
    ctx: 'u32 hidx_ld(u32 i);',
  },
  {
    sym: 'hidx_st',
    src: 'extern u32 gTab[16];\nvoid hidx_st(u32 i, u32 v)\n{\n    gTab[i] = v;\n}',
    features: ['global', 'array', 'variable-index', 'store'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'agbcc', 'mwcc_242_81'],
    ctx: 'void hidx_st(u32 i, u32 v);',
    proto: { hidx_st: { returnsVoid: true } },
  },
  {
    sym: 'hidx_fld',
    src:
      'struct HidxS { u16 a; u16 b; u32 c; };\nextern struct HidxS gHidx[8];\n' +
      'u32 hidx_fld(u32 i)\n{\n    return gHidx[i].b;\n}',
    features: ['global', 'array', 'variable-index', 'struct', 'field'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'agbcc', 'mwcc_242_81'],
    ctx: 'u32 hidx_fld(u32 i);',
  },
  {
    sym: 'hidx_neg',
    src: 'extern u32 gTab[16];\nu32 hidx_neg(u32 i)\n{\n    return gTab[i - 1];\n}',
    features: ['global', 'array', 'variable-index'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'agbcc', 'mwcc_242_81'],
    ctx: 'u32 hidx_neg(u32 i);',
  },
  // `S[i - k]` with the base COMPLETED FIRST: KMC GCC and GCC 2.7.2 spell `&gTab[i - 1]` and
  // `g2[i - 1][j]` as `lui; addiu rB,rB,%lo(S)-k; ...; addu idx`, an address below the symbol that
  // only the index brings back inside it (ido keeps the indexed-half spelling of `hidx_neg`).
  {
    sym: 'hidx_negp',
    src: 'extern u32 gTab[16];\nu32 *hidx_negp(u32 i)\n{\n    return &gTab[i - 1];\n}',
    features: ['global', 'array', 'variable-index', 'pointer'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'agbcc', 'mwcc_242_81'],
    ctx: 'u32 *hidx_negp(u32 i);',
  },
  {
    sym: 'hidx_neg2d',
    src: 'extern u8 g2[4][8];\nu32 hidx_neg2d(u32 i, u32 j)\n{\n    return g2[i - 1][j];\n}',
    features: ['global', 'array', 'variable-index', 'multi-arg'],
    toolchains: ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'agbcc', 'mwcc_242_81'],
    ctx: 'u32 hidx_neg2d(u32 i, u32 j);',
  },
  // ── PowerPC LOADS AND STORES WITH UPDATE (frontend/ppc.ts `withUpdate`) ─────────────────────
  // `lbzu rD,D(rA)` is `rA += D; rD = *(u8 *)rA`, and `stbu rS,D(rA)` `rA += D; *(u8 *)rA = rS`.
  // CodeWarrior emits them in four shapes, measured on 2.4.2, 2.3.3 and 2.4.7 (no mwcc source
  // exists, so a compiled probe is the evidence):
  //   • a FULLY UNROLLED compare chain over a table, at -O4,p only: `upd_bscan`, `upd_hscan`,
  //     `upd_shscan`, `upd_wscan` and `break_value` on every build, and `upd_pscan` (a pointer
  //     parameter) on 2.3.3 alone — 2.4.2 and 2.4.7 keep its `bdnz` loop. For a `u16`/`s16`/`u32`
  //     table the FIRST load's displacement is the `@l` half of the table's address
  //     (`lhzu r0,gH@l(r4)`), so the base it leaves is `&gH`;
  //   • a run of stores to a global array, at -O4,p only: the first is `stbu r3,gB@l(r4)` and the
  //     rest plain `stb`. The flat `gB[0] = v; … gB[7] = v;` (`upd_bfillflat`) compiles to the same
  //     run as the loop (`upd_bfill`);
  //   • the word loop of a struct copy, `lwz; lwzu 8; stw; stwu 8; bdnz`, at every level
  //     (`upd_scopy`, `upd_gcopy` of 72 bytes; `upd_scopy0` of 80 at -O0,p). Into a LOCAL
  //     (`upd_lcopy`) the destination base is `addi r5,r1,4`, a word below the object, and the
  //     stores step it: the frame-object audit refuses that capture, and the row declines rather
  //     than guess an object;
  //   • a PRE-INCREMENT pointer walk, at -O4,p on every build: `*++p` is one `lbzu` in the loop body,
  //     its base a loop-carried phi (`upd_skipsp`, `upd_slen`), and `*++d = *++s` an `lbzu` and an
  //     `stbu` whose stored value the loop then tests (`upd_scpy`, MSL's `strcpy` shape). A
  //     post-increment walk (`while (*p++)`) emits none.
  // The pre-increment walks match on CodeWarrior and the rest do not yet, which is not this
  // capability's gap: an unrolled chain needs its loop RE-ROLLED (the flat `if (gTab[1] == 0x1C) …`
  // spelling compiles to `lbz D(r3)` with no update form), a constant chain is spelled
  // `(u32)&gTab + 2 + 1 + 1`, and a copy loop wants a struct assignment recovered from it. The same
  // sources on agbcc, ido7.1 and gcc2.7.2kmc are the controls, which have no update form to emit.
  ...(
    [
      [['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'], MWCC_O4P],
      [['agbcc', 'ido7.1', 'gcc2.7.2kmc'], undefined],
    ] as const
  ).flatMap(([toolchains, cflags]): SynthSpec[] =>
    (
      [
        ['upd_bscan', 'u8', 'gTab', 16, 16],
        ['upd_hscan', 'u16', 'gH', 16, 8],
        ['upd_shscan', 's16', 'gS', 16, 8],
        ['upd_wscan', 'u32', 'gW', 16, 8],
      ] as const
    )
      .map(([sym, type, table, size, n]): SynthSpec => ({
        sym,
        src:
          `extern ${type} ${table}[${size}];\ns32 ${sym}(${type} x)\n{\n    s32 i;\n    for (i = 0; i < ${n}; i++) {\n` +
          `        if (${table}[i] == x) {\n            return i;\n        }\n    }\n    return -1;\n}`,
        features: ['array', 'global', 'compare'],
        toolchains: [...toolchains],
        ...(cflags ? { cflags } : {}),
        ctx: `s32 ${sym}(${type} x);`,
      }))
      .concat([
        {
          sym: 'upd_pscan',
          src:
            's32 upd_pscan(u8 *p, u8 x)\n{\n    s32 i;\n    for (i = 0; i < 8; i++) {\n' +
            '        if (p[i] == x) {\n            return i;\n        }\n    }\n    return -1;\n}',
          features: ['array', 'pointer', 'compare'],
          toolchains: [...toolchains],
          ...(cflags ? { cflags } : {}),
          ctx: 's32 upd_pscan(u8 *p, u8 x);',
        },
        {
          sym: 'upd_skipsp',
          src: "u8 *upd_skipsp(u8 *p)\n{\n    while (*++p == ' ') {\n    }\n    return p;\n}",
          features: ['pointer', 'compare'],
          toolchains: [...toolchains],
          ...(cflags ? { cflags } : {}),
          ctx: 'u8 *upd_skipsp(u8 *p);',
        },
        {
          sym: 'upd_slen',
          src: 's32 upd_slen(u8 *s)\n{\n    u8 *p = s - 1;\n    while (*++p) {\n    }\n    return p - s;\n}',
          features: ['pointer', 'arithmetic'],
          toolchains: [...toolchains],
          ...(cflags ? { cflags } : {}),
          ctx: 's32 upd_slen(u8 *s);',
        },
        {
          sym: 'upd_scpy',
          src: 'void upd_scpy(u8 *d, u8 *s)\n{\n    d--;\n    s--;\n    while ((*++d = *++s) != 0) {\n    }\n}',
          features: ['pointer', 'store'],
          toolchains: [...toolchains],
          ...(cflags ? { cflags } : {}),
          ctx: 'void upd_scpy(u8 *d, u8 *s);',
          proto: { upd_scpy: { returnsVoid: true } },
        },
        ...(
          [
            ['upd_bfill', 'u8', 'gB'],
            ['upd_hfill', 'u16', 'gH'],
            ['upd_wfill', 'u32', 'gW'],
          ] as const
        ).map(([sym, type, table]): SynthSpec => ({
          sym,
          src:
            `extern ${type} ${table}[16];\nvoid ${sym}(${type} v)\n{\n    s32 i;\n` +
            `    for (i = 0; i < 8; i++) {\n        ${table}[i] = v;\n    }\n}`,
          features: ['array', 'global', 'store'],
          toolchains: [...toolchains],
          ...(cflags ? { cflags } : {}),
          ctx: `void ${sym}(${type} v);`,
          proto: { [sym]: { returnsVoid: true } },
        })),
        {
          sym: 'upd_bfillflat',
          src:
            'extern u8 gB[16];\nvoid upd_bfillflat(u8 v)\n{\n    gB[0] = v;\n    gB[1] = v;\n    gB[2] = v;\n' +
            '    gB[3] = v;\n    gB[4] = v;\n    gB[5] = v;\n    gB[6] = v;\n    gB[7] = v;\n}',
          features: ['array', 'global', 'store'],
          toolchains: [...toolchains],
          ...(cflags ? { cflags } : {}),
          ctx: 'void upd_bfillflat(u8 v);',
          proto: { upd_bfillflat: { returnsVoid: true } },
        },
        {
          sym: 'upd_scopy',
          src: 'struct UpdBig { s32 w[18]; };\nvoid upd_scopy(struct UpdBig *d, struct UpdBig *s)\n{\n    *d = *s;\n}',
          features: ['struct-copy', 'pointer'],
          toolchains: [...toolchains],
          ...(cflags ? { cflags } : {}),
          ctx: 'struct UpdBig { s32 w[18]; };\nvoid upd_scopy(struct UpdBig *d, struct UpdBig *s);',
          proto: { upd_scopy: { returnsVoid: true } },
        },
        {
          sym: 'upd_gcopy',
          src:
            'struct UpdBig { s32 w[18]; };\nextern struct UpdBig gUpdA;\nextern struct UpdBig gUpdB;\n' +
            'void upd_gcopy(void)\n{\n    gUpdA = gUpdB;\n}',
          features: ['struct-copy', 'global'],
          toolchains: [...toolchains],
          ...(cflags ? { cflags } : {}),
          ctx: 'struct UpdBig { s32 w[18]; };\nvoid upd_gcopy(void);',
          proto: { upd_gcopy: { returnsVoid: true } },
        },
        {
          sym: 'upd_lcopy',
          src:
            'struct UpdBig { s32 w[18]; };\nextern void upd_useb(struct UpdBig *p);\n' +
            'void upd_lcopy(struct UpdBig *s)\n{\n    struct UpdBig b;\n    b = *s;\n    upd_useb(&b);\n}',
          features: ['struct', 'struct-copy', 'stack-addr'],
          // ido7.1 is off, as for every call row (see the header)
          toolchains: toolchains.filter((t) => t !== 'ido7.1'),
          ...(cflags ? { cflags } : {}),
          ctx: 'struct UpdBig { s32 w[18]; };\nvoid upd_useb(struct UpdBig *p);\nvoid upd_lcopy(struct UpdBig *s);',
          proto: { upd_useb: { params: ['struct UpdBig *'], returnsVoid: true }, upd_lcopy: { returnsVoid: true } },
        },
      ]),
  ),
  {
    sym: 'upd_scopy0',
    src: 'struct UpdBig0 { s32 w[20]; };\nvoid upd_scopy0(struct UpdBig0 *d, struct UpdBig0 *s)\n{\n    *d = *s;\n}',
    features: ['struct-copy', 'pointer'],
    toolchains: ['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'],
    cflags: MWCC_O0P,
    ctx: 'struct UpdBig0 { s32 w[20]; };\nvoid upd_scopy0(struct UpdBig0 *d, struct UpdBig0 *s);',
    proto: { upd_scopy0: { returnsVoid: true } },
  },
  // break_value's twin on the three CodeWarrior builds: six or seven `lbzu` at -O4,p.
  {
    sym: 'break_value',
    src:
      'extern u8 gTab[16];\nextern u8 gVal[16];\nextern s32 gOut;\n' +
      'void break_value(void)\n{\n    u32 i;\n    u32 r = 1;\n    for (i = 1; i < 9; i++) {\n' +
      '        if (gTab[i] == 0x1C) {\n            r = i;\n            break;\n        }\n    }\n    gOut = gVal[r];\n}',
    features: ['break', 'array'],
    toolchains: ['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'],
    cflags: MWCC_O4P,
    ctx: 'void break_value(void);',
    proto: { break_value: { returnsVoid: true } },
  },
  // A SWITCH IN A LOOP, WHOSE BREAK JOIN IS THE LOOP'S INCREMENT: the MIPS compilers fill a likely
  // branch's slot with its target's first word, the `i++` (`bnezl at,T; addiu v0,v0,4`, the same
  // `addiu` at T-4). ido's arm branch and KMC's bounds `beqzl` are both that shape, and they pin
  // the retarget to T-4 that keeps the arm on the switch's join: without it ido's arms do not
  // linearize, and KMC's bounds branch cannot annul its slot. GCC 2.7.2's likely skips only its own
  // slot here, and agbcc and mwcc_242_81 have no likely branch: controls of the same source.
  {
    sym: 'sw_h3',
    src:
      's32 sw_h3(s32 x, s32 *p)\n{\n    s32 i;\n    s32 s = 0;\n    for (i = 0; i < x; i++) {\n' +
      '        switch (p[i]) {\n        case 0: s += 1; break;\n        case 2: s += 5; break;\n' +
      '        case 5: if (s > 9) { s = 0; } break;\n        case 6: s -= 4; break;\n' +
      '        case 7: s *= 2; break;\n        }\n    }\n    return s;\n}',
    features: ['array'],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 's32 sw_h3(s32 x, s32 *p);',
  },
  {
    sym: 'sw_h4',
    src:
      's32 sw_h4(s32 x, s32 *p)\n{\n    s32 i;\n    s32 s = 0;\n    for (i = 0; i < x; i++) {\n' +
      '        switch (p[i]) {\n        case 0: s += 1; break;\n        case 2: s += 5; break;\n' +
      '        case 5: s ^= 3; break;\n        case 6: s -= 4; break;\n' +
      '        case 7: s *= 2; break;\n        }\n    }\n    return s;\n}',
    features: ['array'],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 's32 sw_h4(s32 x, s32 *p);',
  },
  {
    sym: 'sw_h5',
    src:
      's32 sw_h5(s32 x, s32 *p)\n{\n    s32 i;\n    s32 s = 0;\n    for (i = 0; i < x; i++) {\n' +
      '        switch (p[i]) {\n        case 0: s += 1; break;\n        case 2: s += 5; break;\n' +
      '        case 5: if (s > 9) { s = 0; } break;\n        case 6: s -= 4; break;\n' +
      '        case 7: s *= 2; if (s > 100) { s = 1; } break;\n        }\n    }\n    return s;\n}',
    features: ['array'],
    toolchains: [...ALL, 'gcc2.7.2'],
    ctx: 's32 sw_h5(s32 x, s32 *p);',
  },

  // ── kleod decline census, second pass: the nineteen functions still declining at 504da435 ────
  // The same census as the family above, re-run on main 504da435 (2026-10-19): of 0.9.0's 49 declines
  // 30 now lift and 19 remain, under seven messages. Every one of the 19 was run through its refusing
  // site again — instrumented in a private worktree, or ablated on the input side until one source
  // element toggled the decline — and the seven messages turned out to be FOURTEEN causes. Each row
  // below is the smallest shape that reproduces the real function's words, in its measured spelling;
  // its control is the sibling that lifts. The toolchain list is decided per cell: a lane is on the
  // row when the shape declines there on the same capability or lifts as a control, and off when it
  // would measure an unrelated earlier link (named in the comment). agbcc's cross-jumping after reload
  // (jump.c find_cross_jump) is behind eight of the fourteen.
  //
  //   1. stksidx (sub_0804CFD0). `s8 a[64]` at a runtime index times a global halfword. Thumb has no
  //      `ldrsb rd,[rn,#imm]`; agbcc's `*extendqisi2_insn` (thumb.md:461-487) spells the signed byte
  //      `ldrb/lsl #24/asr #24` only when the loaded value lands in the base register, and otherwise
  //      `mov r1,#0 / ldrsb r1,[r0,r1]` — a register-offset load through a zero register, which the
  //      frontend lowers as `add` + load@0, so the frame audit sees the indexed address flow into an
  //      `add` and refuses (frame-objects.ts `indexedAccess`). `u8` (`stkidx`) and `s8` with the
  //      multiplier in a parameter register both MATCH. ido7.1 / gcc2.7.2kmc / mwcc_242_81 lift it
  //      (controls; kmc matches). Ablation-pinned.
  //   2. imgpair / imgone (sub_0804D0B0). TWO brace-initialised locals in one frame (`s8 a[16]` from
  //      .LC184, `u8 b[16]` from .LC186, each `bl memcpy` of 16). The frame audit declares a captured
  //      object by its RESERVATION, so the object at sp is `u8 sp0[32]` and the second local is
  //      `(u32)sp0 + 16`; the constant-init fold (l3/constinit.ts `planCopy`) then finds a 16-byte
  //      image filling a 32-byte local and refuses. imgone (one image) MATCHes; a second address-taken
  //      object of ANY kind beside the image declines in these words. agbcc only: the one-image control
  //      itself fails elsewhere on the other three (ido7.1 lifts the image as `(s32 *)&.data` and no
  //      candidate compiles; gcc2.7.2kmc refuses the copy's `swl`; mwcc_242_81 its anonymous constant
  //      pool entry) — the local-aggregate-init gap on each, its own future row. Ablation-pinned.
  //   3. spillu8byte / spillu8word (sub_0800D188, sub_08016EEC; one site, instrumented on both). A
  //      `u8` local agbcc gives no register is promoted to SImode (thumb.h:344 PROMOTE_MODE), spilled
  //      as a word (reload1.c:2274 → `str`), and a QImode use of it is alter_subreg's `(mem:QI slot)`
  //      (final.c:2153-2159 → `ldrb`), which Thumb addresses only through a copy of sp (thumb.h:884,
  //      :786): `add r3, sp, #0x28 / ldrb r3, [r3]`. That copy used to be a capture: it tainted the
  //      slot, folded the direct str/ldr into the same object, and frame-objects.ts `objectShapes`
  //      refused the widths (4 vs 1) — a decline rather than the one-object fallback, because the
  //      frame also holds a struct-return temp. LIFTED since the Thumb frontend reads a narrow load at
  //      a word slot's low-order bytes, through a copy that dies at it, as the slot narrowed
  //      (thumb.ts `narrowSlotReloads`): MATCH. spillu8word reads the slot back as a word (control,
  //      MATCH); spillu8half reads the u8's slot as a halfword (`mov r3, sp / ldrh r3, [r3, #0x28]`);
  //      spillu8nosret has a scalar-returning callee instead, so nothing escapes and it used to lift as
  //      one `u8 sp0[44]` that recompiles 114 lines off. agbcc only: ido7.1 and gcc2.7.2kmc spill the
  //      u8 as a byte and mwcc_242_81 keeps it in r16, so none compiles the shape.
  //   4. bfstrad (SetUpRoomInfo). A u8 bitfield straddling a byte: agbcc packs bitfields contiguously
  //      (thumb.h has no PCC_BITFIELD_TYPE_MATTERS, stor-layout.c:404-405), so `c:7` sits in bits 5-11
  //      and is read as a HALFWORD (expmed.c:1153) beside the byte reads of `a` and `d`; the raise
  //      clusters them into `union { u16; u8[2] }`, rounds it to agbcc's 4-byte aggregate boundary, and
  //      `e` at +2 starts inside the rounding: raise/structs.ts `buildUnionStruct` declines. Move `e`
  //      to +4 and it MATCHes. ido7.1 and mwcc_242_81 do not straddle (ido's overlap fits at its 1-byte
  //      boundary): MATCH, controls. gcc2.7.2kmc reads the word three times and lifts on the
  //      bitfield-from-word spelling, off. Instrument-pinned on the real function and the row.
  //   5. unarrow1 (sub_08014760). Not a bitfield: a `u16` member narrowed to its low byte on one path
  //      (`gUnk.unk54 += e->x - x0` into an s8 — combine.c `gen_lowpart_for_combine` turns the
  //      subreg-of-MEM into `mem:QI`, so `ldrb` on that path and `ldrh` on the other). No wide read
  //      dominates, truncload cannot fold, and the `{u16,u8}` union at +0 rounds over `y` at +2: the
  //      same `buildUnionStruct` refusal. gcc2.7.2kmc narrows the same way, sizes the union at 2, and
  //      lifts (control); mwcc_242_81 reads `lhz` on both paths, MATCH; ido7.1 lifts on narrow-param
  //      (unrelated), off. Instrument-pinned.
  //   6. sw_jtifbreak / sw_jtifbreak_ctl (sub_0800A804, sub_0800B3C0, sub_08042E64; one cause). A
  //      jump-table arm that `break`s under a guard and otherwise falls into the next case. agbcc and
  //      gcc2.7.2kmc also PRODUCE this shape from `case 1: if (c) f(i); break; case 2: f(i); break;` —
  //      jump.c cross-jumps the shared `bl f; b end` tail into case 2's entry, byte-identical — which is
  //      how the three kleod entity loops hit it; switch-recover's `analyzeArmExit` refuses because a
  //      `break` is only ever loop-scoped. ido7.1's edge is native (it does not cross-jump). All three
  //      decline; mwcc_242_81 builds a tree and lifts it as a nested-if ladder (21/35 against the
  //      control's 2/35). `s32` and a trailing call on purpose: `u8` makes IDO decline first on v0 read
  //      past a call, and a store after the switch makes KMC decline first on `arms do not linearize`.
  //   7. cmn_field / cmn_eq / cmn_ult (sub_08022CA0). A compare against a NEGATED operand: agbcc has no
  //      `cmp rA, -rB`, combine folds the `neg` into the compare, and thumb.md `cmnsi` (823-827) spells
  //      it `cmn rA, rB`, which sets NZCV from a + b. One row per branch class, since each tests a
  //      different flag of the sum: signed (`bgt`), EQ/NE (`bne`), unsigned (`bcs`, C = carry out).
  //      `a + b <= 0` is not folded (`add ; cmp #0`) and MATCHes: the control. The other three have no
  //      compare-negative and MATCH all three (controls). Ablation-pinned. thumb.ts `lowerCmn` reads
  //      `cmn` as `cmp rA, -rB`, so cmn_field and cmn_eq MATCH on agbcc. cmn_ult declines, and
  //      correctly: the carry out of a + b is not a >=u -b at b == 0, so agbcc's `cmn; bcs` for `a < -b`
  //      is its own miscompile, and the exact C (`a + b >= a`) compiles to `add; cmp; bcc`.
  //   8. jt_pre_midg (EntityCreate). A jump table with PRE's code INSIDE its dispatch: gcse's
  //      `insert_insn_end_bb` (gcse.c:4231-4236) puts a later switch's index computation "just before
  //      the tablejump", between `ldr r0,[r0]` and `mov pc` (thumb.md:979 tablejump is the `mov pc`
  //      alone), so it runs on every dispatched case and on no other path. thumb.ts `recoverJumpTable`
  //      takes those instructions as the table's `extras` (`dispatchExtraRefusal` says which it
  //      refuses), and the dispatch block stays, cut to them, under its bounds test: agbcc lifts,
  //      nonmatch. EntityCreate's second table carries four such values. Give `case 4` a body or drop
  //      the `if` path and the insertion moves to the join: MATCH (controls, not rows). ido7.1 and
  //      gcc2.7.2kmc decline the control on their own second table, for an unrelated reason: the
  //      table's `%lo` folds into its load (`lw t7,32(at)`), which frontend/mips.ts refuses on a
  //      non-zero offset, as it does for sw_jtloop2:ido7.1; mwcc_242_81 lifts it.
  //   9. jt_dupdef (VisionSelectInputAndMovement). A table entry naming a label that ALIASES the
  //      default: `case 8` and `default` have identical arms, jump.c cross-jumps case 8's, and its
  //      label is left on the default's first instruction. `recoverJumpTable` reads a `.word` entry
  //      through `decode`'s label aliases, as a branch is read, so agbcc MATCHes. ido7.1 and
  //      gcc2.7.2kmc MATCH and mwcc_242_81 lifts it (their tables are object data). The family
  //      above's "table case aliasing `default`" set-aside.
  //  10. thrbreak (sub_0801C82C). A `break` on `x == t[i].a` whose test the code after the loop
  //      repeats: agbcc threads the break's jump through that test (jump.c thread_jumps, on from -O1),
  //      so the loop's exit lands on the post-loop `if`'s THEN arm while the other exits land on the
  //      re-test — two exit targets (structure.ts `singleExit`, then `foreverShape`, then `onStack`;
  //      traced on the real function and the row). gcc2.7.2kmc threads it too, past the THEN arm into
  //      its delay slot, but its exits hand the re-test an index each computes on its own edge (the
  //      counter re-masked for a `u8`, `i<<2` for an `int`), so the threaded exit cannot be pointed
  //      back at it; ido7.1 does not thread and lifts (control); mwcc_242_81 off (frontend `nor` on
  //      both siblings). Lifted since by pointing the threaded exit back at the re-test on agbcc
  //      (raise/unthread.ts) and by the shared break tail of item 11 on gcc2.7.2kmc.
  //  11. brmerge (sub_0801D6B0). Two break arms that run their own code and then share one tail
  //      (`gHit = i; break;`) before leaving the loop: `codeBreakArm` requires an arm's region to be
  //      entered only through its own edge, the shared tail is entered from the other arm, both arms
  //      refuse, and the header re-enters. Declines on agbcc, ido7.1 and gcc2.7.2kmc with lifting
  //      one-arm controls; mwcc_242_81 off (its one-arm control declines at emission of the recovered
  //      while). The three `continue` tests keep agbcc from peeling the first iteration. Lifted
  //      since on all three: `codeBreakArm` admits a tail other arms enter from the body, and each arm
  //      writes it again ahead of its own `break` (the one copy at the join needs a `continue` that
  //      runs the latch's update, which no loop form spells).
  //  12. dmasret (sub_080202D4). A `vu16` published to a DMA source register BESIDE a struct-return
  //      temp of a two-field 4-byte struct (thumb.c:1426-1472 returns it in memory), with a store
  //      through a computed pointer AFTER the DMA block. The audit bounds a DMA source read by walking
  //      forward from the arming store (frame-objects.ts `readWindow`); the tail's store through an
  //      unresolved pointer makes the walk unbounded, the escape reaches the temp
  //      (`reaches-another-object`), and the one-object answer is withheld because a callee's return
  //      storage is a writer it cannot hold (`writerNotKept`). Drop the tail store, make the callee
  //      scalar, or drop the DMA: each lifts. agbcc only: the other three decline the scalar control on
  //      the published address itself (no `readOnlyAddressSinks` off the GBA). Instrument-pinned.
  //  13. spillhsret (sub_0803D4AC). A spilled local READ BACK NARROWER than it was stored, beside a
  //      struct-return temp: a promoted `u16` spilled as a word (a slot the SSA model keys) and reloaded
  //      `mov r2, sp / ldrh r2, [r2, #4]` because Thumb admits an sp-relative offset only at word size
  //      (thumb.h:886-891). It used to be an object of width 2 over the slot, "one byte, two models"
  //      (`failIfSlotKeysIt`), with the one-object answer off because the hidden return pointer is an
  //      escape. LIFTED by item 3's narrow slot reload: MATCH. spillhsword reloads the word (control,
  //      MATCH). gcc2.7.2kmc MATCHes (control); ido7.1 and mwcc_242_81 lift the row and its controls
  //      to one residual, off. The real function's by-value parameter read as `ldrb` over its home is
  //      the same site and did not reproduce small. Instrument-pinned.
  //  14. sretloop2ret / sretloop1ret (sub_08014230), break_elsetail / break_noelsetail (TextBoxInit),
  //      retarm2_tail / retarm1_tail (sub_0801DFC4): one guard chain (`singleExit` → `foreverShape` →
  //      `onStack`, traced on all three), three cross-jumped exit shapes. sretloop2ret: the function's
  //      OWN hidden-pointer struct return written by two `p.at=..; p.kind=..; return p;` in one loop —
  //      agbcc merges the two insert tails into one non-ret block; one assigning return lifts.
  //      mwcc_242_81 returns the struct in r3 and lifts both (controls); ido7.1 (`swl`) and
  //      gcc2.7.2kmc (frame as sp data) decline first, off. break_elsetail: break_value with an `else`
  //      OUTSIDE the loop assigning the same u8, whose truncation tail is cross-jumped with the break's;
  //      the `while` reading takes the break arm as the exit. Declines on all four (mwcc unrolls 8x,
  //      MIPS put the `andi` in the arm); the no-else control lifts on all four. retarm2_tail: two arms
  //      in one loop ending in the same `Hit(a); return;`, cross-jumped into one block no edge owns
  //      (`earlyReturnArm`); one arm owning the tail MATCHes. mwcc_242_81 keeps the tails apart
  //      (controls); ido7.1 and gcc2.7.2kmc decline on a void function's v0 after `jal`, off. The real
  //      sub_0801DFC4 reaches this through three `goto`s whose goto-free spelling is a different
  //      object, so the FUNCTION stays set aside under the no-goto rule; the row pins the guard.
  // Still set aside, each one function: sub_0801D6B0's second blocker, a return tail shared by a loop
  // exit and post-loop code (the `goto` set-aside; sound); sub_0803D4AC's by-value parameter byte read
  // (same site as 13, not isolated); EntityCreate's and sub_0801DFC4's far-jump relays (lowered).
  {
    sym: 'stksidx',
    src:
      'void *memcpy(void *, const void *, unsigned long);\nstruct E { u16 w; u8 k; u8 pad; };\nextern struct E gE;\nextern s16 gOut;\n' +
      'extern const s8 gBlob[64];\nvoid stksidx(u32 i){ s8 a[64]; memcpy(&a[0], gBlob, sizeof a); gOut += a[i] * gE.w; }',
    features: ['stack-addr', 'array', 'variable-index', 'sign-extend'],
    toolchains: ALL,
    ctx: 'void *memcpy(void *, const void *, unsigned long);\nstruct E { u16 w; u8 k; u8 pad; };\nextern struct E gE;\nextern s16 gOut;\nvoid stksidx(u32 i);',
    proto: { stksidx: { returnsVoid: true } },
  },
  {
    sym: 'imgpair',
    src:
      'struct O { u16 x, y, w, h; };\nextern struct O gO[16];\n' +
      'void imgpair(u32 i){ s8 a[16] = {32,36,-24,-8,8,14,20,8,40,-20,-30,32,46,24,64,48}; u8 b[16] = {130,96,100,92,107,76,120,77,130,80,128,70,124,82,112,70}; gO[i].x = a[3]; gO[i].y = b[5]; }',
    features: ['array'],
    toolchains: ['agbcc'],
    ctx: 'struct O { u16 x, y, w, h; };\nextern struct O gO[16];\nvoid imgpair(u32 i);',
    proto: { imgpair: { returnsVoid: true } },
  },
  {
    sym: 'imgone',
    src:
      'struct O { u16 x, y, w, h; };\nextern struct O gO[16];\n' +
      'void imgone(u32 i){ s8 a[16] = {32,36,-24,-8,8,14,20,8,40,-20,-30,32,46,24,64,48}; gO[i].x = a[3]; }',
    features: ['array'],
    toolchains: ['agbcc'],
    ctx: 'struct O { u16 x, y, w, h; };\nextern struct O gO[16];\nvoid imgone(u32 i);',
    proto: { imgone: { returnsVoid: true } },
  },
  {
    sym: 'spillu8byte',
    src:
      'struct S4 { u16 a; u8 b; u8 pad; };\nextern struct S4 mk(u16 x, u16 y, u8 z);\n' +
      'extern u8 gTbl[];\nextern u32 gA[16];\nextern u8 gOut8;\nextern u32 gOut;\nextern u16 gOut16;\nvoid sink(u32 a, u32 b, u32 c, u32 d);\n' +
      'u32 spillu8byte(u32 k){ u32 v0,v1,v2,v3,v4,v5,v6,v7,v8,v9,v10,v11,v12,v13; u32 i; struct S4 s; u8 m;\n' +
      ' v0=gA[0];v1=gA[1];v2=gA[2];v3=gA[3];v4=gA[4];v5=gA[5];v6=gA[6];v7=gA[7];v8=gA[8];v9=gA[9];v10=gA[10];v11=gA[11];v12=gA[12];v13=gA[13];\n' +
      ' m = gTbl[k];\n' +
      ' for(i=0;i<k;i++){ sink(v0+i,v1+i,v2+i,v3+i); sink(v4+i,v5+i,v6+i,v7+i); sink(v8+i,v9+i,v10+i,v11+i); sink(v12+i,v13+i,0,0); }\n' +
      ' s = mk(k, 0, 0x10); gOut16 = s.a;\n' +
      ' gOut8 = m; return v0; }',
    features: ['narrow', 'promotion', 'struct-return', 'multi-arg'],
    toolchains: ['agbcc'],
    ctx:
      'struct S4 { u16 a; u8 b; u8 pad; };\nstruct S4 mk(u16 x, u16 y, u8 z);\nvoid sink(u32 a, u32 b, u32 c, u32 d);\n' +
      'u32 spillu8byte(u32 k);',
    proto: {
      sink: { params: 4, returnsVoid: true },
      mk: {
        params: ['u16', 'u16', 'u8'],
        returns: 'struct S4',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u16' },
            { name: 'b', type: 'u8' },
            { name: 'pad', type: 'u8' },
          ],
        },
      },
    },
  },
  {
    sym: 'spillu8word',
    src:
      'struct S4 { u16 a; u8 b; u8 pad; };\nextern struct S4 mk(u16 x, u16 y, u8 z);\n' +
      'extern u8 gTbl[];\nextern u32 gA[16];\nextern u8 gOut8;\nextern u32 gOut;\nextern u16 gOut16;\nvoid sink(u32 a, u32 b, u32 c, u32 d);\n' +
      'u32 spillu8word(u32 k){ u32 v0,v1,v2,v3,v4,v5,v6,v7,v8,v9,v10,v11,v12,v13; u32 i; struct S4 s; u8 m;\n' +
      ' v0=gA[0];v1=gA[1];v2=gA[2];v3=gA[3];v4=gA[4];v5=gA[5];v6=gA[6];v7=gA[7];v8=gA[8];v9=gA[9];v10=gA[10];v11=gA[11];v12=gA[12];v13=gA[13];\n' +
      ' m = gTbl[k];\n' +
      ' for(i=0;i<k;i++){ sink(v0+i,v1+i,v2+i,v3+i); sink(v4+i,v5+i,v6+i,v7+i); sink(v8+i,v9+i,v10+i,v11+i); sink(v12+i,v13+i,0,0); }\n' +
      ' s = mk(k, 0, 0x10); gOut16 = s.a;\n' +
      ' gOut = m; return v0; }',
    features: ['narrow', 'promotion', 'struct-return', 'multi-arg'],
    toolchains: ['agbcc'],
    ctx:
      'struct S4 { u16 a; u8 b; u8 pad; };\nstruct S4 mk(u16 x, u16 y, u8 z);\nvoid sink(u32 a, u32 b, u32 c, u32 d);\n' +
      'u32 spillu8word(u32 k);',
    proto: {
      sink: { params: 4, returnsVoid: true },
      mk: {
        params: ['u16', 'u16', 'u8'],
        returns: 'struct S4',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u16' },
            { name: 'b', type: 'u8' },
            { name: 'pad', type: 'u8' },
          ],
        },
      },
    },
  },
  {
    sym: 'spillu8half',
    src:
      'struct S4 { u16 a; u8 b; u8 pad; };\nextern struct S4 mk(u16 x, u16 y, u8 z);\nextern u32 mk2(u16 x, u16 y, u8 z);\n' +
      'extern u8 gTbl[];\nextern u32 gA[16];\nextern u8 gOut8;\nextern u32 gOut;\nextern u16 gOut16;\nvoid sink(u32 a, u32 b, u32 c, u32 d);\n' +
      'u32 spillu8half(u32 k){ u32 v0,v1,v2,v3,v4,v5,v6,v7,v8,v9,v10,v11,v12,v13; u32 i; struct S4 s; u8 m;\n' +
      ' v0=gA[0];v1=gA[1];v2=gA[2];v3=gA[3];v4=gA[4];v5=gA[5];v6=gA[6];v7=gA[7];v8=gA[8];v9=gA[9];v10=gA[10];v11=gA[11];v12=gA[12];v13=gA[13];\n' +
      ' m = gTbl[k];\n' +
      ' for(i=0;i<k;i++){ sink(v0+i,v1+i,v2+i,v3+i); sink(v4+i,v5+i,v6+i,v7+i); sink(v8+i,v9+i,v10+i,v11+i); sink(v12+i,v13+i,0,0); }\n' +
      ' s = mk(k, 0, 0x10); gOut16 = s.a;\n' +
      ' gOut16 = m; return v0; }',
    features: ['narrow', 'promotion', 'struct-return', 'multi-arg'],
    toolchains: ['agbcc'],
    ctx:
      'struct S4 { u16 a; u8 b; u8 pad; };\nstruct S4 mk(u16 x, u16 y, u8 z);\nu32 mk2(u16 x, u16 y, u8 z);\nvoid sink(u32 a, u32 b, u32 c, u32 d);\n' +
      'u32 spillu8half(u32 k);',
    proto: {
      sink: { params: 4, returnsVoid: true },
      mk2: { params: ['u16', 'u16', 'u8'], returns: 'u32' },
      mk: {
        params: ['u16', 'u16', 'u8'],
        returns: 'struct S4',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u16' },
            { name: 'b', type: 'u8' },
            { name: 'pad', type: 'u8' },
          ],
        },
      },
    },
  },
  {
    sym: 'spillu8nosret',
    src:
      'struct S4 { u16 a; u8 b; u8 pad; };\nextern struct S4 mk(u16 x, u16 y, u8 z);\nextern u32 mk2(u16 x, u16 y, u8 z);\n' +
      'extern u8 gTbl[];\nextern u32 gA[16];\nextern u8 gOut8;\nextern u32 gOut;\nextern u16 gOut16;\nvoid sink(u32 a, u32 b, u32 c, u32 d);\n' +
      'u32 spillu8nosret(u32 k){ u32 v0,v1,v2,v3,v4,v5,v6,v7,v8,v9,v10,v11,v12,v13; u32 i; struct S4 s; u8 m;\n' +
      ' v0=gA[0];v1=gA[1];v2=gA[2];v3=gA[3];v4=gA[4];v5=gA[5];v6=gA[6];v7=gA[7];v8=gA[8];v9=gA[9];v10=gA[10];v11=gA[11];v12=gA[12];v13=gA[13];\n' +
      ' m = gTbl[k];\n' +
      ' for(i=0;i<k;i++){ sink(v0+i,v1+i,v2+i,v3+i); sink(v4+i,v5+i,v6+i,v7+i); sink(v8+i,v9+i,v10+i,v11+i); sink(v12+i,v13+i,0,0); }\n' +
      ' gOut16 = mk2(k, 0, 0x10);\n' +
      ' gOut8 = m; return v0; }',
    features: ['narrow', 'promotion', 'multi-arg'],
    toolchains: ['agbcc'],
    ctx:
      'struct S4 { u16 a; u8 b; u8 pad; };\nstruct S4 mk(u16 x, u16 y, u8 z);\nu32 mk2(u16 x, u16 y, u8 z);\nvoid sink(u32 a, u32 b, u32 c, u32 d);\n' +
      'u32 spillu8nosret(u32 k);',
    proto: {
      sink: { params: 4, returnsVoid: true },
      mk2: { params: ['u16', 'u16', 'u8'], returns: 'u32' },
      mk: {
        params: ['u16', 'u16', 'u8'],
        returns: 'struct S4',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u16' },
            { name: 'b', type: 'u8' },
            { name: 'pad', type: 'u8' },
          ],
        },
      },
    },
  },
  {
    sym: 'bfstrad',
    src:
      'struct S { u8 a:2; u8 b:3; u8 c:7; u8 d:3; u16 e; u32 w; };\n' +
      'extern u8 gA, gC, gD;\n' +
      'extern u16 gE;\n' +
      'void bfstrad(struct S *s)\n{\n    gA = s->a;\n    gC = s->c;\n    gD = s->d;\n    gE = s->e;\n}',
    features: ['struct', 'bitfield', 'field', 'pointer', 'mixed-width'],
    toolchains: ['agbcc', 'ido7.1', 'mwcc_242_81'],
    ctx: 'struct S; extern u8 gA, gC, gD; extern u16 gE; void bfstrad(struct S *s);',
    proto: { bfstrad: { returnsVoid: true } },
  },
  {
    sym: 'unarrow1',
    src:
      'struct E { u16 x; u16 y; };\n' +
      'extern s8 gDx;\n' +
      'u32 unarrow1(struct E *e, u16 x0, s32 k)\n{\n    if (k != 0)\n    {\n        gDx += e->x - x0;\n        return e->y;\n    }\n    return e->x + e->y;\n}',
    features: ['struct', 'field', 'pointer', 'narrow', 'mixed-width', 'branch'],
    toolchains: ['agbcc', 'gcc2.7.2kmc', 'mwcc_242_81'],
    ctx: 'struct E; extern s8 gDx; u32 unarrow1(struct E *e, u16 x0, s32 k);',
  },
  {
    sym: 'sw_jtifbreak',
    src:
      'extern s32 gA, gB;\nvoid f(s32 x);\nvoid g(s32 x);\nvoid h(s32 x);\nvoid m(s32 x);\nvoid q(s32 x);\nvoid r(s32 x);\n' +
      'void sw_jtifbreak(s32 i, s32 k)\n{\n    switch (k) {\n    case 0: g(i); break;\n    case 1: if (i != gA && i != gB) break;\n' +
      '    case 2: f(i); break;\n    case 3: h(i); break;\n    case 4: m(i); break;\n    }\n    r(0);\n}',
    features: ['fallthrough', 'break', 'dense'],
    toolchains: ALL,
    ctx: 'extern s32 gA, gB;\nvoid f(s32 x);\nvoid g(s32 x);\nvoid h(s32 x);\nvoid m(s32 x);\nvoid q(s32 x);\nvoid r(s32 x);\nvoid sw_jtifbreak(s32 i, s32 k);',
    proto: {
      sw_jtifbreak: { returnsVoid: true },
      f: { params: 1, returnsVoid: true },
      g: { params: 1, returnsVoid: true },
      h: { params: 1, returnsVoid: true },
      m: { params: 1, returnsVoid: true },
      q: { params: 1, returnsVoid: true },
      r: { params: 1, returnsVoid: true },
    },
  },
  {
    sym: 'sw_jtifbreak_ctl',
    src:
      'extern s32 gA, gB;\nvoid f(s32 x);\nvoid g(s32 x);\nvoid h(s32 x);\nvoid m(s32 x);\nvoid q(s32 x);\nvoid r(s32 x);\n' +
      'void sw_jtifbreak_ctl(s32 i, s32 k)\n{\n    switch (k) {\n    case 0: g(i); break;\n    case 1: if (i == gA || i == gB) f(i); break;\n' +
      '    case 2: q(i); break;\n    case 3: h(i); break;\n    case 4: m(i); break;\n    }\n    r(0);\n}',
    features: ['dense', 'branch'],
    toolchains: ALL,
    ctx: 'extern s32 gA, gB;\nvoid f(s32 x);\nvoid g(s32 x);\nvoid h(s32 x);\nvoid m(s32 x);\nvoid q(s32 x);\nvoid r(s32 x);\nvoid sw_jtifbreak_ctl(s32 i, s32 k);',
    proto: {
      sw_jtifbreak_ctl: { returnsVoid: true },
      f: { params: 1, returnsVoid: true },
      g: { params: 1, returnsVoid: true },
      h: { params: 1, returnsVoid: true },
      m: { params: 1, returnsVoid: true },
      q: { params: 1, returnsVoid: true },
      r: { params: 1, returnsVoid: true },
    },
  },
  {
    sym: 'cmn_field',
    src:
      'struct Ent {\n    u8 pad[0x10];\n    s16 x;\n    u16 y;\n    u8 unk14;\n    u8 flags;\n};\nextern u16 gMag;\n' +
      'void cmn_field(struct Ent *e)\n{\n    if (e->x <= -gMag) {\n        e->x = 0;\n    }\n}',
    features: ['branch', 'compare'],
    toolchains: ALL,
    ctx: 'struct Ent {\n    u8 pad[0x10];\n    s16 x;\n    u16 y;\n    u8 unk14;\n    u8 flags;\n};\nextern u16 gMag;\nvoid cmn_field(struct Ent *e);',
    proto: { cmn_field: { returnsVoid: true } },
  },
  {
    sym: 'cmn_eq',
    src: 'void cmn_eq(s32 a, s32 b, s32 *p)\n{\n    if (a == -b) {\n        *p = 1;\n    }\n}',
    features: ['branch', 'compare'],
    toolchains: ALL,
    ctx: 'void cmn_eq(s32 a, s32 b, s32 *p);',
    proto: { cmn_eq: { returnsVoid: true } },
  },
  {
    sym: 'cmn_ult',
    src: 'void cmn_ult(u32 a, u32 b, s32 *p)\n{\n    if (a < -b) {\n        *p = 1;\n    }\n}',
    features: ['branch', 'compare'],
    toolchains: ALL,
    ctx: 'void cmn_ult(u32 a, u32 b, s32 *p);',
    proto: { cmn_ult: { returnsVoid: true } },
  },
  {
    sym: 'jt_pre_midg',
    src:
      'extern s32 gOut;\nvoid jt_pre_midg(s32 x, s32 *p, s32 c)\n{\n    if (c) {\n        gOut = x - 37;\n    } else {\n        switch (x) {\n' +
      '        case 1: p[0] = 1; break;\n        case 2: p[1] = 2; break;\n        case 3: p[2] = 3; break;\n        case 4: break;\n' +
      '        case 5: p[4] = 5; break;\n        case 6: p[5] = 6; break;\n        case 7: p[6] = 7; break;\n        case 8: p[7] = 8; break;\n' +
      '        default: p[8] = 9; break;\n        }\n    }\n    switch (x) {\n' +
      '    case 37: p[9] = 1; break;\n    case 38: p[10] = 2; break;\n    case 39: p[11] = 3; break;\n    case 40: p[12] = 4; break;\n' +
      '    case 41: p[13] = 5; break;\n    case 42: p[14] = 6; break;\n    case 43: p[15] = 7; break;\n    case 44: p[16] = 8; break;\n    }\n}',
    features: ['dense', 'branch'],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx: 'extern s32 gOut;\nvoid jt_pre_midg(s32 x, s32 *p, s32 c);',
    proto: { jt_pre_midg: { returnsVoid: true } },
  },
  {
    sym: 'jt_dupdef',
    src:
      'void jt_dupdef(u32 x, s32 *p)\n{\n    s32 v;\n    switch (x) {\n    case 1: v = 2; break;\n    case 2: v = 3; break;\n' +
      '    case 3: v = 4; break;\n    case 4: v = 5; break;\n    case 5: v = 6; break;\n    case 6: v = 7; break;\n' +
      '    case 7: v = 8; break;\n    case 8: v = 1; break;\n    default: v = 1; break;\n    }\n    *p = v;\n}',
    features: ['dense', 'switch-arms'],
    toolchains: ALL,
    ctx: 'void jt_dupdef(u32 x, s32 *p);',
    proto: { jt_dupdef: { returnsVoid: true } },
  },
  // jt_idxreuse. A case body that reads the index the jump table's dispatch scaled: mwcc 2.4.2 at
  // -O4,p computes `slwi r5,r3,2` once in the dispatch block and reuses r5 in every `p[i]` case
  // (`stwx r0,r4,r5`). Every recognizer prunes the dispatch block, so the case read a register no
  // lifted path wrote, and the lift minted a parameter for it (`*(s32 *)(a1 + a2) = 7`);
  // frontend/jump-table.ts `enterCaseTarget` now writes `i << 2` there. agbcc emits the reuse as
  // `add r1, r0, r1` (into the pointer register), a dispatch form `recoverJumpTable` does not
  // recognise; ido7.1 and gcc2.7.2kmc recompute the index in the case. Those three are controls.
  {
    sym: 'jt_idxreuse',
    src:
      'extern s32 gArr[];\nvoid jt_idxreuse(s32 i, s32 *p)\n{\n    switch (i) {\n    case 0: p[i] = 7; break;\n' +
      '    case 1: p[i] += 9; break;\n    case 2: p[i] -= 3; break;\n    case 3: p[i] = 0; break;\n' +
      '    case 4: p[i] ^= 5; break;\n    case 5: p[i] |= 0x30; break;\n    case 6: gArr[i] = 1; break;\n    }\n}',
    features: ['dense'],
    toolchains: ALL,
    ctx: 'extern s32 gArr[];\nvoid jt_idxreuse(s32 i, s32 *p);',
    proto: { jt_idxreuse: { returnsVoid: true } },
  },
  {
    sym: 'thrbreak',
    src:
      'struct Pair { u8 a; u8 b; u8 c; u8 d; };\nextern struct Pair gTbl[3];\nextern u8 gOut;\n' +
      'void thrbreak(u8 x)\n{\n    u8 i;\n    for (i = 0; i < 3; i++) {\n        if (x == gTbl[i].a || x == gTbl[i].b)\n            break;\n    }\n    if (x == gTbl[i].a)\n        gOut = 1;\n    else\n        gOut = 2;\n}',
    features: ['break', 'struct'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'void thrbreak(u8 x);',
    proto: { thrbreak: { returnsVoid: true } },
  },
  // thrbreak as a pointer walk: gcc2.7.2kmc's bottom-tested loop hands the re-test the stepped
  // pointer from its latch and the current one from its in-body exit, which is the one the threaded
  // exit read, so raise/unthread.ts points that exit back at the re-test through the THEN arm its
  // delay slot carried (agbcc and ido7.1 are controls). gcc2.7.2 -O1 re-masks `x` on each exit's
  // own block, so its exit target only forwards to the re-test, and unthread reads the re-test
  // behind it.
  {
    sym: 'thrwalk',
    src:
      'struct Pair { u8 a; u8 b; u8 c; u8 d; };\nextern struct Pair gTbl[3];\nextern u8 gOut;\n' +
      'void thrwalk(u8 x)\n{\n    struct Pair *p;\n    for (p = gTbl; p < gTbl + 3; p++) {\n        if (x == p->a || x == p->b)\n            break;\n    }\n    if (x == p->a)\n        gOut = 1;\n    else\n        gOut = 2;\n}',
    features: ['break', 'struct'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'void thrwalk(u8 x);',
    proto: { thrwalk: { returnsVoid: true } },
  },
  // thrwalk with its break tests swapped: gcc2.7.2kmc puts the step in the threaded branch's delay
  // slot, so the current and the stepped pointer are both defined at the threaded exit, and
  // raise/unthread.ts judges each as the re-test's arg (gcc2.7.2kmc and gcc2.7.2).
  {
    sym: 'thrwalkba',
    src:
      'struct Pair { u8 a; u8 b; u8 c; u8 d; };\nextern struct Pair gTbl[3];\nextern u8 gOut;\n' +
      'void thrwalkba(u8 x)\n{\n    struct Pair *p;\n    for (p = gTbl; p < gTbl + 3; p++) {\n        if (x == p->b || x == p->a)\n            break;\n    }\n    if (x == p->a)\n        gOut = 1;\n    else\n        gOut = 2;\n}',
    features: ['break', 'struct'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'],
    ctx: 'void thrwalkba(u8 x);',
    proto: { thrwalkba: { returnsVoid: true } },
  },
  {
    sym: 'brmerge',
    src:
      'struct Ent { u16 x; u16 y; u8 kind; u8 target; u8 flags; u8 pad; };\nextern struct Ent gEnt[8];\nextern u8 gCount, gHit, gB;\n' +
      'void brmerge(u8 self)\n{\n    u8 i;\n    for (i = 1; i <= gCount; i++) {\n        if (gEnt[i].kind > 0x1a)\n            continue;\n        if (gEnt[i].kind == 0x13)\n            continue;\n        if (gEnt[i].target == 1)\n            continue;\n        if (gEnt[i].x == gEnt[self].x)\n            gEnt[self].flags |= 0x10;\n        else if (gEnt[i].y == gEnt[self].y)\n            gEnt[self].flags |= 0x20;\n        else\n            continue;\n        gHit = i;\n        break;\n    }\n    gB = 1;\n}',
    features: ['break', 'continue', 'struct'],
    toolchains: ['agbcc', 'ido7.1', 'gcc2.7.2kmc'],
    ctx: 'void brmerge(u8 self);',
    proto: { brmerge: { returnsVoid: true } },
  },
  {
    sym: 'dmasret',
    src:
      'struct S4 { u16 a; u16 b; };\nstruct Ent { u16 x; u16 y; u8 f; u8 pad[3]; };\n#define gEnts ((struct Ent *)0x03003440)\n' +
      'extern struct S4 mk(u16 x);\n#define gDma ((volatile u32 *)0x040000d4)\n' +
      'void dmasret(u8 i, u8 k)\n{\n    volatile u16 tmp;\n    struct S4 s;\n' +
      '    if (k) {\n        s = mk(gEnts[i].x);\n        gEnts[i].x = s.a;\n    } else {\n        tmp = 0xFFFF;\n        gDma[0] = (u32)&tmp;\n        gDma[1] = 0x05000200;\n        gDma[2] = 0x81000010;\n    }\n' +
      '    gEnts[i].f = 1;\n}',
    features: ['struct-return', 'struct'],
    toolchains: ['agbcc'],
    ctx: 'struct S4 { u16 a; u16 b; };\nstruct S4 mk(u16 x);\nvoid dmasret(u8 i, u8 k);',
    proto: {
      mk: {
        params: ['u16'],
        returns: 'struct S4',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u16' },
            { name: 'b', type: 'u16' },
          ],
        },
      },
      dmasret: { returnsVoid: true },
    },
  },
  {
    sym: 'spillhsret',
    src:
      'struct S4 { u16 a; u16 b; };\nstruct Ent { u16 x; u16 y; u32 w; };\n#define gEnts ((struct Ent *)0x03003440)\nextern u8 gFlags;\n' +
      'extern struct S4 mk(u16 x);\n' +
      'void spillhsret(u8 i)\n{\n    struct S4 s;\n    u16 k0, k1, k2, k3, k4, k5;\n' +
      '    k0 = gEnts[i + 0].x;\n    k1 = gEnts[i + 1].x;\n    k2 = gEnts[i + 2].x;\n    k3 = gEnts[i + 3].x;\n    k4 = gEnts[i + 4].x;\n    k5 = gEnts[i + 5].x;\n' +
      '    if (gFlags & 0x10) {\n        s = mk(gEnts[i].y);\n        if (s.a != 0xFFFF) {\n            gFlags |= 4;\n        } else {\n            gFlags &= ~4;\n        }\n    }\n' +
      '    gEnts[i + 0].y = k0;\n    gEnts[i + 1].y = k1;\n    gEnts[i + 2].y = k2;\n    gEnts[i + 3].y = k3;\n    gEnts[i + 4].y = k4;\n    gEnts[i + 5].y = k5;\n}',
    features: ['struct-return', 'value-home', 'struct'],
    toolchains: ['agbcc', 'gcc2.7.2kmc'],
    ctx: 'struct S4 { u16 a; u16 b; };\nextern u8 gFlags;\nstruct S4 mk(u16 x);\nvoid spillhsret(u8 i);',
    proto: {
      mk: {
        params: ['u16'],
        returns: 'struct S4',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u16' },
            { name: 'b', type: 'u16' },
          ],
        },
      },
      spillhsret: { returnsVoid: true },
    },
  },
  {
    sym: 'spillhsword',
    src:
      'struct S4 { u16 a; u16 b; };\nstruct Ent { u16 x; u16 y; u32 w; };\n#define gEnts ((struct Ent *)0x03003440)\nextern u8 gFlags;\n' +
      'extern struct S4 mk(u16 x);\n' +
      'void spillhsword(u8 i)\n{\n    struct S4 s;\n    u16 k0, k1, k2, k3, k4; u32 k5;\n' +
      '    k0 = gEnts[i + 0].x;\n    k1 = gEnts[i + 1].x;\n    k2 = gEnts[i + 2].x;\n    k3 = gEnts[i + 3].x;\n    k4 = gEnts[i + 4].x;\n    k5 = gEnts[i + 5].x;\n' +
      '    if (gFlags & 0x10) {\n        s = mk(gEnts[i].y);\n        if (s.a != 0xFFFF) {\n            gFlags |= 4;\n        } else {\n            gFlags &= ~4;\n        }\n    }\n' +
      '    gEnts[i + 0].y = k0;\n    gEnts[i + 1].y = k1;\n    gEnts[i + 2].y = k2;\n    gEnts[i + 3].y = k3;\n    gEnts[i + 4].y = k4;\n    gEnts[i + 5].w = k5;\n}',
    features: ['struct-return', 'value-home', 'struct'],
    toolchains: ['agbcc'],
    ctx: 'struct S4 { u16 a; u16 b; };\nextern u8 gFlags;\nstruct S4 mk(u16 x);\nvoid spillhsword(u8 i);',
    proto: {
      mk: {
        params: ['u16'],
        returns: 'struct S4',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u16' },
            { name: 'b', type: 'u16' },
          ],
        },
      },
      spillhsword: { returnsVoid: true },
    },
  },
  {
    sym: 'sretloop2ret',
    src:
      'struct Pick { u16 at; u8 kind; };\nstruct Seg { u16 lo, mid, hi, end; u8 kind; };\n' +
      'struct SegTab { u16 unk0; u16 count; struct Seg *segs; };\nextern struct SegTab *gSegTab;\n' +
      'struct Pick sretloop2ret(u16 x)\n{\n    struct Pick p;\n    u32 i;\n\n    p.at = 0xFFFF;\n' +
      '    for (i = 0; i < gSegTab->count; i++) {\n        if (x <= gSegTab->segs[i].mid) {\n' +
      '            p.at = gSegTab->segs[i].mid;\n            p.kind = gSegTab->segs[i].kind;\n            return p;\n        }\n' +
      '        if (x <= gSegTab->segs[i].end) {\n            p.at = gSegTab->segs[i].end;\n            p.kind = gSegTab->segs[i].kind;\n            return p;\n        }\n' +
      '    }\n    return p;\n}',
    features: ['struct-return', 'field'],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx:
      'struct Pick { u16 at; u8 kind; };\nstruct Seg { u16 lo, mid, hi, end; u8 kind; };\n' +
      'struct SegTab { u16 unk0; u16 count; struct Seg *segs; };\nextern struct SegTab *gSegTab;\nstruct Pick sretloop2ret(u16 x);',
    proto: {
      sretloop2ret: {
        params: ['u16'],
        returns: 'struct Pick',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'at', type: 'u16' },
            { name: 'kind', type: 'u8' },
          ],
        },
      },
    },
  },
  {
    sym: 'sretloop1ret',
    src:
      'struct Pick { u16 at; u8 kind; };\nstruct Seg { u16 lo, mid, hi, end; u8 kind; };\n' +
      'struct SegTab { u16 unk0; u16 count; struct Seg *segs; };\nextern struct SegTab *gSegTab;\n' +
      'struct Pick sretloop1ret(u16 x)\n{\n    struct Pick p;\n    u32 i;\n\n    p.at = 0xFFFF;\n' +
      '    for (i = 0; i < gSegTab->count; i++) {\n        if (x <= gSegTab->segs[i].mid) {\n' +
      '            p.at = gSegTab->segs[i].mid;\n            p.kind = gSegTab->segs[i].kind;\n            return p;\n        }\n' +
      '    }\n    return p;\n}',
    features: ['struct-return', 'field'],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx:
      'struct Pick { u16 at; u8 kind; };\nstruct Seg { u16 lo, mid, hi, end; u8 kind; };\n' +
      'struct SegTab { u16 unk0; u16 count; struct Seg *segs; };\nextern struct SegTab *gSegTab;\nstruct Pick sretloop1ret(u16 x);',
    proto: {
      sretloop1ret: {
        params: ['u16'],
        returns: 'struct Pick',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'at', type: 'u16' },
            { name: 'kind', type: 'u8' },
          ],
        },
      },
    },
  },
  {
    sym: 'break_elsetail',
    src:
      'extern u16 gTab[32];\nextern u16 gKey;\nextern u8 gOff;\nextern void Out(u8 id);\n' +
      'void break_elsetail(void)\n{\n    u8 id = 0;\n    s32 i;\n\n    if (gOff == 0) {\n' +
      '        for (i = 0; i < 32; i++) {\n            if (gTab[i] == gKey) {\n                id = i;\n                break;\n            }\n        }\n' +
      '    } else {\n        id = gOff + 0x1A;\n    }\n    Out(id);\n}',
    features: ['break', 'branch', 'narrow'],
    toolchains: ALL,
    ctx: 'extern u16 gTab[32];\nextern u16 gKey;\nextern u8 gOff;\nvoid Out(u8 id);\nvoid break_elsetail(void);',
    proto: { Out: { params: 1, returnsVoid: true }, break_elsetail: { returnsVoid: true } },
  },
  {
    sym: 'break_noelsetail',
    src:
      'extern u16 gTab[32];\nextern u16 gKey;\nextern u8 gOff;\nextern void Out(u8 id);\n' +
      'void break_noelsetail(void)\n{\n    u8 id = 0;\n    s32 i;\n\n    if (gOff == 0) {\n' +
      '        for (i = 0; i < 32; i++) {\n            if (gTab[i] == gKey) {\n                id = i;\n                break;\n            }\n        }\n' +
      '    }\n    Out(id);\n}',
    features: ['break', 'branch', 'narrow'],
    toolchains: ALL,
    ctx: 'extern u16 gTab[32];\nextern u16 gKey;\nextern u8 gOff;\nvoid Out(u8 id);\nvoid break_noelsetail(void);',
    proto: { Out: { params: 1, returnsVoid: true }, break_noelsetail: { returnsVoid: true } },
  },
  {
    sym: 'retarm2_tail',
    src:
      'extern u8 gTab[16];\nextern void Hit(u32 who);\nextern void Ping(u32 i);\nextern void Pong(u32 i);\n' +
      'void retarm2_tail(u32 a, u32 n)\n{\n    u32 i;\n\n    for (i = 0; i < n; i++) {\n' +
      '        if (gTab[i] == 7) {\n            Ping(i);\n            Hit(a);\n            return;\n        }\n' +
      '        if (gTab[i] == 8) {\n            Pong(i);\n            Hit(a);\n            return;\n        }\n    }\n}',
    features: ['branch'],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx: 'extern u8 gTab[16];\nvoid Hit(u32 who);\nvoid Ping(u32 i);\nvoid Pong(u32 i);\nvoid retarm2_tail(u32 a, u32 n);',
    proto: {
      Hit: { params: 1, returnsVoid: true },
      Ping: { params: 1, returnsVoid: true },
      Pong: { params: 1, returnsVoid: true },
      retarm2_tail: { returnsVoid: true },
    },
  },
  {
    sym: 'retarm1_tail',
    src:
      'extern u8 gTab[16];\nextern void Hit(u32 who);\nextern void Ping(u32 i);\nextern void Pong(u32 i);\n' +
      'void retarm1_tail(u32 a, u32 n)\n{\n    u32 i;\n\n    for (i = 0; i < n; i++) {\n' +
      '        if (gTab[i] == 7) {\n            Ping(i);\n            Hit(a);\n            return;\n        }\n' +
      '        if (gTab[i] == 8) {\n            Pong(i);\n            return;\n        }\n    }\n}',
    features: ['branch'],
    toolchains: ['agbcc', 'mwcc_242_81'],
    ctx: 'extern u8 gTab[16];\nvoid Hit(u32 who);\nvoid Ping(u32 i);\nvoid Pong(u32 i);\nvoid retarm1_tail(u32 a, u32 n);',
    proto: {
      Hit: { params: 1, returnsVoid: true },
      Ping: { params: 1, returnsVoid: true },
      Pong: { params: 1, returnsVoid: true },
      retarm1_tail: { returnsVoid: true },
    },
  },
];

// ── C++ (mwcc `.cp` frontend, PPC only) ───────────────────────────────────────────────────
// The measured symbol is an `extern "C"` wrapper: the method inlines into it at -O4, so the row
// measures C++ codegen (this-pointer member access) under a symbol name BOTH decompilers can
// spell — candidates stay plain C and score through the normal C path. A mangled-method row
// (scoring `len2__3VecFv` itself, asmlift's cpp backend vs m2c's demangler) is future dataset work.
export const SYNTHETIC_CPP: SynthSpec[] = [
  {
    sym: 'Vec__len2',
    lang: 'c++',
    src: 'struct Vec{int x;int y;int len2(){ return x*x+y*y; }};\nextern "C" int Vec__len2(Vec*v){ return v->len2(); }',
    features: ['method'],
    toolchains: ['mwcc_242_81'],
    note: 'C++ method via this-pointer',
  },
  {
    sym: 'Counter__inc',
    lang: 'c++',
    src: 'struct Counter{int n;void inc(){ n++; }};\nextern "C" void Counter__inc(Counter*c){ c->inc(); }',
    features: ['method'],
    toolchains: ['mwcc_242_81'],
    // `struct` spelled out: the ctx must parse as C (m2c's context parser) AND as C++
    ctx: 'struct Counter; void Counter__inc(struct Counter*);',
    proto: { Counter__inc: { returnsVoid: true } },
  },
];
