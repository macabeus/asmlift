// EACH CODEWARRIOR BUILD, AGAINST THE BYTES ITS GAME SHIPS.
//
// A toolchain entry is a claim that this binary, mounted and run the way the harness runs it,
// compiles that project's code the way the project's own build does. Nothing short of the ROM
// settles it: a compile that succeeds, an object that disassembles, even a row that scores — all
// of those are true of the WRONG CodeWarrior build too.
//
// So each new build takes one function of its own game through the whole real-tier path — the
// unit's own flags off its `build.ninja` edge, mwcceppc's own front end over the project's include
// tree, the target compile, then `compareWithRom` against the project's linked ELF with every
// relocated field masked — and the answer must be the bytes the game holds at that address.
//
// EQUALITY IS HALF A PROOF. That the bytes match says the harness compiled something correctly; it
// does not say the id chose the binary, because a substituted build can answer the same bytes.
// Mario Party 4's DOL code is the case in point: `mwcc_242_81` and `mwcc_247_107` compile all 128
// functions of `game/main.c`, `game/dvd.c`, `game/memory.c` and `game/board/main.c` to IDENTICAL
// bytes, at `-O0,p` and at `-O4,p` alike, so on that code GC/2.6 buys provenance rather than
// codegen — a manifest naming the compiler the project names. So each proof also names a build
// that must NOT reproduce its bytes, chosen among the substitutions its own unit decides, and
// asserts that too. WHAT EACH SEPARATES DIFFERS: Pikmin's C++ breaks at +0x3 under `mwcc_242_81`,
// Mario Party 4's unit at +0x0 under `mwcc_233_163n`.
//
// Checkout-gated: `bench setup --build` materializes and builds these projects, and CI has
// neither. Where a checkout is absent the claim is not weakened, it is simply not asked.
import { storedFlags, tokenizeFlags, unitLanguage } from '@asmlift/core/codegen-flags';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { ninjaCflags } from '../src/cases/derive-flags';
import { benchCheckoutsDir } from '../src/cases/manifests';
import { compareWithRom } from '../src/cases/rom-function';
import { realCompilerFor } from '../src/compile/real';
import type { RealProjectCfg } from '../src/compile/types';
import type { ToolchainId } from '../src/toolchains';

/** Preprocessing a project's include tree and compiling the result costs tens of seconds. */
const BUDGET = 600_000;

interface RomProof {
  toolchain: ToolchainId;
  project: string;
  /** the `objdiff.json` unit, and the source file it is built from */
  unitName: string;
  unit: string;
  /** the symbol as the object spells it — mangled, for a C++ unit */
  sym: string;
  /** where the game holds that function, and the linked ELF that holds it */
  addr: number;
  elf: string;
  /** A build that must NOT reproduce these bytes. Equality on its own proves the harness compiled
   *  SOMETHING correctly; it does not prove the binary was chosen by the id, because a substituted
   *  build can answer the very same bytes — Mario Party 4's DOL code does, under GC/1.3.2 and
   *  GC/2.6 alike. The substitution named here is one this unit DOES decide, so the proof turns
   *  red when an id stops selecting its own compiler. */
  separatedFrom: ToolchainId;
}

const PROOFS: RomProof[] = [
  {
    toolchain: 'mwcc_247_107',
    project: 'marioparty4',
    unitName: 'main/game/memory',
    unit: 'src/game/memory.c',
    sym: 'HuMemHeapDump',
    addr: 0x8000ad48,
    elf: 'build/GMPE01_00/main.elf',
    // GC/1.3.2 IS this unit's twin (all 128 functions identical); GC/1.2.5n is not.
    separatedFrom: 'mwcc_233_163n',
  },
  {
    toolchain: 'mwcc_233_163n',
    project: 'pikmin',
    unitName: 'main/sysCommon/controller',
    unit: 'src/sysCommon/controller.cpp',
    sym: 'getMainStickX__10ControllerFv',
    addr: 0x80040a9c,
    elf: 'build/GPIE01_01/main.elf',
    separatedFrom: 'mwcc_242_81',
  },
];

/** The unit's preprocessor words, split out of the same `build.ninja` edge its codegen flags come
 *  from: the include paths a row's manifest will carry, taken from the build rather than retyped. */
function preprocessorWords(words: string[]): { includes: string[]; defines: string[] } {
  const includes: string[] = [];
  const defines: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '-i' || w === '-I') {
      includes.push(w, words[++i]);
    } else if (w === '-nodefaults' || w === '-nosyspath' || w === '-multibyte') {
      includes.push(w);
    } else if (w === '-d') {
      defines.push(w, words[++i]);
    } else if (w.startsWith('-D')) {
      defines.push(w);
    }
  }
  return { includes, defines };
}

/** PIKMIN'S ONE PREPROCESSOR-ONLY SOURCE LINE. `include/DebugLog.h` spells an `#elif` with C++'s
 *  alternative `or`, which every CodeWarrior build COMPILES and none of them accepts under `-EP` —
 *  measured on all three, with `-lang=c++`, a `.cpp` extension, `-ansi off` and `-stdkeywords off`
 *  alike. It is the only such line in the tree, and it stands between this project and a vendored
 *  translation unit, so the row PR that switches the checkout to the fork branch has to rewrite it
 *  as `||` (a no-op for the compiler, which is what makes the rewrite safe).
 *
 *  Until then this proof cannot be asked of Pikmin, and it says which line is why rather than
 *  reporting a compiler failure. */
const PIKMIN_EP_BLOCKER = /^#elif defined\(VERSION_DPIJ01_PIKIDEMO\) or /m;

function blockedByAlternativeToken(root: string, project: string): boolean {
  const header = join(root, 'include/DebugLog.h');
  return project === 'pikmin' && existsSync(header) && PIKMIN_EP_BLOCKER.test(readFileSync(header, 'utf8'));
}

describe('a CodeWarrior build compiles its own game', () => {
  for (const p of PROOFS) {
    const root = join(benchCheckoutsDir(), p.project);
    const built = existsSync(join(root, 'build.ninja')) && existsSync(join(root, p.elf));
    if (!built) {
      console.warn(`[${p.toolchain}] ${p.project} is not built — skipping its ROM proof.`);
    } else if (blockedByAlternativeToken(root, p.project)) {
      console.warn(
        `[${p.toolchain}] ${p.project}'s include/DebugLog.h still spells an #elif with C++'s ` +
          `alternative 'or', which mwcceppc -EP rejects — skipping its ROM proof.`,
      );
    }
    test.runIf(built && !blockedByAlternativeToken(root, p.project))(
      `${p.toolchain}: ${p.sym} is byte-equal to ${p.project}'s own 0x${p.addr.toString(16)}`,
      () => {
        const objdiff = JSON.parse(readFileSync(join(root, 'objdiff.json'), 'utf8')) as {
          units: { name: string; base_path: string; scratch: { compiler: string; c_flags: string } }[];
        };
        const unit = objdiff.units.find((u) => u.name === p.unitName);
        expect(unit, `${p.project} objdiff.json has no unit ${p.unitName}`).toBeDefined();
        // the project itself says which build compiles this unit; the proof is only a proof of this
        // toolchain if the project names it
        expect(unit!.scratch.compiler).toBe(p.toolchain);

        const edge = ninjaCflags(readFileSync(join(root, 'build.ninja'), 'utf8'), unit!.base_path);
        expect(edge, `build.ninja has no edge building ${unit!.base_path}`).toBeDefined();
        const words = tokenizeFlags(edge!);
        const cflags = storedFlags('mwcc', words);
        const { includes, defines } = preprocessorWords(words);

        const cfg: RealProjectCfg = {
          project: p.project,
          toolchain: p.toolchain,
          root,
          unit: p.unit,
          cflags,
          cppIncludes: includes,
          headers: [],
          defines,
        };
        const rc = realCompilerFor(p.toolchain);
        // the dialect the project's own edge builds this unit in — `preprocess` reads the same word
        const language = unitLanguage(p.unit, cflags);
        const iText = rc.preprocess(cfg, readFileSync(join(root, p.unit), 'utf8'));
        const target = rc.buildTarget(iText, p.sym, cflags, language);
        const elf = readFileSync(join(root, p.elf));
        expect(compareWithRom(readFileSync(target.obj), p.sym, elf, p.addr)).toMatchObject({ equal: true });

        // …and the same text through a build the project does NOT name is not these bytes. Without
        // this half the proof passes just as happily with every id bound to one binary.
        const other = realCompilerFor(p.separatedFrom).buildTarget(iText, p.sym, cflags, language);
        expect(
          compareWithRom(readFileSync(other.obj), p.sym, elf, p.addr),
          `${p.separatedFrom} must not reproduce ${p.project}'s ${p.sym}`,
        ).toMatchObject({ equal: false });
      },
      BUDGET,
    );
  }
});
