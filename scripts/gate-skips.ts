// THE SKIPS A GATE EXPECTS ON THIS HOST — read by scripts/gate-skips-check.ts, which
// scripts/gate-vitest.sh runs on every gate.
//
// A skip is a gate that did not run, and that rule stays: a test that skipped because the shell
// lacked a toolchain is not a pass. But a few root-config tests can only run on a host this one is
// not — macOS, an old Command Line Tools SDK, a GCC 15 preprocessor, a bash `sh`, GCC 2.7.2 through
// Docker rather than natively — and a blanket FAIL on those made every Linux gate print FAIL, so
// that a real FAIL read like the known one. Each entry here names the tests a condition skips, in
// the condition's own words, and `holds` asks THIS host that condition with the same probe the test
// file uses. The gate then passes a skip only when an entry lists it AND its `holds` is true here;
// it fails a skip no entry lists, a listed skip whose condition does not hold (it skipped for some
// other reason), and an entry whose condition holds while its listed test ran or no longer exists
// (stale: a renamed test, or a condition copied wrong). Entries for a file the run did not collect
// are not asked.
//
// `tests` are vitest's names: the describe titles and the test title joined with ' > ', exactly as
// a `test.each` formats them. `holds` must be the NEGATION of the test's own `runIf` (or its
// `skipIf`), probed the way that file probes it; keep the two in step when either moves.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { agbccAvailable, gcc272Available } from '../packages/toolchains/src/compile';
import { gcc272Native } from '../packages/toolchains/src/native';
import { TOOLCHAIN } from '../packages/toolchains/src/toolchain';

export interface ExpectedSkip {
  /** The test file, relative to the repository root. */
  file: string;
  /** The condition that skips them, as a sentence: what this host lacks. */
  when: string;
  /** Whether that condition holds here — the negation of the tests' own gate. */
  holds: () => boolean;
  tests: readonly string[];
}

/** apps/benchmark/test/candcache-reads.test.ts `HAVE_EMBED`: the agbcc pipeline's preprocessor
 *  reads `#embed` (GCC 15 and later). */
const cppEmbeds = (): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-skips-embed-'));
  try {
    const file = join(dir, 'b');
    writeFileSync(file, 'x');
    return spawnSync('arm-none-eabi-cpp', ['-P', '-'], { input: `#embed "${file}"\n` }).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** candcache-reads.test.ts `HAVE_GCC`: the agbcc pipeline's arm-none-eabi-gcc preprocesses C2x. */
const armGccPreprocesses = (): boolean => {
  const gcc = isAbsolute(TOOLCHAIN.as) ? join(dirname(TOOLCHAIN.as), 'arm-none-eabi-gcc') : 'arm-none-eabi-gcc';
  return spawnSync(gcc, ['-std=c2x', '-trigraphs', '-E', '-x', 'c', '-'], { input: '' }).status === 0;
};

/** candcache-reads.test.ts `SH_INDIRECT`: the `sh` a command runs under expands `${!name}`. */
const shIndirects = (): boolean =>
  spawnSync('sh', ['-c', 'a=b; b=1; echo "${!a}"'], { encoding: 'utf8' }).stdout?.trim() === '1';

const GCC272_IN_CONTAINER = 'GCC 2.7.2 in its container';

export const EXPECTED_SKIPS: readonly ExpectedSkip[] = [
  {
    file: 'packages/cli/test/offline/candcache-bench.test.ts',
    when: 'the host is not macOS, or has no /usr/bin/cpp (an xcrun trampoline exists only there)',
    holds: () => !(platform() === 'darwin' && existsSync('/usr/bin/cpp')),
    tests: [
      'R310-28: an xcrun trampoline refuses the namespace > a store run whose cpp is Apple’s /usr/bin/cpp stores nothing',
    ],
  },
  {
    file: 'packages/cli/test/offline/candcache-bench.test.ts',
    when: 'the host is not macOS (otool and @executable_path are Mach-O)',
    holds: () => platform() !== 'darwin',
    tests: [
      'R310-30: the libraries a program loads, as the loader finds them > R310-40: refuses a program otool cannot read, which it lists as no libraries',
      'R310-30: the libraries a program loads, as the loader finds them > a library’s @executable_path and @loader_path libraries are in its program’s chain',
    ],
  },
  {
    file: 'apps/benchmark/test/candcache-namespace.test.ts',
    when: 'the host has no Command Line Tools clang beside a MacOSX12.3 SDK',
    holds: () =>
      !(
        existsSync('/Library/Developer/CommandLineTools/usr/bin/clang') &&
        existsSync('/Library/Developer/CommandLineTools/SDKs/MacOSX12.3.sdk')
      ),
    tests: [
      'hole 5 — the compile environment is an input to every candidate compile > …because a clang predefines from SDKROOT',
    ],
  },
  {
    file: 'apps/benchmark/test/candcache-reads.test.ts',
    when: "agbcc is missing, or the agbcc pipeline's arm-none-eabi-cpp does not read #embed (GCC 15 and later do)",
    holds: () => !(agbccAvailable() && cppEmbeds()),
    tests: [
      'agbcc > compiles a TU that reads a file afresh on every run: #embed',
      'agbcc > compiles a TU that reads a file afresh on every run: __has_embed',
    ],
  },
  {
    file: 'apps/benchmark/test/candcache-reads.test.ts',
    when: "arm-none-eabi-gcc is missing, or this host's sh does not expand ${!name} (dash does not, bash does)",
    holds: () => !(armGccPreprocesses() && shIndirects()),
    tests: [
      'a command whose program reads what its words do not show > compiles afresh on every run: a variable named through another',
    ],
  },
  {
    file: 'apps/benchmark/test/docker-cache.test.ts',
    when: 'GCC 2.7.2 is missing, or runs natively here, so no compile of it goes through a container',
    holds: () => !(gcc272Available() && !gcc272Native()),
    tests: [
      'two compiles of one TU differ only in the scratch directory, and the rewrite makes them equal',
      'keeps an error the compiler located in the candidate',
      'does not keep a located warning beside an object it could not write',
      'does not keep what the daemon says about a container that is not there',
      'serves warm what it compiled cold, and its sampled audit agrees with a fresh compile',
      'never stores a failure that is not a located refusal, and compiles that key again',
      'stores an object it may only read, and leaves that file as the compiler wrote it',
      'gives a key the audit withheld its stored answer back when the fresh compile fails',
      'does not store a compile that took another route than its probe',
      'does not keep a located error from a compiler that was killed before it finished',
      'a retagged image misses the store: the namespace is the image content, not its tag',
      'ends the store on a pool that changed image for every flag set, and keeps no rejection compiled there',
      'notices a pool that another process started on a moved image while this one compiled',
      'R310-44: stores nothing compiled in a pool another process replaced, on another image, and ends the store',
      'R310-44: stores nothing compiled in a pool another process replaced, on the same image: another daemon, or a restart, and ends the store',
      'keeps nothing a one-shot docker run compiled: the tag it reads can move between two of them',
      'reads the image of a compile with no pool container off the tag alone, and the runtime that executes it',
    ].map((t) => `${GCC272_IN_CONTAINER} > ${t}`),
  },
];
