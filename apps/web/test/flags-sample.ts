// Rows for the compiler-flags tests, each a full `FunctionResult` so the detail drawer renders over it.
// The real units' flags and derivations are copied from the committed manifests
// (apps/benchmark/dataset/real/*.json); the dtk row is a CodeWarrior unit with a level word overridden,
// a state no committed row is in.
import type { DecompilerResult, FlagsFrom, FunctionResult, ToolchainId } from '@asmlift/bench-schema';
import { canonicalFlagsOf } from '@asmlift/core/target';

/** A synthetic sample row compiles at its toolchain's canonical flags — so a toolchain that has
 *  none cannot have one, and says so here rather than producing a row with no flags. */
function canonicalCflags(toolchain: ToolchainId): string[] {
  const flags = canonicalFlagsOf(toolchain);
  if (flags === undefined) {
    throw new Error(`${toolchain} has no canonical flags: it compiles no synthetic row`);
  }
  return [...flags];
}

const ISA: Record<ToolchainId, FunctionResult['isa']> = {
  agbcc: 'arm',
  'ido7.1': 'mips',
  'gcc2.7.2': 'mips',
  'gcc2.7.2kmc': 'mips',
  mwcc_242_81: 'ppc',
  mwcc_233_163n: 'ppc',
  mwcc_247_107: 'ppc',
};

function declined(decompiler: DecompilerResult['decompiler']): DecompilerResult {
  return {
    decompiler,
    outcome: 'declined',
    source: '',
    score: null,
    maxScore: null,
    compileErrors: null,
    quality: { score: 0, lines: 0, gotos: 0, casts: 0, unkGlue: 0, rawMem: 0, addrDeref: 0 },
  };
}

interface Unit {
  path: string;
  cflags: string[];
  flagsFrom: FlagsFrom;
}

function row(id: string, unit: Unit | null): FunctionResult {
  const [project, sym, toolchain] = id.split(':') as [string, string, ToolchainId];
  return {
    id,
    sym,
    project,
    ...(unit === null
      ? { tier: 'synthetic' as const }
      : { tier: 'real' as const, unit: unit.path, flagsFrom: unit.flagsFrom }),
    toolchain,
    isa: ISA[toolchain],
    compiler: toolchain,
    language: 'c',
    cflags: unit === null ? canonicalCflags(toolchain) : unit.cflags,
    features: [],
    loc: 1,
    refSource: `void ${sym}(void) {}`,
    targetAsm: `${sym}:\n\tbx lr\n`,
    asmlift: declined('asmlift'),
    m2c: declined('m2c'),
  };
}

const SA3_MAKEFILE = {
  from: 'makefile',
  commit: 'a069e81bb4c7128e12bfb182bdcc49141ec5f7fb',
  file: 'Makefile',
  sha256: '7018e47569549f33ae7fee18c6d12c0c8ff43c9a30690991383989beeed1e417',
} as const;
const MP3_MAKEFILE = {
  from: 'makefile',
  commit: '6b4380b9493a2bf9a60e3be5f5b6b6e70e4b927e',
  file: 'Makefile',
  sha256: '8cc14473b9df17fb5f590623d215d057e74a81399e63dd9fbaed8357a24d35aa',
} as const;

const SA3_MATH: Unit = {
  path: 'src/game/math.c',
  cflags: ['-fhex-asm', '-mthumb-interwork', '-O2'],
  flagsFrom: {
    ...SA3_MAKEFILE,
    command:
      'tools/preproc/preproc build/gba/sa3/src/game/math.i | tools/agbcc/bin/agbcc  -Wimplicit -Wparentheses -Werror -fhex-asm -mthumb-interwork -O2 -o build/gba/sa3/src/game/math.s -',
  },
};
const SA3_FLASH: Unit = {
  path: 'src/lib/agb_flash/agb_flash.c',
  cflags: ['-O1', '-mthumb-interwork'],
  flagsFrom: {
    ...SA3_MAKEFILE,
    command:
      'tools/preproc/preproc build/gba/sa3/src/lib/agb_flash/agb_flash.i | tools/agbcc/bin/agbcc  -O1 -mthumb-interwork -Werror -o build/gba/sa3/src/lib/agb_flash/agb_flash.s -',
  },
};
const AF_GFXALLOC: Unit = {
  path: 'src/code/gfxalloc.c',
  cflags: ['-G', '0', '-non_shared', '-Wab,-r4300_mul', '-mips2', '-EB', '-O2', '-g3'],
  flagsFrom: {
    from: 'makefile',
    commit: '4515c15b5848b1ec85e78cb3776e12990cafe004',
    file: 'Makefile',
    sha256: '87b59c4187d6ce62434844487a5b385f7694d1f46eb6c838d2183ca368ca4f2a',
    command:
      '.venv/bin/python3 tools/asm-processor/build.py --input-enc=utf-8 --output-enc=euc-jp --convert-statics=global-with-filename tools/ido/macos/7.1/cc -- mips-linux-gnu-as -march=vr4300 -32 -G0 -- -c -G 0 -non_shared -Xcpluscomm -nostdinc -Wab,-r4300_mul -DVERSION_JP=1 -Iinclude -Isrc -Iassets/jp -I. -Ibuild -Ilib/ultralib/include -Ilib/ultralib/include/PR -Ilib/ultralib/include/compiler/ido -fullwarn -verbose -woff 624,649,838,712,516,513,596,564,594 -mips2 -EB -DLANGUAGE_C -D_LANGUAGE_C -D_MIPS_SZLONG=32 -DF3DEX_GBI_2 -DNDEBUG -D_FINALROM -DBUILD_VERSION=VERSION_L -O2 -g3 -o build/src/code/gfxalloc.o src/code/gfxalloc.c',
  },
};
const MP3_WINDOW: Unit = {
  path: 'src/window.c',
  cflags: ['-O1', '-G0', '-mips3', '-mgp32', '-mfp32', '-Wa,--vr4300mul-off'],
  flagsFrom: {
    ...MP3_MAKEFILE,
    command:
      'export COMPILER_PATH=tools/gcc_2.7.2/mac && tools/gcc_2.7.2/mac/gcc -O1 -G0 -mips3 -mgp32 -mfp32 -Wa,--vr4300mul-off -D_LANGUAGE_C -DOLD_GCC -I include -I build/include -I src -DF3DEX_GBI_2 -D_LANGUAGE_C -c -o build/src/window.c.o src/window.c',
  },
};
const MP3_PAUSE: Unit = {
  path: 'src/pause.c',
  cflags: ['-O1', '-G0', '-mips3', '-mgp32', '-mfp32', '-fno-common'],
  flagsFrom: {
    ...MP3_MAKEFILE,
    command:
      'export COMPILER_PATH=tools/gcc_2.7.2/mac && tools/gcc_2.7.2/mac/gcc -O1 -G0 -mips3 -mgp32 -mfp32 -D_LANGUAGE_C -fno-common -I include -I build/include -I src -DF3DEX_GBI_2 -D_LANGUAGE_C -c -o build/src/pause.c.o src/pause.c',
  },
};
const MP3_8ACD0: Unit = {
  path: 'src/8ACD0.c',
  cflags: ['-O2', '-G0', '-mips3', '-mgp32', '-mfp32', '-Wa,--vr4300mul-off'],
  flagsFrom: {
    ...MP3_MAKEFILE,
    command:
      'export COMPILER_PATH=tools/gcc_2.7.2/mac && tools/gcc_2.7.2/mac/gcc -O2 -G0 -mips3 -mgp32 -mfp32 -Wa,--vr4300mul-off -D_LANGUAGE_C -DOLD_GCC -I include -I build/include -I src -DF3DEX_GBI_2 -D_LANGUAGE_C -c -o build/src/8ACD0.c.o src/8ACD0.c',
  },
};
const MP4_MAP: Unit = {
  path: 'src/REL/m427Dll/map.c',
  cflags: ['-O4,p', '-inline', 'auto', '-pragma', 'scheduling off', '-str', 'reuse,', 'readonly', '-O0,p'],
  flagsFrom: {
    from: 'objdiff',
    commit: '0123456789abcdef0123456789abcdef01234567',
    file: 'objdiff.json',
    sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    unit: 'm427Dll/map',
    cFlags:
      '-nodefaults -O4,p -inline auto -pragma "scheduling off" -str reuse, readonly -maxerrors 1 -nosyspath -O0,p',
  },
};

export const FLAGS_SAMPLE: readonly FunctionResult[] = [
  row('sa3:AbsMax:agbcc', SA3_MATH),
  row('sa3:SeedRng:agbcc', SA3_MATH),
  row('sa3:VerifyFlashSector_Core:agbcc', SA3_FLASH),
  row('af:gfxopen:ido7.1', AF_GFXALLOC),
  row('marioparty3:func_800600C0_60CC0:gcc2.7.2', MP3_WINDOW),
  row('marioparty3:func_8006014C_60D4C:gcc2.7.2', MP3_WINDOW),
  row('marioparty3:func_80045350_45F50:gcc2.7.2', MP3_PAUSE),
  row('marioparty3:func_8008A0D0_8ACD0:gcc2.7.2', MP3_8ACD0),
  row('marioparty4:fn_1_C2BC:mwcc_242_81', MP4_MAP),
  row('synthetic:clamp0:mwcc_242_81', null),
];

export const sampleRow = (sym: string): FunctionResult => FLAGS_SAMPLE.find((r) => r.sym === sym)!;
