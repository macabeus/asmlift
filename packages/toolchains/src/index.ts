// @asmlift/toolchains — asmlift's PINNED toolchains (agbcc, IDO 7.1, KMC GCC, CodeWarrior
// 2.4.2b81). PRIVATE by design: sibling-checkout paths and Docker images are benchmark/test
// infrastructure, never a product — user projects bring their own compiler via decomp.yaml.
//
// Importing this package (or compile.ts directly) REGISTERS the four candidate compilers with
// @asmlift/cli's registry — registration lives at compile.ts module scope, never here, so a
// subpath import cannot bypass it.

export * from './toolchain';
export * from './compile';
export * from './score';
export * from './asmdata';
// Re-exported so toolchain-bound tests can single-import everything they score with.
export { scoreObjects, registerCandidateCompiler } from '@asmlift/cli/score';
export type { MatchScore, DiffBreakdown, CandidateCompiler } from '@asmlift/cli/score';
