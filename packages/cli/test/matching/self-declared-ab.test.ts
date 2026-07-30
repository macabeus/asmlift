// CI-ized A/B for SELF-DECLARING CANDIDATES (mitigation 3 of the consolidation review;
// research/self-declaring-candidates-2026-07-26.md): for the klonoa dogfood functions, the
// WINNING NAMED candidate must compile to byte-identical objects in BOTH worlds —
//   A. SELF-DECLARED: the project's own 4-step template (cpp → agbcc → align-footer → as, from
//      its decomp.yaml `tools.asmlift.compiler`) with asmlift's typedef prelude + the
//      candidate's synthesized declaration block (declare.ts, arbitrated by the world probe);
//   B. HEADERS-WRAPPER: the same 4 steps over a temporary wrapper TU that #includes the
//      project's real headers (the pre-self-declaration compile form) — the headers own every
//      declaration, nothing is synthesized.
// Byte-compare = `objcopy -O binary` on each object, then the raw section bytes must be equal:
// if synthesis ever drifts from the header truth (signedness, volatile, layout padding), the
// bytes diverge and this suite goes red — the drift the manual acceptance used to catch by hand.
//
// EXPECTED ASYMMETRY, pinned rather than skipped: a candidate that VALUE-references a code
// symbol no project header declares (a nonmatching placeholder like ProcessStaticBGScroll)
// CANNOT compile in the headers world at all — that gap is exactly the coverage self-declaring
// adds. Such a wrapper failure is accepted ONLY when it is an `undeclared` diagnostic naming
// one of the candidate's own code refs; any other wrapper failure fails the test, and the
// aggregate pin below keeps the byte-compare from silently degrading to vacuous.
//
// GATE: needs the bench-owned klonoa checkout (apps/benchmark/checkouts/, built: `pnpm bench
// setup --project kleod --build`) plus the arm-none-eabi binutils the project itself uses.
// Missing pieces skip GREEN with a console.warn, docker-gate.ts style.
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';

import { compileFromCommand } from '../../src/compile-command';
import { loadDecompConfig } from '../../src/config';
import { renderDeclarations } from '../../src/declare';
import { type RankedCandidate, decompileRanked } from '../../src/rank';
import { loadSymbolMap } from '../../src/symbols-provider';
import { KLEOD_CHECKOUT as CHECKOUT, kleodCheckoutGate } from './checkout-gate';

// The 5-fn dogfood set every self-declaring acceptance ran (the near-miss gfx functions the
// symbol-map rounds are calibrated on). All are asm/nonmatchings — their ground truth is the
// project's own assembled build/src/gfx.o, which is also the objdiff scoring target here.
const DOGFOOD = [
  'StreamCmd_ToggleLayerFlag',
  'StreamCmd_SetTimerAndMode',
  'StreamCmd_InitStaticScroll',
  'StreamCmd_InitOscillation',
  'LoadBGTileData',
];
// The headers the kleod bench manifest names — the wrapper world's declaration source.
const HEADERS = ['global.h', 'globals.h', 'structs/variables.h'];
const TARGET_OBJ = join(CHECKOUT, 'build/src/gfx.o');

const HAVE = kleodCheckoutGate(
  'self-declared-ab',
  [
    'decomp.yaml',
    'klonoa-eod-syms.elf',
    'tools/agbcc/bin/agbcc',
    'build/src/gfx.o',
    ...DOGFOOD.map((f) => `asm/nonmatchings/gfx/${f}.s`),
  ],
  ['arm-none-eabi-cpp', 'arm-none-eabi-as', 'arm-none-eabi-objcopy'],
);

/** Run one shell script from the checkout root; throws with full stderr on any failing step. */
function sh(cmd: string): void {
  const r = spawnSync('sh', ['-ec', cmd], { cwd: CHECKOUT, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`step failed (exit ${r.status ?? 'signal'}): ${cmd}\n${(r.stderr || r.stdout).trim()}`);
  }
}

/** World B — compile `source` against the project's REAL headers through the project's own
 *  cpp/agbcc/as steps (no prelude, no synthesized declarations). Returns the object path. */
function wrapperCompile(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-ab-wrap-'));
  const c = join(dir, 'wrap.c');
  const i = join(dir, 'wrap.i');
  const s = join(dir, 'wrap.s');
  const o = join(dir, 'wrap.o');
  writeFileSync(c, HEADERS.map((h) => `#include "${h}"`).join('\n') + '\n\n' + source);
  sh(`arm-none-eabi-cpp -nostdinc -I tools/agbcc/include -iquote include ${c} -o ${i}`);
  // no -Werror: candidate CALLS rely on C89 implicit declarations (same as the project's own
  // scoring template) — a hard error still exits nonzero and throws above.
  sh(`./tools/agbcc/bin/agbcc ${i} -o ${s} -mthumb-interwork -Wimplicit -Wparentheses -O2 -fhex-asm -fprologue-bugfix`);
  sh(`printf ".text\\n\\t.align\\t2, 0\\n" >> ${s}`);
  sh(`arm-none-eabi-as -mcpu=arm7tdmi -mthumb-interwork ${s} -o ${o}`);
  return o;
}

/** The object's raw section bytes as hex (objcopy -O binary), so a mismatch diffs readably. */
function rawBytesHex(obj: string): string {
  sh(`arm-none-eabi-objcopy -O binary ${obj} ${obj}.bin`);
  return readFileSync(`${obj}.bin`).toString('hex');
}

interface Row {
  named: RankedCandidate; // best-scoring candidate that names map symbols
  selfHex: string; // world A bytes
  wrapper: { ok: true; hex: string } | { ok: false; error: string };
}

describe.runIf(HAVE)('self-declared vs headers-wrapper A/B — klonoa dogfood (checkout-gated)', () => {
  const rows = new Map<string, Row>();

  beforeAll(async () => {
    const cfg = loadDecompConfig(join(CHECKOUT, 'decomp.yaml'));
    const tool = cfg?.config.tools?.asmlift;
    if (!tool?.compiler || !tool.elf) {
      throw new Error('klonoa decomp.yaml lost its tools.asmlift compiler/elf keys');
    }
    const symbols = await loadSymbolMap(join(CHECKOUT, tool.elf));
    const compile = compileFromCommand(tool.compiler, { cwd: CHECKOUT });
    for (const fn of DOGFOOD) {
      const asm = readFileSync(join(CHECKOUT, 'asm/nonmatchings/gfx', `${fn}.s`), 'utf8');
      const ranked = decompileRanked(fn, asm, ARMV4T_AGBCC, TARGET_OBJ, { symbols, compile });
      // candidates arrive sorted best-first, so the first ref-carrying one is the winning
      // NAMED spelling (the overall best may be a '/raw-globals' sibling — not this A/B's
      // subject: it names nothing, so both worlds are trivially the same compile).
      const named = ranked.candidates.find((c) => c.symbolRefs?.length);
      if (!named) {
        continue; // pinned below: the dogfood set must keep producing named winners
      }
      // World A: the exact scoring-path compile — prelude + synthesized declarations (the
      // probe put this template in the self-declared world; it has no headers of its own).
      const selfHex = rawBytesHex(compile(named.source, fn, 'c', renderDeclarations(named.symbolRefs ?? [])));
      let wrapper: Row['wrapper'];
      try {
        wrapper = { ok: true, hex: rawBytesHex(wrapperCompile(named.source)) };
      } catch (e) {
        wrapper = { ok: false, error: (e as Error).message };
      }
      rows.set(fn, { named, selfHex, wrapper });
    }
  }, 240_000);

  test.each(DOGFOOD)('%s: named winner byte-identical self-declared vs headers-wrapper', (fn) => {
    const row = rows.get(fn);
    expect(row, `no scored NAMED candidate for ${fn} — the symbol-map lever went inert`).toBeDefined();
    const { named, selfHex, wrapper } = row!;
    if (wrapper.ok) {
      expect(wrapper.hex, `object bytes diverge for ${fn} (${named.label}) — synthesis drifted`).toBe(selfHex);
      return;
    }
    // The one accepted failure class: the headers world cannot DECLARE a code symbol no
    // project header knows (undeclared placeholder fns) — the exact gap self-declaring closes.
    // The diagnostic must be `undeclared` AND name one of this candidate's own code refs.
    const undeclaredCodeRef = (named.symbolRefs ?? []).some(
      (r) => r.info.kind === 'code' && wrapper.error.includes(`\`${r.name}' undeclared`),
    );
    expect(
      undeclaredCodeRef,
      `wrapper compile failed for ${fn} for an UNEXPECTED reason (not a header-undeclared code ref):\n${wrapper.error}`,
    ).toBe(true);
  });

  test('the byte-compare never degrades to vacuous: ≥3 of the 5 compile in BOTH worlds', () => {
    const compared = [...rows.values()].filter((r) => r.wrapper.ok).length;
    expect(compared).toBeGreaterThanOrEqual(3);
  });
});
