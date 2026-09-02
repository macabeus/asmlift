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
import { renderDeclarations } from '@asmlift/core/declare';
import { arrayInnerExtents, declaredFields } from '@asmlift/core/symbols';
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
import { syntheticCases } from '../src/cases/synthetic';

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

  // THE ONE PLACE a signature fact still reaches m2c and not asmlift, pinned by NAME so it cannot
  // grow quietly. A manifest's `prependC` sometimes has to forward-declare the function for the
  // reference to compile standalone, and m2c can read it. Closing it would mean re-vendoring the
  // blob asmlift's candidate scorer also compiles against, so it is DISCLOSED (README residual 4)
  // rather than removed — measured at 3 of 8 rows changing m2c's output and 0 matches either way.
  test('only the known rows have their own signature declared by their prependC', () => {
    const self = lines
      .filter(({ fn }) => fn.prependC && new RegExp(`\\b${fn.sym}\\s*\\(`).test(fn.prependC))
      .map(({ where }) => where)
      .sort();
    expect(self).toEqual(
      [
        'kleod:ConfigureEntityBehavior',
        'kleod:CountCollectedGems',
        'kleod:IsSelectButtonPressed',
        'kleod:ProcessInputAndUpdateEntities',
        'kleod:SetupBG3WindowOverlay',
        'kleod:UpdateWorldMapNodeAnim',
        'kleod:VBlankDMA_Level2',
        'pokeemerald:AcroBikeHandleInputTurning',
      ].sort(),
    );
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

// ── An authored SYMBOL MAP is an authored fact, and gets an authored fact's gate ──────────────
//
// `SynthSpec.symbols` carries the six zero-row-family rows and is strictly MORE expressive than
// `proto`, the channel whose absence of a gate once cost a real row its match (a manifest
// declaring `returnsVoid: true` for a function whose own reference returns `void *`). A map states
// member offsets, bitfield bit offsets, pointee widths and array rank — and the rows that carry
// one exist precisely to defend the axes those facts enumerate, so a map that quietly disagreed
// with its own source would flatter exactly what it was authored to measure.
//
// TWO THINGS ARE CHECKED, and neither is a restatement of the other.
//
// SYMMETRY — every FACT the map declares to asmlift must also reach m2c. The map is asmlift-only
// input (`Case.symbols`; m2c's analogue is `ctx`), so `src/cases/synthetic.ts` renders it into the
// ctx and this asserts the rendering actually happened. It is the same class the callee check
// above covers and the class PR #119 corrected on the real tier, on a channel that check cannot
// see: `declaredFunctionNames` reads FUNCTION names, so a struct layout added to one side alone is
// invisible to it. Measured: told only its prototype, m2c emits `extern ? gBgTilemapBufs;` on
// `sbscope` and the row publishes a DECLINE.
//
// FACT, not SYMBOL, because a symbol-level check is defeated in one line: match `\b<name>\b`
// against the ctx and degrading the renderer's input to core's documented name-only exception
// leaves it green while the ctx becomes `extern u32 gPacked;` — the whole layout gone from m2c and
// kept for asmlift, which is PR #119's asymmetry reopened inside the fix for it. Three tests carry
// the FACT-level check instead, and each was shown to fire.
//
// AGREEMENT WITH THE ROW'S OWN SOURCE — the synthetic tier's `src` IS the compiler's input, so it
// is the oracle here exactly as it is for `proto` above. Checked by NAME (every symbol and every
// member the map declares must be spelled in the source that defines them) and by internal
// CONSISTENCY (a member cannot lie outside the size it is declared in, a bitfield cannot span past
// its container, a pointee width must be one a load can have).
//
// WHAT THIS DOES NOT CHECK, stated so the next reader does not over-trust it: it does not compile
// anything, so it cannot catch a map whose OFFSETS are self-consistent and still wrong for the
// struct the source declares — a `dreamStones` moved from bit 5 to bit 6 passes here. That is a
// compiled question and it belongs to a toolchain-bound suite, not to a hosted runner with no
// compilers. It also does not check an array's OUTERMOST extent, which `declare.ts` leaves unsized
// by design and which therefore reaches asmlift and not the ctx text — measured on `sbscope` to
// leave m2c's output byte-identical either way, so it is disclosed rather than gated. What it does
// catch is the map pointing at a different symbol, a different member, or a shape no C declaration
// could have — and now, a fact that reaches one channel and not the other.
describe('an authored symbol map agrees with its own row', () => {
  const mapped = SYNTHETIC.filter((s) => s.symbols);

  test('the map channel is CONNECTED — some row carries one', () => {
    // Before asserting anything about maps, prove there are maps: every check below is vacuously
    // green over an empty list, which reads identically to "nothing is wrong".
    expect(mapped.length).toBeGreaterThan(0);
  });

  // SYMMETRY, LAYER 1 — CHANNEL IDENTITY. The ctx must contain the declaration block the map
  // renders to, byte for byte, and the block is re-derived HERE from `c.symbols` rather than
  // asked of the production helper: a gate that calls the same function the call site calls
  // cannot see the call site hand it worse input. THE NAME IS NOT THE FACT, and that is measured:
  // a check asserting only that each symbol's NAME appears somewhere in the ctx stays green under
  // a renderer input degraded to `{name, kind, declared}` — core's documented name-only exception
  // — while the ctx becomes `extern u32 gPacked;` / `extern u32 gBgTilemapBufs;` /
  // `extern u32 gBgPtrs;`: struct layout, bitfield bit offsets, pointee width and array rank all
  // present for asmlift and gone for m2c. Under that degradation `ptrelem` emits
  // `(gBgPtrs + (i * 2))->unk13A` — verbatim the map-less output the map channel exists to
  // dissolve — and `sbscope` goes from nonmatch to noncompile.
  test("the m2c ctx carries the map's rendered declarations verbatim", () => {
    const cases = syntheticCases().filter((c) => c.symbols);
    expect(cases.length).toBe(mapped.reduce((n, s) => n + s.toolchains.length, 0));
    const missing = cases
      .filter((c) => {
        const block = renderDeclarations([...c.symbols!.values()].flat().map((info) => ({ name: info.name, info })));
        return !(c.ctx ?? '').includes(block);
      })
      .map((c) => `${c.id}: the ctx does not contain the declaration block its own map renders to`);
    expect(missing).toEqual([]);
  });

  // SYMMETRY, LAYER 2 — THE FACTS THEMSELVES, read off the map and looked for in the ctx TEXT.
  // Layer 1 is defeated the moment the renderer itself loses a fact, because both sides then
  // render the same loss; this layer does not go through the renderer at all. It is what catches
  // a member that never reaches the declaration: give a map two bitfields overlapping at one
  // offset and `declaredFields` keeps the first view and drops the alias, so the second member
  // vanishes from the struct with no error anywhere.
  //
  // THE ONE FACT DELIBERATELY NOT CHECKED, so its absence is a decision and not an oversight: an
  // array's OUTERMOST extent. `declare.ts` leaves it unsized on purpose (`u16 g[][1024]`) — it is
  // the extent C lets a declaration omit, and omitting it keeps the synthesized decl compatible
  // with a project's real one whatever its size. So `sbscope`'s `dims: [4, 1024]` reaches asmlift
  // whole and reaches m2c as the inner `[1024]` alone. Measured rather than waved past: rendering
  // that ctx with `[4][1024]` substituted leaves m2c's output BYTE-IDENTICAL on that row, so the
  // residual is disclosed and costs nothing today — it is not a fact m2c is denied the use of.
  test('every fact a map declares — symbol, member, inner extent — is spelled in the m2c ctx', () => {
    const problems = syntheticCases()
      .filter((c) => c.symbols)
      .flatMap((c) => {
        const ctx = c.ctx ?? '';
        const spelled = (w: string): boolean => new RegExp(`\\b${w}\\b`).test(ctx);
        return [...c.symbols!.values()]
          .flat()
          .flatMap((info) => [
            ...(spelled(info.name) ? [] : [`${c.id}: map declares \`${info.name}\`, the m2c ctx does not`]),
            ...[...(info.layout ?? []), ...(info.pointee?.layout ?? [])]
              .filter((f) => !spelled(f.name))
              .map((f) => `${c.id}: map declares member \`${info.name}.${f.name}\`, the m2c ctx does not`),
            ...(arrayInnerExtents(info) ?? [])
              .filter((d) => !new RegExp(`\\[\\s*${d}\\s*\\]`).test(ctx))
              .map((d) => `${c.id}: map declares inner extent [${d}] of \`${info.name}\`, the m2c ctx does not`),
          ]);
      });
    expect(problems).toEqual([]);
  });

  // AND THE SAME LOSS, ATTRIBUTED. The check above says a member is missing from one channel; this
  // one says why, and it is the more accurate charge: `declaredFields` is the SHARED predicate —
  // core's access rules gate on the same call the declaration renderer does — so a member it drops
  // is a member NEITHER decompiler can name. That is not an asymmetry, it is an authored map the
  // row cannot mean, and a synthetic map is hand-written so there is no excuse for authoring one.
  // (A real project's map may legitimately carry union aliases; this rule is for authored data.)
  test('every member an authored map declares survives the shared declaration predicate', () => {
    const problems = mapped.flatMap((s) =>
      [...s.symbols!.values()].flat().flatMap((info) =>
        [[info.name, info.layout] as const, [`${info.name}'s pointee`, info.pointee?.layout] as const].flatMap(
          ([where, layout]) => {
            if (layout === undefined) {
              return [];
            }
            const kept = new Set((declaredFields(layout) ?? []).map((f) => f.name));
            return layout
              .filter((f) => !kept.has(f.name))
              .map((f) => `${s.sym}: ${where} declares \`${f.name}\`, which the declaration renderer drops`);
          },
        ),
      ),
    );
    expect(problems).toEqual([]);
  });

  test("every map names only symbols and members its row's own src spells", () => {
    const problems = mapped.flatMap((s) =>
      [...s.symbols!.values()]
        .flat()
        .flatMap((info) => [
          ...(new RegExp(`\\b${info.name}\\b`).test(s.src)
            ? []
            : [`${s.sym}: map declares \`${info.name}\`, src does not`]),
          ...[...(info.layout ?? []), ...(info.pointee?.layout ?? [])]
            .filter((f) => !new RegExp(`\\b${f.name}\\b`).test(s.src))
            .map((f) => `${s.sym}: map declares member \`${info.name}.${f.name}\`, src does not`),
        ]),
    );
    expect(problems).toEqual([]);
  });

  test('every map is internally consistent — no member outside its object, no bitfield past its unit', () => {
    const problems = mapped.flatMap((s) =>
      [...s.symbols!.values()].flat().flatMap((info) => {
        const where = `${s.sym}:${info.name}`;
        return [
          ...(info.dims ?? [])
            .filter((d) => d !== null && !(Number.isInteger(d) && d > 0))
            .map((d) => `${where}: array extent ${d} is not a positive integer`),
          ...[...(info.layout ?? []), ...(info.pointee?.layout ?? [])].flatMap((f) => {
            const at = `${where}.${f.name}`;
            const out: string[] = [];
            if (f.size !== null && info.size !== undefined && f.offset + f.size > info.size) {
              out.push(`${at}: ends at ${f.offset + f.size}, past the declared size ${info.size}`);
            }
            if (f.bitWidth !== undefined) {
              // A bitfield's bit offset is stated RELATIVE TO ITS OWN BYTE OFFSET, so the unit it
              // must fit inside is the member's own `size` — the same convention the fold reads
              // (`f.offset * 8 + f.bitOffset`), which is why a `bitOffset` big enough to leave it
              // is not a tighter style rule but a member the fold would seat in the wrong word.
              const unit = (f.size ?? 4) * 8;
              if (f.bitWidth < 1 || (f.bitOffset ?? 0) < 0 || (f.bitOffset ?? 0) + f.bitWidth > unit) {
                out.push(`${at}: bits [${f.bitOffset ?? 0}, +${f.bitWidth}) do not fit its ${unit}-bit unit`);
              }
            }
            if (f.pointer && f.pointeeSize !== undefined && ![1, 2, 4].includes(f.pointeeSize)) {
              out.push(`${at}: pointee width ${f.pointeeSize} is not a width a load has`);
            }
            return out;
          }),
        ];
      }),
    );
    expect(problems).toEqual([]);
  });
});
