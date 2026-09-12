// `pnpm bench sweep` (src/run/sweep.ts) — the corpus-wide compile-free differential re-lift.
//
// WHAT IS WORTH PINNING HERE. Not the lifting: the driver hands `decompile` the row's own
// `rankOptionsFor` options and hashes what comes back, and core's own suites own whether that text
// is right. What can go wrong is everything AROUND it, and each of these was a defect in one of
// the twenty hand-built rigs this command replaces:
//
//   - a comparison that reports "nothing moved" because the two sides were keyed differently, or
//     because one side is a PREFIX of the other and the extra rows were silently dropped;
//   - a flag pair that is accepted and then ignored, so the run measures a configuration nobody
//     asked for (`--toolchain` without `--asm-dir` was exactly this defect in `bench fan`, fixed
//     in #194 by `optionRefusal`);
//   - a `--fan` guard that lets the corpus's one 77,760-spelling row through and turns a 437 s
//     diagnostic into an overnight job.
//
// The CI mirror gate (`vitest run apps/benchmark/test`) runs where no compiler is available, so
// nothing here builds a target.
import { describe, expect, it, vi } from 'vitest';

import { SWEEP_FAN_LIMIT, type SweepRecord, compareSweeps, renderDiff, sweepRefusal } from '../src/run/sweep';

const rec = (over: Partial<SweepRecord> & Pick<SweepRecord, 'id' | 'arm'>): SweepRecord => ({
  src: 'aaaaaaaaaaaa',
  len: 100,
  diag: 0,
  marks: 0,
  ...over,
});

const base = () => [
  rec({ id: 'synthetic:a:agbcc', arm: 'harness' }),
  rec({ id: 'synthetic:a:agbcc', arm: 'nomap' }),
  rec({ id: 'kleod:B:agbcc', arm: 'harness' }),
];

describe('the sweep comparison', () => {
  it('reports a row identical in both trees as identical, and names nothing', () => {
    const d = compareSweeps(base(), base());
    expect(d.same).toBe(3);
    expect(d.moved).toEqual([]);
    expect(renderDiff(d)).toEqual([]);
  });

  it('keys on the ROW AND THE ARM, so a change in one arm is not attributed to the other', () => {
    // The defect this pins: a rig keyed by row id alone reports the map-ful and map-less records
    // of one row as a single moved row, and a change that moves ONLY the map-less arm — which is
    // most naming and global-recovery work — then reads as "the benchmark configuration moved".
    const head = base().map((r) => (r.arm === 'nomap' ? { ...r, src: 'bbbbbbbbbbbb' } : r));
    const d = compareSweeps(base(), head);
    expect(d.moved).toHaveLength(1);
    expect(d.moved[0]).toMatchObject({ id: 'synthetic:a:agbcc', arm: 'nomap' });
    expect(d.same).toBe(2);
  });

  it('names every field that moved, not just the source hash', () => {
    const head = base().map((r) =>
      r.id === 'kleod:B:agbcc' ? { ...r, src: 'cccccccccccc', len: 140, diag: 1, marks: 2 } : r,
    );
    const d = compareSweeps(base(), head);
    const line = renderDiff(d)[0];
    expect(line).toContain('kleod:B:agbcc harness');
    expect(line).toContain('src aaaaaaaaaaaa -> cccccccccccc');
    expect(line).toContain('len 100 -> 140');
    expect(line).toContain('diag 0 -> 1');
    expect(line).toContain('marks 0 -> 2');
  });

  it('reports a record only one side produced instead of dropping it', () => {
    // A sweep whose two sides have different ROW SETS is the normal case after a dataset commit,
    // and it is the case a `for (const h of head) { const b = byId[h.id]; if (!b) continue; }` rig
    // reports as "0 moved" — the most convincing wrong answer this command can give.
    const head = [
      ...base().filter((r) => r.id !== 'kleod:B:agbcc'),
      rec({ id: 'synthetic:new:agbcc', arm: 'harness' }),
    ];
    const d = compareSweeps(base(), head);
    expect(d.baseOnly).toEqual(['kleod:B:agbcc harness']);
    expect(d.headOnly).toEqual(['synthetic:new:agbcc harness']);
    expect(renderDiff(d).join('\n')).toContain('[base-only] kleod:B:agbcc harness');
    expect(renderDiff(d).join('\n')).toContain('[head-only] synthetic:new:agbcc harness');
  });

  it('treats a throw and a lift as different, both ways', () => {
    const head = base().map((r) =>
      r.id === 'kleod:B:agbcc' ? { id: r.id, arm: r.arm, threw: 'no frontend for this target' } : r,
    );
    const d = compareSweeps(base(), head);
    expect(d.moved[0].fields.map((f) => f.field).sort()).toEqual(['diag', 'len', 'marks', 'src', 'threw']);
    // and the reverse direction is a move too — a row that STOPPED throwing is the whole point of
    // most of this project's rounds, and a diff that only notices new throws misses every fix.
    expect(compareSweeps(head, base()).moved).toHaveLength(1);
  });

  it('compares the fan fields when --fan recorded them', () => {
    const b = [rec({ id: 'r:s:agbcc', arm: 'harness', fan: 32, fanHash: '111111111111' })];
    const h = [rec({ id: 'r:s:agbcc', arm: 'harness', fan: 64, fanHash: '222222222222' })];
    const line = renderDiff(compareSweeps(b, h))[0];
    expect(line).toContain('fan 32 -> 64');
    expect(line).toContain('fanHash 111111111111 -> 222222222222');
  });

  it('reports a fan that is the same SIZE and a different SET', () => {
    // The move a count-only census cannot see, and the reason the record carries a hash of the
    // candidate SOURCES and not just `candidateCount`: an axis that swaps one spelling for another
    // leaves the count identical and is exactly the kind of change a round ships.
    const b = [rec({ id: 'r:s:agbcc', arm: 'harness', fan: 32, fanHash: '111111111111' })];
    const h = [rec({ id: 'r:s:agbcc', arm: 'harness', fan: 32, fanHash: '222222222222' })];
    const d = compareSweeps(b, h);
    expect(d.moved[0].fields).toEqual([{ field: 'fanHash', from: '111111111111', to: '222222222222' }]);
  });
});

describe('the sweep refusals', () => {
  const ok = { tiers: ['synthetic'] as const, arms: ['harness'] };

  it('accepts the ordinary selection', () => {
    expect(sweepRefusal(ok)).toBeUndefined();
  });

  it('refuses --toolchain without --asm-dir instead of silently pricing another target', () => {
    expect(sweepRefusal({ ...ok, toolchain: 'mwcc_242_81' })).toContain('--asm-dir alone');
  });

  it('refuses --asm-dir without --toolchain, because a .s does not say which target lifted it', () => {
    expect(sweepRefusal({ ...ok, asmDir: '/tmp/asm' })).toContain('--toolchain');
  });

  it('refuses --base together with --base-dir rather than picking one', () => {
    expect(sweepRefusal({ ...ok, base: 'origin/main', baseDir: '/tmp/x' })).toContain('Pick one');
  });

  it('refuses --repeat beside a base: two different questions, one exit code', () => {
    expect(sweepRefusal({ ...ok, repeat: 3, base: 'origin/main' })).toContain('agrees with itself');
  });

  it('refuses a --repeat that cannot compare anything', () => {
    expect(sweepRefusal({ ...ok, repeat: 1 })).toContain('≥ 2');
    expect(sweepRefusal({ ...ok, repeat: Number.NaN })).toContain('≥ 2');
  });

  it('refuses an unknown arm by name, and lists the arms', () => {
    const r = sweepRefusal({ ...ok, arms: ['harness', 'symbolz'] });
    expect(r).toContain('symbolz');
    expect(r).toContain('nomap');
  });

  it('refuses --compare that is not exactly two files', () => {
    // `--compare a.json b.json` is one flag plus one positional, so a missing second file arrives
    // here as a one-element list. Refused by NAME: compared against `undefined` instead, the
    // command prints "0 record(s) moved" over an empty side, which is the most convincing wrong
    // answer a differential tool can give.
    expect(sweepRefusal({ ...ok, compare: ['a.json'] })).toContain('<base.json> <head.json>');
    expect(sweepRefusal({ ...ok, compare: ['a.json', 'b.json', 'c.json'] })).toContain('two record files');
    expect(sweepRefusal({ ...ok, compare: ['a.json', 'b.json'] })).toBeUndefined();
  });

  it('refuses --compare beside a base — one of them would have to be ignored', () => {
    expect(sweepRefusal({ ...ok, compare: ['a.json', 'b.json'], base: 'origin/main' })).toContain('Pick one');
  });
});

describe('the --fan size guard', () => {
  it("sits above the biggest row a round actually enumerates and below the corpus's one giant", () => {
    // Not a round number for its own sake, and the bracket is read off the COMMITTED artifact:
    // `kleod:CountCollectedGems:agbcc` records 9,192 spellings (measured 83.0 s here) and is the
    // row this project's rounds enumerate most; `kleod:ProcessInputAndUpdateEntities:agbcc`
    // records 77,760 and is the only corpus row over the limit. A limit between them IS the
    // design, so moving it has to fail here rather than quietly turn a 437 s sweep into an
    // overnight one.
    expect(SWEEP_FAN_LIMIT).toBeGreaterThan(13728);
    expect(SWEEP_FAN_LIMIT).toBeLessThan(77760);
  });
});

describe('the raw-asm population', () => {
  it('finds .s and .inc under a tree, in a stable order, and nothing else', async () => {
    // The unit of iteration that keeps this command from being bypassed the way `bench fan` was:
    // the hand rigs swept `checkouts/<project>/asm/{matchings,nonmatchings}` and
    // `checkouts/sa3/asm/non_matching`, on functions that are not dataset rows. Sorted, because
    // `--repeat` compares two runs and `readdirSync` order is a filesystem detail.
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { asmFilesUnder } = await import('../src/run/sweep-driver');

    const root = mkdtempSync(join(tmpdir(), 'sweep-asm-'));
    mkdirSync(join(root, 'nonmatchings'));
    writeFileSync(join(root, 'zeta.s'), '');
    writeFileSync(join(root, 'alpha.s'), '');
    writeFileSync(join(root, 'notes.txt'), '');
    writeFileSync(join(root, 'nonmatchings', 'beta.inc'), '');

    expect(asmFilesUnder(root)).toEqual([
      join(root, 'alpha.s'),
      join(root, 'nonmatchings', 'beta.inc'),
      join(root, 'zeta.s'),
    ]);
  });
});

describe('a base that cannot be resolved is refused before the head sweep is paid for', () => {
  it('exits 2 on an unresolvable --base without lifting anything', async () => {
    // MEASURED DEFECT, not a hypothetical: with the base resolved where it reads naturally — just
    // before it is needed, after the head side — `bench sweep --base no/such/ref` printed
    // `1062 row(s) ... 59.6 s` and only THEN "git cannot resolve that ref". `run/fan.ts` states the
    // rule this restores ("a nonsense flag pair is worth refusing before a ~46 s enumeration is
    // paid for it"). The driver is stubbed so that a regression fails LOUDLY here rather than by
    // taking a minute.
    const { sweep } = await import('../src/run/sweep');
    const driver = await import('../src/run/sweep-driver');
    const spy = vi.spyOn(driver, 'collect').mockResolvedValue([]);
    try {
      expect(await sweep({ tiers: ['synthetic'], arms: ['harness'], base: 'no/such/ref-here' })).toBe(2);
      expect(spy, 'the head sweep ran before the base ref was checked').not.toHaveBeenCalled();

      expect(await sweep({ tiers: ['synthetic'], arms: ['harness'], baseDir: '/definitely/not/a/tree' })).toBe(2);
      expect(spy, 'the head sweep ran before --base-dir was checked').not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
