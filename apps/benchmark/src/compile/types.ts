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

/** What a real row's translation unit is, before preprocessing (cases/manifests.ts `tu`). */
export type TuModel = 'assembled' | 'unit';

/** Vendor/verify-time description of a live project checkout (never used by the runner). */
export interface RealProjectCfg {
  project: string;
  toolchain: ToolchainId;
  root: string; // project root (cwd for the preprocessor include resolution)
  /** the build unit this TU belongs to, as the manifest keys its `units` by. A project's build can
   *  run the compiler under a per-unit WRAPPER (dtk's `sjiswrap.exe`), and a unit preprocessed
   *  without it is not the text that build compiled. */
  unit: string;
  /** the flags the project's build compiles `unit` at, as the manifest stores them. Preprocessing
   *  is not flag-free: a CodeWarrior unit's DIALECT is a flag (`-lang`), and the headers branch on
   *  it. */
  cflags: readonly string[];
  cppIncludes: string[]; // e.g. ["-nostdinc","-I","tools/agbcc/include","-iquote","include"]
  headers: string[]; // project headers to #include (in order)
  defines?: string[]; // extra -D macros for cpp
}

export interface RealCompile {
  /** Compile a PREPROCESSED translation unit at `cflags`, in the row's `language` → scoring-target
   *  obj + the disasm asmlift consumes, read from the section defining `sym` when the object has
   *  more than one. A toolchain with no C++ front end implements the C parameters alone: real.ts
   *  refuses a `c++` row before it can reach one. */
  buildTarget(iText: string, sym: string, cflags: readonly string[], language: 'c' | 'c++'): BuiltTarget;
  /** Compile a candidate TU (self-contained — no project includes) at `cflags`, in the row's
   *  `language` → obj path. Throws on compile failure (mapped to `noncompile` upstream). */
  compileCandidate(tu: string, sym: string, cflags: readonly string[], language: 'c' | 'c++'): string;
  /** Preprocess a raw TU against a live checkout — vendor/verify time only. */
  preprocess(cfg: RealProjectCfg, tu: string): string;
  /** The context a row vendors, out of its unit preprocessed with the body removed: what a candidate
   *  compiles against and what m2c reads as `--context`, so it has to be text m2c's C parser accepts. */
  vendoredContext(preprocessed: string, cflags: readonly string[], language: 'c' | 'c++'): string;
  /** The functions a PREPROCESSED translation unit calls with no declaration in scope, sorted, each once —
   *  answered in the unit's own dialect. A call without one compiles as a C89 implicit declaration (an
   *  `int` return, promoted arguments), which is not the unit the project built. */
  undeclaredCallees(tu: string, cflags: readonly string[], language: 'c' | 'c++'): string[];
}
