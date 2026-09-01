# The ranked repro

The one invocation both `/match-function` and `/attribute-function` measure a real-project row
with, and the only place its flags are written down. **Both commands point here; edit this file,
not a copy inside a prompt.** The last time the same command was described in two prompts they
drifted, and a round published `557/578` against a `547` baseline — three numbers produced by
three different commands (PR #79).

## The command

```sh
cd <repo> && pnpm --filter @asmlift/cli build     # rebuild the loader; see below

cd <project checkout>            # e.g. apps/benchmark/checkouts/klonoa-empire-of-dreams
node <repo>/packages/cli/dist/asmlift.mjs <asm/nonmatchings/…/Fn.s> \
  --config decomp.yaml \
  --score-against <build/…/tu.o> \
  --proto '{"<callee>":{"params":N}}' \
  --jobs 6 --progress
```

Run it from the project checkout and redirect stderr to a file — the `[score]` and `[progress]`
lines are stderr, and they are the whole record. From a git worktree, export the harness's
toolchain overrides first (`ASMLIFT_AGBCC` and the rest): a worktree's repo root is not the
workspace, so without them the sibling checkouts do not resolve and the run measures nothing.

## The loader is part of the number

Two loaders run the same sources. `npx tsx packages/cli/src/main.ts` reads and transforms every
file on every run, and its transform wraps every arrow function in esbuild's `--keep-names` shim,
which the enumerator's per-candidate closures then pay for on every candidate.
`packages/cli/dist/asmlift.mjs` is those same sources bundled once without it, and it is what the
command above runs. Both produce the same candidates and the same scores; the `[score]` diff below
is the check, and it is cheap.

Measured back to back on the LoadBGTilemapData command below — one machine, other work running on
it, `--jobs 6`, 26880 candidates: **620s under tsx against 484s bundled**, of which the ENUMERATION
(the only phase a loader touches — the candidate compiles are subprocesses) was **207s against
118s**. Both printed the same `[ranked]` line, the same 26880 `[score]` lines and the same stdout
byte for byte. The ratio is the machine's, not the code's: re-time on your own log.

**A bundle is only as fresh as its last build, and `dist/` is gitignored** — nothing rebuilds it for
you, nothing commits it, and an old one runs exactly as happily as a new one. So rebuild before any
run you intend to quote, and read the stamp: the build BAKES the tree it was built from into the
bundle, and the run compares that bake against the checkout it is standing in. A bundle that no
longer matches says `STALE BUNDLE` on the line you are pasting, instead of naming a commit whose
code it is not running.

The comparison is on `packages/` CONTENT, not on the commit: docs and the regenerated benchmark
artifact are committed constantly and change nothing a ranked run computes, so a commit that leaves
`packages/` alone is not staleness and does not warn. CONTENT means the bytes — the check hashes
every tracked-or-untracked file under `packages/` — so re-editing a file the tree was ALREADY
carrying dirty is staleness like any other. That is the state a perf round runs in, and a check that
stopped at the list of dirty paths would have called such a bundle current.

## The cache state is part of the number

asmlift can serve a candidate object a previous run already compiled, instead of compiling it
again (`packages/cli/src/candcache.ts`). **It is ON unless `ASMLIFT_CANDCACHE` says otherwise**,
and it changes a run's WALL by several times while changing nothing a run computes. So every wall
quoted from now on has to say which state it was measured in, in the same breath as the command:

| `ASMLIFT_CANDCACHE`                         | what the run does                                                                                      | when to use it                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| unset, `1`, `on`, `true`, `yes`             | serves any candidate this toolchain already compiled, and AUDITS a sampled 2% by compiling them anyway | **the default** — say `cold` or `warm`, and paste the `[candcache]` line with the wall |
| `0`, `off`, `false`, `no`, or SET-AND-EMPTY | compiles every candidate; touches no disk                                                              | a wall you want comparable with every wall published before the default flipped        |
| `verify` (any capitalisation)               | compiles every candidate AND audits the store against it, loudly                                       | after any change to the cache, or when a stored answer is suspect                      |
| anything else                               | **OFF, with `[candcache] REFUSED reason=unrecognised-mode` on stderr**                                 | never on purpose — the parse is closed so a typo cannot silently SERVE                 |

**EVERY WALL PUBLISHED IN THIS REPO BEFORE THE DEFAULT FLIPPED WAS MEASURED CACHE-OFF**, because
the variable was set in no shell profile, no `.envrc` and no CI job — so `unset` and `off` were the
same run. They are not the same run now. A wall taken today with nothing said about the cache is a
WARM CACHE wall and is not comparable with any of them; measure with `ASMLIFT_CANDCACHE=0` to
compare against a published number, and say so.

`ASMLIFT_CANDCACHE=` (set, empty) is OFF and says so on stderr. It is deliberately NOT the same
state as unset: an empty value is both a one-shot bypass someone typed and an unexpanded
`$SOMETHING`, so it lands on the side whose cost is a cold start rather than a served object.

**SET-AND-EMPTY is guarded on every one of these variables, and it was not.** An unexpanded
`$SOMETHING` reaches a variable as the empty STRING, which `??` does not catch — and for the two
below an empty string is a perfectly usable value, so nothing failed:

- `ASMLIFT_CANDCACHE_DIR=` is a PATH, and the path it is is the CURRENT DIRECTORY. `ns/`,
  `objects/` and `MISMATCHES.log` landed wherever the process was standing — which the section
  above tells you is your decomp checkout — and the pruner then deleted from a two-level
  `objects/<dir>/<file>` layout that is an ordinary build-output shape. It now falls back to the
  default store and says so; a non-empty value is resolved once, so a relative store cannot mean
  two directories in one process.
- `ASMLIFT_CANDCACHE_SAMPLE_SEED=` pinned the audit's selection to one fixed subset of every store
  forever — the exact "audits the same keys and never the rest" failure the seed exists to prevent
  — with a trailing `seed=` on the `[candcache]` line as the only tell. It now falls back to a
  fresh random seed and says so.

`ASMLIFT_BENCH_CACHE=0` turns this cache off too: "bypass the benchmark's caches" has to mean all
of them, or bisecting a suspect row still reads candidate objects off disk.

**TEST RUNS ARE FENCED, and two of the three pins are not the obvious one.** `vitest.config.ts`
pins `ASMLIFT_CANDCACHE=0` for every suite it runs (`test:offline`, `apps/benchmark/test`,
`apps/web/test`) — ablated, `pnpm test:offline` wrote 8 namespaces / 20 keys of a throwaway `sh`
"compiler"'s output into the shared store, and against a poisoned store 13 tests in
`compile-command.test.ts` failed on the poison. It also pins `ASMLIFT_CANDCACHE_SAMPLE=0`, because
the 2% audit under a random per-run seed is a 1-in-50 flake for any test asserting "a hit is an
execution that did not happen"; and `ASMLIFT_CANDCACHE_DIR` to a per-run throwaway, because the
candcache suites DELETE the mode pin to exercise the real default and the mode pin therefore cannot
protect them. `pnpm test:matching` is the deliberate exception: it forces `verify` and audits the
SHARED store, which is the only thing in the repo that does — pointed at a fresh directory it would
find nothing to disagree with and go green having audited nothing.

- **COLD or WARM is a property of the STORE, not of the flag.** The first cache-on
  run after a toolchain change, a flag change, or a change to the harness code that shapes the
  compiler's input is COLD by construction — the namespace moved and nothing in the store answers
  to it. Say `cold` or `warm`, not just `on`. The store lives at `ASMLIFT_CANDCACHE_DIR`
  (default `$TMPDIR/asmlift-candcache`); deleting it makes the next run cold.
  **AND SO DOES REBUILDING THE BUNDLE, whatever you changed.** That sentence used to say "the
  harness code that shapes the compiler's input", which is what the namespace INTENDS to measure
  (`compile-command.ts` hashes its own module file) — but in the shipped bundle that file is
  `dist/asmlift.mjs`, so the digest covers the whole CLI. MEASURED, on this box, with everything
  else held fixed: two LoadBGTilemapData runs off one bundle both resolved
  `ns=82c83810be494b45`; adding a COMMENT to `packages/cli/src/phase.ts` — a file no compile
  reads and that shapes no compiler input — and rebuilding moved it to `ns=a5e72b95f10cea78`.
  **AND SO DOES COMMITTING.** The build bakes its own commit and dirty flag into the bundle, so a
  DOC-ONLY commit, and the dirty-to-clean transition of an unchanged tree, both move the namespace
  as surely as an emitter change does. In this repo's own workflow — commit, rebuild, quote — that
  makes the first run after every commit cold, and it means **a warm store cannot be carried across
  one**: a wall quoted as `warm` is only reproducible from the store filled at the same commit, so
  name that commit beside the wall.
  This is the cold-start direction and therefore sound, but it decides how to pair runs: `docs`
  above tells you to rebuild before any run you intend to quote, so **a base run and a lever run
  with a rebuild between them share nothing** and both are cold. Build once, then run the pair —
  or expect the first of them to pay full price.
- **Never compare a warm wall against a cold one and call the difference a code change.** This is
  the same rule as "never compare numbers made with different flag sets", and it is easier to
  break because nothing on the command line says which state you were in. The run itself does:
  with the cache on, an `asmlift: [candcache]` line prints next to `[ranked]` with the mode and
  the hit/miss/stored counts. **Paste it whenever you paste a wall.**
- **The cache is a throughput lever and never a result lever.** The `[score]` lines, the winner
  and the stdout are identical in all three states by construction — a cache miss is
  indistinguishable in RESULT from no cache at all. If a `[score]` line moves between a cold run
  and a warm one, the cache is wrong; run the `diff` below, then re-run with `ASMLIFT_CANDCACHE=0`
  and report it.
- **On a PROJECT's own `decomp.yaml` command, the cache runs — there is nothing to declare.**
  **THE POSTURE CHANGE, stated where it happens:** two of them, in sequence. First, the cache
  stopped needing a `tools.asmlift.cacheInputs` declaration, so `ASMLIFT_CANDCACHE=1` stopped being
  inert on a project's own command. Then the DEFAULT flipped: it is live for everyone now, on every
  project's own `decomp.yaml` — the path every published score comes from — with no variable set
  anywhere. Your next run caches your own project's compiles with no further action, and the only
  signal is one `asmlift: [candcache]` line among the phase output. `ASMLIFT_CANDCACHE=0` is the
  way back.
  The opt-in existed because one input class could not be measured: a directory named by a flag.
  `-I tools/agbcc/include` was hashed by content already; `-iquote include` — klonoa's own template
  — was a bare word nothing looked at. A declaration a project could get incomplete was itself a
  stale-object hole, so it is gone: the namespace measures the toolchain rather than listing it.
  Measured now: **every token that names an existing path**, whether or not anyone listed the flag
  in front of it (`--include-directory inc`, `-iframework inc`, a flag invented after this was
  written); every ATTACHED operand of the flags in the de-gluer table (`-Iinc`, `--sysroot=dir`,
  `-Wa,-Iinc`); the CONTENTS of a `@response` or `-specs` file, scanned BOTH ways the outer
  template is — the de-gluer table and every token tried as a path — because scanning a body with
  the table alone made a response file the safer place to hide an input; the directory a
  SUBDIRECTORY-qualified injected `-include` header resolves its own quoted includes from; the
  DIRECTORY PART of a glob (`cat inc/*.h`); an operand held in a variable the template assigns,
  quoted with a space in it, or written `~/…`; the base a `cd` in the template moves to; and what
  `CPATH` and friends point AT.
  A shell COMMENT is not scanned — `sh` drops from an unquoted `#` to the end of the line, so
  nothing in it is read, and scanning it put the project's own `build/` tree in the namespace
  (every rebuild cold) or refused the whole cache over the word `docker` in an English sentence.
  Editing the comment still moves the namespace: the template's raw bytes are hashed
  unconditionally.
  The cache still refuses, out loud, when the compile is not a pure function of its input —
  `[candcache] REFUSED label=command reason=object-is-not-a-pure-function-of-its-input` is what
  `ido7.1` gets, because it writes the absolute path of its input `.c` into the object — when a
  measured path exists and CANNOT BE READ (an include directory at mode 0311 is searchable and not
  listable: the compile can read it and the walk cannot, so nothing is cached), and when the
  command runs the compiler somewhere this namespace cannot follow — a container image named by a
  mutable tag, another host over `ssh`, a `chroot`/`qemu`/`wine` (`reason=stamp-threw`).
- **A project can refuse for itself: `tools.asmlift.candidateCache: off`.** One key, one value.
  Declare it when your command runs the compiler somewhere nothing here can read it, or reaches
  something in the residual list below. It is deliberately the inverse of the deleted
  `cacheInputs`: that key asserted what a command reads and an incomplete assertion served a stale
  object; this one only ever turns the cache OFF, so an unnecessary one costs a cold start.
  `ASMLIFT_CANDCACHE=0` is the same answer for a whole process; this one is per project, which is
  what you want when only one of your projects has the problem.
- **What is still NOT measured, said out loud.** A path the command itself COMPUTES
  (`H=in; cat ${H}c/k.h`), which no token scan can resolve, and its cousin, a `cd` into a computed
  directory (`cd "$(dirname …)"` contributes no resolution base); a wrapper script that reads a
  config DIRECTORY (the chain follows what a script EXECS, not what it OPENS — though editing the
  script itself does move the namespace); `-B /opt/tc/arm-` used as a filename PREFIX rather than a
  directory (the operand is measured as a path, so the prefix spelling names nothing that exists
  and contributes nothing);
  a candidate's assembler `.include`/`.incbin` (the per-key refusal tests the C preprocessor's
  `#include`, and asmlift's emitter emits object-like `#define` only — measured 0 of 66,816 on
  LoadBGTilemapData); the compiler's own built-in search directories, which every corpus
  template puts out of reach with `-nostdinc`; and an opaque runtime this build has never heard of
  — the refusal above is a deny-list of process names, and a deny-list's miss is on the
  stale-object side.
  **THE PROJECT ROOT is on this list on purpose, with a number.** A glob with no directory part
  (`cat *.h`, `rm -f *.o`) expands in the project root, and an injected header spelled without a
  directory (`-include global.h`) resolves its quoted includes from it — and the project root is
  the whole checkout, not an include directory anyone named. Measured on one box: 29,126 entries
  at `pokeemerald`, 25,901 at `af`, 47,211 at a real klonoa dev checkout, all over the
  20,000-entry stamp budget, so treating `.` as an operand REFUSED those projects outright; its
  depth-0 files alone are the baserom (26 files / 131,114,078 bytes at `pokeemerald`), a quarter
  of the 512 MiB budget hashed per process for a file no compile reads; and where it did fit, the
  namespace tracked `build/` and `.git/`, so every rebuild was a cold start. A glob or an injected
  header WITH a directory part (`cat inc/*.h`, `-include inc/pre.h`) is bounded and is measured —
  though only one level: a `#include "../other/k.h"` from inside that header escapes it.
  One FALSE POSITIVE is kept for the same asymmetry: the container-runtime check reads every
  token, so a runtime word inside a quoted string (`echo "no ssh here"`) refuses the project's
  cache. That is loud and costs a cold start, and a command-position-only rule would silently miss
  `env X=1 docker run`.
  If your command reads something in one of those shapes, declare
  `tools.asmlift.candidateCache: off`, or run with `ASMLIFT_CANDCACHE=verify` — it compiles anyway
  and fails on any disagreement — or `ASMLIFT_CANDCACHE=0`. Serving mode's own sampled audit is the
  standing mitigation for this whole list, and it is a bound on how long one survives, not a
  removal: see the `on` MODE AUDITS ITSELF bullet below.
  **What `verify` can and cannot evidence for this bullet.** A verify run compares stored bytes
  against fresh for every key it stores — but 0 of 66,816 LoadBGTilemapData candidate TUs carry an
  `#include`, so the include directory is never read for any key stored, and a clean verify run is
  zero evidence about the directory measurement specifically. It evidences the toolchain, the
  environment and the template. The evidence for the directory measurement is the offline poison
  suite (`packages/cli/test/offline/candcache-dirflags.test.ts`), which drives each shape through
  a real compile across an edit.
- **A `put` does not trust the store either, and that hole had NO audit over it at all.** The
  store is content-addressed: `objects/<sha>` is deduped and hardlinked per key. Treating the
  EXISTENCE of that file as proof of its CONTENT meant a corrupted entry — a disk error, an
  external edit, a store living where the project's own build writes — was hardlinked onto a key
  whose object had just been compiled correctly, and the caller was served bytes it had not
  produced. MEASURED: a run in which every key MISSED, every candidate compiled freshly and
  correctly, and the audit ran at 100% published a NONMATCH as a byte-exact MATCH with exit 0 and
  wrote no `MISMATCHES.log`. What sampling cannot reach is that RUN — it is reached from the SERVE
  path, so it withholds only keys the store can already ANSWER, and there every key MISSED. (Once
  such a key can be served, the audit does compare it and does report; the run in which the
  corruption is first deduped onto is the hole.) A `put` holds the truth and has already hashed it,
  so it compares: a disagreement is an `OBJECT STORE CORRUPT` mismatch like any other, and the run
  exits 3. **The repair is written THROUGH THE INODE**, because `objects/<sha>` is hardlinked from
  every key that deduped onto it — replacing the NAME would repair the key being stored and leave
  every other one serving the bytes the same line just reported, with a warm run (all hits, no
  puts) never reaching the comparison again. Cost, measured at the cold LBG fan's own shape (53,228
  dedup-hit puts over 15,124 distinct objects): +1.5 s on a 683-905 s run, and zero on a warm run,
  which serves and never stores.
- **The store is bounded, but only between runs.** `ASMLIFT_CANDCACHE_MAX_MB` (default 4096)
  counts the distinct object bytes plus one allocation block per stored key — 77% of a warm store
  is negative entries, which weigh nothing logically and cost a block each. It is enforced ONCE per
  process, at the first namespace resolution and before any candidate compiles: whole namespaces no
  live process holds go first, then the oldest-written keys of the namespace this run is about to
  use. A namespace another process holds is never touched, so under `pnpm bench run`'s 8–16 shards
  the second shard onward prunes nothing. `rm -rf "$TMPDIR/asmlift-candcache"` is the reliable
  reset, and it is also how you make the next run cold on purpose.
- **`verify` audits the OUTCOME, not only the bytes.** A stored object whose TU no longer compiles,
  and a stored rejection whose TU now does, are both mismatches — the second is the one that
  silently drops a spelling from a row's fan, and it is 77% of what a warm store serves. Any
  mismatch is written to `MISMATCHES.log` in the store and fails the run with **exit 3**, on every
  path that can produce one: the ranked CLI's success return AND its decline/internal-error return,
  a `pnpm bench run` shard, and the orchestrator over those shards (which propagates 3 only when
  EVERY failed shard says cache — one shard that failed for its own reason is a run whose headline
  is that failure). `bench fidelity` is the exception by design: it pins the cache OFF for its
  ~1234 reproduction scripts, so nothing there can disagree.
  **3, not 1, and the distinction is the whole point:** a ranked run that does not MATCH exits 1
  already, so `1` carries no signal for the case this repo actually publishes — LoadBGTilemapData
  has been a nonmatch at 386 for twenty rounds, and a clean run and a poisoned run of it were
  measured exiting 1 with byte-identical `[ranked]` lines. Measured offline end to end, on one
  store: the audited run and the unaudited one print the same `[ranked]` line and the same stdout,
  and the unaudited one publishes the target's own bytes as a byte-exact **MATCH with exit 0**
  (`packages/cli/test/offline/candcache-sampling.test.ts`).
- **`on` MODE AUDITS ITSELF, and that is what licenses serving at all.** `bench regression` and
  `bench diff` compare OUTCOMES: a stale object is served identically on the base and on the head,
  so a cache defect makes BOTH GO GREEN. Neither gate is capable of catching one, so serving mode
  compiles a sampled fraction of the keys it serves anyway and runs them through the exact same
  two-direction comparison `verify` uses. Same counters, same `MISMATCHES.log`, same nonzero exit.
  - **The rate is 2%, and a five-rate measurement is what picked it.** Ten runs on ONE warm
    LoadBGTilemapData store (68,352 candidates, one box, one namespace, one bundle at
    `dae489e`), interleaved `0 25 0 10 0 5 0 2` so a drifting load cannot be read as a rate, then
    the same command with the cache off:

    | state               | wall        | loadavg (1 m, before) | `sampled` |
    | ------------------- | ----------- | --------------------- | --------- |
    | cache OFF           | **740.9 s** | 16.8                  | —         |
    | cache on, COLD fill | **711.2 s** | 28.3                  | —         |
    | warm, audit off     | 167.4 s     | 15.0                  | 0         |
    | warm, audit off     | 173.1 s     | 9.0                   | 0         |
    | warm, audit off     | 176.2 s     | 10.2                  | 0         |
    | warm, audit off     | 192.7 s     | 20.2                  | 0         |
    | **warm, 2%**        | **186.2 s** | 16.7                  | 1,394     |
    | warm, 5%            | 222.6 s     | 17.2                  | 3,477     |
    | warm, 10%           | 238.9 s     | 8.8                   | 6,977     |
    | warm, 25%           | 287.0 s     | 6.6                   | 17,137    |

    All ten printed `best …: 386`, the same 68,352 `[score]` lines (md5
    `3cd87d7623dd843fd791b9bdc86ea27b`) and the same stdout (md5
    `fd90209d88d7313cb7f5568186ef6e73`), each stamped `[asmlift source dae489e]`.

    **2% is the largest rate that lands inside the audit-off arms' OWN SPREAD** (167.4-192.7 s);
    5% is 30 s above the slowest of them, 10% is 46 s and 25% is 94 s above their mean. So the
    audit is NOT free as a function of rate, and an earlier round's "0%, 1% and 2% are not
    separable" was the flat part of a curve, not the curve: read off the separable arms the cost
    is 6-13 ms of wall per sampled compile, falling as the count rises because a warm run's six
    workers are otherwise idle. Speedup against cache-off: **4.18x** with the audit off, **3.98x**
    at 2% — **95% of it survives**, and every survival number below is halved against 1%.
    **Do not price the audit off the `[phase]` compile column.** It reads 273-306 s with the audit
    off and 633 s at 2%, 817 s at 5%, 926 s at 10% — 2.3x the worker time for a wall 5% longer.
    That column sums the queueing every hit does behind a busy worker; a "cost per sampled
    compile" derived from it is an artifact.
    **A wall here is ordinal, and the loadavgs say why**: another project's test suite ran at
    390% CPU on this box throughout, and the 1-minute loadavg before these arms swung between 6.6
    and 28.3. The interleave is what makes the comparison survive that; a single sequential pair
    would not.

  - **The seed is on the line and it rotates.** `[candcache] on sample=2%/seed=8cd2c1164ce2105d {…}`
    — an audited run is distinguishable from an unaudited one, and `sample=off` says so when
    someone turns it off. Sampling is deterministic within a run (so a run is reproducible) and
    picks DIFFERENT keys next run (so the rest of the store is eventually looked at, which
    hashing the key alone would never do). `ASMLIFT_CANDCACHE_SAMPLE_SEED=<seed>` replays a run's
    exact selection; `ASMLIFT_CANDCACHE_SAMPLE=<percent>` changes the rate (`0` turns it off).
  - **What it catches and how fast — PER CLASS, because the residuals are not one population.**
    The catch probability in one run is `1 - (1 - rate)^C` where C is the number of SERVED keys the
    staleness touches. At 2%: C = 700 is certain, C = 100 is 87%, C = 9 is 17%, C = 1 is 2%
    (mean 50 runs, 87% within 100). Most of the residuals listed above are "the namespace does
    not measure input X" where X is read by a whole CLASS — a directory, a wrapper's config, the
    runtime — and those are caught in the first run that serves a few hundred keys. **One is not:**
    a candidate's own assembler `.include`/`.incbin` is per-CANDIDATE, and the same list measures
    it at 0 of 68,352 on LoadBGTilemapData — the sparse regime, where the honest number is the
    50-run figure, not "the first run".
    **And the BENCH path is sparser than the ranked one, though the rate is the same.** One whole
    `pnpm bench run` serves ~60,800 answers and audits ~1,280 of them (2.1%), so a staleness
    confined to ONE ROW's keys (~9 objects on the agbcc real tier) is caught with probability 17%
    per bench run — a mean of about 6. The bench is where every published score comes from, so that
    is the number to quote for a row-local staleness, not the ranked fan's.
    Sampling does not ELIMINATE the residual list; it bounds how long one can live undetected.
  - **This fan prices only the OBJECT half, and the negative half is measured on the bench.** 0 of
    its 68,352 answers are cached rejections. The `pnpm bench run` behind the artifact as it stood
    when this was measured (948 rows, warm store, 16 shards) served **10,221 objects and 50,583
    rejections** — 83% negative — and audited **1,283 of them (2.11% of what it served): 210
    objects, 1,073 rejections, 0 disagreements**, with `sampled` reconciling exactly against the
    audits. A second full run the same day read 84% negative on the same measure, so treat it as
    "five sixths", not as a constant. That is the direction that silently DROPS a spelling, and it
    is only ever exercised by a bench run: sum the per-shard `[candcache]` lines, which is where a
    reader can check it too.
  - **A withholding accounts for itself, so `sampled` cannot overstate the audit.** `sampled`
    counts keys the cache WITHHELD, not comparisons it made: a withheld key whose compile dies
    without a verdict is never compared, because a transient must never be stored as a rejection.
    The counters therefore close:
    `sampled = verified + verifiedFail + mismatch + sampledStale + sampledAbandoned + sampledPending`
    — `sampledStale` a key a sibling shard pruned between the get and the put, `sampledAbandoned`
    a compile that produced no verdict, `sampledPending` still outstanding when the line was
    printed. Read `sampled` alone and a run that audited 400 keys can claim 700.
  - A sampled key is withheld, so its candidate is compiled for real — and is therefore exposed to
    a transient compile failure exactly as an uncached run is. That is the state every wall
    published before the default flipped was measured in, on 100% of keys instead of 2%. What
    that no longer costs is the CANDIDATE: when the compile of a withheld key produces neither an
    object nor a deterministic rejection, the withheld answer is handed back (`sampledAbandoned`),
    which is what an unaudited run would have been served. Sampling must never be worse than not
    sampling, and a warm run's exposure to a transient had been zero.
  - **`bench fidelity` runs its ~1234 reproduction scripts with `ASMLIFT_CANDCACHE=0`,
    deliberately.** That gate exists to prove a READER who copies a published script reproduces
    the published row, and that reader starts with an empty store. Inheriting the default would
    run the gate SERVED off the publishing machine's warm store — the base-versus-head asymmetry
    the audit exists to bound, in the one gate whose job is to be the reader.

## The flags are part of the number

- **`--proto`, whenever a callee's arity matters.** A callee still written in assembly carries no
  DWARF signature, so asmlift has to guess its arity and guesses wrong. `LoadBGTilemapData`
  without `--proto '{"thunk_HeapFree":{"params":1}}'` scores **578** where the round's baseline is
  **547** — a plausible number that is comparable to nothing. Pass the table inline, as above; a
  path to a file holding the same JSON is accepted too, but a scratch file is one more thing that
  drifts between rounds, and two of them carrying different tables is how the `557/578/547` above
  happened.
- **`--jobs 6 --progress`.** The candidate compiles dominate a ranked run and pool cleanly.
  Two LBG runs launched together measured **36m10s serial against 21m32s at `--jobs 6`** (20608
  candidates, 0 dropped, identical winner) — but that machine was also running two full benches
  and both test suites, and a quieter pair measured **31m55s against 11m16s**. The ratio is the
  machine's, not the code's: re-time on your own log and quote that, never these. The
  `asmlift: [progress]` lines are what make a later claim about the run checkable from its log.

- **`--progress` also prints WHERE the time went**, as one `asmlift: [phase]` line from the run's own
  clock (`packages/cli/src/phase.ts`) — so a per-phase claim comes from the log everyone already
  pastes, not from a rig outside the tree that the next round has to rebuild:

  ```
  asmlift: [phase] wall 259.4s · enumerate 19.9s (1 call) · compile 1257.3s over 6 workers
    (26880 calls) · score 163.7s (26880 calls) · rank 2.5s (1 call) · main-thread idle+other 73.3s
  ```

  Two denominators, answering different questions. `compile` is summed ACROSS workers, so
  `compile / wall` is the pool's average parallelism — **4.85 of 6** above, which is what says
  whether more `--jobs` would buy anything. The MAIN THREAD's budget is `enumerate + score + rank`
  = 186.1s of the 259.4s wall, of which scoring is 88%; the remaining `idle+other` is the main
  thread waiting on subprocesses. Of the work charged at all (1443.4s), the compiles are **87%**.

  Both figures move with the machine, and by a lot. The same command on the same commit, sharing
  the box with a full `pnpm bench run`, read `wall 426.3s · compile 2175.1s · score 211.2s` —
  same 26880 candidates, same 0 dropped, same 395, same winner. Only the shares travel; re-time on
  your own log, and say what else the machine was doing.

  `idle+other` is the wall minus the work that HELD the main thread, which is not a fixed list of
  phases: at `--jobs 1` the compiles run on the main thread and come out of it, at `--jobs n` they
  are subprocess awaits and do not. So the residual means "waiting on subprocesses, plus whatever
  this clock does not name" in both, and the parts never sum past the wall.

- **`--proto`'s absence is now in the log.** Every run ends with an `asmlift: [proto]` line
  naming the callees whose arity it had to guess (nothing declared them: no `--proto` entry, no
  signature in `tools.asmlift.elf`). On the canonical LBG command that line is absent; without
  `--proto` it reads `1 callee(s) have no declared arity … thunk_HeapFree`, in the same stderr you
  are already pasting. Check the tail of your log before you quote a score.
- Quote the counts by pasting the **`asmlift: [ranked]` line**, the last thing every ranked run
  writes:

  ```
  asmlift: [ranked] 20608 candidate(s) scored, 0 dropped, 0 withheld, 0 synthesized, best <label>: 531 [asmlift source 7362050]
  ```

  A score from a run that dropped candidates is not comparable to one that dropped none — and
  "0 dropped" is now something the run SAYS. It used to be spelled as an absent line, so a clean
  run, a truncated log and a killed run left identical evidence.

  `synthesized` counts the declarations asmlift wrote for the winning candidate because no symbol
  map knew the name — read out of the same asm the score is about, so they cannot lose score, only
  manufacture agreement. A non-zero count means the artifact is that declaration block plus the
  source; the block itself is printed on the `asmlift: [declared]` lines just above.

  **WITHHELD is a third count and a different fact.** `dropped` means the scorer refused a
  spelling; `withheld` means one compiled, scored, and was refused PUBLICATION because it is
  proof-gated (`Candidate.matchOnly` — a spelling whose semantics no gate over the C can settle, so
  only a byte-exact score licenses it). Without the count, `candidates scored` silently
  under-reports the fan. On the LBG command below it is 0, because `/unreduce` declines there.

  **The candidate COUNT belongs to the tree, not to the function.** Every axis admitted multiplies
  it, so the counts quoted in the anecdotes above are each an A/B against themselves and none of
  them is a figure to reproduce. Quote your own `[ranked]` line.

- **The tree is part of the number too, and it is on that same line.** `[asmlift source <commit>]`
  names the asmlift sources the run actually executed. A reviewer's run of the command above
  returned **455** against a twice-reproduced **419** with a spotless log — another session had
  written `packages/core/src/target.ts` inside that read-only worktree at the minute it launched and
  restored it before it finished, so `git status` was clean on both sides of the run. Rounds run in
  parallel worktrees other agents write to. **If the stamp is not a bare commit, the number is not
  comparable to anything; fix what it names and re-run.** A bare commit is not a proof of the
  converse: the tree is sampled at the run's two ends, so an edit that lands and is reverted
  strictly between them leaves no mark. The window is the run's length rather than unbounded.

  | stamp                                            | what it says                                                                                                    |
  | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
  | `asmlift source af59b99`                         | the commit whose `packages/` produced this score. Quotable.                                                     |
  | `asmlift source af59b99+dirty`                   | uncommitted changes under `packages/`; nobody else can reproduce it                                             |
  | `asmlift source af59b99, CHANGED DURING THE RUN` | the sources moved between the run's start and its end — a tsx run can load a file from either side of that edit |
  | `asmlift source af59b99, STALE BUNDLE: …`        | the bundle ran `af59b99`'s code, and the checkout no longer holds it. Rebuild, re-run                           |
  | `asmlift source unversioned`                     | not run out of an asmlift checkout at all (an installed package), so nothing here can name the sources          |

## Comparing two runs

Compare on the `[score]` lines, filtered with a **fixed** string:

```sh
diff <(grep -F '[score]' a.err) <(grep -F '[score]' b.err)
```

`grep '[progress]'` is a bracket **expression** matching any one of `p r o g e s`, so
`grep -v '[progress]'` deletes almost every line including every `[score]` one, and the diff
passes having compared nothing. A neutrality check that filters away what it is comparing is
worse than none.

## Write it down

Whatever you run, paste it verbatim, flags included, into your report. Every later measurement —
each reviewer's, each remediation's, the PR body's — re-runs _that_ command, not one recomposed
from memory.
