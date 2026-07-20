// The Case abstraction: ONE shape both tiers produce and the ONE runner consumes — the row's
// provenance, how to build the scoring target, and (real tier) the context-aware scorer that
// replaces the adapter default.
import type { CandidateCompiler } from '@asmlift/cli/compile-command';
import type { Prototypes } from '@asmlift/core/proto';

import type { Scorer } from '../eval/asmlift';
import type { BuiltTarget, Toolchain } from '../toolchains';

export interface Case {
  id: string; // `${project}:${sym}:${toolchain}` — the stable row id
  tier: 'synthetic' | 'real';
  sym: string;
  project: string; // "synthetic" | manifest project name
  language: 'c' | 'c++';
  features: string[];
  loc: number; // reference source line count
  refSource: string; // ground-truth C/C++ (for the report)
  sourceUrl?: string; // real tier: GitHub permalink to the reference source
  ctx?: string; // m2c --context (full text — inline authored, or sanitized vendored)
  ctxRef?: string; // repo-relative vendored-context path, published on the row instead of ctx
  proto?: Prototypes; // asmlift prototypes
  note?: string;
  toolchain: Toolchain;
  /** Compile the reference → scoring target + the disassembly both decompilers consume.
   *  Throws on build failure (the runner logs BUILD-FAIL and moves on). */
  build: () => BuiltTarget;
  /** Context-aware candidate scorer (real tier); undefined = the toolchain adapter default. */
  scorer?: Scorer;
  /** Context-aware candidate COMPILE (real tier): asmlift's decompileRanked ranks + scores its
   *  candidates through THIS, so asmlift compiles in the same project context (headers, extern
   *  globals) as m2c — symmetric. undefined = the decomp.yaml/registry compiler (synthetic). */
  compile?: CandidateCompiler;
}
