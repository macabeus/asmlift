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
// oracle is the vendored preprocessed TU — the exact text the reference compiler saw — so neither
// authored field can be reconciled by editing the other, and `funcC`, which DEFINES the target, is
// never the field that gets tuned.
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
  authoredFactProblems,
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

  // The oracle has to actually resolve, or the suite above passes by checking nothing.
  test('the oracle resolves for every row', () => {
    const checked = manifests.flatMap(({ man }) => {
      const tus = vendoredTUs(man);
      return man.functions.map((fn) => quotedSignature(fn.funcC) !== null && tus.get(fn.sym)!.includes(fn.sym));
    });
    expect(checked.length).toBe(252);
    expect(checked.filter((ok) => !ok)).toEqual([]);
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

// The synthetic tier authors 86 `proto` tables of its own, and its `src` IS the compiler's input —
// no headers, no macros — so it is its own oracle and the same check applies with no vendoring.
// It is clean today; what this buys is that the NEXT hand-written spec cannot quietly declare a
// void-ness its source refutes, which on the real tier cost a match before anything looked.
describe('the synthetic tier declares nothing its own source refutes', () => {
  test('every synthetic proto agrees with its src', () => {
    const problems = SYNTHETIC.flatMap((s) => protoFactProblems(`synthetic:${s.sym}`, s.sym, s.proto, s.src));
    expect(problems).toEqual([]);
  });

  test('every synthetic src yields exactly one definition of its symbol', () => {
    const noOracle = SYNTHETIC.filter((s) => typeof oracleFor('', s.sym, s.src) === 'string').map((s) => s.sym);
    expect(noOracle).toEqual([]);
    expect(SYNTHETIC.length).toBeGreaterThan(200);
  });

  // The dataset's own stated policy, in its header: "`ctx` is the m2c --context (prototypes only
  // — no struct layouts, so both decompilers must RECOVER structure); `proto` feeds asmlift the
  // SAME info". Unchecked, that is a comment. A callee declared to one decompiler and not the
  // other is an information asymmetry, and the round that hunts for those should not have to read
  // 220 specs to find one.
  test('a callee named in `ctx` for m2c has a `proto` entry for asmlift, and vice versa', () => {
    const asymmetric = SYNTHETIC.flatMap((s) => {
      const inCtx = [...(s.ctx ?? '').matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]).filter((n) => n !== s.sym);
      const inProto = Object.keys(s.proto ?? {}).filter((n) => n !== s.sym);
      return [
        ...inCtx
          .filter((n) => !inProto.includes(n))
          .map((n) => `synthetic:${s.sym}: m2c is told about \`${n}\`, asmlift is not`),
        ...inProto
          .filter((n) => !inCtx.includes(n))
          .map((n) => `synthetic:${s.sym}: asmlift is told about \`${n}\`, m2c is not`),
      ];
    });
    expect(asymmetric).toEqual([]);
  });
});
