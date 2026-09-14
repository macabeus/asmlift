// EVERY VARIATION'S EXAMPLE, COMPILED. A definition in `packages/core/src/variation-definitions.ts`
// shows a reader two spellings and claims the variation's choice between them reaches the object.
// This holds each pair to that claim: its `unit` with `before` in the hole and with `after` in it,
// compiled by the example's own compiler, must be two different objects for `EXAMPLE_FUNCTION`.
//
// "Different" is objdiff's verdict, the scorer's own eye: a relocation is compared by the symbol
// it names, never by the placeholder bytes in the section, and only the example function's
// instructions and literal pool are read. A pair that builds one object is a wrong example.
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC } from '@asmlift/core/target';
import {
  EXAMPLE_FUNCTION,
  EXAMPLE_HOLE,
  type ExampleCompiler,
  TARGET_BEHAVIOR_READINGS,
  VARIATION_DEFINITIONS,
} from '@asmlift/core/variation-definitions';
import { type GatingBehavior, type VariationName, hasVariation } from '@asmlift/core/variation-tokens';
import {
  assembleTarget,
  compileCandAgbcc,
  compileCandIdoC,
  compileCandKmc,
  compileCandPpc,
  compileTargetAsm,
  scoreObjects,
} from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { decompileRanked } from '../../src/rank';
import { dockerGate, ppcDockerGate } from './docker-gate';

const COMPILE: { readonly [C in ExampleCompiler]: (source: string) => string } = {
  agbcc: compileCandAgbcc,
  ido: compileCandIdoC,
  gcc: compileCandKmc,
  mwcc: compileCandPpc,
};

const entries = Object.entries(VARIATION_DEFINITIONS);
const uses = (compiler: ExampleCompiler) => entries.some(([, d]) => d.example.compiler === compiler);
const HAVE: { readonly [C in ExampleCompiler]: boolean } = {
  agbcc: true,
  ido: true,
  gcc: !uses('gcc') || dockerGate('variation-examples'),
  mwcc: !uses('mwcc') || ppcDockerGate('variation-examples'),
};

const spell = (unit: string, spelling: string): string => `${unit.replace(EXAMPLE_HOLE, spelling)}\n`;

describe('every variation example compiles to two different objects', () => {
  for (const [name, { example }] of entries) {
    test.runIf(HAVE[example.compiler])(`${name} (${example.compiler})`, () => {
      expect(example.unit.split(EXAMPLE_HOLE)).toHaveLength(2);
      const compile = COMPILE[example.compiler];
      const before = compile(spell(example.unit, example.before));
      const after = compile(spell(example.unit, example.after));
      const score = scoreObjects(before, after, EXAMPLE_FUNCTION);
      expect(score.match, `${name}: both spellings compile to one object`).toBe(false);
    });
  }
});

// THE TARGET LINE, COMPILED. A drawer tells a reader which compilers a variation is withheld on by
// reading a compiler behavior (`TARGET_BEHAVIOR_READINGS`), so each reading carries a pair that
// shows it, built by the compiler of every shipped target that declares the behavior. A behavior
// no pair can show states why, and nothing is skipped.
const SHIPPED_TARGETS = [ARMV4T_AGBCC, MIPS_IDO, MIPS_GCC, PPC_MWCC];

describe('every compiler behavior a target gate reads is shown by a compiled pair, or says why none can', () => {
  for (const [behavior, { witness }] of Object.entries(TARGET_BEHAVIOR_READINGS)) {
    test(behavior, () => {
      const declaring = SHIPPED_TARGETS.filter((t) => {
        const value = t.compilerBehaviors[behavior as GatingBehavior];
        return value !== undefined && value !== false;
      });
      expect(declaring.length, `${behavior}: no shipped target declares it`).toBeGreaterThan(0);
      if ('uncompiled' in witness) {
        return;
      }
      expect([...new Set(declaring.map((t) => t.compiler))]).toEqual([witness.compiler]);
      expect(witness.unit.split(EXAMPLE_HOLE)).toHaveLength(2);
      const compile = COMPILE[witness.compiler];
      const [a, b] = witness.spellings.map((s) => compile(spell(witness.unit, s)));
      expect(
        scoreObjects(a, b, EXAMPLE_FUNCTION).match,
        `${behavior}: the pair does not compile ${witness.compiles}`,
      ).toBe(witness.compiles === 'same');
    });
  }
});

// THE STRONGER CLAIM, where it holds: asmlift lifts the object `after` built and matches it byte for
// byte, and every candidate that matches carries the variation, so the example is a spelling this
// variation emits and nothing else in the fan does. Not every example can say it: an example whose
// unit leans on an `extern` the lift has no declaration for yields no candidate that compiles, and
// one whose `after` another variation also spells matches without it.
const REACHED_ONLY_THROUGH: readonly VariationName[] = [
  'setup-args',
  'connective',
  'defsite',
  'addr-home',
  'expr-home',
  'derived-home',
  'copy-defpos',
  'zerosub',
  'vol-slot',
  'vol-store',
  'coalesce',
];

describe("asmlift matches an example's `after` only through its variation", () => {
  for (const name of REACHED_ONLY_THROUGH) {
    test(name, () => {
      const { example } = VARIATION_DEFINITIONS[name];
      expect(example.compiler).toBe('agbcc');
      const asm = compileTargetAsm(spell(example.unit, example.after));
      const matched = decompileRanked(EXAMPLE_FUNCTION, asm, ARMV4T_AGBCC, assembleTarget(asm)).candidates.filter(
        (c) => c.score.match,
      );
      expect(matched.length).toBeGreaterThan(0);
      expect(matched.filter((c) => !hasVariation(c.variations, name)).map((c) => c.variations.join('/'))).toEqual([]);
    });
  }
});
