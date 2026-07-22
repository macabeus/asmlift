// Pin tests for the Function Explorer's reproduction scripts — real rows from the committed
// results.json, so the scripts are exercised against exactly what the page renders.
import type { BenchOutput, FunctionResult } from '@asmlift/bench-schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { asmliftScript, m2cScript } from '../src/report/repro-scripts';

const rows = (JSON.parse(readFileSync(join(import.meta.dirname, '../results/results.json'), 'utf8')) as BenchOutput)
  .results;
const byId = new Map(rows.map((r) => [r.id, r]));
const row = (id: string): FunctionResult => {
  const r = byId.get(id);
  if (!r) {
    throw new Error(`row ${id} missing from committed results`);
  }
  return r;
};

describe('m2cScript (pinned)', () => {
  test('ARM rows embed the agbcc .s verbatim', () => {
    const fn = row('synthetic:add:agbcc');
    const s = m2cScript(fn);
    expect(s).toContain(fn.targetAsm.trimEnd());
    expect(s).toContain('--target gba');
    expect(s).toContain(`--function add`);
    expect(s).toContain('--no-cache');
  });

  test('rows with a context embed it and pass --context; rows without state that plainly', () => {
    const withCtx = rows.filter((r) => r.ctx);
    expect(withCtx.length).toBeGreaterThan(0); // the dataset does carry ctx rows
    for (const fn of withCtx) {
      const s = m2cScript(fn);
      expect(s, fn.id).toMatch(/cat > ctx\.h <<'CTX_INPUT'\n[\s\S]*\nCTX_INPUT\n/);
      expect(s, fn.id).toContain(fn.ctx!.trimEnd());
      expect(s, fn.id).toContain('--context ctx.h');
    }
    const bare = m2cScript(row('synthetic:add:agbcc'));
    expect(bare).toContain('NO context header');
    expect(bare).not.toContain('--context');
  });

  test('MIPS/PPC rows embed the normalized GNU-as text, not raw objdump', () => {
    const fn = row('synthetic:add:mwcc_242_81');
    const s = m2cScript(fn);
    expect(s).toContain(`glabel add`); // normalizer output
    expect(s).not.toContain('Disassembly of section'); // raw objdump header must be gone
    expect(s).toContain('--target ppc-mwcc-c');
  });

  test('vendored-context functions reference the repo blob and sanitize attributes', () => {
    const withRef = rows.filter((r) => r.ctxRef);
    expect(withRef.length).toBeGreaterThan(0);
    for (const fn of withRef) {
      const s = m2cScript(fn);
      expect(s, fn.id).toContain(`gunzip -kc "$ASMLIFT_PATH/${fn.ctxRef}"`);
      expect(s, fn.id).toContain('perl -pe'); // the attribute-strip expression
      expect(s, fn.id).toContain('--context ctx.h');
      expect(s, fn.id).toContain("ASMLIFT_PATH='/path/to/asmlift'");
      expect(fn.ctx, fn.id).toBeUndefined(); // referenced, never embedded
    }
  });

  test('jump-table rows embed their data sections (the published asmDump feeds the normalizer)', () => {
    const s = m2cScript(row('synthetic:sw_jt:gcc2.7.2kmc'));
    expect(s).toContain('.rodata'); // the emitted jump-table block
    expect(s).toContain('jtbl_'); // named for m2c's jtbl requirement
  });

  test('the c++ rows select the ppc-mwcc-c++ dialect', () => {
    expect(m2cScript(row('synthetic:Vec__len2:mwcc_242_81'))).toContain('--target ppc-mwcc-c++');
  });

  test('every row produces a script with a well-formed heredoc', () => {
    for (const fn of rows) {
      const s = m2cScript(fn);
      expect(s, fn.id).toMatch(/cat > in\.s <<'ASM_INPUT'\n[\s\S]*\nASM_INPUT\n/);
      expect(s.split("<<'ASM_INPUT'")[1], fn.id).not.toContain('ASM_INPUT\nASM_INPUT'); // no empty body
    }
  });
});

// A glued `flag#comment` is NOT a comment in bash — the comment words become tool arguments;
// every args-array line must keep whitespace before its `#`.
describe('long symbols never glue the flag to its comment', () => {
  test('across every row and both scripts', () => {
    for (const fn of rows) {
      for (const s of [m2cScript(fn), asmliftScript(fn)]) {
        const args = s.split('args=(')[1].split(')')[0];
        for (const line of args.split('\n')) {
          const hash = line.indexOf('#');
          if (hash > 0) {
            expect(line[hash - 1], `${fn.id}: ${line}`).toMatch(/\s/);
          }
        }
      }
    }
  });

  test('the longest symbol in the dataset stays separated', () => {
    const longest = rows.reduce((a, b) => (b.sym.length > a.sym.length ? b : a));
    expect(m2cScript(longest)).toContain(`--function ${longest.sym} #`);
    expect(asmliftScript(longest)).toContain(`--name ${longest.sym} #`);
  });
});

describe('asmliftScript (pinned)', () => {
  test('pre-step + visible CLI flags + mandatory benchmark-grade scoring', () => {
    const fn = row('synthetic:add:ido7.1');
    const s = asmliftScript(fn);
    expect(s).toContain(`pnpm --dir "$ASMLIFT_PATH" bench target ${fn.id} --out "$PWD" 1>&2`);
    expect(s).toContain(fn.targetAsm.trimEnd());
    expect(s).toContain('--target ido7.1');
    expect(s).toContain('--name add');
    expect(s).toContain('--config decomp.yaml');
    expect(s).toContain('--score-against target.o');
    expect(s).toContain('"$ASMLIFT_PATH/node_modules/.bin/asmlift"');
    expect(s).not.toContain('npx');
    expect(s).not.toContain('packages/cli'); // internal layout must not leak
  });

  test('rows with a dump embed it and pass --asm-data; ARM rows have neither', () => {
    const s = asmliftScript(row('synthetic:sw_jt:gcc2.7.2kmc'));
    expect(s).toMatch(/cat > dump\.txt <<'DUMP_INPUT'\n[\s\S]*\nDUMP_INPUT\n/);
    expect(s).toContain('--asm-data dump.txt');
    const arm = asmliftScript(row('synthetic:add:agbcc'));
    expect(arm).not.toContain('DUMP_INPUT');
    expect(arm).not.toContain('--asm-data');
  });

  test('no dump body line collides with the DUMP_INPUT terminator, across every row', () => {
    for (const fn of rows.filter((r) => r.asmDump)) {
      const count = (asmliftScript(fn).match(/^DUMP_INPUT$/gm) ?? []).length;
      expect(count, fn.id).toBe(1);
    }
  });

  test('real rows carry the context-scoring caveat; synthetic rows do not', () => {
    const real = rows.find((r) => r.tier === 'real');
    if (real) {
      expect(asmliftScript(real)).toContain('real tier:');
    }
    expect(asmliftScript(row('synthetic:add:ido7.1'))).not.toContain('real tier:');
  });
});
