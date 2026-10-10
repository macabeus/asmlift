// The native path of the 32-bit toolchains (@asmlift/toolchains' native.ts) emits the same code as
// the container path, per compiler. Each case compiles one source twice — `ASMLIFT_NATIVE=on`, then
// `ASMLIFT_NATIVE=off` — and compares:
//   • CodeWarrior: the objects, byte for byte. wibo and mwcceppc.exe are the same files on both
//     paths, and mwcceppc records no build path.
//   • the two GCC 2.7.2 builds: every instruction (`objdump -d`), every relocation of every section
//     (`objdump -r`, the jump table's in `.rodata` included), and the bytes of the data sections
//     (`objdump -s` of `.rodata` and `.data`). Not the whole object: gcc records the absolute source
//     path in its file symbol, `/tmp/…` on the host and `/host-tmp/…` in the pooled container — a
//     symbol-table string no scorer reads.
// A negative control proves the comparison can fail: one source at -O2 and at -O0 must differ.
// Each case runs only where BOTH paths can (an x86 Linux host with the binaries, and Docker), and
// says so when it cannot.
import { C_TYPEDEFS, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import {
  GCC272_TOOLCHAIN,
  GCC_KMC_TOOLCHAIN,
  MWCC_TOOLCHAIN_IDS,
  type MwccToolchainId,
  dockerAvailable,
  gcc272Compile,
  gcc272Native,
  kmcCompile,
  kmcNative,
  mkShareableTmp,
  mwccNative,
  ppcCompile,
  ppcDockerAvailable,
  run,
} from '@asmlift/toolchains';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const saved = process.env.ASMLIFT_NATIVE;
afterEach(() => {
  if (saved === undefined) {
    delete process.env.ASMLIFT_NATIVE;
  } else {
    process.env.ASMLIFT_NATIVE = saved;
  }
});

/** Whether `native()` holds with native execution REQUIRED — false, not a throw, where it cannot. */
const canNative = (native: () => boolean): boolean => {
  process.env.ASMLIFT_NATIVE = 'on';
  try {
    return native();
  } catch {
    return false;
  } finally {
    if (saved === undefined) {
      delete process.env.ASMLIFT_NATIVE;
    } else {
      process.env.ASMLIFT_NATIVE = saved;
    }
  }
};

const gate = (tag: string, native: boolean, docker: boolean): boolean => {
  if (!native || !docker) {
    console.warn(`[native-parity ${tag}] needs both paths here (native: ${native}, docker: ${docker}) — skipping.`);
  }
  return native && docker;
};

// A jump table (data relocations), a global read, a call, a float constant: the parts of an object
// beyond straight-line code where two builds of one compiler could disagree.
const SOURCE = `extern s32 g; s32 h(s32); float k;
s32 pf(s32 a, s32 b) {
  s32 r;
  switch (a) {
  case 0: r = b; break;
  case 1: r = b * 3; break;
  case 2: r = h(b); break;
  case 3: r = g; break;
  case 4: r = (s32)(k * 2.5f); break;
  case 5: r = b - g; break;
  default: r = -1;
  }
  return r + g;
}
`;

/** Compile SOURCE once per mode with `compile(dir)`, returning each mode's object path. */
function both(prefix: string, compile: (dir: string) => void): { native: string; docker: string } {
  const out = { native: '', docker: '' };
  for (const [mode, key] of [
    ['on', 'native'],
    ['off', 'docker'],
  ] as const) {
    process.env.ASMLIFT_NATIVE = mode;
    const dir = mkShareableTmp(`${prefix}-${key}-`);
    writeFileSync(join(dir, 'p.c'), C_TYPEDEFS + SOURCE);
    compile(dir);
    out[key] = join(dir, 'p.o');
  }
  return out;
}

/** Code, every relocation, and the data sections' bytes — each dump without its header line, which
 *  names the object's own path. */
function code(objdump: string, obj: string): string {
  const dumps = [['-d'], ['-r'], ['-s', '-j', '.rodata', '-j', '.data']].map((args) => {
    const r = run(objdump, [...args, obj]);
    expect(r.status).toBe(0);
    return r.stdout.replace(/^.*file format.*$/m, '');
  });
  return dumps.join('\n');
}

describe('native and container compiles emit the same code', () => {
  test.runIf(gate('kmc', canNative(kmcNative), dockerAvailable()))('KMC GCC', () => {
    const flags = TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags;
    const o = both('asmlift-parity-kmc', (dir) => kmcCompile(dir, 'p.c', 'p.o', flags));
    const native = code(GCC_KMC_TOOLCHAIN.objdump, o.native);
    expect(native).toContain('<pf>:');
    expect(native).toContain('RELOCATION RECORDS FOR [.rodata]'); // the jump table is compared
    expect(native).toBe(code(GCC_KMC_TOOLCHAIN.objdump, o.docker));
  });

  test.runIf(canNative(kmcNative))('the comparison can fail: -O2 and -O0 differ', () => {
    process.env.ASMLIFT_NATIVE = 'on';
    const objs = (['-O2', '-O0'] as const).map((opt) => {
      const dir = mkShareableTmp(`asmlift-parity-neg${opt}-`);
      writeFileSync(join(dir, 'p.c'), C_TYPEDEFS + SOURCE);
      kmcCompile(dir, 'p.c', 'p.o', ['-mips3', '-G0', opt]);
      return join(dir, 'p.o');
    });
    expect(code(GCC_KMC_TOOLCHAIN.objdump, objs[0])).not.toBe(code(GCC_KMC_TOOLCHAIN.objdump, objs[1]));
  });

  test.runIf(gate('gcc272', canNative(gcc272Native), dockerAvailable()))('GCC 2.7.2', () => {
    const flags = TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags;
    const o = both('asmlift-parity-gcc272', (dir) => gcc272Compile(dir, 'p.c', 'p.o', flags));
    const native = code(GCC272_TOOLCHAIN.objdump, o.native);
    expect(native).toContain('<pf>:');
    expect(native).toBe(code(GCC272_TOOLCHAIN.objdump, o.docker));
  });

  const mwccFlags = TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags;
  test.each(MWCC_TOOLCHAIN_IDS)('CodeWarrior %s', (mwcc: MwccToolchainId) => {
    if (
      !gate(
        mwcc,
        canNative(() => mwccNative(mwcc)),
        ppcDockerAvailable(mwcc),
      )
    ) {
      return;
    }
    const o = both(`asmlift-parity-${mwcc}`, (dir) => ppcCompile(mwcc, dir, 'p.c', 'p.o', mwccFlags));
    expect(readFileSync(o.native).length).toBeGreaterThan(0);
    expect(readFileSync(o.native).equals(readFileSync(o.docker))).toBe(true);
  });
});
