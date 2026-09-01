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

  test('vendored-context functions reference the repo blob VERBATIM', () => {
    const withRef = rows.filter((r) => r.ctxRef);
    expect(withRef.length).toBeGreaterThan(0);
    for (const fn of withRef) {
      const s = m2cScript(fn);
      expect(s, fn.id).toContain(`gunzip -kc "$ASMLIFT_PATH/${fn.ctxRef}" > ctx.h`);
      // NO filter between the blob and ctx.h: the attribute strip that used to sit here deleted
      // `packed` and silently repadded the project's structs (see eval/m2c-normalizer.ts).
      expect(s, fn.id).not.toContain('perl -pe');
      expect(s, fn.id).toContain('--context ctx.h');
      expect(s, fn.id).toContain("ASMLIFT_PATH='/path/to/asmlift'");
      expect(fn.ctx, fn.id).toBeUndefined(); // referenced, never embedded
    }
  });

  test('the appended prototype block appears exactly on the rows that carry one', () => {
    for (const fn of rows) {
      const s = m2cScript(fn);
      if (fn.ctxProto) {
        expect(s, fn.id).toContain(`cat >> ctx.h <<'CTX_PROTO'\n${fn.ctxProto}\nCTX_PROTO`);
        expect(fn.ctxProto, fn.id).toMatch(/^void \w+\(.*\);$/); // proto-derived, never funcC text
      } else {
        expect(s, fn.id).not.toContain('CTX_PROTO');
      }
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

  test('real rows state the ctx-world scoring (step 1 materializes the vendored context)', () => {
    const real = rows.filter((r) => r.tier === 'real');
    expect(real.length).toBeGreaterThan(0);
    for (const fn of real) {
      const s = asmliftScript(fn);
      expect(s, fn.id).toContain('real tier:');
      expect(s, fn.id).toContain('ctx.i'); // the materialized scoring context is named
      // the old "may grade differently" caveat is gone — scoring now happens IN the ctx world
      expect(s, fn.id).not.toContain('may grade');
    }
    const synth = asmliftScript(row('synthetic:add:ido7.1'));
    expect(synth).not.toContain('real tier:');
    expect(synth).not.toContain('ctx.i');
  });

  test('real rows state the pinned-checkout recipe with real commands (comments only)', () => {
    const real = rows.filter((r) => r.tier === 'real');
    expect(real.length).toBeGreaterThan(0);
    for (const fn of real) {
      const s = asmliftScript(fn);
      expect(s, fn.id).toMatch(/#\s+git clone --branch asmlift-benchmark https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git/);
      expect(s, fn.id).toMatch(/#\s+make -C /);
      // the recipe must be COMMENTS — the script itself stays checkout-free
      expect(s, fn.id).not.toMatch(/^git clone/m);
    }
    // sidecar projects additionally derive the symbols ELF
    const sidecar = real.find((r) => r.project === 'marioparty3');
    if (sidecar) {
      expect(asmliftScript(sidecar)).toContain('make -C marioparty3 asmlift-elf');
    }
    expect(asmliftScript(row('synthetic:add:ido7.1'))).not.toContain('git clone --branch');
  });

  test('symbol-fed rows carry the vendored-map provenance; map-free rows state none is needed', () => {
    // Two KINDS of map row, and the script owes a different provenance for each: a REAL row's map
    // is derived from the project's ELF and vendored, a SYNTHETIC row's is authored in the
    // dataset. What neither may do is stay silent — a map-less reproduction of a map-fed row
    // answers a different question than the row.
    const withMap = rows.filter((r) => r.asmlift.symbolMap && r.tier === 'real');
    expect(withMap.length).toBeGreaterThan(0); // the dataset does carry symbol-fed real rows
    for (const fn of withMap) {
      const s = asmliftScript(fn);
      expect(s, fn.id).toContain(`apps/benchmark/dataset/real/tu/${fn.project}/symbols.json.gz`);
      expect(s, fn.id).toMatch(/sha256 of the decompressed map JSON: [0-9a-f]{64}/);
      expect(s, fn.id).toContain('decomp.yaml (tools.asmlift.elf)');
    }
    const authored = rows.filter((r) => r.asmlift.symbolMap && r.tier === 'synthetic');
    expect(authored.length).toBeGreaterThan(0); // and the synthetic tier carries authored ones
    for (const fn of authored) {
      const s = asmliftScript(fn);
      expect(s, fn.id).toContain('SYMBOLS:');
      expect(s, fn.id).toContain('apps/benchmark/dataset/synthetic.ts');
      expect(s, fn.id).toContain('tools.asmlift.symbols');
      // authored, so there is no vendored blob and no project checkout to name
      expect(s, fn.id).not.toContain('symbols.json.gz');
      expect(s, fn.id).not.toContain('sha256 of the decompressed map JSON');
    }
    const noMap = rows.find((r) => r.tier === 'real' && !r.asmlift.symbolMap);
    if (noMap) {
      const s = asmliftScript(noMap);
      expect(s).toContain('no symbols needed');
      expect(s).not.toContain('sha256 of the decompressed map JSON');
    }
    expect(asmliftScript(row('synthetic:add:ido7.1'))).not.toContain('SYMBOLS:');
  });

  test('symbol-fed rows LOAD the map: PROJECT_PATH placeholder + --project-root on the pre-step', () => {
    const withMap = rows.filter((r) => r.asmlift.symbolMap && r.tier === 'real');
    expect(withMap.length).toBeGreaterThan(0);
    for (const fn of withMap) {
      const s = asmliftScript(fn);
      // the placeholder names the same checkout dir the clone recipe creates
      const dir = /^#\s+git clone --branch \S+ \S+\.git (\S+)$/m.exec(s)?.[1];
      expect(dir, fn.id).toBeTruthy();
      expect(s, fn.id).toContain(`PROJECT_PATH='/path/to/${dir}'`);
      expect(s, fn.id).toContain(`bench target ${fn.id} --out "$PWD" --project-root "$PROJECT_PATH" 1>&2`);
      // the old "standalone run does NOT load it" caveat is gone — the script loads the map now
      expect(s, fn.id).not.toContain('does NOT load');
    }
    // kleod's repoDir differs from its GitHub repo name — the placeholder must use repoDir
    const kleod = withMap.find((r) => r.project === 'kleod');
    if (kleod) {
      expect(asmliftScript(kleod)).toContain("PROJECT_PATH='/path/to/klonoa-empire-of-dreams'");
    }
    // map-free rows keep the plain pre-step and no placeholder — and so do the AUTHORED-map
    // rows, whose map `bench target` writes itself: there is no checkout for a placeholder to
    // point at, and a script that asked for one would be asking for a thing that does not exist.
    for (const fn of rows.filter((r) => !r.asmlift.symbolMap || r.tier === 'synthetic')) {
      const s = asmliftScript(fn);
      expect(s, fn.id).not.toContain('PROJECT_PATH');
      expect(s, fn.id).not.toContain('--project-root');
    }
  });
});
