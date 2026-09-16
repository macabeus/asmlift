// Per-project recipes for BENCH-OWNED checkouts (apps/benchmark/checkouts/ — see
// manifests.benchCheckoutsDir). `bench setup` clones each fork there and runs the project's
// `prepare` steps (toolchains, venvs, generated sources); `bench setup --build` then runs the
// full VERIFIED build (every recipe ends in the project's own byte-compare gate — a non-matching
// ROM fails loudly). These recipes MUTATE the checkout they are given, so they must only ever
// run against a bench-owned clone — setup enforces that; the sibling WORKSPACE checkouts carry
// the maintainer's WIP and are read at most as a baserom copy-in source.
//
// Host facts the recipes encode (verified empirically on macOS/arm64):
//   - host-tool C builds run with /usr/bin ahead of homebrew, so `cc`/`gcc` is Apple clang
//     (homebrew gcc miscompiles some of the projects' host tools);
//   - kleod's ROM build must preprocess with the CROSS cpp (arm-none-eabi-cpp): every host
//     preprocessor here defines __APPLE__, which the project's headers act on;
//   - af needs mips-linux-gnu binutils under /opt/cross and Rosetta (x86_64 IDO recomp);
//   - snowboardkids2 builds inside a linux/amd64 Docker container;
//   - the KMC gcc 2.7.2 mac binaries (marioparty3) are x86_64 → Rosetta as well;
//   - the GameCube projects build with dtk and ninja rather than gmake, under wine on macOS, and
//     their disc images are never committed: each goes in the checkout's own `orig/<version>/`
//     (src/cases/dtk-project.ts holds the whole dtk story).
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';

import { type DtkOptions, dtkBuild, dtkPrepare } from './dtk-project';
import { benchCheckoutsDir } from './manifests';

export interface ProjectRecipe {
  /** checkout-relative baserom paths copied in from the sibling user checkout when found */
  baseroms: string[];
  /** idempotent post-clone preparation (cheap no-op when already prepared) */
  prepare?: (dir: string) => void;
  /** the full build; MUST end in the project's own byte-compare gate */
  build: (dir: string) => void | Promise<void>;
}

const sh = (cmd: string, cwd: string, env: NodeJS.ProcessEnv = process.env): void => {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', env });
};

/** /usr/bin first: host-tool builds must see Apple clang as cc/gcc, not homebrew gcc. */
const hostToolEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: `/usr/bin:${process.env.PATH}` });

/** af (and mac KMC gcc) additionally need the /opt/cross mips binutils on PATH. */
const afBuildEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `/usr/bin:/opt/cross/bin:${process.env.PATH}`,
});

const jobs = (): string => `-j${Math.min(8, cpus().length || 4)}`;

/** Missing or contentless — an `mkdir` alone must not satisfy an "already extracted" guard. */
const emptyDir = (p: string): boolean => !existsSync(p) || readdirSync(p).length === 0;

/** Clone (cached under checkouts/.tools) + build an agbcc fork, and install it into the
 *  project (tools/agbcc/{bin,include,lib}). Skipped when the project already has the binary. */
function installAgbcc(fork: string, projDir: string): void {
  if (existsSync(join(projDir, 'tools', 'agbcc', 'bin', 'agbcc'))) {
    return;
  }
  const cache = join(benchCheckoutsDir(), '.tools', `agbcc-${fork.replace('/', '-')}`);
  if (!existsSync(cache)) {
    mkdirSync(dirname(cache), { recursive: true });
    try {
      sh(`git clone --depth 1 https://github.com/${fork}.git ${JSON.stringify(cache)}`, benchCheckoutsDir(), {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      });
    } catch (e) {
      rmSync(cache, { recursive: true, force: true }); // no half-clones in the cache
      throw e;
    }
  }
  sh('sh build.sh', cache, hostToolEnv());
  sh(`sh install.sh ${JSON.stringify(projDir)}`, cache, hostToolEnv());
}

/** snowboardkids2 builds inside a linux/amd64 container (KMC gcc linux binaries + splat). */
function sbk2DockerBuild(dir: string): void {
  const script = [
    'apt-get update -qq >/dev/null',
    // clang: the project's CC_CHECK advisory pass runs it on every TU
    'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential clang binutils-mips-linux-gnu python3 python3-pip git wget file >/dev/null',
    'pip3 install -q --break-system-packages -r requirements.txt',
    "git config --global --add safe.directory '*'",
    'make setup',
    'make -C tools',
    'make extract',
    `make ${jobs()}`,
  ].join(' && ');
  sh(
    `docker run --rm --platform linux/amd64 -v "$PWD":/w -w /w debian:bookworm bash -ec ${JSON.stringify(script)}`,
    dir,
  );
  // the in-container make already compares; assert the artifact really is there and matching
  sh('shasum -c snowboardkids2.sha1', dir);
}

/** Fail fast with the install remedy when a host prerequisite is missing. */
function requireHost(check: () => boolean, what: string, remedy: string): void {
  let ok = false;
  try {
    ok = check();
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(`setup: missing host prerequisite — ${what}\n  remedy: ${remedy}`);
  }
}

const hasDocker = (): boolean => {
  execSync('docker info', { stdio: 'ignore' });
  return true;
};

const onPath = (tool: string): boolean => spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0;

/** A GameCube project: `python3 configure.py && ninja`, supervised. The CodeWarrior compilers are
 *  Windows binaries, and dtk-template runs them under wibo only on linux/x86 — everywhere else,
 *  wine. Nothing is copied in: the disc image is the maintainer's, and `dtkPrepare` refuses with
 *  the directory to put it in. */
function dtkRecipe(opts: DtkOptions): ProjectRecipe {
  return {
    baseroms: [],
    prepare: (dir) => {
      requireHost(() => onPath('python3'), 'python3 (dtk-template configures with it)', 'brew install python');
      requireHost(() => onPath('ninja'), 'ninja (dtk projects build with it)', 'brew install ninja');
      if (process.platform !== 'linux') {
        requireHost(
          () => onPath('wine'),
          'wine (the CodeWarrior compilers are Windows binaries)',
          'brew install --cask wine-stable',
        );
      }
      dtkPrepare(dir, opts);
    },
    build: (dir) => dtkBuild(dir, { ...opts, ninjaArgs: [jobs()] }),
  };
}

/** Recipes keyed by manifest `project`. */
export const PROJECT_RECIPES: Record<string, ProjectRecipe> = {
  'ac-decomp': dtkRecipe({ version: 'GAFE01_00' }),
  marioparty4: dtkRecipe({ version: 'GMPE01_00' }),
  pikmin: dtkRecipe({ version: 'GPIE01_01' }),

  marioparty3: {
    baseroms: ['baserom.us.z64'],
    prepare: (dir) => {
      if (!existsSync(join(dir, 'venv'))) {
        sh('python3 -m venv venv', dir);
        sh('bash install.sh', dir, { ...process.env, PATH: `${join(dir, 'venv', 'bin')}:${process.env.PATH}` });
      }
      if (!existsSync(join(dir, 'tools', 'gcc_2.7.2', 'mac', 'gcc'))) {
        sh('gmake -C tools', dir, hostToolEnv());
      }
      if (!existsSync(join(dir, 'marioparty3.ld'))) {
        sh('gmake split', dir);
      }
    },
    build: (dir) => sh(`gmake ${jobs()}`, dir, hostToolEnv()), // COMPARE=1 diffs against the baserom
  },

  pokeemerald: {
    baseroms: [], // pret builds from source; `make` compares against rom.sha1
    prepare: (dir) => {
      installAgbcc('pret/agbcc', dir);
      sh('gmake -C tools/mapjson', dir, hostToolEnv());
      sh('gmake -C tools/jsonproc', dir, hostToolEnv());
      sh('gmake generated', dir, hostToolEnv());
    },
    build: (dir) => sh(`gmake ${jobs()}`, dir, hostToolEnv()), // ends in `pokeemerald.gba: OK`
  },

  sa3: {
    baseroms: ['baserom.gba', 'baserom_sa3.gba'],
    prepare: (dir) => installAgbcc('SAT-R/agbcc', dir),
    build: (dir) => sh(`gmake ${jobs()}`, dir, hostToolEnv()), // ends in `sha1sum -c sa3.sha1`
  },

  // GOES LIVE WITH THE ROW SWAP: this recipe describes testyourmine/kleod (through the
  // macabeus/kleod#asmlift-benchmark fork), the tree the kleod manifest names from the swap
  // commit onward. That repo has no setup.sh and no agbcc submodule — its INSTALL.md says to
  // install stock pret/agbcc, the same fork pokeemerald uses, so it comes from the same cache.
  kleod: {
    baseroms: ['baserom.gba'],
    prepare: (dir) => installAgbcc('pret/agbcc', dir),
    build: (dir) => {
      // CPP=arm-none-eabi-cpp, not the Makefile's default `$(CC) -E`: on macOS every host
      // preprocessor defines __APPLE__, and include/gba/defines.h + include/global.h carry
      // `#if defined(__APPLE__)` blocks that swap EWRAM_DATA/IWRAM_DATA to the Mach-O section
      // spelling (the build then dies in m4a.s) and neuter INCBIN/_() to `{0}` (which would
      // silently empty every INCBIN'd blob). The cross cpp defines no __APPLE__ — and it is
      // the same preprocessor asmlift's own agbcc path uses (compile/agbcc.ts).
      sh(`gmake compare ${jobs()} CPP=arm-none-eabi-cpp`, dir, hostToolEnv()); // ends in `kleod.gba: OK`
      // the symbol-source ELF the fork branch's decomp.yaml names (tools.asmlift.elf): a copy
      // of kleod.elf carrying the DWARF macro sidecar, so the map keeps the REG_* volatiles
      sh('gmake asmlift-elf CPP=arm-none-eabi-cpp', dir, hostToolEnv());
    },
  },

  af: {
    baseroms: ['baseroms/jp/baserom.z64'],
    prepare: (dir) => {
      requireHost(
        () => existsSync('/opt/cross/bin/mips-linux-gnu-ld'),
        'mips-linux-gnu binutils under /opt/cross',
        'build big-endian mips-linux-gnu binutils with --prefix=/opt/cross (af cross toolchain)',
      );
      requireHost(
        () => {
          execSync('arch -x86_64 /usr/bin/true', { stdio: 'ignore' });
          return true;
        },
        'Rosetta (af runs the x86_64 IDO recomp binaries)',
        'softwareupdate --install-rosetta --agree-to-license',
      );
      // the project's own bootstrap chain: venv → setup (tools + baserom decompress) → extract
      if (!existsSync(join(dir, '.venv'))) {
        sh('gmake venv', dir, afBuildEnv());
      }
      if (!existsSync(join(dir, 'baseroms', 'jp', 'baserom-decompressed.z64'))) {
        sh('gmake setup', dir, afBuildEnv());
      }
      // the split may have left EMPTY dirs behind — only a populated tree counts as extracted
      if (emptyDir(join(dir, 'asm', 'jp')) || emptyDir(join(dir, 'assets', 'jp'))) {
        sh('gmake extract', dir, afBuildEnv());
      }
    },
    build: (dir) => sh(`gmake ${jobs()}`, dir, afBuildEnv()), // COMPARE=1 checks baseroms/jp/checksum.md5
  },

  snowboardkids2: {
    baseroms: ['snowboardkids2.z64'],
    prepare: () => requireHost(hasDocker, 'a running Docker daemon (sbk2 builds in linux/amd64)', 'start Docker'),
    build: sbk2DockerBuild,
  },
};
