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

import { ASM_CHECKED, KNOWN_FEATURES, SOURCE_CHECKED, asmEvidence, sourceEvidence } from '../src/cases/features';

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
  JSON.parse(readFileSync(RESULTS, 'utf8')).results as { project: string; sym: string; targetAsm: string }[]
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

  it('never tags a codegen feature the compiled reference does not show', () => {
    const checked = new Set(Object.keys(ASM_CHECKED));
    const bad = every
      .flatMap(({ project, fn }) => {
        const asm = asmOf.get(`${project}:${fn.sym}`);
        if (!asm) return [];
        const ev = asmEvidence(asm, fn.sym);
        return fn.features.filter((t) => checked.has(t) && !ev.has(t)).map((t) => `${project}:${fn.sym} claims ${t}`);
      })
      .sort();
    expect(bad).toEqual([]);
  });

  it('never omits a codegen feature the compiled reference shows', () => {
    const bad = every
      .flatMap(({ project, fn }) => {
        const asm = asmOf.get(`${project}:${fn.sym}`);
        if (!asm) return [];
        const have = new Set(fn.features);
        return [...asmEvidence(asm, fn.sym)]
          .filter((t) => !have.has(t))
          .map((t) => `${project}:${fn.sym} missing ${t}`);
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

  it('reads a MIPS call rendered against the enclosing symbol in an unlinked object', () => {
    // objdump prints an unresolved external `jal` as `jal 0 <the function we are inside>`
    expect([...asmEvidence('  38:\tjal\t0 <func_8005DF10_5EB10>', 'func_8005DF10_5EB10')]).toEqual(['call']);
  });

  it('does not mistake a hardware or BIOS division for a soft-division helper', () => {
    expect([...asmEvidence('  4:\tdiv\tzero,a0,at\n  8:\tmflo\tv0', 'f')]).toEqual([]);
    expect([...asmEvidence('\tbl\t__divsi3', 'f')].sort()).toEqual(['call', 'soft-div']);
  });

  it('separates I/O registers from other hardware address ranges', () => {
    expect([...asmEvidence('\t.word\t0x4000130', 'f')]).toEqual(['mmio']);
    expect([...asmEvidence('\t.word\t0x40000d4', 'f')].sort()).toEqual(['dma', 'mmio']);
    expect([...asmEvidence('\t.word\t0x5000000', 'f')]).toEqual([]); // palette RAM
    expect([...asmEvidence('\t.word\t0x3007ff8', 'f')]).toEqual([]); // IWRAM
  });
});
