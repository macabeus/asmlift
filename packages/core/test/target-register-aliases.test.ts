import { describe, expect, test } from 'vitest';

import { ARM_REGISTER_ALIASES, O32_REGISTER_ALIASES, TOOLCHAIN_TARGETS, type TargetDescription } from '../src/target';

// The register lists a target states key a register by spelling, as the frontends do after
// `unifyRegisterSpellings` has rewritten a function to one spelling of each pair. A list naming
// one spelling of a pair and not the other classifies the register by whichever spelling the
// function happened to use, and a pair the alias table leaves out is never unified at all: one
// register read as two partition keys, saved under one and written under the other.
const ALIASES: Record<string, readonly (readonly [string, string])[]> = {
  armv4t: ARM_REGISTER_ALIASES,
  mips: O32_REGISTER_ALIASES,
};

const listsOf = (t: TargetDescription): [string, readonly string[]][] => [
  ['argRegs', t.argRegs],
  ['nonArgRegs', t.nonArgRegs ?? []],
  ['scratchRegs', t.scratchRegs ?? []],
  ['hiddenInputRegs', t.hiddenInputRegs ?? []],
  ['callerSaved', t.callerSaved ?? []],
  ['globalRegisterVariables', Object.keys(t.globalRegisterVariables?.regs ?? {})],
];

describe('every register list a target states names both spellings of a register or neither', () => {
  for (const [id, tc] of Object.entries(TOOLCHAIN_TARGETS)) {
    const t = tc.description;
    test(id, () => {
      const pairs = ALIASES[t.id] ?? [];
      for (const [name, list] of listsOf(t)) {
        for (const [a, b] of pairs) {
          expect(`${name}: ${a} ${list.includes(a)}, ${b} ${list.includes(b)}`).toBe(
            `${name}: ${a} ${list.includes(b)}, ${b} ${list.includes(a)}`,
          );
        }
      }
      // …and a global register variable is one global under either spelling
      const regs = t.globalRegisterVariables?.regs ?? {};
      for (const [a, b] of pairs) {
        if (Object.hasOwn(regs, a)) {
          expect(regs[b]).toBe(regs[a]);
        }
      }
    });
  }

  test('the tables name every aliased spelling the targets list', () => {
    // A spelling that is no `r<n>`/`s<n>` and no other ISA register name must come from a table.
    const named = new Set([...ARM_REGISTER_ALIASES, ...O32_REGISTER_ALIASES].flat());
    for (const tc of Object.values(TOOLCHAIN_TARGETS)) {
      const t = tc.description;
      if (t.id !== 'armv4t') {
        continue;
      }
      for (const [, list] of listsOf(t)) {
        for (const r of list) {
          expect(/^r\d+$/.test(r) || r === 'lr' || named.has(r)).toBe(true);
        }
      }
    }
  });
});
