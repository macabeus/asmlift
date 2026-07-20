// @asmlift/toolchains — per-toolchain scorers: compile a candidate with the PINNED toolchain,
// objdiff it against a target object. Thin wrappers over compile.ts + @asmlift/cli's
// scoreObjects; use @asmlift/cli's target-dispatched `scoreSource` unless you know the target.
import { type MatchScore, scoreObjects } from '@asmlift/cli/score';

import {
  compileCandAgbcc,
  compileCandIdoC,
  compileCandIdoPascal,
  compileCandKmc,
  compileCandPpc,
  compileCandPpcCpp,
} from './compile';

/** Compile C with agbcc, assemble to an object, and objdiff-score it against a target .o. */
export function scoreC(cSource: string, symbol: string, targetObj: string): MatchScore {
  return scoreObjects(targetObj, compileCandAgbcc(cSource), symbol);
}

/** Compile candidate C with IDO, and objdiff-score it against a target object. */
export function scoreCMips(cSource: string, symbol: string, targetObj: string): MatchScore {
  return scoreObjects(targetObj, compileCandIdoC(cSource), symbol);
}

/** Compile candidate IDO Pascal (`cc`→`upas`), and objdiff-score it against a target object. */
export function scorePascalMips(pascalSource: string, symbol: string, targetObj: string): MatchScore {
  return scoreObjects(targetObj, compileCandIdoPascal(pascalSource), symbol);
}

/** Compile candidate C with KMC GCC, and objdiff-score it against a target object. */
export function scoreCMipsGcc(cSource: string, symbol: string, targetObj: string): MatchScore {
  return scoreObjects(targetObj, compileCandKmc(cSource), symbol);
}

/** Compile candidate C with CodeWarrior, and objdiff-score it against a target object. */
export function scoreCPpc(cSource: string, symbol: string, targetObj: string): MatchScore {
  return scoreObjects(targetObj, compileCandPpc(cSource), symbol);
}

/** Compile candidate C++ (`.cp`) with CodeWarrior, and objdiff-score it against the target
 *  object by its MANGLED symbol — how the C++ backend's output is judged byte-exact. */
export function scoreCppPpc(cppSource: string, symbol: string, targetObj: string): MatchScore {
  return scoreObjects(targetObj, compileCandPpcCpp(cppSource), symbol);
}
