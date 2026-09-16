// Which vendored symbol map a row is read with (cases/manifests.ts `vendoredSymbols`).
//
// A row with a linked address is read with the project's map. A row in a GameCube REL module is
// read with THAT MODULE's map — its own symbols over the base ELF's globals — because a module's
// code refers to the module's own symbols. The third answer is the one that matters most: a
// project that vendors a map but not the module's REFUSES, rather than quietly handing the row the
// base ELF's map and publishing different source under a row that looks like every other one.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import { MODULE_MAP_DIR, vendoredSymbols } from '../src/cases/manifests';

const mapJson = (name: string, addr: string) => JSON.stringify({ [addr]: [{ name, kind: 'code' }] });

/** A vendored dir as `bench vendor` writes one: the project's map, and optionally a module's. */
function vendoredDir(opts: { project?: boolean; module?: boolean } = { project: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-vendmap-'));
  if (opts.project) {
    writeFileSync(join(dir, 'symbols.json.gz'), gzipSync(Buffer.from(mapJson('OSReport', '0x80003100'))));
  }
  if (opts.module) {
    mkdirSync(join(dir, MODULE_MAP_DIR));
    writeFileSync(
      join(dir, MODULE_MAP_DIR, 'm416Dll.json.gz'),
      gzipSync(Buffer.from(mapJson('ObjectSetup', '0x01000000'))),
    );
  }
  return dir;
}

describe('vendoredSymbols', () => {
  test("a row with a linked address is read with the project's own map", () => {
    const map = vendoredSymbols('marioparty4', vendoredDir({ project: true, module: true }), undefined);
    expect([...map!.values()].flat().map((i) => i.name)).toEqual(['OSReport']);
  });

  test("a row in a REL module is read with that module's map, and nothing of the project's", () => {
    const map = vendoredSymbols('marioparty4', vendoredDir({ project: true, module: true }), 'm416Dll');
    expect([...map!.values()].flat().map((i) => i.name)).toEqual(['ObjectSetup']);
  });

  test('a module with no vendored map is REFUSED, not served the project map', () => {
    const dir = vendoredDir({ project: true });
    expect(() => vendoredSymbols('marioparty4', dir, 'm416Dll')).toThrow(
      /marioparty4: rows live in module m416Dll, but no map is vendored for it — run `pnpm bench vendor --project marioparty4`/,
    );
  });

  test('a project that vendors no map at all has none for any row: those rows run map-less', () => {
    const dir = vendoredDir({ project: false, module: true });
    expect(vendoredSymbols('af', dir, undefined)).toBeUndefined();
    expect(vendoredSymbols('af', dir, 'm416Dll')).toBeUndefined();
  });
});
