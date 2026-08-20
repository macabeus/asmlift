// The `features` vocabulary is only worth something if it can be falsified. The vocabulary lives in
// @asmlift/bench-schema and the detectors in src/cases/features.ts; these assert that they and the
// dataset agree — published tags are defined, definitions are used and well-formed, derived tags
// match their evidence in both directions, and authored tags stay above their floor.
import { FEATURES, FEATURE_BY_ID, GROUP_ORDER, KNOWN_FEATURES, featuresByEvidence } from '@asmlift/bench-schema';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SYNTHETIC } from '../dataset/synthetic';
import {
  CODEGEN_DERIVED,
  JUDGEMENT_FLOOR,
  SOURCE_CHECKED,
  codegenEvidence,
  sourceEvidence,
  stripLiterals,
} from '../src/cases/features';

const REAL_DIR = join(import.meta.dirname, '..', 'dataset', 'real');
const RESULTS = join(import.meta.dirname, '..', 'results', 'results.json');

interface Fn {
  sym: string;
  features: string[];
  funcC: string;
}

const manifests = readdirSync(REAL_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(REAL_DIR, f), 'utf8')) as { project: string; functions: Fn[] });

const rows = (
  JSON.parse(readFileSync(RESULTS, 'utf8')).results as {
    id: string;
    project: string;
    sym: string;
    features: string[];
    targetAsm: string;
  }[]
).filter((r) => r.targetAsm);

/** Everything the dataset AUTHORS, real tier and synthetic tier alike. */
const authored = [
  ...manifests.flatMap((m) =>
    m.functions.map((fn) => ({ where: `${m.project}:${fn.sym}`, tags: fn.features, src: fn.funcC })),
  ),
  ...SYNTHETIC.map((s) => ({ where: `synthetic:${s.sym}`, tags: s.features, src: s.src })),
];

describe('the vocabulary is closed over the published data', () => {
  it('every published tag has a definition', () => {
    const undefined_ = new Set<string>();
    for (const r of rows) {
      for (const t of r.features) {
        if (!KNOWN_FEATURES.has(t)) undefined_.add(`${t} (e.g. ${r.id})`);
      }
    }
    expect([...undefined_].sort()).toEqual([]);
  });

  it('every definition is carried by at least one row', () => {
    const published = new Set(rows.flatMap((r) => r.features));
    const unused = FEATURES.filter((f) => !f.deprecated && !published.has(f.id)).map((f) => f.id);
    expect(unused.sort()).toEqual([]);
  });

  it('every AUTHORED tag has a definition', () => {
    const bad = authored
      .flatMap(({ where, tags }) => tags.filter((t) => !KNOWN_FEATURES.has(t)).map((t) => `${where} ${t}`))
      .sort();
    expect(bad).toEqual([]);
  });

  it('gives every row at least one tag', () => {
    expect(rows.filter((r) => r.features.length === 0).map((r) => r.id)).toEqual([]);
  });
});

describe('the definitions are well-formed', () => {
  it('ids are unique and kebab-case', () => {
    expect(FEATURES.length).toBe(KNOWN_FEATURES.size);
    expect(FEATURES.map((f) => f.id).filter((id) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))).toEqual([]);
  });

  it('every definition carries a label, a group and a non-empty summary', () => {
    const bad = FEATURES.filter((f) => !f.label.trim() || !f.summary.trim() || !GROUP_ORDER.includes(f.group)).map(
      (f) => f.id,
    );
    expect(bad).toEqual([]);
  });

  it('every seeAlso resolves to a real id', () => {
    const bad = FEATURES.flatMap((f) =>
      (f.seeAlso ?? []).filter((s) => !FEATURE_BY_ID.has(s)).map((s) => `${f.id} → ${s}`),
    );
    expect(bad.sort()).toEqual([]);
  });

  it('a codegen tag never claims to be checkable from the source, and vice versa', () => {
    // the detectors are keyed off `evidence`, so a mislabelled entry would silently stop being
    // checked rather than fail
    expect([...SOURCE_CHECKED].sort()).toEqual([
      'bitwise',
      'do-while',
      'goto',
      'loop',
      'nested-loop',
      'shift',
      'sizeof',
      'switch',
      'ternary',
    ]);
    expect([...CODEGEN_DERIVED].sort()).toEqual([
      'branchless',
      'call',
      'comparison-tree',
      'dma',
      'hw-div',
      'jump-table',
      'magic-div',
      'mmio',
      'soft-div',
      'strength-reduce',
    ]);
  });
});

describe('tags match their evidence', () => {
  it('authored data carries JUDGEMENT tags only (source and codegen are derived per row)', () => {
    const derived = new Set([...SOURCE_CHECKED, ...CODEGEN_DERIVED]);
    const bad = authored
      .flatMap(({ where, tags }) => tags.filter((t) => derived.has(t)).map((t) => `${where} authors ${t}`))
      .sort();
    expect(bad).toEqual([]);
  });

  it("publishes exactly the source tags each function's own C supports", () => {
    const srcOf = new Map(authored.map((a) => [a.where, a.src]));
    const bad: string[] = [];
    for (const r of rows) {
      const src = srcOf.get(`${r.project}:${r.sym}`);
      if (src === undefined) continue;
      const want = sourceEvidence(src);
      const got = new Set(r.features.filter((t) => SOURCE_CHECKED.has(t)));
      for (const t of want) if (!got.has(t)) bad.push(`${r.id} missing ${t}`);
      for (const t of got) if (!want.has(t)) bad.push(`${r.id} claims ${t}`);
    }
    expect(bad.sort()).toEqual([]);
  });

  it("publishes exactly the codegen tags each row's own assembly supports", () => {
    const srcOf = new Map(authored.map((a) => [a.where, a.src]));
    const bad: string[] = [];
    for (const r of rows) {
      const src = srcOf.get(`${r.project}:${r.sym}`);
      if (src === undefined) continue;
      const want = codegenEvidence(src, r.targetAsm);
      const got = new Set(r.features.filter((t) => CODEGEN_DERIVED.has(t)));
      for (const t of want) if (!got.has(t)) bad.push(`${r.id} missing ${t}`);
      for (const t of got) if (!want.has(t)) bad.push(`${r.id} claims ${t}`);
    }
    expect(bad.sort()).toEqual([]);
  });

  it('keeps every judgement tag above its floor', () => {
    // EVERY toolchain's assembly for the symbol: a tag defensible on the row that branches must
    // not be failed by the row the compiler made branchless.
    const asmOf = new Map<string, string>();
    for (const r of rows) {
      const k = `${r.project}:${r.sym}`;
      asmOf.set(k, (asmOf.get(k) ?? '') + '\n' + r.targetAsm);
    }
    const bad = authored
      .flatMap(({ where, tags, src }) => {
        const stripped = stripLiterals(src);
        const body = stripped.slice(stripped.indexOf('{'));
        const asm = asmOf.get(where) ?? '';
        return tags
          .filter((t) => JUDGEMENT_FLOOR[t] && !JUDGEMENT_FLOOR[t](body, asm, stripped))
          .map((t) => `${where} claims ${t}`);
      })
      .sort();
    expect(bad).toEqual([]);
  });

  it('every judgement tag with a floor is actually a judgement tag', () => {
    const judgement = new Set(featuresByEvidence('judgement').map((f) => f.id));
    expect(
      Object.keys(JUDGEMENT_FLOOR)
        .filter((k) => !judgement.has(k))
        .sort(),
    ).toEqual([]);
  });
});

describe('the detectors themselves', () => {
  const src = (c: string) => [...sourceEvidence(c)].sort();

  it('does not count `do { … } while (0)` as a loop', () => {
    expect(src('void f(void) { do { g(); } while (0); }')).toEqual([]);
    expect(src('void f(void) { do { g(); } while (n); }')).toEqual(['do-while', 'loop']);
  });

  it('sees a nested loop through a three-clause for header', () => {
    expect(src('void f(void){ for (i=0;i<5;i++) { for (j=0;j<7;j++) { g(); } } }')).toContain('nested-loop');
    expect(src('void f(void){ for (i=0;i<5;i++) { g(); } for (j=0;j<7;j++) { h(); } }')).not.toContain('nested-loop');
  });

  it('separates bitwise operators from address-of and short-circuits', () => {
    expect(src('void f(void){ g(&x); }')).toEqual([]);
    expect(src('void f(void){ if (a && b) g(); }')).toEqual([]);
    expect(src('void f(void){ y = a & 0xFF; }')).toEqual(['bitwise']);
  });

  it('ignores operators inside comments and string literals', () => {
    expect(src('void f(void){ /* a << b */ g("x ? y : z"); }')).toEqual([]);
  });

  const cg = (src: string, asm: string) => [...codegenEvidence(src, asm)].sort();

  it('reads a MIPS call rendered against the enclosing symbol in an unlinked object', () => {
    // objdump prints an unresolved external `jal` as `jal 0 <the function we are inside>`
    expect(cg('void f(void){g();}', '  38:\tjal\t0 <func_8005DF10_5EB10>')).toEqual(['call']);
  });

  it('tells the three ways a constant divide can compile apart', () => {
    const src = 'int f(int a){ return a/10; }';
    expect(cg(src, '\tbl\t__divsi3')).toEqual(['call', 'soft-div']);
    expect(cg(src, '  4:\tdiv\tzero,a0,at\n  8:\tmflo\tv0')).toEqual(['hw-div']);
    expect(cg(src, '  0:\tlui\tv0,0x6666\n  8:\tmult\ta0,v0\n  c:\tmfhi\tv1')).toEqual(['magic-div']);
    expect(cg(src, '  0:\tlis\tr4,26214\n  8:\tmulhw\tr0,r0,r3')).toEqual(['magic-div']);
  });

  it('separates a jump table from a comparison tree for the same switch', () => {
    const src = 'int f(int a){ switch(a){ case 0: return 1; default: return 0; } }';
    expect(cg(src, '\tmov\tpc, r0')).toEqual(['jump-table']);
    expect(cg(src, '  1c:\tjr\tt6')).toEqual(['jump-table']);
    expect(cg(src, '  18:\tmtctr   r0\n  1c:\tbctr')).toEqual(['jump-table']);
    expect(cg(src, '  0:\tbeqz\ta0,28 <f+0x28>')).toEqual(['comparison-tree']);
    // `jr ra` is a return, not a computed jump — this is still a comparison tree
    expect(cg(src, '  0:\tbeqz\ta0,28 <f+0x28>\n  8:\tjr\tra')).toEqual(['comparison-tree']);
  });

  it('calls a comparison branchless only when the compiler emitted no conditional branch', () => {
    const src = 'int f(int a){ return (a>0) - (a<0); }';
    expect(cg(src, '  4:\tslt\ta0,zero,a0\n  8:\tjr\tra')).toEqual(['branchless']);
    expect(cg(src, '\tble\t.L3\t@cond_branch')).toEqual([]);
    // `->` and shifts must not read as relational operators
    expect(cg('void f(S*p){ p->x = p->y >> 2; }', '\tldr\tr0, [r1]')).toEqual([]);
  });

  it('reports strength reduction only when the multiply actually disappeared', () => {
    const src = 'int f(int a){ return a*10; }';
    expect(cg(src, '\tlsl\tr0, r1, #0x2\n\tadd\tr0, r0, r1')).toEqual(['strength-reduce']);
    expect(cg(src, '  0:\tmulli   r3,r3,10')).toEqual([]);
  });

  it('holds judgement tags to a floor without pretending to decide them', () => {
    // rejects the fabrications …
    expect(JUDGEMENT_FLOOR.arithmetic('{ GwSystem.minigame_index = arg0; }', '')).toBe(false);
    expect(JUDGEMENT_FLOOR.array('{ return gPlayerAvatar.flags; }', '')).toBe(false);
    expect(JUDGEMENT_FLOOR.table('{ return gEntityInfo[0x23].unkF; }', '')).toBe(false);
    expect(JUDGEMENT_FLOOR.branch('{ s->a = 0; s->b = 0; }', '\tmov\tr0, #0')).toBe(false);
    // … and accepts the real thing
    expect(JUDGEMENT_FLOOR.arithmetic('{ return a * 10 + b; }', '')).toBe(true);
    expect(JUDGEMENT_FLOOR.table('{ return gSineDegreeTable[angleMod]; }', '')).toBe(true);
    expect(JUDGEMENT_FLOOR.cast('{ return (uintptr_t)(tgt - 1); }', '')).toBe(true);
    expect(JUDGEMENT_FLOOR.fnptr('{ f(); }', '  28:\tjalr\tv0')).toBe(true);
    // merge-chain wants MORE THAN ONE local for the arms to decide, initialised or not
    expect(JUDGEMENT_FLOOR['merge-chain']('{ int x; if (a) x = 1; else x = 2; return x; }', '')).toBe(false);
    expect(JUDGEMENT_FLOOR['merge-chain']('{ int x, y; return f(x, y); }', '')).toBe(false);
    expect(JUDGEMENT_FLOOR['merge-chain']('{ int x, y; if (a) { x = 1; y = 2; } return x + y; }', '')).toBe(true);
    expect(JUDGEMENT_FLOOR['merge-chain']('{ int x = 0, y = 0, i; if (a) x = y; return x; }', '')).toBe(true);
  });

  it('separates I/O registers from other hardware address ranges', () => {
    expect(cg('void f(void){}', '\t.word\t0x4000130')).toEqual(['mmio']);
    expect(cg('void f(void){}', '\t.word\t0x40000d4').sort()).toEqual(['dma', 'mmio']);
    expect(cg('void f(void){}', '\t.word\t0x5000000')).toEqual([]); // palette RAM
    expect(cg('void f(void){}', '\t.word\t0x3007ff8')).toEqual([]); // IWRAM
  });
});
