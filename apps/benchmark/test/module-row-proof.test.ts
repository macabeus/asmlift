// How a GameCube REL row is proved by `bench vendor`.
//
// A row keyed by a linked address is proved against the ROM: the target it builds must be the
// function the project's linked ELF holds there. A row keyed by a REL MODULE LOCATION is proved the
// same way against its MODULE's ELF — the linked ELF holds no module's bytes — with the module's
// sections placed so its function has an address (`romLocation`). Before that, it is proved to be
// where it says it is: its module really does put that symbol at that section and that offset.
import { placeModuleSections } from '@asmlift/cli/module-elf';
import { describe, expect, test } from 'vitest';

import { compareWithRom, romLocation, targetDigest } from '../src/cases/rom-function';
import { moduleIdentityRefusal } from '../src/cases/vendor';
import { elf32 } from './elf32';

const EM_PPC = 20;

describe('romLocation', () => {
  // `bl 0 ; lis r3,0 ; lwz r3,0(r3) ; blr`, as the compiler writes it: a branch and an address pair
  // left for the linker
  const code = [0x48, 0x00, 0x00, 0x01, 0x3c, 0x60, 0x00, 0x00, 0x80, 0x63, 0x00, 0x00, 0x4e, 0x80, 0x00, 0x20];
  const relocs = [
    { offset: 0, type: 10 },
    { offset: 6, type: 6 },
    { offset: 10, type: 4 },
  ];
  const object = elf32({
    machine: EM_PPC,
    littleEndian: false,
    textAddr: 0,
    text: code,
    symbols: [{ name: 'p', value: 0, size: code.length }],
    relocs,
  });
  const linked = elf32({ machine: EM_PPC, littleEndian: false, textAddr: 0x80003000, text: [], symbols: [] });
  /** A module ELF as dtk links one: `.text` and `.data` both at 0, `p` at `.text+0x4` behind another
   *  function, and its relocated fields holding whatever the module link left in them. */
  const module = (pText: number[]) =>
    elf32({
      machine: EM_PPC,
      littleEndian: false,
      textAddr: 0,
      text: [0x4e, 0x80, 0x00, 0x20, ...pText],
      symbols: [
        { name: 'other', value: 0, size: 4 },
        { name: 'p', value: 4, size: pText.length },
      ],
      moreSections: [{ name: '.data', size: 0x20 }],
    });
  const placed = (bytes: Buffer) => () => placeModuleSections(bytes, 'foresta.plf');

  test('a linked address is read out of the linked ELF, at that address', () => {
    expect(romLocation('0x801d3a04', linked, () => expect.unreachable())).toEqual({ elf: linked, at: 0x801d3a04 });
  });

  test("a module location is read out of the module's own ELF, at its section's placed base plus its offset", () => {
    const asLinked = [0x48, 0x00, 0x12, 0x35, 0x3c, 0x60, 0x80, 0x0a, 0x80, 0x63, 0x12, 0x34, 0x4e, 0x80, 0x00, 0x20];
    const { elf, at } = romLocation('foresta:.text+0x00000004', linked, placed(module(asLinked)));
    expect(compareWithRom(object, 'p', elf, at)).toEqual({ equal: true, digest: targetDigest(object, 'p') });
  });

  // What the module comparison adds over proving the location alone: a target that is not the
  // module's function is refused even at the right section and offset.
  test("a target that is not the module's function is refused", () => {
    const otherRegister = [
      0x48, 0x00, 0x12, 0x35, 0x3c, 0x80, 0x80, 0x0a, 0x80, 0x63, 0x12, 0x34, 0x4e, 0x80, 0x00, 0x20,
    ];
    const { elf, at } = romLocation('foresta:.text+0x00000004', linked, placed(module(otherRegister)));
    expect(compareWithRom(object, 'p', elf, at)).toMatchObject({ equal: false });
  });

  test('a section the module does not hold names no place, and says so', () => {
    expect(() => romLocation('foresta:.rodata+0x00000004', linked, placed(module(code)))).toThrow(
      /no allocated section \.rodata/,
    );
  });
});

describe('moduleIdentityRefusal', () => {
  const addr = 'm416Dll:.text+0x00001f20';

  test('the module putting the symbol exactly there proves the row', () => {
    expect(moduleIdentityRefusal('ObjectSetup', addr, [{ section: '.text', offset: 0x1f20 }])).toBeNull();
  });

  test('a name the module holds at several offsets is proved by the one that matches', () => {
    const at = [
      { section: '.text', offset: 0x3930 },
      { section: '.text', offset: 0x1f20 },
    ];
    expect(moduleIdentityRefusal('ObjectSetup', addr, at)).toBeNull();
  });

  test('the wrong OFFSET is refused, and the refusal names where the symbol really is', () => {
    expect(moduleIdentityRefusal('ObjectSetup', addr, [{ section: '.text', offset: 0x1f24 }])).toBe(
      'ObjectSetup: m416Dll:.text+0x00001f20 — m416Dll puts ObjectSetup at .text+0x00001f24',
    );
  });

  // The half no symbol map can check: placement records a section INDEX, never a name.
  test('the wrong SECTION is refused even at the right offset', () => {
    expect(moduleIdentityRefusal('ObjectSetup', addr, [{ section: '.data', offset: 0x1f20 }])).toBe(
      'ObjectSetup: m416Dll:.text+0x00001f20 — m416Dll puts ObjectSetup at .data+0x00001f20',
    );
  });

  // The other half no map can check: a DOL global is unioned into every module's map at its real
  // address, so `0x801d3a04 % 0x01000000` reads as an offset under any module's name. It is not a
  // function of the module, so it has no location here at all.
  test('a function the module does not define is refused, whatever the map would say', () => {
    expect(moduleIdentityRefusal('HuDvdErrWait', 'm416Dll:.text+0x001d3a04', [])).toBe(
      'HuDvdErrWait: m416Dll:.text+0x001d3a04 — m416Dll defines no function HuDvdErrWait',
    );
  });
});
