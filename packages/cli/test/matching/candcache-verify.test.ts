// Gate E in miniature, with the REAL toolchain: run the cross-run candidate-object cache in
// `verify` mode over agbcc and check that what is on disk is what the compiler produces today.
//
// The offline suites pin the store's mechanics and the namespace's inputs with sh one-liners for
// compilers. Only here does a real compiler answer the questions that matter:
//   • is a candidate object actually a pure function of (TU bytes, symbol) for agbcc, measured by
//     the two-directory stamp probe rather than assumed;
//   • do the bytes served warm equal the bytes compiled cold, on real objects;
//   • does verify mode CATCH a stored object that disagrees — the gate has to be able to fail.
import { TOOLCHAIN } from '@asmlift/toolchains';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';

type CompileCommandModule = typeof import('../../src/compile-command');

/** The project's "own toolchain", as a decomp.yaml command template: cpp -> agbcc -> as. */
const TEMPLATE = [
  `cpp -P -nostdinc {{inputPath}} > {{inputPath}}.pp.c`,
  `${TOOLCHAIN.agbcc} {{inputPath}}.pp.c -o {{inputPath}}.s ${TOOLCHAIN.agbccFlags.join(' ')}`,
  `${TOOLCHAIN.as} ${TOOLCHAIN.asFlags.join(' ')} {{inputPath}}.s -o {{outputPath}}`,
].join(' && ');

const CANDIDATES = [
  'u32 f(u32 a0) { return a0 >> 1; }\n',
  'u32 f(u32 a0) { return a0 * 3; }\n',
  's32 f(s32 a0) { return a0 < 0 ? -a0 : a0; }\n',
  's32 f(s32 a0, s32 a1) { return a0 + a1 * 2; }\n',
  'u8 f(u8 *a0) { return a0[3]; }\n',
  's32 f(s32 a0) { s32 i, s = 0; for (i = 0; i < a0; i++) { s += i; } return s; }\n',
  'void f(u16 *a0, u16 a1) { *a0 = a1; }\n',
  's32 f(s32 a0) { switch (a0) { case 1: return 7; case 2: return 9; } return 0; }\n',
  // MEASURED to compile to different bytes at -O1 and -O2 (652 bytes both, bfa32575… vs
  // 5123e039…), which is what the flag-change case below needs. The obvious loop fixture does
  // NOT: agbcc emits 7a0dd1ff… for it at both levels, and asserting on that one would have
  // "passed" the cache for the wrong reason.
  's32 f(s32 a0, s32 a1) { s32 i, s = 0; for (i = 0; i < a0; i++) { if (i & 1) { s += a1 * i; } else { s -= i; } } return s; }\n',
];

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
};

/** compile-command.ts + candcache.ts read the cache environment once, at module load. */
async function withCache<T>(mode: string, store: string, fn: (m: CompileCommandModule) => Promise<T> | T): Promise<T> {
  const saved = [process.env.ASMLIFT_CANDCACHE, process.env.ASMLIFT_CANDCACHE_DIR];
  process.env.ASMLIFT_CANDCACHE = mode;
  process.env.ASMLIFT_CANDCACHE_DIR = store;
  vi.resetModules();
  try {
    return await fn(await import('../../src/compile-command'));
  } finally {
    process.env.ASMLIFT_CANDCACHE = saved[0];
    process.env.ASMLIFT_CANDCACHE_DIR = saved[1];
    if (saved[0] === undefined) {
      delete process.env.ASMLIFT_CANDCACHE;
    }
    if (saved[1] === undefined) {
      delete process.env.ASMLIFT_CANDCACHE_DIR;
    }
    vi.resetModules();
  }
}

const objectsIn = (store: string): string[] => {
  const dir = join(store, 'objects');
  return readdirSync(dir, { withFileTypes: true }).flatMap((ab) =>
    ab.isDirectory() ? readdirSync(join(dir, ab.name)).map((f) => join(dir, ab.name, f)) : [],
  );
};

describe('the candidate cache, verified against real agbcc objects', () => {
  test('agbcc PASSES the purity probe, cold bytes equal warm bytes, and verify finds 0 mismatches', async () => {
    const store = scratch('candcache-e2e-store-');
    const cwd = scratch('candcache-e2e-proj-');

    const cold = await withCache('1', store, ({ compileFromCommand }) => {
      const compile = compileFromCommand(TEMPLATE, { cwd });
      return CANDIDATES.map((c) => readFileSync(compile(c, 'f', 'c')).toString('hex'));
    });
    // The probe answered "pure", so the store exists at all — that is hole 3's measurement
    // passing on a real toolchain rather than being assumed.
    expect(objectsIn(store).length, 'agbcc is path-independent through this template').toBeGreaterThan(0);
    expect(new Set(cold).size, 'the fixtures must be distinct objects, or this proves nothing').toBe(CANDIDATES.length);

    const warm = await withCache('1', store, ({ compileFromCommand }) => {
      const compile = compileFromCommand(TEMPLATE, { cwd });
      return CANDIDATES.map((c) => readFileSync(compile(c, 'f', 'c')).toString('hex'));
    });
    expect(warm).toEqual(cold);

    const stats = await withCache('verify', store, async ({ compileFromCommand }) => {
      const compile = compileFromCommand(TEMPLATE, { cwd });
      for (const c of CANDIDATES) {
        compile(c, 'f', 'c');
      }
      return (await import('../../src/candcache')).cacheStats();
    });
    expect(stats.verified, 'every candidate was compiled and compared').toBe(CANDIDATES.length);
    expect(stats.mismatch).toBeUndefined();
  });

  test('verify CATCHES a stored object that disagrees, and records it where the gate can read it', async () => {
    const store = scratch('candcache-e2e-store-');
    const cwd = scratch('candcache-e2e-proj-');
    const one = CANDIDATES[0];

    const served = await withCache('1', store, ({ compileFromCommand }) =>
      compileFromCommand(TEMPLATE, { cwd })(one, 'f', 'c'),
    );
    // What a namespace hole looks like on disk: a well-formed object of the wrong toolchain.
    // Write THROUGH the hardlink so the content-addressed copy moves with it.
    const truth = readFileSync(served);
    const forged = Buffer.from(truth);
    forged[forged.length - 1] ^= 0xff;
    writeFileSync(served, forged);
    expect(statSync(served).size).toBe(truth.length);

    const { stats, log } = await withCache('verify', store, async ({ compileFromCommand }) => {
      compileFromCommand(TEMPLATE, { cwd })(one, 'f', 'c');
      const cc = await import('../../src/candcache');
      return { stats: cc.cacheStats(), log: readFileSync(cc.MISMATCH_LOG, 'utf8') };
    });
    expect(stats.mismatch).toBe(1);
    expect(log).toContain('BYTE MISMATCH label=command');
    expect(log).toContain('symbol=f');

    // and the fresh bytes won
    const repaired = await withCache('1', store, ({ compileFromCommand }) =>
      readFileSync(compileFromCommand(TEMPLATE, { cwd })(one, 'f', 'c')),
    );
    expect(repaired.equals(truth)).toBe(true);
  });

  test('a real flag change re-namespaces: -O2 and -O1 never share an answer', async () => {
    const store = scratch('candcache-e2e-store-');
    const cwd = scratch('candcache-e2e-proj-');
    const one = CANDIDATES[CANDIDATES.length - 1];
    const o1 = TEMPLATE.replace('-O2', '-O1');
    expect(o1).not.toBe(TEMPLATE);

    const [a, b] = await withCache('1', store, ({ compileFromCommand }) => [
      readFileSync(compileFromCommand(TEMPLATE, { cwd })(one, 'f', 'c')).toString('hex'),
      readFileSync(compileFromCommand(o1, { cwd })(one, 'f', 'c')).toString('hex'),
    ]);
    expect(b, 'the second compile must be its own object, not the first one served back').not.toBe(a);
    expect(readdirSync(join(store, 'ns')).length).toBe(2);
  });
});
