// How a GameCube REL row is proved by `bench vendor`, and why it is proved differently.
//
// A row keyed by a linked address is proved against the ROM: the target it builds must be the
// function the project's linked ELF holds there. A row keyed by a REL MODULE LOCATION cannot be —
// the linked ELF holds no module's bytes, and the module's own are unrelocated, which the gate's
// ARM/MIPS masks cannot read. So `romAddress` hands the caller null instead of parsing an address
// out of a spelling that holds none, and the row is proved on what IS decidable against the
// checkout: that its module really does put that symbol at that section and that offset.
import { describe, expect, test } from 'vitest';

import { romAddress } from '../src/cases/rom-function';
import { moduleIdentityRefusal } from '../src/cases/vendor';

describe('romAddress', () => {
  test('a linked address is the address the ROM gate reads', () => {
    expect(romAddress('0x0800d188')).toBe(0x0800d188);
    expect(romAddress('0x801d3a04')).toBe(0x801d3a04);
  });

  // Before this returned null it returned NaN, and the row failed with "the linked ELF has no
  // function at 0xNaN" — a refusal that named neither the row's shape nor the reason.
  test('a module location has none, and is not parsed into one', () => {
    expect(romAddress('m416Dll:.text+0x00001f20')).toBeNull();
    expect(romAddress('foresta:.text+0x001a0cf0')).toBeNull();
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
