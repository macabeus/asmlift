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
//   - kleod's setup.sh needs python >= 3.11 first in PATH;
//   - af needs mips-linux-gnu binutils under /opt/cross and Rosetta (x86_64 IDO recomp);
//   - snowboardkids2 builds inside a linux/amd64 Docker container;
//   - the KMC gcc 2.7.2 mac binaries (marioparty3) are x86_64 → Rosetta as well.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';

import { benchCheckoutsDir } from './manifests';

export interface ProjectRecipe {
  /** checkout-relative baserom paths copied in from the sibling user checkout when found */
  baseroms: string[];
  /** idempotent post-clone preparation (cheap no-op when already prepared) */
  prepare?: (dir: string) => void;
  /** the full build; MUST end in the project's own byte-compare gate */
  build: (dir: string) => void;
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

/** A python3 >= 3.11 dir to prepend (kleod's setup.sh requires it first in PATH). */
function python311Env(): NodeJS.ProcessEnv {
  for (const cand of ['python3.13', 'python3.12', 'python3.11', 'python3']) {
    try {
      const out = execSync(`${cand} -c 'import sys; print(sys.executable, sys.version_info[:2] >= (3, 11))'`, {
        encoding: 'utf8',
      }).trim();
      const [exe, ok] = out.split(' ');
      if (ok === 'True') {
        return { ...process.env, PATH: `${dirname(exe)}:${process.env.PATH}` };
      }
    } catch {
      // try the next candidate
    }
  }
  throw new Error('setup: no python3 >= 3.11 on PATH (kleod setup.sh requires it)');
}

const jobs = (): string => `-j${Math.min(8, cpus().length || 4)}`;

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
    'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential binutils-mips-linux-gnu python3 python3-pip git wget file >/dev/null',
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

/** Recipes keyed by manifest `project`. */
export const PROJECT_RECIPES: Record<string, ProjectRecipe> = {
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

  kleod: {
    baseroms: ['baserom.gba'],
    prepare: (dir) => {
      // setup.sh: verifies the baserom, inits submodules, builds the agbcc submodule, extracts
      if (!existsSync(join(dir, 'tools', 'agbcc', 'bin', 'agbcc')) || !existsSync(join(dir, 'asm', 'nonmatchings'))) {
        sh('bash setup.sh', dir, python311Env());
      }
    },
    build: (dir) => sh(`gmake ${jobs()}`, dir, python311Env()), // ends in `sha1sum -c klonoa-eod.sha1`
  },

  af: {
    baseroms: ['baseroms/jp/baserom.z64'],
    prepare: () => {
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
    },
    build: (dir) => sh(`gmake ${jobs()}`, dir, afBuildEnv()), // COMPARE=1 checks baseroms/jp/checksum.md5
  },

  snowboardkids2: {
    baseroms: ['snowboardkids2.z64'],
    prepare: () => requireHost(hasDocker, 'a running Docker daemon (sbk2 builds in linux/amd64)', 'start Docker'),
    build: sbk2DockerBuild,
  },
};
