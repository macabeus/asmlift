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
//     diagnostic into an overnight job;
//   - a census that counts a row NOBODY LIFTED — its toolchain missing from this shell — in the
//     same word as a row both trees spelled identically.
//
// The CI mirror gate (`vitest run apps/benchmark/test`) runs where no compiler is available, so
// nothing here builds a target. That is why the PRODUCER is pinned through the pure functions
// `collect` is assembled from (`armsFor`, `optsDigest`) rather than by calling `collect`: a
// reviewer collapsed the two arms onto one key and all 40 files / 1,128 tests of this suite stayed
// green, because every assertion was on hand-built records.
import { describe, expect, it, vi } from 'vitest';

import {
  SWEEP_FAN_LIMIT,
  type SweepRecord,
  compareSweeps,
  renderDiff,
  sweepRefusal,
  unmeasuredCounts,
} from '../src/run/sweep';
import { armsFor, optsDigest } from '../src/run/sweep-driver';

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

describe('a record neither tree lifted is not "identical"', () => {
  const skipped = (id: string, why: string): SweepRecord => ({ id, arm: 'harness', skipped: why });

  it('counts a row whose toolchain is missing apart from a row both trees spelled the same way', () => {
    // MEASURED DEFECT. With `ASMLIFT_AGBCC` unset — one login shell away, trap #6 of the round
    // protocol — a whole synthetic-tier A/B against a real decompiler change reported
    // `1002 record(s) moved ... 618 identical`, and 618 of those 1,620 records had never been
    // lifted on either side. The two sides' records are field-for-field equal, so only the
    // `skipped` cause tells them apart.
    const side = [rec({ id: 'synthetic:a:agbcc', arm: 'harness' }), skipped('synthetic:b:mwcc_242_81', 'toolchain')];
    const d = compareSweeps(side, side);
    expect(d.same).toBe(1);
    expect(d.notMeasured).toBe(1);
  });

  it('counts a build failure as not measured, and the announced fan-limit skip as measured', () => {
    // `fan-limit` is the one `skipped` cause that is NOT a hole: the guard named the row and its
    // recorded spelling count before paying, and the row was still LIFTED — only its enumeration
    // is missing. Reading it as "not measured" would make `--fan` refuse on the corpus's one giant
    // every time.
    const side = [
      skipped('synthetic:c:agbcc', 'build'),
      rec({ id: 'kleod:ProcessInputAndUpdateEntities:agbcc', arm: 'harness', skipped: 'fan-limit' }),
    ];
    const d = compareSweeps(side, side);
    expect(d.notMeasured).toBe(1);
    expect(d.same).toBe(1);
    expect(unmeasuredCounts(side)).toEqual({ total: 1, toolchain: 0, build: 1 });
  });
});

describe('the record carries its INPUT, not only its output', () => {
  it('reads a changed dataset row as a changed input rather than a changed decompiler', async () => {
    // MEASURED DEFECT, and the reason `asm`/`opts` are fields at all: `collect` loads the tree
    // under test's OWN dataset and harness, so the base side lifts the BASE tree's rows. Changing
    // one string in `dataset/synthetic.ts` — and no line of `packages/` — moved 6 records, every
    // one of them reading as a decompiler change. `baseOnly`/`headOnly` catches a row that appears
    // or vanishes; a row whose INPUT moved under a stable id was invisible.
    const b = [rec({ id: 'synthetic:mini:agbcc', arm: 'harness', asm: 'aaaaaaaaaaaa', opts: 'oooooooooooo' })];
    const h = [
      rec({
        id: 'synthetic:mini:agbcc',
        arm: 'harness',
        asm: 'bbbbbbbbbbbb',
        opts: 'oooooooooooo',
        src: 'zzzzzzzzzzzz',
      }),
    ];
    const line = renderDiff(compareSweeps(b, h))[0];
    expect(line).toContain('asm aaaaaaaaaaaa -> bbbbbbbbbbbb');
    expect(line.indexOf('asm ')).toBeLessThan(line.indexOf('src '));
  });

  it('digests the option object without depending on key order, and ignores the compiler closure', () => {
    // `rankOptionsFor` builds its result by conditional spread, so the key ORDER is a property of
    // which options exist and not of their values; and `compile` is a closure that cannot be
    // compared across two processes at all.
    const a = optsDigest({ symbols: { a: 1, b: 2 }, compile: () => 'x' });
    const b = optsDigest({ compile: () => 'y', symbols: { b: 2, a: 1 } });
    expect(a).toBe(b);
    expect(optsDigest({ symbols: { a: 1 } })).not.toBe(a);
    // and an option that APPEARS is a move: a row that gains a symbol map lifts differently
    expect(optsDigest({})).not.toBe(optsDigest({ symbols: {} }));
  });
});

describe('the two arms', () => {
  it('asks for two DIFFERENT computations when the row has a symbol map', () => {
    // THE ABLATION THIS PINS: `key: 'nomap'` for both arms collapses them onto one computation and
    // makes the sweep blind to every symbol-map change — half of what the arms exist for, and the
    // half that covers most naming and global-recovery work. The arms genuinely differ on 25 of 42
    // `kleod` rows, so this is not a theoretical distinction.
    const seen: boolean[] = [];
    const armed = armsFor(['harness', 'nomap'], true, (withMap) => {
      seen.push(withMap);
      return withMap ? { symbols: {} } : {};
    });
    expect(armed.map((a) => a.key)).toEqual(['harness', 'nomap']);
    expect(seen).toEqual([true, false]);
    expect(armed[0].opts).not.toEqual(armed[1].opts);
  });

  it('asks for ONE computation when the row has no map, and still reports it under both names', () => {
    // 810 of the 1,062 rows are synthetic and almost none carries a map, so lifting them twice
    // would double the only expensive part of the command. The record set stays rectangular.
    const seen: boolean[] = [];
    const armed = armsFor(['harness', 'nomap'], false, (withMap) => {
      seen.push(withMap);
      return {};
    });
    expect(armed.map((a) => a.arm)).toEqual(['harness', 'nomap']);
    expect(armed.map((a) => a.key)).toEqual(['nomap', 'nomap']);
    expect(seen).toEqual([false]);
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

  it('refuses --compare beside --json, which it silently ignored', () => {
    expect(sweepRefusal({ ...ok, compare: ['a.json', 'b.json'], json: 'out.json' })).toContain('nothing for --json');
  });

  it('refuses a repeated arm instead of collapsing it in the diff Map', () => {
    expect(sweepRefusal({ ...ok, arms: ['harness', 'harness'] })).toContain('at most once');
  });

  it('refuses an unknown --toolchain by name instead of throwing a node stack on exit 1', () => {
    // Exit 1 is this command's "rows moved" code, so a crash landing there is a wrong ANSWER, not
    // just an ugly one: `--asm-dir <dir> --toolchain nosuch` threw out of the driver.
    const r = sweepRefusal({ ...ok, asmDir: '/tmp', toolchain: 'nosuch' });
    expect(r).toContain('unknown --toolchain');
    expect(r).toContain('agbcc');
  });

  it('refuses an --asm-dir that does not exist', () => {
    expect(sweepRefusal({ ...ok, asmDir: '/definitely/no/such/dir', toolchain: 'agbcc' })).toContain('does not exist');
  });

  it('refuses --fan over --asm-dir, where the size guard cannot reach', () => {
    // `SWEEP_FAN_LIMIT` is read off the committed artifact's `candidateCount`, which exists for
    // DATASET ROWS ONLY — so in `--asm-dir` mode the guard is structurally unreachable, and the
    // population this flag exists to sweep (`checkouts/<project>/asm/nonmatchings`) is where the
    // five-hour functions live. Measured: one 1.6 KB klonoa `.s` alone in a directory had not
    // finished enumerating at 120 s, and the only line printed named a DATASET row that
    // invocation never iterated.
    expect(sweepRefusal({ ...ok, asmDir: '/tmp', toolchain: 'agbcc', fan: true })).toContain('no size guard');
    expect(sweepRefusal({ ...ok, asmDir: '/tmp', toolchain: 'agbcc', fan: true, force: true })).toBeUndefined();
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

describe('a sweep that measured nothing is not a clean bill of health', () => {
  it('exits 2 on an empty selection, and on a selection it could not lift', async () => {
    // MEASURED DEFECTS, both. `bench sweep --base main && echo clean` is the gate this command is
    // for. A typo'd `--only zzz-no-such-row` printed `0 record(s) over 0 row(s)` and exited 0; a
    // shell with `ASMLIFT_AGBCC` unset printed `618 identical` over rows nobody lifted and exited
    // 0. `run/gate-census.ts` refuses the first condition at exit 2 already.
    const { sweep } = await import('../src/run/sweep');
    const driver = await import('../src/run/sweep-driver');
    const spy = vi.spyOn(driver, 'collect');
    try {
      spy.mockResolvedValue([]);
      expect(await sweep({ tiers: ['synthetic'], arms: ['harness'], only: 'zzz-no-such-row' })).toBe(2);

      spy.mockResolvedValue([{ id: 'synthetic:a:mwcc_242_81', arm: 'harness', skipped: 'toolchain' }]);
      expect(await sweep({ tiers: ['synthetic'], arms: ['harness'] })).toBe(2);
      // and the machine that genuinely lacks a toolchain (mwcc needs Docker) can still ask
      expect(await sweep({ tiers: ['synthetic'], arms: ['harness'], allowUnmeasured: true })).toBe(0);
    } finally {
      spy.mockRestore();
    }
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
