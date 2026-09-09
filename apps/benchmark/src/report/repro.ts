// THE VEHICLE THAT REPRODUCES ONE ROW — hand a reader the row's own generated script, with this
// machine's paths already in it, in a directory the repo ignores.
//
// A subcommand rather than the `node -e '…results.json…' > repro.sh` block this page used to
// print, for the reason `report/baseline.ts` gives about its own one-liner: in a copy-pasted
// pipeline the failure is silent. Measured, with one character wrong in the row id — the shape a
// reader actually produces:
//
//   node -e … > repro.sh      node exits 1, but the REDIRECT already truncated repro.sh to 0 bytes
//   bash repro.sh …           exit 0, out.err 0 bytes   (separate lines: no `&&`, no `set -e`)
//   grep -n '^WARN' out.err   nothing — which the page teaches means "your setup is right"
//   grep -F '[score]' …       nothing
//
// So a typo rendered as a clean run with no score. Every way of finding no row here is a message
// and an exit 1 instead.
//
// Three more things the block could not do, each of which cost a round:
//   * `--out "$PWD"` in the repo root leaves 7 untracked files (`out.c`, `proto.json`,
//     `decomp.yaml`, …) that `bench run`'s dirty-tree preflight then REFUSES the round for. The
//     default out dir here is under the gitignored `.local/`.
//   * the checkout it points PROJECT_PATH at is resolved from the row's own manifest, so a map
//     from a DIFFERENT project cannot be grafted. `bench target` warns about a MISSING map; a
//     wrong one is silent (`cases/project-elf.ts` reads whatever `decomp.yaml` is at the root it
//     is given), and a wrong map is worse than none — the names come out wrong, not absent.
//   * `--run` reports the `[ranked]` line, which carries `best …` AND the source sha. The block
//     said `grep -F '[score]' | tail -1`, and that table is sorted best-first: on
//     `kleod:GetEntityLookupData:agbcc` it returned `signed: 15/18` where the row (and the run's
//     own best) is `unsigned/raw-globals: 4/14`. It had been validated on a 1-candidate row.
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadManifestsForVendor, resolveProjectRoot } from '../cases/manifests';
import { REPO_ROOT, RESULTS_DIR } from '../config';
import { materialize } from '../run/fidelity';
import { selectRows } from './baseline';
import { asmliftScript, m2cScript } from './repro-scripts';

/** The artifact ON DISK, not `git show <ref>:…`. `bench target` — the script's own step 1 —
 *  reads this same file to pick the scoring rung, so a script generated from some other ref
 *  would be run against a rung chosen from this one. */
function readArtifact(): BenchOutput {
  const path = join(RESULTS_DIR, 'results.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BenchOutput;
  } catch (e) {
    throw new Error(`cannot read ${path}: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

/** The row's project checkout, resolved exactly as `bench fidelity` resolves it (env override >
 *  bench-owned > sibling workspace). Undefined for a row that was measured without a map. */
function projectRootFor(r: FunctionResult): string | undefined {
  if (r.tier !== 'real' || !r.asmlift.symbolMap) {
    return undefined;
  }
  const man = loadManifestsForVendor().find((m) => m.project === r.project);
  return man ? resolveProjectRoot(man) : undefined;
}

export const reproDirFor = (id: string): string => join(REPO_ROOT, '.local', 'repro', id.replace(/[^\w.-]+/g, '_'));

export interface ReproOptions {
  out?: string;
  tool?: string;
  run?: boolean;
}

/** Writes the row's reproduction script and, with `--run`, executes it. Returns the exit code. */
export async function repro(
  needle: string,
  o: ReproOptions = {},
  log: (s: string) => void = console.log,
  err: (s: string) => void = console.error,
): Promise<number> {
  const tool = o.tool ?? 'asmlift';
  if (tool !== 'asmlift' && tool !== 'm2c') {
    err(`repro: unknown --tool ${JSON.stringify(tool)} (asmlift | m2c)`);
    return 2;
  }

  const artifact = readArtifact();
  const rows = selectRows(artifact.results, needle);

  if (rows.length === 0) {
    // Both causes named, never an empty stdout: "no output" is the answer that reads as "this
    // symbol has no benchmark row", which is the one wrong conclusion here.
    const near = artifact.results.filter((r) => r.sym.toLowerCase().includes(needle.toLowerCase().replace(/^.*:/, '')));
    err(`repro: no row for ${JSON.stringify(needle)} in the artifact (${artifact.results.length} rows).`);
    err('Either you mistyped it, or this target is measured outside the harness — in which case the');
    err('vehicle is the project-checkout command in docs/ranked-repro.md, and its number is not');
    err('comparable with a harness outcome.');
    if (near.length > 0) {
      err(
        `Case-insensitively, ${near.length} row(s) match: ${near
          .slice(0, 5)
          .map((r) => r.id)
          .join(', ')}`,
      );
    }
    return 1;
  }
  if (rows.length > 1) {
    err(`repro: ${JSON.stringify(needle)} selects ${rows.length} rows; one script reproduces one row. Name it:`);
    for (const r of rows.slice(0, 10)) {
      err(`  ${r.id}`);
    }
    return 1;
  }

  const [row] = rows;
  const root = projectRootFor(row);
  const script = materialize(tool === 'm2c' ? m2cScript(row) : asmliftScript(row), root);
  const dir = o.out ?? reproDirFor(row.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `repro-${tool}.sh`);
  writeFileSync(path, script);

  log(
    `repro: ${row.id} — ${row.asmlift.outcome} ${row.asmlift.score ?? '-'}/${row.asmlift.maxScore ?? '-'} as published`,
  );
  log(`repro: wrote ${path}`);
  if (row.tier === 'real' && row.asmlift.symbolMap) {
    // A row measured WITH a map and reproduced without one answers a different question, and
    // `bench target` only warns — it exits 0 and the run continues.
    log(
      root !== undefined && existsSync(root)
        ? `repro: symbol map from ${root}`
        : `repro: NO CHECKOUT at ${root ?? '(unresolved)'} — this row was measured WITH the project's symbol map, and this run will not have it (pnpm bench setup --project ${row.project})`,
    );
  }
  if (!o.run) {
    log(`repro: run it with   cd ${dir} && bash ${path.slice(dir.length + 1)}    (or re-run this with --run)`);
    return 0;
  }

  const code = await execute(path, dir, log, err);
  const errText = readFileSync(join(dir, 'out.err'), 'utf8');
  // The setup check FIRST: a map-less run is silent apart from this line, and on a cheap row it
  // prints the same score it would with the map — so it tells you the setup is right when it is not.
  for (const line of errText.split('\n').filter((l) => l.startsWith('WARN'))) {
    err(`repro: ${line}`);
  }
  // `[ranked]`, not the `[score]` table: it carries `best …` and the `[asmlift source <sha>]`
  // stamp, and it is one line whether the fan was 1 or 100,000.
  const ranked = errText.split('\n').filter((l) => l.includes('[ranked]') || l.includes('[declined]'));
  for (const line of ranked) {
    log(line.trim());
  }
  if (ranked.length === 0) {
    err(`repro: the run printed no [ranked] line — read ${join(dir, 'out.err')}`);
  }
  // exit 0 only on byte-exact (`--score-against`), so a non-matching row's script exits 1 by
  // design. That is the row reproducing, not the script breaking — pass it through and say so.
  log(`repro: script exit ${code}${code === 0 ? ' (byte-exact)' : ' — a non-matching row exits nonzero by design'}`);
  return code;
}

/** Run the script in its own directory, capturing both streams to files. Buffered rather than
 *  piped: `pipe()` closes the file stream on its own, so a `close` listener attached later —
 *  when the CHILD exits — can be attached after the event already fired, and the command then
 *  hangs on a promise that never settles. A decompiled function and its stderr are small. */
function execute(path: string, dir: string, log: (s: string) => void, err: (s: string) => void): Promise<number> {
  log(`repro: running (stdout → ${join(dir, 'out.c')}, stderr → ${join(dir, 'out.err')})`);
  return new Promise((res, rej) => {
    const child = spawn('bash', [path], { cwd: dir });
    let out = '';
    let errText = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.on('data', (d: Buffer) => (errText += d));
    child.on('error', (e) => rej(e));
    child.on('close', (code, signal) => {
      writeFileSync(join(dir, 'out.c'), out);
      writeFileSync(join(dir, 'out.err'), errText);
      if (signal) {
        err(`repro: killed by ${signal}`);
      }
      res(code ?? (signal ? 124 : 0));
    });
  });
}
