// One-off residual dumper for the LoadBGTilemapData attribution study: two objects and a symbol
// in, objdiff's aligned display rows out.
//
// The `file://` fetch shim below is COPIED from @match-kit/scoring's Node and Bun engine loader, which owns
// it — objdiff-wasm pulls its sibling `objdiff.core.wasm` over fetch, and Node's fetch will not
// read a `file://` URL. The copy keeps this a plain `.mjs`, runnable by `node` alone, which is how
// the attribution docs hand it to a reader. objdiff-wasm is resolved from @match-kit/scoring, the
// package that pins it, so this reads the same engine the benchmark scores with.
//
// The engine's resource DISPOSAL that the scorer does is deliberately omitted: the hazard it
// exists for is a tight loop exhausting the wasm instance after a few hundred diffs in one
// process, and this script does exactly one.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const fromCli = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
const require = createRequire(fromCli.resolve('@match-kit/scoring/package.json'));

const objdiff = await (async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = input.toString();
    if (url.startsWith('file://') && url.includes('objdiff.core.wasm')) {
      return new Response(readFileSync(fileURLToPath(url)), { headers: { 'content-type': 'application/wasm' } });
    }
    return originalFetch(input);
  };
  try {
    const mod = await import(require.resolve('objdiff-wasm'));
    mod.init('error');
    return mod;
  } finally {
    globalThis.fetch = originalFetch;
  }
})();

const [targetPath, candPath, symbol] = process.argv.slice(2);
if (!targetPath || !candPath || !symbol) {
  throw new Error('Usage: rowdiff.mjs TARGET.o CANDIDATE.o SYMBOL');
}
const CONFIG = new objdiff.diff.DiffConfig();
const mappingConfig = { mappings: [], selectingLeft: undefined, selectingRight: undefined };
const target = objdiff.diff.Object.parse(new Uint8Array(readFileSync(targetPath)), CONFIG, 'target');
const candidate = objdiff.diff.Object.parse(new Uint8Array(readFileSync(candPath)), CONFIG, 'base');
const { left, right } = objdiff.diff.runDiff(target, candidate, CONFIG, mappingConfig);
const lSym = left.findSymbol(symbol, undefined);
const rSym = right.findSymbol(symbol, undefined);
if (!lSym || !rSym) {
  throw new Error(`Missing symbol: ${symbol}`);
}
const lDisp = objdiff.display.displaySymbol(left, lSym.id);
const rDisp = objdiff.display.displaySymbol(right, rSym.id);
const rows = Math.max(lDisp.rowCount, rDisp.rowCount);

const output = { symbol, targetPath, candPath, rows: [] };
for (let i = 0; i < rows; i++) {
  const target = i < lDisp.rowCount ? objdiff.display.displayInstructionRow(left, lSym.id, i, CONFIG) : null;
  const candidate = i < rDisp.rowCount ? objdiff.display.displayInstructionRow(right, rSym.id, i, CONFIG) : null;
  output.rows.push({ index: i, target, candidate });
}
console.log(JSON.stringify(output, (key, value) => (typeof value === 'bigint' ? String(value) : value), 2));
