# @asmlift/toolchains

asmlift's **pinned toolchains** — agbcc (GBA), IDO 7.1 (N64), KMC GCC (N64), GCC 2.7.2 (N64), and
the three CodeWarrior builds (GameCube): the compile+score implementations, the Docker container pool, and the
AsmData extraction the **benchmark** ([`apps/benchmark`](../../apps/benchmark)) and the
**matching test suite** (`packages/cli/test/matching`) run on.

**Private by design, never published.** Sibling-checkout paths and Docker images are
infrastructure, not a product: a user project brings its own compiler via `decomp.yaml`
(`tools.asmlift.compiler` — see [`@asmlift/cli`](../cli/README.md)). Importing this package registers
four candidate compilers with `@asmlift/cli`'s registry — one per compiler family, under the keys
`agbcc`, `ido`, `gcc` (KMC) and `mwcc` (bound to `mwcc_242_81`) — so a target outside those four
compiles through its `decomp.yaml` command instead. Registration lives at `compile.ts` module
scope, so subpath imports can't bypass it.

## Environment

Paths resolve from env vars with sibling-checkout defaults (`src/toolchain.ts`):
`ASMLIFT_AGBCC`, `ASMLIFT_ARM_AS`, `ASMLIFT_IDO_CC`, `ASMLIFT_MIPS_OBJDUMP`,
`ASMLIFT_KMC_DIR`, `ASMLIFT_KMC_IMAGE`, `ASMLIFT_GCC272_DIR`, `ASMLIFT_GCC272_IMAGE`,
`ASMLIFT_MWCC_ROOT`, `ASMLIFT_PPC_IMAGE`,
`ASMLIFT_PPC_OBJDUMP`, `ASMLIFT_WIBO`, `ASMLIFT_DOCKER`. `ASMLIFT_DOCKER_POOL=0` disables the
persistent container pool (the benchmark's A/B baseline switch).

The CodeWarrior Docker image (`asmlift-ppc:latest`) is a **local build** (no registry pull):
`docker build -t asmlift-ppc:latest packages/toolchains/ppc-docker` — 32-bit wibo + PowerPC
objdump ([`ppc-docker/Dockerfile`](ppc-docker/Dockerfile)); the proprietary CodeWarrior dirs are
bind-mounted at run time, never baked in. `ASMLIFT_MWCC_ROOT` names the directory holding them,
one per build (`mwcc_242_81`, `mwcc_233_163n`, `mwcc_247_107`), as decomp.me vendors them.

## Modules

| Module             | What it is                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `src/toolchain.ts` | Paths + flags as data (env overrides; the REPO_ROOT depth invariant is pinned in a comment)                   |
| `src/compile.ts`   | Candidate + reference compiles per toolchain, the Docker pool, and the four `registerCandidateCompiler` calls |
| `src/index.ts`     | The barrel — importing it is what triggers the registrations above                                            |
| `src/score.ts`     | Thin per-toolchain scorers (compile + `@asmlift/cli`'s `scoreObjects`)                                        |
| `src/asmdata.ts`   | `objdump -s -r -t` jump-table side-table extraction (shares the pool)                                         |
