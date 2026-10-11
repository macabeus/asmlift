// A compile whose attempts are unread (compile/real.ts `ladderCompile`, docs/vocabulary.md): once the
// stillborn verdict is in, nothing reads a rejection's attempts, so the ladder may skip a rung that
// cannot accept the candidate. What it must keep is what the row publishes and what the ranking
// reads: the object of the first rung that compiles, the richest rung's message, and whether the
// throw is a `CompilerRejection`. The ranked driver (cli rank.ts) must compile the default and the
// probes with every attempt, or the stillborn rule reads a different rejection.
//
// On the real compilers, behind an observer that records every translation unit the ladder hands
// them. Candidate preprocessing runs `-nostdinc` with no project `-I`, so a prelude that includes a
// project header fails on it exactly as the corpus's manifest rungs do.
import { decompileRankedParallel, enumerateRanked } from '@asmlift/cli/rank';
import { CompilerRejection, attemptsOf } from '@asmlift/core/compiler-diagnostics';
import { NoScorableCandidateError } from '@asmlift/core/rank';
import { probeIndices } from '@asmlift/core/stillborn';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import {
  agbccAvailable,
  assembleTarget,
  compileTargetAsm,
  idoAvailable,
  ppcDockerAvailable,
} from '@asmlift/toolchains';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { failsOnOwnInclude, ladderCompile, realCompilerFor } from '../src/compile/real';
import type { RealCompile } from '../src/compile/types';
import { canonicalCodegen } from '../src/toolchains';

const CTX = 'struct S { s32 x; };\n';
/** compiles in the vendored context only: the bare rung has no `struct S` */
const SOURCE = 'void f(struct S *s) { s->x = 1; }\n';
/** refused by every rung */
const REFUSED = 'void f(struct S *s) { s->x = ; }\n';
const MISSING = '#include "global.h"\n';

/** `rc`, recording the translation units it is handed. */
function observed(rc: RealCompile): { rc: RealCompile; compiled: string[] } {
  const compiled: string[] = [];
  return {
    compiled,
    rc: {
      ...rc,
      compileCandidate(tu, sym, cflags, language) {
        compiled.push(tu);
        return rc.compileCandidate(tu, sym, cflags, language);
      },
    },
  };
}

type Outcome = { bytes: Buffer } | { message: string; rejection: boolean; labels: string[] };

/** What one ladder compile publishes: the object's bytes, read before the next compile reuses its
 *  scratch slot, or the thrown error's message and class, with its attempts' labels. */
async function outcome(compile: ReturnType<typeof ladderCompile>, source: string, unread: boolean): Promise<Outcome> {
  try {
    return { bytes: readFileSync(await compile(source, 'f', 'c', undefined, { attemptsUnread: unread })) };
  } catch (e) {
    return {
      message: (e as Error).message,
      rejection: e instanceof CompilerRejection,
      labels: e instanceof CompilerRejection ? attemptsOf(e.diagnostic).map((a) => a.label) : [],
    };
  }
}

/** A header file outside the compile's directory, named by its absolute path so `-nostdinc` finds it. */
function header(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'ladder-unread-')), 'found.h');
  writeFileSync(path, text);
  return path;
}

const COMPILE_BUDGET = 60_000;

describe.skipIf(!agbccAvailable())('an agbcc ladder whose attempts are unread', () => {
  const agbcc = realCompilerFor('agbcc');
  const cflags = canonicalCodegen('agbcc').cflags;
  const ladder = (prependC: string, ctxI = CTX) => {
    const o = observed(agbcc);
    return { ...o, compile: ladderCompile(o.rc, cflags, 'assembled', prependC, ctxI, 'c') };
  };
  const inManifestRung = (compiled: string[], marker: string) =>
    compiled.filter((tu) => tu.includes(marker) && tu.includes('void f(')).length;

  test(
    'skips a manifest rung that fails on its own missing include, probing that prelude once',
    async () => {
      const unread = ladder(MISSING);
      const first = await outcome(unread.compile, SOURCE, true);
      await outcome(unread.compile, SOURCE.replace('= 1', '= 2'), true);
      expect(unread.compiled.filter((tu) => tu.includes(MISSING) && !tu.includes('void f('))).toHaveLength(1);
      expect(inManifestRung(unread.compiled, MISSING)).toBe(0);
      expect(unread.compiled).toHaveLength(5);

      const read = ladder(MISSING);
      expect(first).toEqual(await outcome(read.compile, SOURCE, false));
      expect(inManifestRung(read.compiled, MISSING)).toBe(1);
      expect(read.compiled).toHaveLength(3);
    },
    COMPILE_BUDGET,
  );

  test(
    "throws the richest rung's message and class whether the dead rung ran or not",
    async () => {
      const skipped = await outcome(ladder(MISSING).compile, REFUSED, true);
      const ran = await outcome(ladder(MISSING).compile, REFUSED, false);
      expect(ran).toMatchObject({
        rejection: true,
        message: expect.stringMatching(/^agbcc failed: c\.c:\d+: syntax error/),
      });
      expect(skipped).toEqual({
        ...ran,
        labels: (ran as { labels: string[] }).labels.filter((l) => l !== '+ manifest prependC (c)'),
      });
    },
    COMPILE_BUDGET,
  );

  test(
    'compiles a manifest rung whose prelude holds no include, even one that repeats the bare rung',
    async () => {
      const unread = ladder('');
      const skipped = await outcome(unread.compile, REFUSED, true);
      expect(unread.compiled).toHaveLength(3);
      expect(skipped).toEqual(await outcome(ladder('').compile, REFUSED, false));
    },
    COMPILE_BUDGET,
  );

  test(
    'compiles a manifest rung whose include is found, and scores the candidate there',
    async () => {
      const found = `#include "${header(CTX)}"\n`;
      const unread = ladder(found);
      const compiled = await outcome(unread.compile, SOURCE, true);
      expect(inManifestRung(unread.compiled, found)).toBe(1);
      expect(compiled).toEqual(await outcome(ladder(found).compile, SOURCE, false));
    },
    COMPILE_BUDGET,
  );

  test(
    'compiles a manifest rung whose prelude fails on anything but its own missing include',
    async () => {
      const broken = `#include "${header(CTX)}"\nint oops(;\n`;
      const unread = ladder(broken);
      await outcome(unread.compile, SOURCE, true);
      expect(inManifestRung(unread.compiled, broken)).toBe(1);
    },
    COMPILE_BUDGET,
  );

  test(
    'never skips the richest rung',
    async () => {
      const unread = ladder(MISSING, '');
      await outcome(unread.compile, SOURCE, true);
      expect(inManifestRung(unread.compiled, MISSING)).toBe(1);
    },
    COMPILE_BUDGET,
  );

  test(
    'reads a missing include only at the line of an include naming it',
    () => {
      const prelude = `#define NULL ((void *)0)\n${MISSING}`;
      let diagnostic = '';
      try {
        agbcc.compileCandidate(prelude, 'asmlift_probe', cflags, 'c');
      } catch (e) {
        diagnostic = `${(e as Error).message}\n${(e as CompilerRejection).diagnostic}`;
      }
      expect(diagnostic).toMatch(/c\.c:2:\d+: fatal error: global\.h: No such file or directory/);
      expect(failsOnOwnInclude(prelude, diagnostic)).toBe(true);
      // the same failure, read against a prelude that includes the header on another line or not at all
      expect(failsOnOwnInclude(`\n${prelude}`, diagnostic)).toBe(false);
      expect(failsOnOwnInclude(prelude.replace('global.h', 'other.h'), diagnostic)).toBe(false);
    },
    COMPILE_BUDGET,
  );

  test('reads no include in a missing-file error that names no line', () => {
    // cpp whose own input is gone: the shape a compile that lost its scratch file prints
    const gone = join(mkdtempSync(join(tmpdir(), 'ladder-unread-')), 'c.i');
    const cpp = spawnSync('arm-none-eabi-cpp', ['-nostdinc', gone], { encoding: 'utf8' });
    expect(cpp.stderr).toContain(`fatal error: ${gone}: No such file or directory`);
    expect(failsOnOwnInclude(`#include "${gone}"\n`, cpp.stderr)).toBe(false);
  });
});

describe.runIf(ppcDockerAvailable('mwcc_242_81'))('a CodeWarrior ladder whose attempts are unread', () => {
  test('skips a manifest rung that fails on its own missing include', async () => {
    const cflags = canonicalCodegen('mwcc_242_81').cflags;
    const prependC = '#include "dolphin.h"\n';
    const runs: Outcome[] = [];
    const counts: number[] = [];
    for (const unread of [true, false]) {
      const o = observed(realCompilerFor('mwcc_242_81'));
      const compile = ladderCompile(o.rc, cflags, 'assembled', prependC, CTX, 'c');
      runs.push(await outcome(compile, SOURCE, unread));
      counts.push(o.compiled.filter((tu) => tu.includes(prependC) && tu.includes('void f(')).length);
    }
    expect(counts).toEqual([0, 1]);
    expect(runs[0]).toEqual(runs[1]);
  }, 120_000);
});

// IDO's lane preprocesses with the host's cpp, which throws a plain Error, so a dead rung there is a
// transient by class and the ladder's throw has to stay one when the rung is skipped.
describe.skipIf(!idoAvailable())('an IDO ladder whose attempts are unread', () => {
  test(
    'throws the same plain Error whether its dead rung ran or not',
    async () => {
      const cflags = canonicalCodegen('ido7.1').cflags;
      const runs: Outcome[] = [];
      const counts: number[] = [];
      for (const unread of [true, false]) {
        const o = observed(realCompilerFor('ido7.1'));
        runs.push(await outcome(ladderCompile(o.rc, cflags, 'assembled', MISSING, CTX, 'c'), REFUSED, unread));
        counts.push(o.compiled.filter((tu) => tu.includes(MISSING) && tu.includes('void f(')).length);
      }
      expect(counts).toEqual([0, 1]);
      expect(runs[1]).toMatchObject({ rejection: false, message: expect.stringMatching(/^ido cc failed: /) });
      expect(runs[0]).toEqual(runs[1]);
    },
    COMPILE_BUDGET,
  );
});

// The ranked driver over a ladder whose manifest rung is dead: the default and the probes reach that
// rung, so the stillborn rule reads the same attempts in each of them, and every other candidate
// skips it.
describe.skipIf(!agbccAvailable())('the ranked driver over a ladder with a dead rung', () => {
  const rank = async (src: string, ctxI: string) => {
    const asm = compileTargetAsm(src, TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
    const o = observed(realCompilerFor('agbcc'));
    const compile = ladderCompile(o.rc, canonicalCodegen('agbcc').cflags, 'assembled', MISSING, ctxI, 'c');
    const ranked = await decompileRankedParallel('f', asm, ARMV4T_AGBCC, assembleTarget(asm), {
      jobs: 1,
      worker: () => compile,
    }).catch((e: unknown) => e);
    const candidates = enumerateRanked('f', asm, ARMV4T_AGBCC, {});
    const reachedDeadRung = candidates.flatMap((c, i) =>
      o.compiled.some((tu) => tu.includes(MISSING) && tu.endsWith(`${c.source}\n`)) ? [i] : [],
    );
    return { ranked, candidates, reachedDeadRung };
  };

  test(
    'stops a stillborn fan, having compiled the default and the probes in every rung',
    async () => {
      const { ranked, candidates, reachedDeadRung } = await rank(
        'extern unsigned short gX, gY; int f(int a, int b) { int r = 7; if (a || b) r = gX + a; if (b) r += gY; return r; }',
        'struct S { s32 x; };\nextern u16 gX;\nextern struct S gY;\n',
      );
      expect(ranked).toBeInstanceOf(NoScorableCandidateError);
      const notCompiled = (ranked as NoScorableCandidateError).notCompiled.length;
      expect(notCompiled).toBeGreaterThan(0);
      expect(reachedDeadRung).toEqual([0, ...probeIndices(candidates)]);
      expect(reachedDeadRung.length + notCompiled).toBe(candidates.length);
    },
    COMPILE_BUDGET,
  );

  test(
    'compiles the rest of a live fan without its dead rung',
    async () => {
      const { ranked, candidates, reachedDeadRung } = await rank(
        'extern unsigned short gX; extern int g(int, int); int f(int a, int b) { int r = 7; if (a || b) r = gX + a; if (b) r += g(a, b); return r; }',
        'extern u16 gX;\nint g(int);\n',
      );
      expect(ranked).not.toBeInstanceOf(Error);
      const { candidates: scored, dropped, withheld } = ranked as Awaited<ReturnType<typeof decompileRankedParallel>>;
      expect(scored.length + dropped.length + withheld.length).toBe(candidates.length);
      expect(reachedDeadRung).toEqual([0, ...probeIndices(candidates)]);
      expect(reachedDeadRung.length).toBeLessThan(candidates.length);
    },
    COMPILE_BUDGET,
  );
});
