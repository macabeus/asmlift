// Regression suite — data-driven over test/matching/fixtures.ts.
//
// Every fixture is decompiled, recompiled with its real toolchain (agbcc / IDO / mwcc), and
// objdiff-scored against its own target object. This locks in the functions asmlift already
// matches so a future change that regresses any of them fails loudly. To cover a new assembly
// function, add a row to FIXTURES — the loop below picks it up automatically. (mwcc fixtures
// skip with a warning when the Docker toolchain is unavailable.)
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, MIPS_IDO, PPC_MWCC, type TargetDescription } from '@asmlift/core/target';
import {
  type MatchScore,
  assembleTarget,
  compileMipsTarget,
  compilePpcTarget,
  compileTargetAsm,
  scoreC,
  scoreCMips,
  scoreCPpc,
} from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { ppcDockerGate } from './docker-gate';
import { type DecompFixture, FIXTURES, type FixtureToolchain } from './fixtures';

interface ToolchainRunner {
  target: TargetDescription;
  compile: (referenceC: string, symbol: string) => { asm: string; obj: string };
  score: (source: string, symbol: string, targetObj: string) => MatchScore;
}

const RUNNERS: Record<FixtureToolchain, ToolchainRunner> = {
  agbcc: {
    target: ARMV4T_AGBCC,
    compile: (c) => {
      const asm = compileTargetAsm(c);
      return { asm, obj: assembleTarget(asm) };
    },
    score: scoreC,
  },
  ido: {
    target: MIPS_IDO,
    compile: (c, sym) => compileMipsTarget(c, sym),
    score: scoreCMips,
  },
  mwcc: {
    target: PPC_MWCC,
    compile: (c, sym) => compilePpcTarget(c, sym),
    score: scoreCPpc,
  },
};

function runFixture(fx: DecompFixture) {
  const runner = RUNNERS[fx.toolchain ?? 'agbcc'];
  const { asm, obj } = runner.compile(fx.referenceC, fx.symbol);

  const r = decompile(fx.symbol, asm, runner.target, { patterns: fx.patterns, prototypes: fx.prototypes });

  if (fx.expectPatternHits !== undefined) {
    expect(r.patternHits).toBe(fx.expectPatternHits);
  }
  if (fx.expectSource !== undefined) {
    expect(r.source).toBe(fx.expectSource);
  }

  const s = runner.score(r.source, fx.symbol, obj);
  if (s.match !== (fx.expectMatch ?? true)) {
    console.log(`emitted C for ${fx.symbol}:\n${r.source}`);
    console.log('objdiff:', JSON.stringify(s));
  }
  expect(s.score).toBe(fx.expectScore ?? 0);
  expect(s.match).toBe(fx.expectMatch ?? true);
}

const HAVE_PPC = ppcDockerGate('regression');

describe('regression: decompile → recompile → objdiff', () => {
  for (const fx of FIXTURES.filter((f) => f.toolchain !== 'mwcc')) {
    test(`${fx.symbol} (${fx.toolchain ?? 'agbcc'}) — ${fx.note}`, () => runFixture(fx));
  }
});

describe.runIf(HAVE_PPC)('regression (mwcc, Docker-gated)', () => {
  for (const fx of FIXTURES.filter((f) => f.toolchain === 'mwcc')) {
    test(`${fx.symbol} (mwcc) — ${fx.note}`, () => runFixture(fx));
  }
});
