// The benchmark's own agbcc command (apps/benchmark/dataset/toolchains/agbcc/decomp.yaml), runnable
// offline. Its compiler and assembler slots need an ARM toolchain no CI runner has, so both hold a
// TEST DOUBLE: a native program built here from the C below. Its `cpp` is the host's. The candidate
// store keys this command because it is the benchmark's own (src/candcache-bench.ts), so a store
// test driven through it runs the path the benchmark takes.
//
// The double writes the flags it was given, then its input, to its `-o` output — so an object
// follows the TU and the flags, as a compiler's does. What else it does is read from its
// environment, which no namespace hashes, so a test can change it between two compiles:
//   BENCH_DOUBLE_TALLY=<file>  appends a line per run;
//   BENCH_DOUBLE=kill          dies by SIGKILL;
//   BENCH_DOUBLE=reject        prints `<input>:1: error: rejected` and exits 1, as it does for an
//                              input holding REJECTME;
//   BENCH_DOUBLE=bake          appends its input's path, as `ido7.1` writes its into the object;
//   BENCH_DOUBLE=reject-probe  rejects the store's stamp probe TU only.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type BenchCommand, benchCommand } from '../../src/candcache-bench';

const SOURCE = String.raw`
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void reject(const char *in) {
  fprintf(stderr, "%s:1: error: rejected\n", in);
  exit(1);
}

int main(int argc, char **argv) {
  const char *in = 0, *out = 0, *mode = getenv("BENCH_DOUBLE"), *tally = getenv("BENCH_DOUBLE_TALLY");
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "-o") && i + 1 < argc) {
      out = argv[++i];
    } else if (argv[i][0] != '-' && !in) {
      in = argv[i];
    }
  }
  if (!in || !out) {
    fprintf(stderr, "bench double: usage: [flags] <input> -o <output>\n");
    return 2;
  }
  if (tally) {
    FILE *t = fopen(tally, "a");
    fputs("x\n", t);
    fclose(t);
  }
  if (mode && !strcmp(mode, "kill")) {
    raise(SIGKILL);
  }
  FILE *f = fopen(in, "rb");
  if (!f) {
    reject(in);
  }
  static char buf[1 << 20];
  size_t n = fread(buf, 1, sizeof buf - 1, f);
  fclose(f);
  buf[n] = 0;
  if (strstr(buf, "REJECTME") || (mode && !strcmp(mode, "reject")) ||
      (mode && !strcmp(mode, "reject-probe") && strstr(buf, "asmlift_candcache_stamp"))) {
    reject(in);
  }
  FILE *o = fopen(out, "wb");
  fputs("flags:", o);
  for (int i = 1; i < argc; i++) {
    if (argv[i][0] == '-' && strcmp(argv[i], "-o")) {
      fprintf(o, " %s", argv[i]);
    }
  }
  fputs("\n", o);
  fwrite(buf, 1, n, o);
  if (mode && !strcmp(mode, "bake")) {
    fprintf(o, "%s\n", in);
  }
  fclose(o);
  return 0;
}
`;

let built: string | undefined;
/** The double, built once per process with the host's `cc`. */
function double(): string {
  if (built === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'bench-double-'));
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'double.c'), SOURCE);
    execFileSync('cc', ['-O1', '-o', join(dir, 'bench-double'), join(dir, 'double.c')]);
    built = join(dir, 'bench-double');
  }
  return built;
}

/** The benchmark's agbcc command with the double in its compiler and assembler slots, and the
 *  `bench` option that names it to the store. It takes `{{flags}}`. */
export function benchAgbcc(): { command: string; bench: BenchCommand } {
  const bench = { toolchain: 'agbcc', placeholders: { ASMLIFT_AGBCC: double(), ASMLIFT_ARM_AS: double() } };
  return { command: benchCommand(bench), bench };
}
