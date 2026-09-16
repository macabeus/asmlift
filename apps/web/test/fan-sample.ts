// A small ranked sample for the Fan Explorer's tests: the fan fields the producer wrote for these
// rows (`winnerVariations`, `fanSize`, `fanVariations`), and nothing else a row carries. Typed as
// `FunctionResult`, so a renamed or reshaped field fails `tsc` here instead of leaving a stale copy.
//
// It holds the states the tests need together: three toolchains, a noncompile row whose whole fan
// was dropped, withheld candidates, a winner carrying a subject (`coalesce-v1-v0`), and fans of 5
// to 800.
import type { DecompilerResult, FunctionResult, Outcome, ToolchainId } from '@asmlift/bench-schema';
import { canonicalFlagsOf } from '@asmlift/core/target';

type Tally = { candidates: number; dropped?: number; withheld?: number };

/** A real row's flags are its unit's, copied from the committed manifests; a synthetic row's are its
 *  toolchain's canonical flags. */
const UNIT_FLAGS: Record<string, string[]> = {
  sa3: ['-fhex-asm', '-mthumb-interwork', '-O2'],
  marioparty3: ['-O1', '-G0', '-mips3', '-mgp32', '-mfp32', '-Wa,--vr4300mul-off'],
  snowboardkids2: [
    '-x',
    'c',
    '-mabi=32',
    '-mgp32',
    '-mfp32',
    '-mno-abicalls',
    '-fno-PIC',
    '-G',
    '0',
    '-Wa,-force-n64align',
    '-funsigned-char',
    '-mips3',
    '-EB',
    '-O2',
    '-fno-builtin',
    '-fno-asm',
  ],
};

/** The build unit every real row of the sample compiles in. */
const UNIT = {
  unit: 'src/sample.c',
  flagsFrom: { from: 'makefile', commit: 'a'.repeat(40), file: 'Makefile', sha256: 'b'.repeat(64), command: 'cc1' },
} as const;

/** A synthetic sample row compiles at its toolchain's canonical flags — so a toolchain that has
 *  none cannot have one, and says so here rather than producing a row with no flags. */
function canonicalCflags(toolchain: ToolchainId): string[] {
  const flags = canonicalFlagsOf(toolchain);
  if (flags === undefined) {
    throw new Error(`${toolchain} has no canonical flags: it compiles no synthetic row`);
  }
  return [...flags];
}

const ISA: Partial<Record<ToolchainId, FunctionResult['isa']>> = {
  agbcc: 'arm',
  'gcc2.7.2': 'mips',
  'gcc2.7.2kmc': 'mips',
};

function unscored(decompiler: DecompilerResult['decompiler'], outcome: Outcome): DecompilerResult {
  return {
    decompiler,
    outcome,
    source: '',
    score: null,
    maxScore: null,
    compileErrors: null,
    quality: { score: 0, lines: 0, gotos: 0, casts: 0, unkGlue: 0, rawMem: 0, addrDeref: 0 },
  };
}

function ranked(
  id: string,
  outcome: Outcome,
  winnerVariations: readonly string[] | undefined,
  fanVariations: Record<string, Tally>,
): FunctionResult {
  const [project, sym, toolchain] = id.split(':') as [string, string, ToolchainId];
  return {
    id,
    sym,
    project,
    ...(project === 'synthetic' ? { tier: 'synthetic' as const } : { tier: 'real' as const, ...UNIT }),
    toolchain,
    isa: ISA[toolchain]!,
    compiler: toolchain,
    language: 'c',
    cflags: project === 'synthetic' ? canonicalCflags(toolchain) : UNIT_FLAGS[project],
    features: [],
    loc: 0,
    refSource: '',
    targetAsm: '',
    asmlift: {
      ...unscored('asmlift', outcome),
      ...(winnerVariations ? { winnerVariations } : {}),
      // every candidate carries exactly one signedness
      fanSize: (fanVariations.unsigned?.candidates ?? 0) + (fanVariations.signed?.candidates ?? 0),
      fanVariations,
    },
    m2c: unscored('m2c', 'declined'),
  };
}

export const FAN_SAMPLE: readonly FunctionResult[] = [
  ranked('synthetic:dmafield:agbcc', 'match', ['signed', 'livebase', 'volatile', 'nearbase', 'initfirst'], {
    signed: { candidates: 50 },
    unsigned: { candidates: 50 },
    defsite: { candidates: 52 },
    'expr-home': { candidates: 42 },
    'loop-entry': { candidates: 52 },
    initfirst: { candidates: 16 },
    livebase: { candidates: 48 },
    nearbase: { candidates: 42 },
    offmember: { candidates: 10 },
    sinkinit: { candidates: 12 },
    unfolded: { candidates: 8 },
    'vol-store': { candidates: 10 },
    volatile: { candidates: 28 },
  }),
  ranked(
    'synthetic:sizebound:agbcc',
    'nonmatch',
    ['signed', 'expr-home', 'uns-cmp', 'livebase-block', 'volatile', 'initfirst', 'pollread'],
    {
      signed: { candidates: 400 },
      unsigned: { candidates: 400 },
      defsite: { candidates: 304 },
      'expr-home': { candidates: 456 },
      'loop-entry': { candidates: 304 },
      'uns-cmp': { candidates: 400 },
      initfirst: { candidates: 248 },
      livebase: { candidates: 256 },
      'livebase-block': { candidates: 256 },
      mulfirst: { candidates: 48 },
      nearbase: { candidates: 240 },
      pollread: { candidates: 400 },
      sinkinit: { candidates: 160 },
      unfolded: { candidates: 64 },
      'vol-store': { candidates: 48 },
      volatile: { candidates: 336 },
    },
  ),
  ranked('synthetic:armhomes:agbcc', 'match', ['signed', 'livebase', 'volatile', 'coalesce-v1-v0', 'initfirst'], {
    signed: { candidates: 82 },
    unsigned: { candidates: 82 },
    defsite: { candidates: 80 },
    'expr-home': { candidates: 68 },
    'flip-join': { candidates: 82 },
    'loop-entry': { candidates: 80 },
    coalesce: { candidates: 84 },
    initfirst: { candidates: 52 },
    livebase: { candidates: 96 },
    'vol-store': { candidates: 20 },
    volatile: { candidates: 48 },
  }),
  ranked('synthetic:dmaptrsrc:agbcc', 'match', ['unsigned', 'vol-store', 'unreduce', 'ptr-field'], {
    signed: { candidates: 8, withheld: 2 },
    unsigned: { candidates: 8, withheld: 2 },
    nearbase: { candidates: 4 },
    'ptr-field': { candidates: 4 },
    sinkinit: { candidates: 2 },
    unreduce: { candidates: 6, withheld: 4 },
    'vol-store': { candidates: 6, withheld: 2 },
  }),
  ranked('synthetic:gcsefwd:agbcc', 'match', ['unsigned', 'shared-tail', 'reread-globals', 'uns-cmp'], {
    unsigned: { candidates: 204 },
    'shared-tail': { candidates: 96 },
    'derived-home': { candidates: 68 },
    'flip-branch': { candidates: 48 },
    'flip-join': { candidates: 102 },
    'reread-globals': { candidates: 68 },
    'uns-cmp': { candidates: 102 },
    basefold: { candidates: 24 },
    livebase: { candidates: 36 },
    offmember: { candidates: 48 },
    sinkinit: { candidates: 12 },
    unmerge: { candidates: 48 },
    'raw-globals': { candidates: 156 },
  }),
  ranked('sa3:sub_803213C:agbcc', 'match', ['unsigned', 'setup-args', 'merge-home', 'offmember'], {
    unsigned: { candidates: 36, dropped: 18 },
    'setup-args': { candidates: 18 },
    'flip-join': { candidates: 18, dropped: 9 },
    'merge-home': { candidates: 20, dropped: 10 },
    basefold: { candidates: 16, dropped: 8 },
    offmember: { candidates: 8, dropped: 4 },
    regcopy: { candidates: 4, dropped: 2 },
    sinkinit: { candidates: 8, dropped: 4 },
  }),
  ranked('sa3:sub_806132C:agbcc', 'noncompile', undefined, {
    unsigned: { candidates: 5, dropped: 5 },
    livebase: { candidates: 1, dropped: 1 },
    'ptr-field': { candidates: 1, dropped: 1 },
    sinkinit: { candidates: 1, dropped: 1 },
    unfolded: { candidates: 1, dropped: 1 },
  }),
  ranked('marioparty3:GWBoardRecordGet:gcc2.7.2', 'nonmatch', ['signed'], {
    signed: { candidates: 8 },
    unsigned: { candidates: 8 },
    'flip-join': { candidates: 8 },
    'fresh-merge': { candidates: 8 },
    'raw-globals': { candidates: 8 },
  }),
  ranked('snowboardkids2:func_80038000_38C00:gcc2.7.2kmc', 'match', ['unsigned'], {
    signed: { candidates: 16 },
    unsigned: { candidates: 8 },
    defsite: { candidates: 12 },
    'flip-join': { candidates: 12 },
    'uns-cmp': { candidates: 8 },
    'raw-globals': { candidates: 12 },
  }),
];
