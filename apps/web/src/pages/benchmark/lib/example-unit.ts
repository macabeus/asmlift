// A variation example's translation unit as the drawer shows it. The unit is data the matching suite
// compiles byte for byte, written on one line; a reader needs it indented, with the hole on a line of
// its own and without the callee declarations the unit never calls. Whitespace and those declarations
// are the only things this changes.
import { EXAMPLE_HOLE } from '@asmlift/core/variation-definitions';

import { formatC } from './format-c';

/** Where the unit's hole is drawn: a C comment, so the block still highlights as C. */
export const HOLE_MARKER = '/* ← the spelling above */';

/** A placeholder no unit spells, carried through formatting in place of the hole. */
const PLACEHOLDER = '__example_hole__';
/** An unprototyped callee declaration, `void A();`. */
const CALLEE = /^(?:void|s32) (\w+)\(\);$/;

export function unitForDisplay(unit: string): string {
  const [head, tail] = unit.split(EXAMPLE_HOLE);
  // At statement position the hole is a statement; before a body it is the signature, and stays on its line.
  const hole = /^\s*\{/.test(tail) ? PLACEHOLDER : `${PLACEHOLDER};`;
  const lines = `${head}${hole}${tail}`.split('\n').flatMap((l) => formatC(l).trimEnd().split('\n'));
  const called = (name: string) => lines.some((l) => !CALLEE.test(l) && new RegExp(`\\b${name}\\(`).test(l));
  return lines
    .filter((l) => {
      const callee = CALLEE.exec(l);
      return callee === null || called(callee[1]);
    })
    .map((l) => l.replace(`${PLACEHOLDER};`, HOLE_MARKER).replace(PLACEHOLDER, HOLE_MARKER))
    .join('\n');
}
