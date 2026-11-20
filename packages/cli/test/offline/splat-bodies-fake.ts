// The seam the project-asm body tests share (src/splat-bodies.ts): asmlift's own assembly of a
// project file, faked by the object fixture `<dir>/<callee>.o`. test/matching/splat-bodies-assembly
// checks each such fixture against the real controlled assembly, so the fake is what GNU as writes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type ObjInput, runCli } from '../../src/main';
import type { BodyAssemble } from '../../src/splat-bodies';

/** asmlift's assembly of `<name>` (the callee, unless `name` says otherwise) in a source's dialect, as
 *  the object `<dir>/<name>.<dialect>.o`, or `<dir>/<name>.o` for the divided one (gas's default);
 *  undefined where there is none, which stands for a source gas does not assemble. */
export const fakeAssembly =
  (dir: string, name?: string): BodyAssemble =>
  async (source, callee) => {
    const dialect = /^\.syntax unified$/m.test(source) ? 'unified' : 'divided';
    const base = join(dir, name ?? callee);
    for (const path of dialect === 'divided' ? [`${base}.divided.o`, `${base}.o`] : [`${base}.unified.o`]) {
      try {
        return new Uint8Array(readFileSync(path));
      } catch {
        continue;
      }
    }
    return undefined;
  };

/** A CLI run of `argv` whose project bodies are assembled by `assemble`. */
export const runWithAssembly = (argv: string[], assemble: BodyAssemble) =>
  runCli(argv, (p) => readFileSync(p), {
    disasm: () => {
      throw new Error('no object input in these tests');
    },
    asmData: () => undefined,
    assembleBody: assemble,
  } satisfies ObjInput);
