import { describe, expect, test } from 'vitest';

import {
  type FlagFamily,
  UnreadableLevelError,
  effectiveFlags,
  optLevel,
  parseFlags,
  profileKey,
  shellJoinFlags,
  storedFlags,
  tokenizeFlags,
  unitLanguage,
} from '../src/codegen-flags';
import {
  ARMV4T_AGBCC,
  MIPS_GCC,
  MIPS_IDO,
  PPC_MWCC,
  TOOLCHAIN_TARGETS,
  type TargetDescription,
  type ToolchainId,
  canonicalFlagsOf,
  isCanonicalToolchainId,
  isToolchainId,
  structureOptionsFor,
  targetFor,
} from '../src/target';

const DESCRIPTIONS: Record<ToolchainId, TargetDescription> = {
  agbcc: ARMV4T_AGBCC,
  'ido7.1': MIPS_IDO,
  'gcc2.7.2kmc': MIPS_GCC,
  'gcc2.7.2': MIPS_GCC,
  mwcc_242_81: PPC_MWCC,
  mwcc_233_163n: PPC_MWCC,
  mwcc_247_107: PPC_MWCC,
};
const IDS = Object.keys(TOOLCHAIN_TARGETS).filter(isToolchainId);
/** the toolchains that HAVE canonical flags — the questions below that are about a flag set */
const CANONICAL_IDS = IDS.filter(isCanonicalToolchainId);

describe('targetFor', () => {
  test.each(CANONICAL_IDS)('%s at its canonical flags is its description', (id) => {
    expect(targetFor(id, TOOLCHAIN_TARGETS[id].canonicalFlags).target).toBe(DESCRIPTIONS[id]);
  });

  // A toolchain with no synthetic tier has no canonical flags, and every flag set still resolves to
  // its description — what it lacks is a set to fall back ON, not a reading.
  test.each(IDS.filter((id) => !isCanonicalToolchainId(id)))('%s has no canonical flags at all', (id) => {
    expect(canonicalFlagsOf(id)).toBeUndefined();
    expect(targetFor(id, ['-proc', 'gekko', '-O0,p']).target).toBe(DESCRIPTIONS[id]);
  });

  // A profile of a compiler inherits its declarations. Withholding them would not claim nothing:
  // ido7.1 declares coalesceLoopInit TRUE and switchAllowsNeqCase FALSE, and the structurer's
  // absent value is the opposite of both.
  test.each([
    ['agbcc', ['-O1', '-mthumb-interwork']],
    ['agbcc', ['-mthumb-interwork', '-O2', '-fhex-asm', '-g', '-ansi']],
    ['ido7.1', ['-mips2', '-O2', '-g3', '-32', '-non_shared', '-G', '0']],
    ['gcc2.7.2kmc', [...TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags, '-Wa,-force-n64align', '-x', 'c']],
    ['mwcc_242_81', ['-O0,p', '-inline', 'auto', '-sdata', '8']],
  ] as const)('%s at %j keeps every declared behavior', (id, flags) => {
    const r = targetFor(id, flags);
    expect(r.target).toBe(DESCRIPTIONS[id]);
    expect(structureOptionsFor(r.target, false)).toEqual(structureOptionsFor(DESCRIPTIONS[id], false));
  });

  test.each(CANONICAL_IDS)('%s’s canonical flags are in normal form and every word is in its family’s table', (id) => {
    const { family, canonicalFlags } = TOOLCHAIN_TARGETS[id];
    expect(storedFlags(family, canonicalFlags)).toEqual(canonicalFlags);
    expect(parseFlags(family, canonicalFlags).unclassified).toEqual([]);
  });

  test('a toolchain id is a key of the registry and nothing else', () => {
    expect(IDS).toEqual(['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107']);
    expect(isToolchainId('toString')).toBe(false);
  });
});

describe('parsing', () => {
  test('the shell words of a dtk unit', () => {
    expect(tokenizeFlags(`-pragma "cats off" -str reuse, readonly -d MUST_MATCH`)).toEqual([
      '-pragma',
      'cats off',
      '-str',
      'reuse,',
      'readonly',
      '-d',
      'MUST_MATCH',
    ]);
    expect(() => tokenizeFlags('-pragma "cats off -O4,p')).toThrow('unterminated " quote at column 9');
  });

  test('inside double quotes a backslash escapes only what sh lets it escape', () => {
    expect(tokenizeFlags('-DX="a\\b" -DY="c\\"d" -DZ=e\\f')).toEqual(['-DX=a\\b', '-DY=c"d', '-DZ=ef']);
  });

  test('a backslash-newline continues the line, inside quotes or out', () => {
    expect(tokenizeFlags('-O2 \\\n-g')).toEqual(['-O2', '-g']);
    expect(tokenizeFlags('"-DA=x\\\ny" -O2')).toEqual(['-DA=xy', '-O2']);
  });

  test('the last level wins, and only an override that changes a value is reported', () => {
    const argv = tokenizeFlags('-O4,p -inline auto -O0,p -fp hardware -sym on -sym on');
    const p = parseFlags('mwcc', argv);
    expect(p.slots).toEqual({ O: '0,p', inline: 'auto', fp: 'hard', sym: 'on' });
    expect(p.overrides).toEqual(['-O4,p overridden by later -O0,p']);
    expect(effectiveFlags('mwcc', argv)).toEqual(['-inline', 'auto', '-O0,p', '-fp', 'hardware', '-sym', 'on']);
    expect(optLevel('mwcc', argv)).toBe('-O0,p');
    expect(profileKey(parseFlags('mwcc', tokenizeFlags('-O4 -str reuse, readonly')))).toBe('O=4 str=reuse,readonly');
  });

  test('mwcc options whose occurrences add up are never overrides', () => {
    const p = parseFlags('mwcc', tokenizeFlags('-inline auto -inline deferred'));
    expect(p.slots.inline).toBe('auto deferred');
    expect(p.spelled.inline).toBe('-inline auto -inline deferred');
    expect(p.overrides).toEqual([]);
    expect(p.overriddenAt).toEqual([]);
    const key = (s: string) => profileKey(parseFlags('mwcc', tokenizeFlags(s)));
    expect(key('-str noreuse -str pool,readonly')).not.toBe(key('-str pool,readonly'));
    expect(key('-inline auto -inline deferred')).not.toBe(key('-inline deferred'));
  });

  test('slots do not depend on the order of the flags; toggles and unclassified words do', () => {
    const key = (family: 'gcc' | 'agbcc', s: string) => profileKey(parseFlags(family, tokenizeFlags(s)));
    expect(key('gcc', '-G0 -mips3 -mgp32 -O1')).toBe(key('gcc', '-mgp32 -mips3 -mips3 -O1 -G 0'));
    expect(key('agbcc', '-O2 -fcommon -fno-common')).not.toBe(key('agbcc', '-O2 -fno-common -fcommon'));
    expect(key('agbcc', '-ansi -traditional')).not.toBe(key('agbcc', '-traditional -ansi'));
    expect(key('agbcc', '-ansi -ansi')).toBe(key('agbcc', '-ansi'));
    expect(parseFlags('mwcc', tokenizeFlags('-sdatathreshold 0 -vector on')).slots).toEqual({
      sdatathreshold: '0',
      vector: 'on',
    });
  });

  test('the level each family acts on: its own grammar, its default, and what -g does to it', () => {
    expect(optLevel('agbcc', ['-O'])).toBe('-O1');
    expect(optLevel('agbcc', ['-O9'])).toBe('-O3');
    expect(optLevel('agbcc', ['-mthumb-interwork'])).toBe('-O0');
    expect(optLevel('agbcc', ['-O2', '-Os'])).toBe('-Os');
    expect(optLevel('agbcc', ['-O2', '-O1'])).toBe('-O1');
    expect(optLevel('ido', ['-O'])).toBe('-O2');
    expect(optLevel('ido', ['-mips2'])).toBe('-O1');
    expect(optLevel('ido', ['-O1', '-O2'])).toBe('-O2');
    const debug = parseFlags('ido', ['-O2', '-g']);
    expect(debug.slots).toEqual({ O: '1', g: '2' });
    expect(debug.spelled.O).toBe('-O2');
    expect(debug.implied).toEqual(['ido does not optimise with -g or -g1: -O2 compiles as -O1 (-g3 keeps both)']);
    expect(profileKey(debug)).toBe(profileKey(parseFlags('ido', ['-g'])));
    expect(profileKey(parseFlags('ido', ['-O2', '-g1']))).toBe(profileKey(parseFlags('ido', ['-g1'])));
    expect(optLevel('ido', ['-O3', '-g'])).toBe('-O3');
    expect(optLevel('ido', ['-O2', '-g3'])).toBe('-O2');
    expect(parseFlags('ido', ['-Olimit', '3000', '-O2']).slots).toEqual({ Olimit: '3000', O: '2' });
    expect(optLevel('mwcc', ['-O4'])).toBe('-O4');
    expect(profileKey(parseFlags('mwcc', ['-O4']))).not.toBe(profileKey(parseFlags('mwcc', ['-O4,p'])));
    expect(optLevel('mwcc', ['-O4,p', '-O0,p'])).toBe('-O0,p');
    expect(optLevel('mwcc', ['-O'])).toBe('-O2');
    expect(optLevel('mwcc', ['-Os'])).toBe('-O0,s');
  });

  test('mwcc reads a level and a mode apart: a mode holds across levels, and a lower level after -O4 adds to it', () => {
    const level = (s: string) => optLevel('mwcc', tokenizeFlags(s));
    const key = (s: string) => profileKey(parseFlags('mwcc', tokenizeFlags(s)));
    expect(level('-O4 -Op')).toBe('-O4,p');
    expect(level('-Op -O4')).toBe('-O4,p');
    expect(level('-O4,p -O0')).toBe('-O0,p');
    expect(level('-Op')).toBe('-O0,p');
    expect(level('-O3 -O2')).toBe('-O2');
    expect(key('-O4 -Os')).not.toBe(key('-Os'));
    expect(level('-O4,p -O2,p')).toBe('-O4 -O2,p');
    expect(key('-O4,p -O2,p')).not.toBe(key('-O2,p'));
    const sticky = parseFlags('mwcc', tokenizeFlags('-O4 -Op'));
    expect(sticky.overrides).toEqual([]);
    expect(sticky.overriddenAt).toEqual([]);
    expect(sticky.spelled.O).toBe('-O4 -Op');
    const modes = parseFlags('mwcc', tokenizeFlags('-O4 -Op -Os'));
    expect(modes.overriddenAt).toEqual([1]);
    expect(modes.overrides).toEqual(['-Op overridden by later -Os']);
    expect(effectiveFlags('mwcc', tokenizeFlags('-O4 -Op -Os'))).toEqual(['-O4', '-Os']);
  });

  test('mwcc -O1 after -O2 or -O3 keeps what they turned on, and says the words read together', () => {
    const level = (s: string) => optLevel('mwcc', tokenizeFlags(s));
    const key = (s: string) => profileKey(parseFlags('mwcc', tokenizeFlags(s)));
    expect(key('-O2 -O1')).not.toBe(key('-O1'));
    expect(key('-O1 -O2 -O1')).toBe(key('-O2 -O1'));
    expect(key('-O2 -O1,p')).not.toBe(key('-O1,p'));
    expect(level('-O2 -O1 -O2')).toBe('-O2');
    expect(level('-O2 -O1 -O3')).toBe('-O3');
    expect(level('-O4 -O2 -O1')).toBe('-O4 -O1');
    const together = parseFlags('mwcc', tokenizeFlags('-O2 -O1'));
    expect(together.overrides).toEqual([]);
    expect(together.implied).toEqual(['mwcc reads -O2 -O1 as neither level alone']);
    expect(parseFlags('mwcc', tokenizeFlags('-O4,p -O2')).implied).toEqual([
      'mwcc reads -O4,p -O2 as -O4 -O2,p, neither level alone',
    ]);
    expect(parseFlags('mwcc', tokenizeFlags('-O4 -O2 -O1')).overrides).toEqual(['-O2 overridden by later -O1']);
    expect(parseFlags('mwcc', tokenizeFlags('-O2 -O1 -O2')).overrides).toEqual(['-O1 overridden by later -O2']);
  });

  test('a level word the family cannot read is refused; any other -O word is left to the compiler', () => {
    expect(() => parseFlags('agbcc', ['-O4,p'])).toThrow(
      '-O4,p is not an optimisation level agbcc accepts; mwcc spells its levels that way',
    );
    expect(() => parseFlags('mwcc', ['-O+p'])).toThrow('-O+p is not an optimisation level mwcc accepts');
    expect(parseFlags('agbcc', ['-Og']).unclassified).toEqual(['-Og']);
    expect(parseFlags('ido', ['-Olimit', '3000']).unclassified).toEqual([]);
  });

  test('each option spans its argument words, and a word no table names spans the operand after it', () => {
    expect(parseFlags('gcc', ['-x', '-', '-O2']).spans).toEqual([[0, 1], [2]]);
    expect(parseFlags('mwcc', tokenizeFlags("-pragma 'cats off' -str reuse, readonly -O4,p")).spans).toEqual([
      [0, 1],
      [2, 3, 4],
      [5],
    ]);
    expect(parseFlags('agbcc', ['-ansi', 'x.c', '-O2', 'y.c']).spans).toEqual([[0, 1], [2], [3]]);
    // an option whose argument the argv ends before spans itself alone
    expect(parseFlags('mwcc', ['-O4,p', '-pragma']).spans).toEqual([[0], [1]]);
    expect(parseFlags('mwcc', ['-O4,p', '-str']).spans).toEqual([[0], [1]]);
    expect(parseFlags('gcc', ['-O2', '-x']).spans).toEqual([[0], [1]]);
  });

  test('a flag handed to another pass is codegen, a diagnostic is inert', () => {
    expect(parseFlags('ido', ['-Wo,-loopunroll,0']).unclassified).toEqual(['-Wo,-loopunroll,0']);
    expect(parseFlags('agbcc', ['-Wimplicit', '-Werror']).inertAt).toEqual([0, 1]);
  });

  test('a slot keeps the build’s own words', () => {
    expect(parseFlags('agbcc', ['-mthumb-interwork', '-O2', '-fno-hex-asm', '-fhex-asm']).spelled).toEqual({
      '-mthumb-interwork': '-mthumb-interwork',
      O: '-O2',
      '-fhex-asm': '-fhex-asm',
    });
  });

  test('a level word another family spells names that family', () => {
    const refusal = (family: FlagFamily, argv: string[]) => {
      try {
        parseFlags(family, argv);
      } catch (e) {
        return e instanceof UnreadableLevelError ? { word: e.word, family: e.family, spelledBy: e.spelledBy } : e;
      }
      return undefined;
    };
    expect(refusal('agbcc', ['-O4,p'])).toEqual({ word: '-O4,p', family: 'agbcc', spelledBy: 'mwcc' });
    expect(refusal('mwcc', ['-O+p'])).toEqual({ word: '-O+p', family: 'mwcc', spelledBy: undefined });
  });

  test('a word that is neither an option nor its argument is an operand', () => {
    const argv = ['-G', '0', 'in.c', '-O2', '$PRE_FILE', '-Og'];
    const p = parseFlags('gcc', argv);
    expect(p.operandAt).toEqual([2, 4]);
    expect(p.unclassified).toEqual(['in.c', '$PRE_FILE', '-Og']);
    const stdin = parseFlags('agbcc', ['-O1', '-', '-mthumb-interwork', '-']);
    expect(stdin.operandAt).toEqual([1, 3]);
    expect(stdin.overriddenAt).toEqual([]);
  });

  test("the gcc driver's program path is inert", () => {
    expect(storedFlags('gcc', ['-B', '/gcc272/', '-B/tools/', '-O1'])).toEqual(['-O1']);
  });

  test('flags joined as shell words read back as the same flags', () => {
    const argv = ['-pragma', 'cats off', '-DX="a b"', "-DY='c'", '', '-O4,p', '-str', 'reuse,', 'readonly'];
    expect(shellJoinFlags(argv)).toBe(`-pragma 'cats off' '-DX="a b"' '-DY='\\''c'\\''' '' -O4,p -str reuse, readonly`);
    expect(tokenizeFlags(shellJoinFlags(argv))).toEqual(argv);
  });

  test('a stored build drops inert words with their arguments and keeps every codegen word', () => {
    const pikmin = tokenizeFlags(
      '-nodefaults -proc gekko -w off -O4,p -i include -pragma "cats off" -str reuse, readonly',
    );
    expect(storedFlags('mwcc', pikmin)).toEqual(['-proc', 'gekko', '-O4,p', '-str', 'reuse,', 'readonly']);
    const pokeemerald = ['-mthumb-interwork', '-Wimplicit', '-Wparentheses', '-Werror', '-O2', '-fhex-asm', '-g'];
    expect(storedFlags('agbcc', pokeemerald)).toEqual(['-mthumb-interwork', '-O2', '-fhex-asm', '-g']);
  });
});

describe("a unit's language", () => {
  // CodeWarrior spells `-lang` two ways and one project uses both — Pikmin's game units say
  // `-lang=c++` and its jaudio units say `-lang c++`. Reading only the `=` form called those 57
  // units C, which would preprocess them against the wrong `#ifdef __cplusplus` branch.
  test('is whichever -lang word the build states last, in either spelling', () => {
    expect(unitLanguage('src/plugPikiKando/piki.cpp', ['-O4,p', '-lang=c++'])).toBe('c++');
    expect(unitLanguage('src/jaudio/aramcall.c', ['-O4,p', '-lang', 'c++'])).toBe('c++');
    expect(unitLanguage('src/static/m_house.c', ['-lang=c'])).toBe('c');
    expect(unitLanguage('src/u.c', ['-lang', 'c++', '-lang=c'])).toBe('c');
    expect(unitLanguage('src/u.c', ['-lang=c', '-lang', 'c++'])).toBe('c++');
  });

  // The extension is the FALLBACK and never the rule: 62 of Animal Crossing's `.c` units are
  // compiled `-lang=c++`, so a row's dialect cannot be read off its file name.
  test('falls back to the extension only when no flag names one', () => {
    expect(unitLanguage('src/static/jsyswrap.cpp', [])).toBe('c++');
    expect(unitLanguage('src/static/m_house.c', [])).toBe('c');
    expect(unitLanguage('src/static/m_house.c', ['-lang=c++'])).toBe('c++');
    expect(unitLanguage('src/static/jsyswrap.cpp', ['-lang=c'])).toBe('c');
  });
});
