// The benchmark result schema: ONE definition imported by both the producer (apps/benchmark)
// and the consumer (apps/web). Types only, zero deps, zero runtime code — browser-safe by
// construction.

export type ToolchainId = 'agbcc' | 'ido7.1' | 'gcc2.7.2kmc' | 'gcc2.7.2' | 'mwcc_242_81';

export type DecompilerId = 'asmlift' | 'm2c';

/** How a single decompiler fared on one function — ONE classifier, applied identically to both
 *  decompilers (apps/benchmark/src/eval/outcome.ts). */
export type Outcome =
  | 'match' // compiled AND objdiff score 0 (byte-exact)
  | 'nonmatch' // compiled but score > 0
  | 'declined' // output bears explicit incompleteness markers (ASMLIFT_ERROR; m2c's
  // M2C_ERROR/M2C_UNK/M2C_CARRY/`?` placeholders) — never compiled or scored.
  // Symmetric label: capability gaps on both sides — functions whose context-free m2c
  // run declined on `?` placeholders receive their context (ctx/ctxRef fields below).
  | 'noncompile' // marker-free source that claims completeness but fails to compile; the
  // function's row keeps the SOURCE (not the error text) + the compiler error in errorMarkers
  | 'failed'; // no usable output at all (crash, "Function not found", empty)

export interface QualityScore {
  score: number; // 0..100 readability heuristic
  lines: number;
  gotos: number;
  casts: number;
  unkGlue: number; // count of undecompiled-glue markers (apps/benchmark/src/eval/quality.ts)
  rawMem: number; // `*(T*)(p + N)` raw memory casts — type recovery failed (score-penalized)
  addrDeref: number; // `*(T*)0xADDR` absolute-address derefs — symbol recovery failed (counted, NOT score-penalized)
}

/** objdiff difference-kind tally (structurally mirrors packages/cli/src/objdiff.ts DiffBreakdown
 *  — spelled out here so this package stays dependency-free). */
export interface DiffBreakdown {
  insert: number;
  delete: number;
  replace: number;
  opMismatch: number;
  argMismatch: number;
}

export interface DecompilerResult {
  decompiler: DecompilerId;
  outcome: Outcome;
  source: string; // the C the decompiler emitted ("failed" rows: its failure text)
  score: number | null; // objdiff differences (differing instruction rows); 0 = match; null if it never compiled/ran
  maxScore: number | null; // objdiff instruction-row count (for normalization)
  compileErrors: number | null; // when outcome === "noncompile"
  /** WHERE the diff sits (per-kind tally over objdiff instruction rows); absent when never scored. */
  breakdown?: DiffBreakdown;
  quality: QualityScore;
  /** declined: decline-marker names (m2c) or `<stage>: <reason>` diagnostics (asmlift);
   *  noncompile: compiler diagnostic lines; failed: a first-line summary. */
  errorMarkers?: string[];
  /** asmlift only: this row ran WITH the project's vendored symbol map (names + declaration
   *  shapes derived from its ELF — the analogue of m2c's context input). Absent ⇒ no map was
   *  available; the report must not read mixed tables as apples-to-apples. */
  symbolMap?: true;
  /** asmlift only: the never-worse BACKSTOP engaged — the symbol map induced a gap and the row
   *  re-ran (and classified) RAW, without the map. Zero occurrences across runs is the signal
   *  the backstop can be retired. */
  symbolMapFellBack?: true;
}

/** MEASURED size of the remaining gap (merge-time): the best compiling candidate's absolute
 *  objdiff diff, its ratio over objdiff instruction rows, and where the diff sits. This column
 *  measures — it does not predict closability. null when either decompiler matched or nothing
 *  compiled. */
export interface GapSize {
  decompiler: DecompilerId; // whose candidate is the best (smallest diff)
  score: number; // objdiff difference count of that candidate
  maxScore: number; // objdiff instruction-row count (denominator)
  ratio: number; // score / max(1, maxScore), 0..1
  kinds?: DiffBreakdown; // insert/delete/replace/op/arg tally of that candidate
}

/** One benchmark row: one (function × toolchain) case with both decompilers' outcomes. */
export interface FunctionResult {
  id: string; // stable unique id: `${project}:${sym}:${toolchain}`
  sym: string;
  project: string; // "synthetic" | "kleod" | "pokeemerald" | ...
  tier: 'synthetic' | 'real';
  toolchain: ToolchainId;
  isa: 'arm' | 'mips' | 'ppc';
  compiler: string;
  language: 'c' | 'c++';
  features: string[]; // e.g. ["arithmetic","branch"]
  loc: number; // reference source line count
  refSource: string; // the reference C/C++ (ground truth), for the report
  /** GitHub permalink (commit-pinned, line-anchored) to the reference source in its decomp
   *  project — real tier only; the manifest records it and CI-verified extraction keeps the
   *  quoted funcC honest against it. */
  sourceUrl?: string;
  targetAsm: string; // disassembly both decompilers consumed
  ctx?: string; // the small authored context header m2c received via --context, when inline
  /** Repo-relative path of the VENDORED project context m2c received (attribute-sanitized at
   *  use) — set instead of `ctx` when the context is the project's own headers (~10–260 KB,
   *  referenced rather than embedded). */
  ctxRef?: string;
  /** Prototype hints asmlift received (structurally mirrors @asmlift/core/proto Prototypes —
   *  spelled out here so this package stays dependency-free): a callee's `params` (a bare arity
   *  count OR the typed parameter list) drives call argument recovery; the function's own entry
   *  supplies `returnsVoid`. */
  proto?: Record<string, { params?: number | string[]; returnsVoid?: boolean }>;
  /** The target object's combined `objdump -s -r -t` dump (symbols + relocs + data-section
   *  bytes) — what feeds jump-table/const recovery for both decompilers. Absent on ARM rows
   *  (agbcc `.s` carries its data inline). */
  asmDump?: string;
  asmlift: DecompilerResult;
  m2c: DecompilerResult;
  /** Copy-paste reproduction shell scripts, generated at merge time from this row's own
   *  inputs (apps/benchmark/src/report/repro-scripts.ts) and re-executed by the pre-publish
   *  fidelity gate — the web app only displays them. */
  scripts?: { m2c: string; asmlift: string };
  note?: string; // provenance / caveats (e.g. version mismatch)
  gapSize?: GapSize | null;
}

export interface BenchMeta {
  generatedAt: string;
  toolchains: ToolchainId[];
  counts: { total: number; synthetic: number; real: number };
  /** provenance: which asmlift produced these numbers (commit sha + working-tree dirty flag);
   *  absent only if git was unreadable. */
  asmlift?: { commit: string; dirty: boolean };
  /** provenance: the pinned m2c commit these numbers measured (enforced pre-run). */
  m2c?: { commit: string };
}

export interface BenchOutput {
  meta: BenchMeta;
  results: FunctionResult[];
}
