// ONE interface per toolchain's compilation: the real-tier target build and candidate compile
// share the same step functions inside each module, and every shell-template spelling of
// "compile with this toolchain" lives in the module that owns the toolchain. Synthetic-tier
// target builds and candidate scoring stay on the audited seams (@asmlift/toolchains adapters +
// the decomp.yaml route) — these modules unify the HARNESS-side spellings, not the measurement
// path.
//
// Real-tier compilation consumes PREPROCESSED translation units: the dataset vendors each
// function's `.i` (see cases/vendor.ts), so the runner needs no project checkouts, no include
// trees and no cpp configuration — those exist only at vendor/verify time (RealProjectCfg).
import type { BuiltTarget, ToolchainId } from '../toolchains';

/** Vendor/verify-time description of a live project checkout (never used by the runner). */
export interface RealProjectCfg {
  project: string;
  toolchain: ToolchainId;
  root: string; // project root (cwd for the preprocessor include resolution)
  /** the build unit this TU belongs to, as the manifest keys its `units` by. A project's build can
   *  run the compiler under a per-unit WRAPPER (dtk's `sjiswrap.exe`), and a unit preprocessed
   *  without it is not the text that build compiled. */
  unit: string;
  cppIncludes: string[]; // e.g. ["-nostdinc","-I","tools/agbcc/include","-iquote","include"]
  headers: string[]; // project headers to #include (in order)
  defines?: string[]; // extra -D macros for cpp
}

export interface RealCompile {
  /** Compile a PREPROCESSED translation unit at `cflags` → scoring-target obj + the disasm asmlift
   *  consumes, read from the section defining `sym` when the object has more than one. */
  buildTarget(iText: string, sym: string, cflags: readonly string[]): BuiltTarget;
  /** Compile a candidate TU (self-contained — no project includes) at `cflags` → obj path. Throws on
   *  compile failure (mapped to `noncompile` upstream). */
  compileCandidate(tu: string, sym: string, cflags: readonly string[]): string;
  /** Preprocess a raw TU against a live checkout — vendor/verify time only. */
  preprocess(cfg: RealProjectCfg, tu: string): string;
}
