// asmlift — the readability habits a SHAPE READING removes, counted off printed C text. The
// benchmark's readability report publishes them (apps/benchmark/src/eval/quality.ts), and rank's
// tie-break reads the same counts (rank.ts `compareScored`), so the two can never weigh one habit
// two ways. Pure text functions: browser-safe.

/** The shape counters (bench-schema `QualityHabits` documents each). */
export interface ShapeHabits {
  joinedReturn: number;
  shiftTruth: number;
  doWhileForable: number;
}

const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length;

/** `} else {` right after a branch that ends in `return`. */
export function elseAfterReturnCount(body: string): number {
  return count(body, /return\b[^;\n]*;\n\s*\} else\b/g);
}

const indentOf = (line: string): number => /^ */.exec(line)![0].length;
const LITERAL = /^-?(?:0x[0-9a-fA-F]+|\d+)$/;

/** Does `k OP l` hold for two integer literals? */
function literalTestHolds(k: string, op: string, l: string): boolean {
  const a = Number(k);
  const b = Number(l);
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '!=':
      return a !== b;
    default:
      return false;
  }
}

/** The shape counters: `joinedReturn`, `shiftTruth` and `doWhileForable`, read line by line off the
 *  printer's layout (four-space indents). */
export function shapeHabits(stmts: readonly string[]): ShapeHabits {
  let joinedReturn = 0;
  let doWhileForable = 0;
  // `return v;` right after an if/else whose two arms each end by setting `v`
  for (let i = 2; i < stmts.length; i++) {
    const ret = /^( *)return ([A-Za-z_]\w*);$/.exec(stmts[i]);
    if (!ret || stmts[i - 1] !== `${ret[1]}}`) {
      continue;
    }
    const ind = ret[1];
    const sets = (line: string | undefined): boolean =>
      line !== undefined && line.startsWith(`${ind}    ${ret[2]} = `) && line.endsWith(';');
    if (!sets(stmts[i - 2])) {
      continue;
    }
    for (let j = i - 3; j > 0 && indentOf(stmts[j]) >= ind.length; j--) {
      if (stmts[j] === `${ind}} else {`) {
        if (sets(stmts[j - 1])) {
          joinedReturn++;
        }
        break;
      }
      if (indentOf(stmts[j]) === ind.length) {
        break;
      }
    }
  }
  // `v = K;` then `do {` … `} while (v OP L);` at the same indent, with `K OP L` true
  for (let i = 1; i < stmts.length; i++) {
    const init = /^( *)([A-Za-z_]\w*) = (-?(?:0x[0-9a-fA-F]+|\d+));$/.exec(stmts[i - 1]);
    if (!init || stmts[i] !== `${init[1]}do {`) {
      continue;
    }
    const end = stmts.findIndex((l, j) => j > i && indentOf(l) === init[1].length);
    const test = end < 0 ? null : /^ *\} while \(([A-Za-z_]\w*) (<=?|>=?|!=) (\S+)\);$/.exec(stmts[end]);
    if (test && test[1] === init[2] && LITERAL.test(test[3]) && literalTestHolds(init[3], test[2], test[3])) {
      doWhileForable++;
    }
  }
  const body = stmts.join('\n');
  const shiftTruth = count(body, /<< 24\)? [!=]= 0\b/g) + count(body, /<< (16|24)\)? >> \1\b/g);
  return { joinedReturn, shiftTruth, doWhileForable };
}

/** Every habit above in one printed function: the tie-break's single number. */
export function shapeHabitCount(source: string): number {
  const h = shapeHabits(source.split('\n'));
  return elseAfterReturnCount(source) + h.joinedReturn + h.shiftTruth + h.doWhileForable;
}
