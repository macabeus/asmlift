// The `features` vocabulary is only worth something if it can be falsified. The vocabulary lives in
// @asmlift/bench-schema and the detectors in src/cases/features.ts; these assert that they and the
// dataset agree — published tags are defined, definitions are used and well-formed, derived tags
// match their evidence in both directions, and authored tags stay above their floor.
import {
  FEATURES,
  FEATURE_BY_ID,
  type FeatureDef,
  GROUP_ORDER,
  KNOWN_FEATURES,
  definitionsOutOfStep,
  featuresByEvidence,
} from '@asmlift/bench-schema';
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

  it('every definition is carried by a row, and every pending definition still waits for one', () => {
    expect(definitionsOutOfStep(new Set(rows.flatMap((r) => r.features)))).toEqual([]);
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

// A tag can be defined before the rows that carry it exist — the GameCube vocabulary landed a
// release ahead of the GameCube rows. `pending` is how a definition says so, and it is a promise
// with an expiry: these hold that the exemption works in one direction only.
describe('a definition and the rows that carry it', () => {
  const def = (id: string, extra: Partial<FeatureDef> = {}): FeatureDef => ({
    id,
    label: id,
    group: 'meta',
    evidence: 'judgement',
    summary: id,
    ...extra,
  });

  it('reports a live definition no row carries', () => {
    expect(definitionsOutOfStep(new Set(['carried']), [def('carried'), def('orphan')])).toEqual([
      'orphan: defined, but no row carries it',
    ]);
  });

  it('lets a pending definition wait', () => {
    expect(definitionsOutOfStep(new Set(), [def('later', { pending: true })])).toEqual([]);
  });

  it('refuses a pending definition the rows have caught up with', () => {
    expect(definitionsOutOfStep(new Set(['later']), [def('later', { pending: true })])).toEqual([
      'later: marked pending, but rows carry it — drop the flag',
    ]);
  });

  it('exempts a deprecated definition either way', () => {
    const gone = [def('gone', { deprecated: true })];
    expect(definitionsOutOfStep(new Set(), gone)).toEqual([]);
    expect(definitionsOutOfStep(new Set(['gone']), gone)).toEqual([]);
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
      'local-aggregate-init',
      'loop',
      'nested-loop',
      'new-delete',
      'shift',
      'short-circuit',
      'sizeof',
      'static-local',
      'switch',
      'ternary',
      'varargs-def',
    ]);
    expect([...CODEGEN_DERIVED].sort()).toEqual([
      'branchless',
      'call',
      'comparison-tree',
      'dma',
      'float-callee-save',
      'float-compare',
      'hw-div',
      'jump-table',
      'libm-call',
      'magic-div',
      'mmio',
      'runtime-helper-call',
      'savegpr-helper',
      'sda-global',
      'soft-div',
      'strength-reduce',
      'vararg-call',
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
    // `&&` is not a bitwise `&` — it is its own tag, and claims neither the other's evidence
    expect(src('void f(void){ if (a && b) g(); }')).toEqual(['short-circuit']);
    expect(src('void f(void){ y = a & 0xFF; }')).toEqual(['bitwise']);
  });

  it('separates a branch-deciding short-circuit from the value-producing one', () => {
    const has = (c: string) => src(c).includes('short-circuit');
    // the VALUE form is a merged-boolean diamond, a different recovery
    expect(has('int f(int a,int b){ return a && b; }')).toBe(false);
    expect(has('void f(void){ int r = a || b; if (r) g(); }')).toBe(false);
    expect(has('void f(void){ if (a) { g(); } }')).toBe(false);
    // … including a connective handed to a call or a ternary as a value
    expect(has('void f(void){ if (f(a && b)) { g(); } }')).toBe(false);
    expect(has('void f(void){ if ((a && b) ? x : y) g(); }')).toBe(false);
    // a `for` header holds three clauses and only the MIDDLE one controls anything
    expect(has('void f(void){ for (i = 0; i < n; i++, j = a && b) g(); }')).toBe(false);
    expect(has('void f(void){ for (i = 0; i < n && j > 0; i++) g(); }')).toBe(true);
    // a preprocessor directive is not a statement — real-tier sources are unpreprocessed
    expect(has('void f(void){ g(); }\n#if (A && B)\nint z;\n#endif')).toBe(false);
    // … and the real thing, through parenthesised calls, casts and a do-while clause
    expect(has('void f(void){ if (a && b) { g(); } }')).toBe(true);
    expect(has('void f(void){ while (f(x) && g(y)) { h(); } }')).toBe(true);
    expect(has('void f(void){ if ((u8)(a) != 0 || (b & 3)) { g(); } }')).toBe(true);
    expect(has('void f(void){ do { g(); } while (a && b); }')).toBe(true);
    // a GROUPING paren is transparent where a CALL's is not — the distinction is what the paren
    // IS, not how deep it is, and a single non-recursive strip gets both halves wrong
    expect(has('void f(void){ if (!(a || b)) g(); }')).toBe(true);
    expect(has('void f(void){ if ((a && b)) g(); }')).toBe(true);
    expect(has('void f(void){ if (((a && b))) g(); }')).toBe(true);
    expect(has('void f(void){ if ((a && b) == 0) g(); }')).toBe(true);
    expect(has('void f(void){ while (!(p && p->next)) g(); }')).toBe(true);
    expect(has('void f(void){ if (f(g(), a && b)) h(); }')).toBe(false);
    expect(has('void f(void){ if (h(a && b, f(x))) g(); }')).toBe(false);
    // a ternary's own `?` stays inside its group, so it does not disqualify the outer connective
    expect(has('void f(void){ if ((c ? x : y) && z) g(); }')).toBe(true);
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
    expect(JUDGEMENT_FLOOR.arithmetic('{ GwSystem.minigame_index = arg0; }', '', '')).toBe(false);
    expect(JUDGEMENT_FLOOR.array('{ return gPlayerAvatar.flags; }', '', '')).toBe(false);
    expect(JUDGEMENT_FLOOR.table('{ return gEntityInfo[0x23].unkF; }', '', '')).toBe(false);
    expect(JUDGEMENT_FLOOR.branch('{ s->a = 0; s->b = 0; }', '\tmov\tr0, #0', '')).toBe(false);
    // … and accepts the real thing
    expect(JUDGEMENT_FLOOR.arithmetic('{ return a * 10 + b; }', '', '')).toBe(true);
    expect(JUDGEMENT_FLOOR.table('{ return gSineDegreeTable[angleMod]; }', '', '')).toBe(true);
    expect(JUDGEMENT_FLOOR.cast('{ return (uintptr_t)(tgt - 1); }', '', '')).toBe(true);
    expect(JUDGEMENT_FLOOR.fnptr('{ f(); }', '  28:\tjalr\tv0', '')).toBe(true);
    // a variable subscript ANYWHERE in the chain: the `k` here follows a `]`, not a name, which
    // the first form of this floor could not see (synthetic:pmarrrow)
    expect(JUDGEMENT_FLOOR['variable-index']('{ return gBlob->unk8[0][k]; }', '', '')).toBe(true);
    expect(JUDGEMENT_FLOOR['variable-index']('{ return gBlob->unk8[0][7]; }', '', '')).toBe(false);
    // merge-chain wants MORE THAN ONE local for the arms to decide, initialised or not
    expect(JUDGEMENT_FLOOR['merge-chain']('{ int x; if (a) x = 1; else x = 2; return x; }', '', '')).toBe(false);
    expect(JUDGEMENT_FLOOR['merge-chain']('{ int x, y; return f(x, y); }', '', '')).toBe(false);
    // two locals declared one per line are still two locals — the comma is a spelling accident
    expect(JUDGEMENT_FLOOR['merge-chain']('{ void *a; void *b; if (s) a = p; else b = p; }', '', '')).toBe(true);
    expect(JUDGEMENT_FLOOR['merge-chain']('{ int x, y; if (a) { x = 1; y = 2; } return x + y; }', '', '')).toBe(true);
    expect(JUDGEMENT_FLOOR['merge-chain']('{ int x = 0, y = 0, i; if (a) x = y; return x; }', '', '')).toBe(true);
  });

  it('holds the C++ floors to the signature, where their evidence is', () => {
    const floor = (id: string, c: string, asm = '') => JUDGEMENT_FLOOR[id](stripLiterals(c), asm, stripLiterals(c));
    // a constructor repeats the class name; a destructor puts a `~` in front of it
    expect(floor('ctor', 'Thing::Thing(int n) { this->count = n; }')).toBe(true);
    expect(floor('ctor', 'void Thing::reset(int n) { this->count = n; }')).toBe(false);
    expect(floor('dtor', 'System::~System() { free(this->buf); }')).toBe(true);
    expect(floor('dtor', 'System::System() { this->buf = 0; }')).toBe(false);
    // a reference parameter, NOT a binary `&` in the body — which is why this reads the signature
    expect(floor('reference', 'void add(Vec& dst, const Vec& src) { dst.x += src.x; }')).toBe(true);
    expect(floor('reference', 'void add(Vec *dst) { dst->x = a & b; }')).toBe(false);
    // a float in the signature is what travels in an FP register; one confined to the body is not
    expect(floor('hw-float-abi', 'f32 lerp(f32 a, f32 b) { return a + b; }')).toBe(true);
    expect(floor('hw-float-abi', 'int n(int a) { float t = a; return (int)t; }')).toBe(false);
  });

  it('holds the remaining new floors without pretending to decide them', () => {
    const floor = (id: string, c: string, asm = '') => JUDGEMENT_FLOOR[id](stripLiterals(c), asm, stripLiterals(c));
    // an indirect call, on all four ISAs — not the same predicate as `fnptr`, which has no PPC form
    expect(floor('virtual-call', '{ o->draw(); }', '  14:\tbctrl')).toBe(true);
    expect(floor('virtual-call', '{ o->draw(); }', '  14:\tjalr\tv0')).toBe(true);
    expect(floor('virtual-call', '{ draw(o); }', '  14:\tbl\tdraw')).toBe(false);
    // an assignment whose right-hand side is a whole object, not an expression
    expect(floor('struct-copy', '{ *a = *b; }')).toBe(true);
    expect(floor('struct-copy', '{ p->pos = q->pos; }')).toBe(true);
    expect(floor('struct-copy', '{ p->x = q->x + 1; }')).toBe(false);
    expect(floor('struct-copy', '{ p->x = f(q); }')).toBe(false);
    // a callee can only have been inlined if the body spells a call; `if (` is not one
    expect(floor('inlined-callee', '{ return fabsf(x); }')).toBe(true);
    expect(floor('inlined-callee', '{ if (x > 0) { return x; } return -x; }')).toBe(false);
  });

  it('reads a static local, and does not read the aggregate it initialises as an automatic one', () => {
    // `static` puts the object in .rodata and there is no per-call copy — the shape
    // `local-aggregate-init` is about — so the two tags are exclusive on the same declaration
    expect(src('void f(u8 h){ static const u8 t[] = { 1, 1, 0 }; use(t[h]); }')).toEqual(['static-local']);
    expect(src('void f(void){ s16 dx[4] = { 0, -1, 0, 1 }; g(dx[k]); }')).toEqual(['local-aggregate-init']);
    // a brace initialiser is a DECLARATION, not any `= {`
    expect(src('void f(void){ p->cb = h; if (a) { b(); } }')).toEqual([]);
  });

  it('reads the ellipsis from the signature, where the body cannot show it', () => {
    expect(src('void f(const char *fmt, ...) { g(fmt); }')).toEqual(['varargs-def']);
    expect(src('void f(const char *fmt) { g(fmt); }')).toEqual([]);
  });

  it('separates a `new` expression from an identifier spelled `new`', () => {
    expect(src('void f(void){ p = new Thing(3); }')).toEqual(['new-delete']);
    expect(src('void f(void){ delete[] p; }')).toEqual(['new-delete']);
    expect(src('void f(void){ x = s->new; }')).toEqual([]);
    expect(src('void f(void){ x = new_value; }')).toEqual([]);
  });

  it('names the runtime helpers the compiler generated, and leaves the division ones to soft-div', () => {
    const f = 'float f(float a, float b){ return a + b; }';
    expect(cg(f, '\tbl\t__addsf3')).toEqual(['call', 'runtime-helper-call']);
    expect(cg(f, '  10:\tbl\t10 <f+0x10>\n\t\t\t10: R_PPC_REL24\t__shl2i')).toEqual(['call', 'runtime-helper-call']);
    // `soft-div` says more about the same call, so it is not doubled up
    expect(cg('int f(int a){ return a/10; }', '\tbl\t__divsi3')).toEqual(['call', 'soft-div']);
    // a project symbol that merely begins with two underscores is not a helper
    expect(cg(f, '\tbl\t__osDisableInt')).toEqual(['call']);
    // a DATA relocation names a datum, not a callee
    expect(cg(f, '   8:\tlis\tr4,0\n\t\t\t8: R_PPC_ADDR16_HA\t__addsf3')).toEqual([]);
  });

  it('reads the maths library and the out-of-line register save off the call, not the text', () => {
    expect(cg('f32 f(f32 a){ return sqrtf(a); }', '\tbl\tsqrtf')).toEqual(['call', 'libm-call']);
    expect(cg('void f(void){ g(); }', '  10:\tbl\t10 <f+0x10>\n\t\t\t10: R_PPC_REL24\t_savegpr_25')).toEqual([
      'call',
      'savegpr-helper',
    ]);
  });

  it('reads a float comparison on all three of its spellings', () => {
    const s = 'f32 f(f32 a, f32 b){ if (a < b) { return a; } return b; }';
    expect(cg(s, '  14:\tc.lt.s\t$f14,$f0\n  1c:\tbc1fl\t30 <f+0x30>')).toEqual(['float-compare']);
    expect(cg(s, '   8:\tfcmpo\tcr0,f1,f2\n   c:\tbge\t20 <f+0x20>')).toEqual(['float-compare']);
    // no FPU: the comparison is a helper call, and it is still a comparison
    expect(cg(s, '\tbl\t__ltsf2\n\tcmp\tr0, #0\n\tbge\t.L3')).toEqual(['call', 'float-compare', 'runtime-helper-call']);
    expect(cg('int f(int a,int b){ if (a<b) { return a; } return b; }', '\tcmp\tr0, r1\n\tbge\t.L3')).toEqual([]);
  });

  it('reads a float callee-save only where the register is written to the FRAME', () => {
    const s = 'f32 f(f32 a){ return a; }';
    expect(cg(s, '   4:\tsdc1\t$f20,16(sp)')).toEqual(['float-callee-save']);
    expect(cg(s, '   4:\tstfd\tf14,8(r1)')).toEqual(['float-callee-save']);
    expect(cg(s, '   4:\tpsq_st\tf31,192(r1),0,0')).toEqual(['float-callee-save']);
    // a volatile register, and a callee-saved one used as a scratch against someone else's pointer
    expect(cg(s, '   4:\tstfd\tf1,8(r1)')).toEqual([]);
    expect(cg(s, '   4:\tsdc1\t$f20,0(a0)')).toEqual([]);
  });

  it('reads the variadic-call marker and the small-data relocation', () => {
    expect(cg('void f(void){ printf(s); }', '   8:\tcrclr\t4*cr1+eq\n   c:\tbl\tprintf')).toEqual([
      'call',
      'vararg-call',
    ]);
    expect(cg('f32 f(f32 x){ return x * gScale; }', '   c:\tlfs\tf0,0(r2)\n\t\t\tc: R_PPC_EMB_SDA21\t@6')).toEqual([
      'sda-global',
    ]);
  });

  it('separates I/O registers from other hardware address ranges', () => {
    expect(cg('void f(void){}', '\t.word\t0x4000130')).toEqual(['mmio']);
    expect(cg('void f(void){}', '\t.word\t0x40000d4').sort()).toEqual(['dma', 'mmio']);
    expect(cg('void f(void){}', '\t.word\t0x5000000')).toEqual([]); // palette RAM
    expect(cg('void f(void){}', '\t.word\t0x3007ff8')).toEqual([]); // IWRAM
  });
});
