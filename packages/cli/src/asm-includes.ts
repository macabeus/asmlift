// asmlift — the files an assembly input `.include`s, found the way gas finds them with no `-I`, for
// the readers that read an included file's text in place of the `.include` line (core
// `LiftOptions.asmIncludes`: frontend/splat.ts, and the macro scan of frontend/thumb.ts).
//
// gas reads `.include "x"` as the file `x` relative to the directory it runs in, and then under each
// `-I` directory. It does not look beside the including file (mips-linux-gnu-as measured: a
// `macro.inc` next to `asm/sub/f.s`, assembled from the project root, is "can't open macro.inc for
// reading"). This module reads the first of those places only, and never the project's compile
// command or build: predicting what a third party's command does was refuted three times over
// (an argument word, a shell expansion, a `cd`), so the `-I` directories are not modelled at all.
// The directory gas runs in is taken to be the decomp.yaml directory, where a project assembles from,
// or the input file's own directory where there is no decomp.yaml.
//
// An include is RESOLVED only where its operand is a plain relative path (no absolute path, no `..`
// component: the kernel walks `lnk/../x` through the link, where a lexical join folds it to another
// file), it names a regular file under that directory, and the file's realpath stays inside the
// directory's own realpath (a symlink that leaves the tree is not followed). Every other one is left
// out of the map, and the reader then reads it as it does with no map: no new decline. So a real
// project's `.include "macro.inc"`, which gas finds only through the build's `-I include`, keeps that
// reading; the gap it leaves (a mnemonic-shadowing macro in such a file) is named in splat.ts.
//
// Nested includes are found the same way, relative to the same directory, as gas finds them. Each
// operand is read once (the map is keyed by operand, and one directory gives one operand one file);
// a cycle is left in the map for the reader to decline, since gas repeats it until it fails.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/** A relative path of plain characters with no `..` component and no empty one. */
export function isPlainIncludePath(path: string): boolean {
  return (
    /^[\w.+/-]+$/.test(path) &&
    !path.startsWith('/') &&
    path.split('/').every((c) => c !== '..' && c !== '') &&
    !path.endsWith('/')
  );
}

// Every `.include "x"` spelling in a text, wherever it sits (a comment too): reading a file nobody
// includes changes nothing, since the readers look an operand up only at an `.include` they read.
const INCLUDE_OPERAND = /\.include[ \t]+"([^"\\\r\n]*)"/gi;

// Bounds on what one input may make this read: past them, the rest is left unresolved.
const MAX_FILES = 256;
const MAX_BYTES = 16 * 1024 * 1024;

/** The file `path` names under `root` (whose realpath is `realRoot`), or undefined where it is not
 *  resolved (see the header). */
function resolveOne(path: string, root: string, realRoot: string): string | undefined {
  if (!isPlainIncludePath(path)) {
    return undefined;
  }
  try {
    const real = realpathSync(join(root, path));
    if (!real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep) || !statSync(real).isFile()) {
      return undefined;
    }
    return real;
  } catch {
    return undefined;
  }
}

/** Each `.include` operand of `text`, and of every file it includes in turn, that resolves under
 *  `root` (gas's working directory), to that file's text. */
export function readAsmIncludes(text: string, root: string): Map<string, string> {
  const out = new Map<string, string>();
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return out;
  }
  let bytes = 0;
  const visit = (t: string): void => {
    for (const m of t.matchAll(INCLUDE_OPERAND)) {
      const op = m[1];
      if (out.has(op) || out.size >= MAX_FILES) {
        continue;
      }
      const file = resolveOne(op, root, realRoot);
      if (file === undefined) {
        continue;
      }
      let body: string;
      try {
        body = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (bytes + body.length > MAX_BYTES) {
        continue;
      }
      bytes += body.length;
      out.set(op, body);
      visit(body);
    }
  };
  visit(text);
  return out;
}
