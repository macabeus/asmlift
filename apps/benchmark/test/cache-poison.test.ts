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
import { afterEach, describe, expect, test } from 'vitest';

import { cachedBuildTarget } from '../src/cache';
import { TOOLCHAINS } from '../src/toolchains';

// A stand-in for the real build step, counting its calls. `refC` is unique per test so the
// content key is too, and nothing here touches a compiler.
const fakeToolchain = (asm: string) => {
  const obj = join(mkdtempSync(join(tmpdir(), 'cache-poison-')), 'a.o');
  writeFileSync(obj, 'obj');
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
        /empty disassembly for poison_a on agbcc/,
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
});
