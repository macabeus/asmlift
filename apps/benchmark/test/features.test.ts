// The `features` vocabulary is only worth something if it can be falsified. These tests do that
// for the machine-checkable half (see src/cases/features.ts): a tag must have evidence, and
// evidence must have a tag. The judgement half is deliberately not asserted — it is defined in
// prose there and reviewed by humans.
//
// Why this exists: an audit found ~20% of the real tier carrying a tag its function does not
// support — `bitfield` invented by a regex that matched ternaries, `soft-div` on a `/` that
// compiles to a shift, `call` on leaf functions, `loop` on straight-line bodies.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CODEGEN_DERIVED,
  JUDGEMENT_FLOOR,
  KNOWN_FEATURES,
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
const asmOf = new Map(rows.map((r) => [`${r.project}:${r.sym}`, r.targetAsm]));

const every = manifests.flatMap((m) => m.functions.map((fn) => ({ project: m.project, fn })));

describe('feature tags', () => {
  it('uses only the closed vocabulary (a typo must fail, not silently split an aggregate)', () => {
    const unknown = every
      .flatMap(({ project, fn }) =>
        fn.features.filter((t) => !KNOWN_FEATURES.has(t)).map((t) => `${project}:${fn.sym} ${t}`),
      )
      .sort();
    expect(unknown).toEqual([]);
  });

  it('never tags a source-level feature the function does not contain', () => {
    const checked = new Set(Object.keys(SOURCE_CHECKED));
    const bad = every
      .flatMap(({ project, fn }) => {
        const ev = sourceEvidence(fn.funcC);
        return fn.features.filter((t) => checked.has(t) && !ev.has(t)).map((t) => `${project}:${fn.sym} claims ${t}`);
      })
      .sort();
    expect(bad).toEqual([]);
  });

  it('never omits a source-level feature the function does contain', () => {
    const bad = every
      .flatMap(({ project, fn }) => {
        const have = new Set(fn.features);
        return [...sourceEvidence(fn.funcC)]
          .filter((t) => !have.has(t))
          .map((t) => `${project}:${fn.sym} missing ${t}`);
      })
      .sort();
    expect(bad).toEqual([]);
  });

  it('never AUTHORS a codegen tag — those are derived per row', () => {
    const derived = new Set(Object.keys(CODEGEN_DERIVED));
    const bad = every
      .flatMap(({ project, fn }) =>
        fn.features.filter((t) => derived.has(t)).map((t) => `${project}:${fn.sym} authors ${t}`),
      )
      .sort();
    expect(bad).toEqual([]);
  });

  it("publishes exactly the codegen tags each row's own assembly supports", () => {
    const bySym = new Map(every.map(({ project, fn }) => [`${project}:${fn.sym}`, fn]));
    const bad: string[] = [];
    for (const r of rows) {
      const fn = bySym.get(`${r.project}:${r.sym}`);
      if (!fn) continue;
      const want = codegenEvidence(fn.funcC, r.targetAsm);
      const got = new Set(r.features.filter((t) => t in CODEGEN_DERIVED));
      for (const t of want) if (!got.has(t)) bad.push(`${r.id} missing ${t}`);
      for (const t of got) if (!want.has(t)) bad.push(`${r.id} claims ${t}`);
    }
    expect(bad.sort()).toEqual([]);
  });

  it('keeps every judgement tag above its floor', () => {
    const asmOf = new Map(rows.map((r) => [`${r.project}:${r.sym}`, r.targetAsm]));
    const bad = every
      .flatMap(({ project, fn }) => {
        const stripped = stripLiterals(fn.funcC);
        const body = stripped.slice(stripped.indexOf('{'));
        const asm = asmOf.get(`${project}:${fn.sym}`) ?? '';
        return fn.features
          .filter((t) => JUDGEMENT_FLOOR[t] && !JUDGEMENT_FLOOR[t](body, asm))
          .map((t) => `${project}:${fn.sym} claims ${t}`);
      })
      .sort();
    expect(bad).toEqual([]);
  });

  it('gives every function at least one tag', () => {
    expect(every.filter(({ fn }) => fn.features.length === 0).map(({ fn }) => fn.sym)).toEqual([]);
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
    // the floor rejects the fabrications the audit found …
    expect(JUDGEMENT_FLOOR.arithmetic('{ GwSystem.minigame_index = arg0; }', '')).toBe(false);
    expect(JUDGEMENT_FLOOR.array('{ return gPlayerAvatar.flags; }', '')).toBe(false);
    expect(JUDGEMENT_FLOOR.table('{ return gEntityInfo[0x23].unkF; }', '')).toBe(false);
    expect(JUDGEMENT_FLOOR.branch('{ s->a = 0; s->b = 0; }', '\tmov\tr0, #0')).toBe(false);
    // … and accepts the real thing
    expect(JUDGEMENT_FLOOR.arithmetic('{ return a * 10 + b; }', '')).toBe(true);
    expect(JUDGEMENT_FLOOR.table('{ return gSineDegreeTable[angleMod]; }', '')).toBe(true);
    expect(JUDGEMENT_FLOOR.cast('{ return (uintptr_t)(tgt - 1); }', '')).toBe(true);
    expect(JUDGEMENT_FLOOR.fnptr('{ f(); }', '  28:\tjalr\tv0')).toBe(true);
  });

  it('separates I/O registers from other hardware address ranges', () => {
    expect(cg('void f(void){}', '\t.word\t0x4000130')).toEqual(['mmio']);
    expect(cg('void f(void){}', '\t.word\t0x40000d4').sort()).toEqual(['dma', 'mmio']);
    expect(cg('void f(void){}', '\t.word\t0x5000000')).toEqual([]); // palette RAM
    expect(cg('void f(void){}', '\t.word\t0x3007ff8')).toEqual([]); // IWRAM
  });
});
