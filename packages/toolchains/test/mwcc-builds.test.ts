// THE THREE CODEWARRIOR BUILDS, AND THE THING THAT SEPARATES THEM. One image, one `wibo`, one
// PowerPC objdump and one set of harness words serve all of them; the only difference is which
// directory is mounted at /mwcc. So every fact below is about that directory — which one a build
// resolves to, and that nothing downstream can conflate two of them.
//
// TOOLCHAIN-FREE: paths and container names are computed, never run. No Docker, no CodeWarrior.
import { TOOLCHAIN_TARGETS, isToolchainId } from '@asmlift/core/target';
import { describe, expect, test } from 'vitest';

import { ppcDumpPoolCfg, ppcPoolCfg } from '../src/compile';
import { MWCC_BUILDS, MWCC_PPC_TOOLCHAIN, MWCC_TOOLCHAIN_IDS, mwccDir } from '../src/toolchain';

describe('the CodeWarrior builds', () => {
  // TWO LISTS, ONE FACT. @asmlift/core says which toolchains a row may name; this package says which
  // binaries exist to compile them. A toolchain declared there with no directory here would compile
  // nothing; a directory here that no toolchain names would be mounted by no row.
  test('are exactly the mwcc toolchains the registry declares', () => {
    const declared = Object.keys(TOOLCHAIN_TARGETS)
      .filter(isToolchainId)
      .filter((id) => TOOLCHAIN_TARGETS[id].family === 'mwcc');
    expect([...MWCC_TOOLCHAIN_IDS].sort()).toEqual([...declared].sort());
  });

  test('each resolves to its own directory under the compilers root', () => {
    for (const id of MWCC_TOOLCHAIN_IDS) {
      expect(mwccDir(id)).toBe(`${MWCC_PPC_TOOLCHAIN.root}/${id}`);
    }
    expect(new Set(MWCC_TOOLCHAIN_IDS.map(mwccDir)).size).toBe(MWCC_TOOLCHAIN_IDS.length);
  });

  // The directory names are decomp.me's; the pack directories are the compilers pack's, and
  // `.github/workflows/benchmark.yml` unzips exactly these into exactly those names. The mapping
  // lives in no other machine-readable place, so a wrong one would be a CI-only failure — or,
  // worse, a silently different compiler under a familiar name.
  test('each names the compilers-pack directory it is a copy of', () => {
    expect(MWCC_BUILDS).toEqual({
      mwcc_242_81: 'GC/1.3.2',
      mwcc_233_163n: 'GC/1.2.5n',
      mwcc_247_107: 'GC/2.6',
    });
  });

  // A pooled container is reached by NAME and keeps its mounts from creation. Two builds resolving
  // to one name would compile Pikmin's C++ with Mario Party 4's compiler and say nothing at all:
  // the object would be well formed, the row would simply not match.
  test('no two builds share a pooled container', () => {
    const names = MWCC_TOOLCHAIN_IDS.map((id) => ppcPoolCfg(id).name);
    expect(new Set(names).size).toBe(names.length);
    for (const id of MWCC_TOOLCHAIN_IDS) {
      expect(ppcPoolCfg(id).mounts).toContain(`${mwccDir(id)}:/mwcc:ro`);
    }
  });

  // The PowerPC objdump is the IMAGE's tool. A dump routed through a build's pool would start that
  // build's container to read an object it never compiled, and would name a compiler the answer
  // does not depend on.
  test('reading an object mounts no CodeWarrior build at all', () => {
    const { name, mounts } = ppcDumpPoolCfg();
    expect(mounts).toEqual(['-v', '/tmp:/host-tmp']);
    expect(MWCC_TOOLCHAIN_IDS.map((id) => ppcPoolCfg(id).name)).not.toContain(name);
  });
});
