// THE GATE for a class the harness had no check for: a row telling one decompiler something its
// own reference source contradicts, and then scoring the decompiler down for obeying it.
//
// It ran uncaught in the published dataset. marioparty3:func_80056254_56E54 carried
// `"returnsVoid": true` four lines under `void *func_80056254_56E54(…) { return (*arg0)->unk0C; }`;
// asmlift honoured the declaration, emitted `return;`, and scored 2 — while m2c, which never reads
// `proto`, matched. Nothing in the harness compared the two fields, and the row published
// `quality 100` with no error marker, so the output looked like a wrong answer BY asmlift.
//
// This is the pre-existing `real-manifests.test.ts` policy suite's missing half: that one asks
// whether a manifest is well-FORMED and portable, this one whether what it SAYS is true. The
// oracle is the vendored preprocessed TU — the text the reference compiler saw AND the blob the
// row's target is compiled from — so a `proto` contradiction cannot be reconciled by moving
// `funcC`: that moves the target too, i.e. it decompiles a different function.
//
// KNOWN-UNCOVERED, deliberately: the provisioning asymmetry between the two tools. asmlift gets a
// symbol map on all 252 real rows; m2c gets a `--context` on 112 and nothing at all on 140. That
// is a benchmark POLICY question (what should each tool be given?), not a contradiction, and no
// mechanical check can settle it. What IS checked below is the per-row authored half: where a row
// hand-writes a `ctx`, the callees it names to m2c and the callees it names to asmlift must be the
// same set.
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
import { m2cFnPrototype } from '../src/cases/real';

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

describe('the prototype line handed to m2c is plain C', () => {
  // m2c's `--context` runs a real C parser: an unexpanded attribute macro in the return-type
  // position is `Syntax error when parsing C context` and the whole row becomes `failed`. The
  // hard-fail is real — pokeemerald:SetMauvilleOldManLanguage reproduces it the moment that row
  // is given a context — and it is invisible today only because that row has none.
  test('no manifest signature reaches m2c carrying an attribute macro', () => {
    const bad = manifests.flatMap(({ man }) =>
      man.functions
        .map((fn) => ({ where: `${man.project}:${fn.sym}`, line: m2cFnPrototype(fn.sym, fn.funcC) }))
        .filter(({ line }) => line && [...ATTRIBUTE_MACROS].some((m) => new RegExp(`\\b${m}\\b`).test(line)))
        .map(({ where, line }) => `${where}: ${line}`),
    );
    expect(bad).toEqual([]);
  });

  // A row that gets a context but no prototype line leaves m2c guessing the signature asmlift may
  // be handed outright. The ONE tolerated reason is a macro-wrapped name (`SA2_LABEL(sub_8083504)`),
  // which m2c's parser reads as K&R and rejects; any other row silently losing its prototype is a
  // defect, not a limitation.
  test('a context row without a prototype line has a macro-wrapped name', () => {
    const unexplained = manifests.flatMap(({ man }) =>
      man.functions
        .filter((fn) => (fn.m2cCtx || fn.ctx) && m2cFnPrototype(fn.sym, fn.funcC) === null)
        .filter((fn) => !/\)\s*\(/.test(fn.funcC.slice(0, fn.funcC.indexOf('{'))))
        .map((fn) => `${man.project}:${fn.sym}`),
    );
    expect(unexplained).toEqual([]);
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
