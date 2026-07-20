// CodeWarrior / PowerPC (GC, Docker) — the real tier is NOT WIRED for mwcc: the synthetic tier
// compiles standalone TUs through @asmlift/toolchains' compilePpcTarget, but a real-project
// build needs the project's include tree preprocessed for mwcc's dialect, which no manifest
// exercises yet. `null` is what the dispatch table and `verify` surface as "unsupported".
import type { RealCompile } from './types';

export const mwccReal: RealCompile | null = null;
