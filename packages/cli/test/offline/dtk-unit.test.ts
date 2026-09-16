// A dtk project's flags (src/dtk-unit.ts + src/flags.ts): the `objdiff.json` unit whose target object
// defines the function. The fixtures under fixtures/dtk are units cut verbatim from the three GameCube
// checkouts' objdiff.json (Mario Party 4 147b165a, Animal Crossing 09ca8e8b, Pikmin 35e28e7c); the
// target objects are written here, since the real ones are split from game binaries.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import YAML from 'yaml';

import { type DtkLookup, elfDefines, readObjdiffUnits, unitDefining } from '../../src/dtk-unit';
import { type FlagsInput, resolveFlags } from '../../src/flags';
import { runCli } from '../../src/main';

const FIXTURES = join(import.meta.dirname, 'fixtures');

/** A relocatable ELF32 object whose symbol table defines `defined` and references `referenced`. */
function elfObject(defined: readonly string[], referenced: readonly string[] = [], littleEndian = false): Buffer {
  const u16 = (b: Buffer, v: number, o: number) => (littleEndian ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const u32 = (b: Buffer, v: number, o: number) => (littleEndian ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  const table = () => {
    const bytes: number[] = [0];
    const add = (s: string) => {
      const at = bytes.length;
      bytes.push(...Buffer.from(s), 0);
      return at;
    };
    return { add, done: () => Buffer.from(bytes) };
  };
  const strtab = table();
  const syms = [
    { name: 0, shndx: 0 },
    ...defined.map((s) => ({ name: strtab.add(s), shndx: 1 })),
    ...referenced.map((s) => ({ name: strtab.add(s), shndx: 0 })),
  ];
  const shstrtab = table();
  const sectionNames = ['.text', '.symtab', '.strtab', '.shstrtab'].map((s) => shstrtab.add(s));
  const symtab = Buffer.alloc(16 * syms.length);
  syms.forEach((s, i) => {
    u32(symtab, s.name, i * 16);
    u16(symtab, s.shndx, i * 16 + 14);
  });
  const strings = strtab.done();
  const sectionStrings = shstrtab.done();
  const symtabAt = 52;
  const stringsAt = symtabAt + symtab.length;
  const sectionStringsAt = stringsAt + strings.length;
  const shoff = sectionStringsAt + sectionStrings.length;
  const header = Buffer.alloc(52);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = 1;
  header[5] = littleEndian ? 1 : 2;
  header[6] = 1;
  u16(header, 1, 0x10);
  u32(header, shoff, 0x20);
  u16(header, 52, 0x28);
  u16(header, 40, 0x2e);
  u16(header, 5, 0x30);
  u16(header, 4, 0x32);
  const sections = Buffer.alloc(40 * 5);
  const section = (i: number, type: number, offset: number, size: number, link: number, entsize: number) => {
    u32(sections, sectionNames[i - 1], i * 40);
    u32(sections, type, i * 40 + 4);
    u32(sections, offset, i * 40 + 16);
    u32(sections, size, i * 40 + 20);
    u32(sections, link, i * 40 + 24);
    u32(sections, entsize, i * 40 + 36);
  };
  section(1, 8, symtabAt, 0, 0, 0);
  section(2, 2, symtabAt, symtab.length, 3, 16);
  section(3, 3, stringsAt, strings.length, 0, 0);
  section(4, 3, sectionStringsAt, sectionStrings.length, 0, 0);
  return Buffer.concat([header, symtab, strings, sectionStrings, sections]);
}

describe('an object defines a symbol', () => {
  test('in its symbol table, by exact name, in either byte order', () => {
    for (const le of [false, true]) {
      const o = elfObject(['clamp0', 'fn_1_C2BC'], ['OSReport'], le);
      expect(elfDefines(o, 'clamp0')).toBe(true);
      expect(elfDefines(o, 'fn_1_C2BC')).toBe(true);
      expect(elfDefines(o, 'clamp'), 'a prefix is another name').toBe(false);
      expect(elfDefines(o, 'OSReport'), 'a reference is not a definition').toBe(false);
    }
  });

  test('a real agbcc object', () => {
    const o = readFileSync(join(FIXTURES, 'objdiff/target.o'));
    expect(elfDefines(o, 'add_one')).toBe(true);
    expect(elfDefines(o, 'add_two')).toBe(false);
    expect(elfDefines(Buffer.from('not an object add_one\0'), 'add_one')).toBe(false);
  });
});

/** A dtk project: decomp.yaml, one fixture's objdiff.json, and a target object for every unit that
 *  `defines` names. */
function project(fixture: string, defines: Record<string, readonly string[]>, compiler?: string) {
  const root = mkdtempSync(join(tmpdir(), 'asmlift-dtk-'));
  copyFileSync(join(FIXTURES, 'dtk', `${fixture}.json`), join(root, 'objdiff.json'));
  const units = readObjdiffUnits(root)!.units as { name: string; target_path: string }[];
  for (const [unit, symbols] of Object.entries(defines)) {
    const path = join(root, units.find((u) => u.name === unit)!.target_path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, elfObject(symbols));
  }
  writeFileSync(
    join(root, 'decomp.yaml'),
    YAML.stringify({ platform: 'gc', tools: { asmlift: compiler === undefined ? {} : { compiler } } }),
  );
  const asm = join(root, 'clamp0.asm');
  writeFileSync(asm, readFileSync(join(import.meta.dirname, '../../../core/test/corpus/ppc-clamp0.asm'), 'utf8'));
  return { root, asm, units };
}

const lookUp = (fixture: string, defines: Record<string, readonly string[]>, module?: string): DtkLookup => {
  const { root, units } = project(fixture, defines);
  return unitDefining(root, units, 'clamp0', module);
};

const REL_MAP = 'm427Dll/REL/m427Dll/map';

describe('the unit whose target object defines the function', () => {
  test('is found among every unit, and narrowed by module', () => {
    expect(lookUp('marioparty4', { [REL_MAP]: ['clamp0'], 'main/game/main': ['main'] })).toMatchObject({
      kind: 'found',
      unit: { name: REL_MAP, compiler: 'mwcc_242_81' },
    });
    const both = { 'm403Dll/REL/executor': ['clamp0'], [REL_MAP]: ['clamp0'] };
    expect(lookUp('marioparty4', both)).toMatchObject({
      kind: 'ambiguous',
      units: [{ name: 'm403Dll/REL/executor' }, { name: REL_MAP }],
    });
    expect(lookUp('marioparty4', both, 'm427Dll')).toMatchObject({ kind: 'found', unit: { name: REL_MAP } });
  });

  test('a unit with no target object is counted, not read', () => {
    expect(lookUp('ac-decomp', { 'static/boot': ['boot'] })).toEqual({ kind: 'none', unbuilt: 1 });
  });
});

const dtkInput = (over: Partial<FlagsInput> & { lookup: DtkLookup; module?: string }): FlagsInput => ({
  toolchain: 'mwcc_242_81',
  cflags: undefined,
  command: undefined,
  env: {},
  unreadObjdiff: undefined,
  configPath: undefined,
  ranked: false,
  ...over,
  dtk: { symbol: 'clamp0', module: over.module, lookup: over.lookup },
});

const unit = (fixture: string, name: string) => {
  const u = (
    JSON.parse(readFileSync(join(FIXTURES, 'dtk', `${fixture}.json`), 'utf8')) as {
      units: { name: string; scratch: { compiler: string; c_flags: string } }[];
    }
  ).units.find((x) => x.name === name)!;
  return { name: u.name, compiler: u.scratch.compiler, cflags: u.scratch.c_flags };
};

describe('the flags a dtk unit gives', () => {
  test("its effective codegen flags, and what its build's later words overrode", () => {
    const r = resolveFlags(dtkInput({ lookup: { kind: 'found', unit: unit('marioparty4', REL_MAP) } }));
    expect(r.ok && r.lines).toBe(
      'asmlift: [flags] -proc gekko -align powerpc -enum int -fp hardware -Cpp_exceptions off -inline auto -RTTI off ' +
        '-str reuse -O0,p -char unsigned -fp_contract off -sdata 0 -sdata2 0 -pool off -lang=c ' +
        `(objdiff.json unit ${REL_MAP})\n` +
        'asmlift: [flags] note: -O4,p overridden by later -O0,p\n' +
        'asmlift: [flags] note: -fp_contract on overridden by later -fp_contract off\n',
    );
    const boot = resolveFlags(dtkInput({ lookup: { kind: 'found', unit: unit('ac-decomp', 'static/boot') } }));
    expect(boot.ok && boot.resolved.profile.slots.O).toBe('4,s');
  });

  test("a unit compiled by another compiler is refused, unless the command takes the unit's through {{cc}}", () => {
    const main = unit('marioparty4', 'main/game/main');
    const refused = resolveFlags(dtkInput({ lookup: { kind: 'found', unit: main } }));
    // a plain run with no compile command: the unit's flags, quoted to paste, are the one way on
    expect(refused).toEqual({
      ok: false,
      message:
        'objdiff.json unit main/game/main is compiled by mwcc_247_107, and the target is mwcc_242_81; asmlift has no ' +
        `mwcc_247_107 target: pass --cflags '${main.cflags}' to give the unit's flags yourself`,
    });
    const compiled = resolveFlags(
      dtkInput({
        lookup: { kind: 'found', unit: main },
        command: 'wibo mwcceppc.exe -c {{cflags}} -o {{outputPath}} {{inputPath}}',
      }),
    );
    expect(compiled).toMatchObject({
      ok: false,
      message: expect.stringMatching(
        /target: write \{\{cc\}\} in tools\.asmlift\.compiler where the compiler's name goes to compile with the unit's compiler, or pass --cflags '.*' to give the unit's flags yourself$/,
      ),
    });
    const mwccUnitOnAgbcc = resolveFlags(
      dtkInput({ toolchain: 'agbcc', lookup: { kind: 'found', unit: { ...main, compiler: 'mwcc_242_81' } } }),
    );
    expect(mwccUnitOnAgbcc).toMatchObject({
      ok: false,
      message: expect.stringMatching(
        /the target is agbcc: pass --target mwcc_242_81, or pass --cflags '.*' to give the unit's flags yourself$/,
      ),
    });
    const dummyprobe = unit('pikmin', 'main/jaudio/dummyprobe');
    const command = 'wibo compilers/{{cc}}/mwcceppc.exe -c {{cflags}} -o {{outputPath}} {{inputPath}}';
    const taken = resolveFlags(dtkInput({ lookup: { kind: 'found', unit: dummyprobe }, command, ranked: true }));
    expect(taken).toMatchObject({ ok: true, cc: 'mwcc_233_163n' });
    expect(taken.ok && taken.fill).toEqual(
      expect.arrayContaining(['-pragma', 'scheduling 7400', '-str', 'reuse,', 'readonly']),
    );
    expect(taken.ok && taken.lines).toContain(`-pragma 'scheduling 7400'`);
    expect(taken.ok && taken.lines).toContain(`(objdiff.json unit main/jaudio/dummyprobe)\n`);
  });

  test('several defining units are listed by module, at most five, with the ways to choose', () => {
    const units = [unit('marioparty4', 'm403Dll/REL/executor'), unit('marioparty4', REL_MAP)];
    expect(resolveFlags(dtkInput({ lookup: { kind: 'ambiguous', units } }))).toEqual({
      ok: false,
      message:
        'clamp0 is defined by an objdiff.json unit in each of 2 modules (m403Dll, m427Dll); pass --module <module> to ' +
        'choose one, or --cflags',
    });
    expect(resolveFlags(dtkInput({ lookup: { kind: 'ambiguous', units }, module: 'm427Dll' }))).toMatchObject({
      ok: false,
      message: `clamp0 is defined by 2 objdiff.json units (m403Dll/REL/executor, ${REL_MAP}); pass --cflags`,
    });
    const executors = Array.from({ length: 92 }, (_, k) => ({ ...units[0], name: `m${400 + k}Dll/REL/executor` }));
    expect(resolveFlags(dtkInput({ lookup: { kind: 'ambiguous', units: executors } }))).toEqual({
      ok: false,
      message:
        'clamp0 is defined by an objdiff.json unit in each of 92 modules (m400Dll, m401Dll, m402Dll, m403Dll, ' +
        'm404Dll, and 87 more); pass --module <module> to choose one, or --cflags',
    });
  });

  test('no defining unit is a note, and the command gives the flags', () => {
    const command = 'wibo mwcceppc.exe -c -O4,p -o {{outputPath}} {{inputPath}}';
    const r = resolveFlags(dtkInput({ lookup: { kind: 'none', unbuilt: 2 }, command, module: 'm427Dll' }));
    expect(r.ok && r.lines).toBe(
      'asmlift: [flags] -O4,p (compiler command)\n' +
        'asmlift: [flags] note: objdiff.json has no unit defining clamp0 in module m427Dll (2 units have no target ' +
        'object to read); reading the compiler command\n',
    );
  });

  test('a ranked run through a unit: the command must take the flags, and {{cc}} needs a unit', () => {
    const map = unit('marioparty4', REL_MAP);
    const literal = 'wibo mwcceppc.exe -c -O4,p -o {{outputPath}} {{inputPath}}';
    expect(
      resolveFlags(dtkInput({ lookup: { kind: 'found', unit: map }, command: literal, ranked: true })),
    ).toMatchObject({
      ok: false,
      message: expect.stringMatching(
        new RegExp(
          `^objdiff.json unit ${REL_MAP} gives the flags, and tools.asmlift.compiler has no \\{\\{cflags\\}\\}`,
        ),
      ),
    });
    const cc = 'wibo compilers/{{cc}}/mwcceppc.exe -c {{cflags}} -o {{outputPath}} {{inputPath}}';
    expect(resolveFlags(dtkInput({ lookup: { kind: 'none', unbuilt: 0 }, command: cc, ranked: true }))).toEqual({
      ok: false,
      message:
        'tools.asmlift.compiler takes its flags through {{cflags}}, and nothing gives them: pass --cflags "<the flags your build compiles this file with>"',
    });
    expect(
      resolveFlags({
        ...dtkInput({ lookup: { kind: 'none', unbuilt: 0 }, command: cc, ranked: true }),
        cflags: '-O4,p',
        dtk: undefined,
      }),
    ).toEqual({
      ok: false,
      message:
        "tools.asmlift.compiler takes an objdiff.json unit's compiler through {{cc}}, and --cflags gives the flags without one",
    });
  });
});

describe('at the CLI surface', () => {
  test('a plain decompile reads the unit beside decomp.yaml', async () => {
    const { asm } = project('marioparty4', { [REL_MAP]: ['clamp0'] });
    const r = await runCli([asm]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`(objdiff.json unit ${REL_MAP})\n`);
    expect(r.stdout).toContain('clamp0');
  });

  test('--module narrows the lookup; a module with no units and a --module with nothing to narrow are refused', async () => {
    const { asm, root } = project('marioparty4', { 'm403Dll/REL/executor': ['clamp0'], [REL_MAP]: ['clamp0'] });
    expect((await runCli([asm])).stderr).toMatch(
      /^asmlift: clamp0 is defined by an objdiff.json unit in each of 2 modules/,
    );
    expect((await runCli([asm, '--module', 'm427Dll'])).stderr).toContain(`(objdiff.json unit ${REL_MAP})\n`);
    expect(await runCli([asm, '--module', 'm999Dll'])).toEqual({
      code: 64,
      stdout: '',
      stderr: `asmlift: --module m999Dll: ${join(root, 'objdiff.json')} has no unit in it\n`,
    });
    // --module has two jobs, the unit lookup here and the module's symbol map; a project that
    // offers it NEITHER is a discarded intent rather than a default
    expect(await runCli([asm, '--module', 'm427Dll', '--cflags', '-O4,p'])).toEqual({
      code: 64,
      stdout: '',
      stderr:
        'asmlift: --module names the module whose objdiff.json unit gives the flags and whose ELF gives the symbols, and --cflags gives the flags without one, and tools.asmlift.elf is unset, so there is no module ELF beside it\n',
    });
    const bare = mkdtempSync(join(tmpdir(), 'asmlift-nodtk-'));
    writeFileSync(join(bare, 'decomp.yaml'), 'platform: gc\n');
    expect((await runCli([asm, '--config', join(bare, 'decomp.yaml'), '--module', 'm427Dll'])).stderr).toBe(
      'asmlift: --module names the module whose objdiff.json unit gives the flags and whose ELF gives the symbols, and there is no objdiff.json beside decomp.yaml, and tools.asmlift.elf is unset, so there is no module ELF beside it\n',
    );
  });
});
