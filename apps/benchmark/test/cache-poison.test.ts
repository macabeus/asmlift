// A cached reference build with an EMPTY disassembly is poison, not a result.
//
// The dump step can fail without raising (a Docker hiccup on the PPC path), and the target cache
// writes tmp-then-rename with no TTL — so an empty `.asm` becomes a well-formed entry that every
// later run reads back happily. The blast radius is another module entirely: `disasmToM2c` throws
// `could not parse objdump output`, the shard exits nonzero, and a row that has been stable for
// weeks looks like a decompiler regression. One such entry (of 642) cost a session its zero-flip
// gate before this guard existed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { cachedAsmDumpText, cachedBuildTarget, cachedExtractAsmData, sha } from '../src/cache';
import { CACHE_DIR } from '../src/config';
import { TOOLCHAINS, checkedTarget } from '../src/toolchains';

// A stand-in for the real build step, counting its calls. `refC` is unique per test so the
// content key is too, and nothing here touches a compiler.
const fakeToolchain = (asm: string, objBytes = 'obj') => {
  const obj = join(mkdtempSync(join(tmpdir(), 'cache-poison-')), 'a.o');
  writeFileSync(obj, objBytes);
  let calls = 0;
  return { tc: { ...TOOLCHAINS.agbcc, buildTarget: () => (calls++, { obj, asm }) }, calls: () => calls };
};

const written: string[] = [];
afterEach(() => {
  for (const p of written.splice(0)) {
    rmSync(p, { force: true });
  }
});

describe('cachedBuildTarget refuses an empty disassembly', () => {
  test('a build that produces no asm throws instead of being cached', () => {
    const { tc } = fakeToolchain('   \n\n');
    process.env.ASMLIFT_BENCH_CACHE = '0';
    try {
      expect(() => cachedBuildTarget(tc, 'int poison_a(void){return 0;}', 'poison_a')).toThrow(
        /poison_a on agbcc produced an empty disassembly/,
      );
    } finally {
      delete process.env.ASMLIFT_BENCH_CACHE;
    }
  });

  test('an entry already poisoned is a MISS, and the rebuild replaces it', () => {
    const refC = 'int poison_b(void){return 1;}';
    const { tc, calls } = fakeToolchain('fn:\n  bx lr\n');

    // Populate normally first, so the entry's paths come from the module's own key derivation
    // rather than a second copy of it here.
    const oPath = cachedBuildTarget(tc, refC, 'poison_b').obj;
    const aPath = oPath.replace(/\.o$/, '.asm');
    written.push(oPath, aPath);
    expect(calls()).toBe(1);
    expect(cachedBuildTarget(tc, refC, 'poison_b').asm).toContain('bx lr');
    expect(calls()).toBe(1); // a good entry is read back

    writeFileSync(aPath, '');
    expect(cachedBuildTarget(tc, refC, 'poison_b').asm).toContain('bx lr');
    expect(calls()).toBe(2); // the empty one is not
    expect(readFileSync(aPath, 'utf8')).toContain('bx lr'); // and it got overwritten
  });

  test('the OBJECT half is checked too — an empty .o is refused on the way in', () => {
    const { tc } = fakeToolchain('fn:\n  bx lr\n', '');
    process.env.ASMLIFT_BENCH_CACHE = '0';
    try {
      expect(() => cachedBuildTarget(tc, 'int poison_c(void){return 2;}', 'poison_c')).toThrow(
        /poison_c on agbcc produced an empty object/,
      );
    } finally {
      delete process.env.ASMLIFT_BENCH_CACHE;
    }
  });

  test('an entry whose .o half is empty is a MISS, however good the .asm half looks', () => {
    const refC = 'int poison_d(void){return 3;}';
    const { tc, calls } = fakeToolchain('fn:\n  bx lr\n');
    const oPath = cachedBuildTarget(tc, refC, 'poison_d').obj;
    written.push(oPath, oPath.replace(/\.o$/, '.asm'));
    expect(calls()).toBe(1);

    writeFileSync(oPath, '');
    expect(cachedBuildTarget(tc, refC, 'poison_d').asm).toContain('bx lr');
    expect(calls()).toBe(2);
    expect(readFileSync(oPath, 'utf8')).toBe('obj');
  });
});

// The PPC objdump text is the OTHER content-keyed, TTL-less cache in this module, and it feeds
// BOTH decompilers on every mwcc row: `cachedAsmDumpText` -> m2c's data-section normalizer,
// `cachedExtractAsmData` -> asmlift's Regime-B jump-table recovery. `parseAsmData` of nothing is a
// well-formed EMPTY AsmData, so there is no throw anywhere to notice — which is exactly why an
// entry that is already empty has to read back as a MISS.
describe('the PPC dump cache does not serve an empty entry', () => {
  test('an empty ppcdump-* entry is a miss, not an AsmData with no sections', () => {
    // A UNIQUE object, so the content key cannot collide with any real row's.
    const obj = join(mkdtempSync(join(tmpdir(), 'ppc-poison-')), 'a.o');
    writeFileSync(obj, `ASMLIFT-CACHE-POISON-TEST-${process.pid}-${Math.random()}`);
    const entry = join(CACHE_DIR, `ppcdump-${sha(readFileSync(obj))}.txt`);
    written.push(entry);
    writeFileSync(entry, '');

    // The rebuild needs a PPC objdump this test has no business running, so the assertion is that
    // the empty entry is NOT returned: it either raises on the way to the container or comes back
    // with real content. What must never happen is the silent empty result.
    for (const call of [
      () => cachedExtractAsmData(obj, TOOLCHAINS.mwcc_242_81.targetDesc),
      () => cachedAsmDumpText(obj, 'mwcc_242_81'),
    ]) {
      let served: unknown = 'THREW';
      try {
        served = call();
      } catch {
        /* a loud failure is the acceptable outcome */
      }
      expect(served).not.toBe('');
      expect(served).not.toEqual({ sections: {}, relocs: [], symbols: {}, bigEndian: true });
    }
  });
});

// THE REAL TIER REACHES NEITHER GUARD ABOVE. Its `Case.build` is `buildRealTarget`, which never
// touches this cache, and its disassembly comes from `compile/{ido,kmc,gcc272}.ts`'s own `disasm()`
// — or, for agbcc, from a `.s` read off disk with no objdump in the path at all, so
// @asmlift/toolchains' `nonEmptyDump` cannot see it either. 252 of the artifact's 894 rows are
// real. The invariant is therefore stated over the CONTRACT, and both tiers cross it.
describe('the BuiltTarget invariant covers the real tier too', () => {
  const obj = join(mkdtempSync(join(tmpdir(), 'checked-target-')), 'a.o');
  writeFileSync(obj, 'obj');
  const empty = join(mkdtempSync(join(tmpdir(), 'checked-target-')), 'empty.o');
  writeFileSync(empty, '');

  test('checkedTarget refuses either empty half and passes a good pair through', () => {
    expect(() => checkedTarget({ obj, asm: '  \n' }, 'row X')).toThrow(/row X produced an empty disassembly/);
    expect(() => checkedTarget({ obj: empty, asm: 'fn:\n  bx lr\n' }, 'row X')).toThrow(
      /row X produced an empty object/,
    );
    expect(checkedTarget({ obj, asm: 'fn:\n  bx lr\n' }, 'row X').asm).toContain('bx lr');
  });

  test('buildRealTarget routes through it — a compiler that emits nothing raises, naming the row', async () => {
    vi.doMock('../src/compile/agbcc', async () => {
      const real = await vi.importActual<typeof import('../src/compile/agbcc')>('../src/compile/agbcc');
      return { ...real, agbccReal: { ...real.agbccReal, buildTarget: () => ({ obj, asm: '' }) } };
    });
    vi.resetModules();
    const { buildRealTarget: fresh } = await import('../src/compile/real');
    expect(() => fresh('agbcc', 'int f(void){return 0;}')).toThrow(/agbcc real-tier target produced an empty/);
    vi.doUnmock('../src/compile/agbcc');
    vi.resetModules();
  });

  test('and the synthetic seam raises with the SAME wording — one predicate, not two copies', () => {
    const { tc } = fakeToolchain('   ');
    process.env.ASMLIFT_BENCH_CACHE = '0';
    try {
      expect(() => cachedBuildTarget(tc, 'int poison_e(void){return 4;}', 'poison_e')).toThrow(
        /produced an empty disassembly — refusing it as a scoring target/,
      );
    } finally {
      delete process.env.ASMLIFT_BENCH_CACHE;
    }
  });
});
