// Gates for the five questions a dataset AUDIT asks. Each is the mechanical half of one — the part
// a machine can decide; the judgement half stays with the reviewer, and is said so at each.
//
// Why here and not in `authored-facts.test.ts`: that file polices whether a row's authored facts
// agree with the function the compiler saw. These police the DATASET AS A WHOLE — one row against
// another, one channel against the other, and the vocabulary against the rows that carry it.
//
// Toolchain-free (the dataset sources plus the committed artifact), so CI runs it on a hosted
// runner with no compilers: `.github/workflows/ci.yml` → `pnpm exec vitest run apps/benchmark/test`.
import { FEATURES } from '@asmlift/bench-schema';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SYNTHETIC, SYNTHETIC_CPP } from '../dataset/synthetic';
import {
  declaredFunctionNames,
  matchParen,
  oracleFor,
  protoFactProblems,
  splitParams,
} from '../src/cases/authored-facts';
import { JUDGEMENT_FLOOR, stripLiterals } from '../src/cases/features';

const ALL_SPECS = [...SYNTHETIC, ...SYNTHETIC_CPP];

// ── 1. a callee named to asmlift is named to m2c ──────────────────────────────────────────────
//
// `proto` reaches asmlift and `ctx` reaches m2c; a callee in one and not the other is the worst
// defect an audit can find, in either direction. `authored-facts.test.ts` holds that for
// `SYNTHETIC`. The C++ specs are a SEPARATE export and no suite had ever read them, so the same
// rule is asserted here rather than assumed to have been inherited.
describe('a callee the dataset names to one decompiler is named to the other', () => {
  it('holds for the C++ specs, which are their own export', () => {
    expect(SYNTHETIC_CPP.length).toBeGreaterThan(0);
    const asymmetric = SYNTHETIC_CPP.flatMap((s) => {
      const declared = new Set(declaredFunctionNames(s.ctx ?? ''));
      const described = Object.keys(s.proto ?? {}).filter((n) => n !== s.sym);
      return [
        ...described
          .filter((n) => !declared.has(n))
          .map((n) => `synthetic:${s.sym}: proto describes '${n}', ctx does not declare it`),
        ...[...declared]
          .filter((n) => n !== s.sym && !described.includes(n))
          .map((n) => `synthetic:${s.sym}: ctx declares '${n}', proto does not describe it`),
      ];
    });
    expect(asymmetric).toEqual([]);
  });
});

// ── 2. a proto arity agrees with the row's own call sites ─────────────────────────────────────
//
// The dataset's own recorded gotcha: a `proto` entry is checked against the callee's DECLARATION
// and never against the arguments the row actually passes, so a wrong arity is invisible to every
// gate — and a `proto` arity is the fact asmlift lifts a call with. Both readings have to agree,
// or one of the two is wrong and no gate says which.
//
// Call sites only. A prototype `void *getbuf(s32 k);` is a DECLARATION, told apart by what
// precedes the name: a declarator head is type tokens and `*` and nothing else, where a call is
// preceded by an operator, a `(`, or nothing at all. The trailing `;` cannot do it — `p = getbuf(k);`
// ends in one too. `splitParams` is the same top-level-comma split the declaration side uses, so
// `f(g(a, b), c)` counts two arguments and not three.
describe("a proto's callee arity agrees with the row's own call sites", () => {
  const problems = ALL_SPECS.flatMap((s) => {
    const body = stripLiterals(s.src);
    return Object.entries(s.proto ?? {}).flatMap(([callee, entry]) => {
      if (callee === s.sym || entry.params === undefined) {
        return [];
      }
      const want = typeof entry.params === 'number' ? entry.params : entry.params.length;
      const out: string[] = [];
      for (const m of body.matchAll(new RegExp(`(?:^|[^\\w.>])${callee}\\s*\\(`, 'g'))) {
        const nameAt = m.index! + m[0].indexOf(callee);
        const open = body.indexOf('(', nameAt);
        const close = matchParen(body, open);
        const head = /(?:^|[;{}\n])([^;{}\n]*)$/.exec(body.slice(0, nameAt))?.[1] ?? '';
        const isDeclaration =
          /^\s*(?:(?:unsigned|signed|const|volatile|struct|union|enum|extern|static|inline)\s+)*[A-Za-z_]\w*[\s*]+$/.test(
            head,
          );
        if (close < 0 || isDeclaration) {
          continue; // unbalanced, or a declaration rather than a call
        }
        const got = splitParams(body.slice(open + 1, close)).length;
        if (got !== want) {
          out.push(`synthetic:${s.sym}: '${callee}(…)' is called with ${got} argument(s); proto declares ${want}`);
        }
      }
      return out;
    });
  });

  it('finds call sites at all', () => {
    // Or the gate passes loudest when the scan is broken.
    const withCallees = ALL_SPECS.filter((s) => Object.keys(s.proto ?? {}).some((n) => n !== s.sym));
    expect(withCallees.length).toBeGreaterThan(5);
  });

  it('agrees on every one', () => {
    expect(problems).toEqual([]);
  });
});

// ── 3. no row is another row alpha-renamed ────────────────────────────────────────────────────
//
// Two DIFFERENT symbols whose source differs only in naming, running on an overlapping toolchain,
// are one test run twice: no capability can tell them apart, and the pair inflates a family's
// count without adding evidence.
//
// NOT a duplicate, and why the toolchain check is there: one `sym` appears in several specs with
// DISJOINT toolchain lists and a platform-appropriate address (`dma_burst` at 0x040000d4 /
// 0xa4600000 / 0xcc006000). That is the dataset's deliberate way of running one shape across four
// toolchains, so the specs are folded by `sym` first and only distinct syms are compared.
//
// The canonical form renames every non-keyword identifier to its rank of first appearance, which
// is exactly the class this catches and no wider: a different constant, a different member offset
// or a different operator all survive it, so a CONTROL row that differs by one token is not a
// duplicate here — which is what keeps the gate from arguing with a family's own design.
describe('no synthetic row is another one alpha-renamed', () => {
  const KEYWORDS = new Set(
    (
      'auto break case char const continue default do double else enum extern float for goto if inline int long ' +
      'register return short signed sizeof static struct switch typedef union unsigned void volatile while ' +
      's8 u8 s16 u16 s32 u32 s64 u64 f32 f64 vu8 vu16 vu32 bool true false NULL'
    ).split(' '),
  );
  const canon = (src: string): string => {
    const seen = new Map<string, string>();
    return stripLiterals(src)
      .replace(/\s+/g, ' ')
      .replace(/\b[A-Za-z_]\w*\b/g, (w) => {
        if (KEYWORDS.has(w)) {
          return w;
        }
        if (!seen.has(w)) {
          seen.set(w, `#${seen.size}`);
        }
        return seen.get(w)!;
      });
  };

  const bySym = new Map<string, { toolchains: string[]; canon: string }>();
  for (const s of ALL_SPECS) {
    const prev = bySym.get(s.sym);
    if (prev) {
      prev.toolchains.push(...s.toolchains);
    } else {
      bySym.set(s.sym, { toolchains: [...s.toolchains], canon: canon(s.src) });
    }
  }

  it('has rows to compare', () => {
    expect(bySym.size).toBeGreaterThan(200);
  });

  it('finds no pair', () => {
    const groups = new Map<string, string[]>();
    for (const [sym, v] of bySym) {
      groups.set(v.canon, [...(groups.get(v.canon) ?? []), sym]);
    }
    const dupes: string[] = [];
    for (const syms of groups.values()) {
      for (let i = 0; i < syms.length; i++) {
        for (let j = i + 1; j < syms.length; j++) {
          const [a, b] = [bySym.get(syms[i])!, bySym.get(syms[j])!];
          const shared = a.toolchains.filter((t) => b.toolchains.includes(t));
          if (shared.length > 0) {
            dupes.push(
              `'${syms[i]}' and '${syms[j]}' differ only in naming and both run on ${shared.join(', ')} — ` +
                `no capability distinguishes them`,
            );
          }
        }
      }
    }
    expect(dupes).toEqual([]);
  });
});

// ── 4. the C++ specs are held to the C specs' rules ───────────────────────────────────────────
//
// `SYNTHETIC_CPP` is a second export, and every authored-fact gate reads `SYNTHETIC`, so nothing
// holds the C++ specs to those rules unless it names the second export. An `extern "C"` linkage
// specifier parsed into the return type — `"C" void` — is what a gate-less second export lets past.
describe('the C++ specs answer to the same authored-fact rules as the C ones', () => {
  it('each src yields exactly one definition of its symbol', () => {
    const noOracle = SYNTHETIC_CPP.filter((s) => typeof oracleFor('', s.sym, s.src) === 'string').map((s) => s.sym);
    expect(noOracle).toEqual([]);
  });

  it('each proto agrees with its own src', () => {
    const problems = SYNTHETIC_CPP.flatMap((s) =>
      protoFactProblems(`synthetic:${s.sym}`, s.sym, s.proto, s.src, s.ctx ?? ''),
    );
    expect(problems).toEqual([]);
  });
});

// ── 5. a definition demonstrates the tag it defines ───────────────────────────────────────────
//
// A FeatureDef's `example` is the vocabulary's own worked case, rendered to readers beside the
// tag. Where the tag has a NECESSARY floor, an example that fails it says the definition and the
// detector disagree about what the tag is — and the rows are held to the detector.
//
// Whether the example is a GOOD demonstration is a human call, as is whether `example.asm` is
// really what `example.toolchain` emits for `example.c`; only the floor is mechanical.
describe('every FeatureDef demonstrates the tag it defines', () => {
  const withExamples = FEATURES.filter((f) => f.example);

  it('there are examples to police', () => {
    expect(withExamples.length).toBeGreaterThan(20);
  });

  it("every example's C passes its own tag's floor", () => {
    const bad = withExamples
      .filter((f) => {
        const floor = JUDGEMENT_FLOOR[f.id];
        const c = stripLiterals(f.example!.c);
        return floor !== undefined && !floor(c, f.example!.asm ?? '', c);
      })
      .map((f) => `${f.id}: its own example.c fails JUDGEMENT_FLOOR['${f.id}']`);
    expect(bad).toEqual([]);
  });

  it('every example names a toolchain the dataset runs', () => {
    const known = new Set(ALL_SPECS.flatMap((s) => s.toolchains));
    const bad = withExamples
      .filter((f) => f.example!.toolchain && !known.has(f.example!.toolchain as never))
      .map((f) => `${f.id}: example.toolchain '${f.example!.toolchain}' is not a toolchain any row runs on`);
    expect(bad).toEqual([]);
  });
});

// ── 6. the dataset cites only rows that exist ─────────────────────────────────────────────────
//
// `project:sym[:toolchain]` is reserved for benchmark rows — it promises a `bench regression` can
// re-run the claim. `citations.test.ts` holds that for packages/ and docs/ and deliberately
// excludes the benchmark's own sources, which manipulate row ids as DATA. The dataset FILES are
// not that: they are prose, and a citation there promises a row `bench regression` can re-run.
// This scans the prose and leaves the code out.
describe('the dataset cites only benchmark rows that exist', () => {
  const DATASET = join(import.meta.dirname, '..', 'dataset');
  const rows = (
    JSON.parse(readFileSync(join(import.meta.dirname, '..', 'results', 'results.json'), 'utf8')) as {
      results: { id: string; project: string; sym: string }[];
    }
  ).results;
  const CITABLE = new Set(rows.flatMap((r) => [`${r.project}:${r.sym}`, r.id]));
  const PROJECTS = [...new Set(rows.map((r) => r.project))].sort();
  const CITATION = new RegExp(`\\b(${PROJECTS.join('|')}):[A-Za-z_]\\w*(?::[\\w.]+)?`, 'g');

  /** The dataset's authored sources. `tu/` is skipped: vendored preprocessed C, not prose. */
  const files = (function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'tu') {
          walk(p, out);
        }
      } else if (/\.(ts|json)$/.test(p)) {
        out.push(p);
      }
    }
    return out;
  })(DATASET);

  const found = files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((text, i) =>
        [...text.matchAll(CITATION)].map((m) => ({ file: file.slice(DATASET.length + 1), line: i + 1, cited: m[0] })),
      ),
  );

  it('finds citations at all', () => {
    expect(found.length).toBeGreaterThan(5);
  });

  it.each(found)('dataset/$file:$line cites $cited', ({ cited, file, line }) => {
    expect(
      CITABLE.has(cited),
      `dataset/${file}:${line} cites '${cited}', which is not a row in the committed results.json.\n` +
        `  Renamed? Update the citation. Not a benchmark row (a checkout function, a dogfooding\n` +
        `  find)? Write it in prose naming where to look, so the spelling stops promising a row.`,
    ).toBe(true);
  });
});
