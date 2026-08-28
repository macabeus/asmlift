// THE GATE for a class the harness had no check for: a row telling one decompiler something its
// own reference source contradicts, and then scoring the decompiler down for obeying it. What a
// contradiction looks like and what the oracle is worth are stated once, in
// `src/cases/authored-facts.ts`; this file is where CI reads the answer.
//
// It is the pre-existing `real-manifests.test.ts` policy suite's missing half: that one asks
// whether a manifest is well-FORMED and portable, this one whether what it SAYS is true.
//
// The provisioning asymmetry this file used to record as KNOWN-UNCOVERED — asmlift with a symbol
// map on all 252 real rows against m2c with a `--context` on 112 — was settled as a POLICY: every
// real row now carries either `m2cCtx` (the project's vendored context) or a hand-written `ctx`.
// `no real row is left without an m2c context` below pins that. It is a policy pin, not a
// contradiction check — what each tool SHOULD be given is not mechanically decidable, and the
// README names the asymmetries that remain, in both directions.
//
// What IS checked as a contradiction: where a row hand-writes a `ctx`, the callees it names to
// m2c and to asmlift must be the same set; and the line appended to a vendored context must be
// derivable from `proto` — the field asmlift reads — rather than from the reference source.
//
// CI runs this: `.github/workflows/ci.yml` → `pnpm exec vitest run apps/benchmark/test`. It is
// toolchain-free (JSON + gzip only) and in no `bench` command, deliberately — a dataset lie must
// fail on a hosted runner with no compilers, not only where someone can run the benchmark.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import { SYNTHETIC } from '../dataset/synthetic';
import {
  ATTRIBUTE_MACROS,
  UNVERIFIABLE_CALLEE_PROTOS,
  authoredFactProblems,
  declarationsOf,
  declaredFunctionNames,
  oracleFor,
  protoFactProblems,
  quotedSignature,
} from '../src/cases/authored-facts';
import { REAL_DIR, type RealManifest } from '../src/cases/manifests';
import { m2cOwnPrototype } from '../src/cases/real';

const files = readdirSync(REAL_DIR).filter((f) => f.endsWith('.json'));

/** The vendored preprocessed TU of every function in one manifest. */
function vendoredTUs(man: RealManifest): Map<string, string> {
  const dir = join(REAL_DIR, 'tu', man.project);
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Record<
    string,
    { tu: string; ctx: string }
  >;
  return new Map(
    man.functions.map((fn) => [fn.sym, gunzipSync(readFileSync(join(dir, index[fn.sym].tu))).toString('utf8')]),
  );
}

const manifests = files.map((f) => ({
  file: f,
  man: JSON.parse(readFileSync(join(REAL_DIR, f), 'utf8')) as RealManifest,
}));

describe('every authored fact agrees with the function the compiler actually saw', () => {
  test('there are manifests to police', () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  for (const { file, man } of manifests) {
    test(`${file}: proto and funcC agree with the vendored TU`, () => {
      const tus = vendoredTUs(man);
      const problems = man.functions.flatMap((fn) => authoredFactProblems(man.project, fn, tus.get(fn.sym)!));
      expect(problems).toEqual([]);
    }, 30_000);
  }

  // The oracle has to actually resolve, or the suite above passes by checking nothing. Stated per
  // row rather than as a row COUNT: adding a benchmark row is the routine operation here, and a
  // gate that answers a correct new row with `expected 253 to be 252` gets deleted, not read.
  test('the oracle resolves for every row', () => {
    const unchecked = manifests.flatMap(({ man }) => {
      const tus = vendoredTUs(man);
      return man.functions
        .filter(
          (fn) => quotedSignature(fn.funcC) === null || typeof oracleFor('', fn.sym, tus.get(fn.sym)!) === 'string',
        )
        .map((fn) => `${man.project}:${fn.sym}`);
    });
    expect(unchecked).toEqual([]);
    expect(manifests.flatMap(({ man }) => man.functions).length).toBeGreaterThan(200);
  }, 30_000);

  // The policy pin. Not a contradiction check — it is the round that gave the 140 context-free
  // rows the project's own context, written down so the next row cannot quietly re-open the gap.
  // It names the offending rows rather than asserting a count, so a correct new row is a
  // one-word fix and not a reason to delete the gate.
  test('no real row is left without an m2c context', () => {
    const bare = manifests.flatMap(({ man }) =>
      man.functions.filter((fn) => !fn.m2cCtx && fn.ctx === undefined).map((fn) => `${man.project}:${fn.sym}`),
    );
    expect(bare).toEqual([]);
  });

  // The inventory of facts this cannot adjudicate must not rot: a callee the TU now declares is a
  // fact with an oracle, and leaving it listed would mute a check that works.
  test('every UNVERIFIABLE_CALLEE_PROTOS entry is still unverifiable, and still exists', () => {
    const stale: string[] = [];
    for (const key of UNVERIFIABLE_CALLEE_PROTOS.keys()) {
      const [project, sym, callee] = key.split(':');
      const entry = manifests.find(({ man }) => man.project === project);
      const fn = entry?.man.functions.find((f) => f.sym === sym);
      if (!fn?.proto?.[callee]) {
        stale.push(`${key}: no such callee proto any more — drop the entry`);
        continue;
      }
      const tu = vendoredTUs(entry!.man).get(sym)!;
      if (declarationsOf(tu, callee).length > 0 || declarationsOf(fn.ctx ?? '', callee).length > 0) {
        stale.push(`${key}: the row now declares it — drop the entry and let the row's own text answer`);
      }
    }
    expect(stale).toEqual([]);
  }, 30_000);
});

describe('the prototype line appended to a vendored m2c context', () => {
  /** The vendored CONTEXT blob of every function in one manifest (the `--context` m2c is given,
   *  before the prototype line). */
  function vendoredCtxs(man: RealManifest): Map<string, string> {
    const dir = join(REAL_DIR, 'tu', man.project);
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Record<
      string,
      { tu: string; ctx: string }
    >;
    return new Map(
      man.functions.map((fn) => [fn.sym, gunzipSync(readFileSync(join(dir, index[fn.sym].ctx))).toString('utf8')]),
    );
  }

  const lines = manifests.flatMap(({ man }) => {
    const ctxs = vendoredCtxs(man);
    return man.functions
      .filter((fn) => fn.m2cCtx)
      .map((fn) => ({
        where: `${man.project}:${fn.sym}`,
        fn,
        ctx: ctxs.get(fn.sym)!,
        line: m2cOwnPrototype(fn.sym, fn.proto, ctxs.get(fn.sym)!),
      }));
  });

  test('there are vendored-context rows to police', () => {
    expect(lines.length).toBeGreaterThan(200);
  });

  // THE LEAKAGE GATE. It used to be reconstructed from `funcC` — the answer — while core's
  // `asIfUndecompiled` stripped the same fact from asmlift's symbol map. A parameter NAME is the
  // cheapest proof that reference text reached m2c: `proto` has no names to give.
  test('no prototype line carries an identifier from the reference source', () => {
    const leaks = lines
      .filter(({ line }) => line !== null)
      .flatMap(({ where, fn, line }) => {
        const head = fn.funcC.slice(0, fn.funcC.indexOf('{'));
        const names = new Set((head.match(/\b[A-Za-z_]\w*\b/g) ?? []).filter((n) => n !== fn.sym));
        const declared = new Set(
          (Array.isArray(fn.proto?.[fn.sym]?.params) ? (fn.proto[fn.sym].params as string[]) : []).flatMap(
            (t) => t.match(/\b[A-Za-z_]\w*\b/g) ?? [],
          ),
        );
        return (line!.match(/\b[A-Za-z_]\w*\b/g) ?? [])
          .filter((w) => w !== 'void' && w !== fn.sym && !declared.has(w) && names.has(w))
          .map((w) => `${where}: \`${w}\` reached m2c from the reference signature`);
      });
    expect(leaks).toEqual([]);
  });

  // m2c's `--context` runs a real C parser: an unexpanded attribute macro is `Syntax error when
  // parsing C context` and the whole row becomes `failed`. `proto` param types are authored, so
  // one can still arrive that way.
  test('no prototype line carries an attribute macro', () => {
    const bad = lines
      .filter(({ line }) => line && [...ATTRIBUTE_MACROS].some((m) => new RegExp(`\\b${m}\\b`).test(line)))
      .map(({ where, line }) => `${where}: ${line}`);
    expect(bad).toEqual([]);
  });

  // The published repro script rebuilds ctx.h as `gunzip > ctx.h` then a heredoc `>>`. The
  // harness builds the same file in memory. They are byte-identical only because every blob ends
  // in a newline — `bench fidelity` compares m2c's OUTPUT, so it cannot see a divergence here.
  test('every vendored context blob ends in a newline', () => {
    const bad = lines.filter(({ ctx }) => !ctx.endsWith('\n')).map(({ where }) => where);
    expect(bad).toEqual([]);
  });

  // A row whose headers already declare it gets nothing appended, and must not: a second
  // declaration is where a conflicting return type would come from.
  test('a row the vendored context declares gets no appended line', () => {
    const bad = lines
      .filter(({ fn, ctx, line }) => line !== null && new RegExp(`\\b${fn.sym}\\s*\\(`).test(ctx))
      .map(({ where }) => where);
    expect(bad).toEqual([]);
  });
});

// A callee declared to one decompiler and not the other is an information asymmetry, and it is
// only answerable where the declaration was AUTHORED for the row: a hand-written `ctx` on the real
// tier, and every synthetic spec (whose `src` IS the compiler's input, so it is its own oracle).
// The vendored `m2cCtx` blob is out of scope by construction — it is a whole project's headers,
// not a per-row claim about what a callee looks like.
const symmetryProblems = (where: string, ctx: string, protoKeys: string[], sym: string): string[] => {
  const inCtx = declaredFunctionNames(ctx).filter((n) => n !== sym);
  const inProto = protoKeys.filter((n) => n !== sym);
  return [
    ...inCtx.filter((n) => !inProto.includes(n)).map((n) => `${where}: m2c is told about \`${n}\`, asmlift is not`),
    ...inProto.filter((n) => !inCtx.includes(n)).map((n) => `${where}: asmlift is told about \`${n}\`, m2c is not`),
  ];
};

describe('neither decompiler is told a callee the other is not', () => {
  test('every real row with a hand-written ctx declares the same callees to both', () => {
    const asymmetric = manifests.flatMap(({ man }) =>
      man.functions
        .filter((fn) => fn.ctx)
        .flatMap((fn) => symmetryProblems(`${man.project}:${fn.sym}`, fn.ctx!, Object.keys(fn.proto ?? {}), fn.sym)),
    );
    expect(asymmetric).toEqual([]);
  });

  test('every synthetic spec declares the same callees to both', () => {
    const asymmetric = SYNTHETIC.flatMap((s) =>
      symmetryProblems(`synthetic:${s.sym}`, s.ctx ?? '', Object.keys(s.proto ?? {}), s.sym),
    );
    expect(asymmetric).toEqual([]);
  });
});

// The synthetic tier's `src` is compiled as written, so it is its own oracle and the same check
// applies with no vendoring. Read UNpreprocessed, which is fine for what it is asked (38 specs do
// carry a `#define`, none of them in a signature) and is the same limit ATTRIBUTE_MACROS names on
// the real tier. What this buys is that the next hand-written spec cannot quietly declare a
// void-ness its source refutes, which on the real tier cost a match before anything looked.
describe('the synthetic tier declares nothing its own source refutes', () => {
  test('every synthetic proto agrees with its src', () => {
    const problems = SYNTHETIC.flatMap((s) =>
      protoFactProblems(`synthetic:${s.sym}`, s.sym, s.proto, s.src, s.ctx ?? ''),
    );
    expect(problems).toEqual([]);
  });

  test('every synthetic src yields exactly one definition of its symbol', () => {
    const noOracle = SYNTHETIC.filter((s) => typeof oracleFor('', s.sym, s.src) === 'string').map((s) => s.sym);
    expect(noOracle).toEqual([]);
    expect(SYNTHETIC.length).toBeGreaterThan(200);
  });
});
