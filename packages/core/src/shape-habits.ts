// asmlift — shape habits counted off printed C text: three a SHAPE READING removes (an `else` after
// a return and a merged local only returned, /ret-split; a `do`/`while` a reader writes as `for`,
// /for-read) and one no reading removes yet (`shiftTruth`, a shift idiom where a reader writes the
// narrowing cast: no shift-idiom reading was built, since the spelling is byte-identical on agbcc
// alone). The benchmark's readability report publishes them (apps/benchmark/src/eval/quality.ts),
// and rank's tie-break reads the same counts (rank.ts `compareScored`), so the two can never weigh
// one habit two ways; there `shiftTruth` only prefers a candidate that some other variation already
// spelled without the shifts. Pure text functions: browser-safe.

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
/** An integer literal `/for-read` takes (l3/forread.ts `literal`): 0 .. 2^31-1. */
const literalOf = (text: string): number | null => {
  const n = /^(?:0x[0-9a-fA-F]+|\d+)$/.test(text) ? Number(text) : NaN;
  return Number.isInteger(n) && n <= 2 ** 31 - 1 ? n : null;
};
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `k` fit the type `declared` gives `name`, as `/for-read` asks of its counter (l3/forread.ts
 *  `fits`)? `declared` is the signature and the declaration lines. Only a non-`volatile` integer
 *  or pointer parameter or local is a counter; a name declared nowhere there (a global) is none. */
function counterFits(declared: readonly string[], name: string, k: number): boolean {
  const re = new RegExp(`(?:^|[(,])\\s*([A-Za-z_][\\w ]*?)\\s*(\\**)\\s*\\b${escapeRe(name)}\\s*[;,)]`);
  for (const line of declared) {
    const m = re.exec(line);
    if (m === null) {
      continue;
    }
    if (/\bvolatile\b/.test(m[1])) {
      return false;
    }
    if (m[2].length > 0) {
      return true;
    }
    const int = /^(?:(u)|s|unk)(8|16|32|64)$/.exec(m[1].replace(/^const /, ''));
    return int !== null && k < 2 ** (int[1] === 'u' ? Number(int[2]) : Number(int[2]) - 1);
  }
  return false;
}

/** Is `line` the body's last statement updating `v` from itself (`v = …v…;`, `v op= e;`, `v++;`)?
 *  The step `/for-read` folds into the header (l3/forheader.ts `forHeaderOf`). */
function selfUpdates(line: string, ind: string, v: string): boolean {
  const n = escapeRe(v);
  if (new RegExp(`^${ind}(?:${n} (?:[-+*/%&|^]|<<|>>)= .*|${n}\\+\\+|${n}--|\\+\\+${n}|--${n});$`).test(line)) {
    return true;
  }
  const plain = new RegExp(`^${ind}${n} = (.*);$`).exec(line);
  return plain !== null && new RegExp(`\\b${n}\\b`).test(plain[1]);
}

/** Does a `continue` between `from` and `to` bind to the loop opened at `from`? One whose nearest
 *  enclosing loop header lies inside the range binds to that inner loop instead. */
function continuesLoopText(stmts: readonly string[], from: number, to: number): boolean {
  for (let c = from + 1; c < to; c++) {
    if (!/\bcontinue;$/.test(stmts[c])) {
      continue;
    }
    let ind = indentOf(stmts[c]);
    let inner = /^ *(?:\} )?(?:for|while) \(.*\bcontinue;$/.test(stmts[c]);
    for (let j = c - 1; j > from && !inner; j--) {
      if (indentOf(stmts[j]) < ind) {
        ind = indentOf(stmts[j]);
        inner = /^ *(?:do \{|for \(|while \()/.test(stmts[j]);
      }
    }
    if (!inner) {
      return true;
    }
  }
  return false;
}

/** Does `a OP b` hold for two integer literals? */
function literalTestHolds(a: number, op: string, b: number): boolean {
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
 *  printer's layout (four-space indents). `declared` is the signature and the declaration lines,
 *  where `doWhileForable` reads its counter's type. */
export function shapeHabits(stmts: readonly string[], declared: readonly string[]): ShapeHabits {
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
  // `v = K;` then `do {` … `v = …v…;` `} while (v OP L);` at the same indent, with `K OP L` true:
  // the loops `/for-read` reads as a `for` (l3/forread.ts), with its refusals — a counter whose
  // type does not hold `K`, a last statement that does not update `v` from itself, a `continue`
  // bound to this loop — so the count is what a reading can remove
  for (let i = 1; i < stmts.length; i++) {
    const init = /^( *)([A-Za-z_]\w*) = (\S+);$/.exec(stmts[i - 1]);
    if (!init || stmts[i] !== `${init[1]}do {`) {
      continue;
    }
    const end = stmts.findIndex((l, j) => j > i && indentOf(l) === init[1].length);
    const test = end < 0 ? null : /^ *\} while \(([A-Za-z_]\w*) (<=?|>=?|!=) (\S+)\);$/.exec(stmts[end]);
    const k = literalOf(init[3]);
    const l = test === null ? null : literalOf(test[3]);
    if (
      test !== null &&
      test[1] === init[2] &&
      k !== null &&
      l !== null &&
      literalTestHolds(k, test[2], l) &&
      counterFits(declared, init[2], k) &&
      selfUpdates(stmts[end - 1], `${init[1]}    `, init[2]) &&
      !continuesLoopText(stmts, i, end)
    ) {
      doWhileForable++;
    }
  }
  const body = stmts.join('\n');
  const shiftTruth = count(body, /<< 24\)? [!=]= 0\b/g) + count(body, /<< (16|24)\)? >> \1\b/g);
  return { joinedReturn, shiftTruth, doWhileForable };
}

/** The signature and the declaration lines of one printed function: the first line that opens the
 *  body, then the four-space-indented `T name;` lines right after it. */
function declarationLines(lines: readonly string[]): string[] {
  const at = lines.findIndex((l) => /^\S.*\)\s*\{\s*$/.test(l));
  if (at < 0) {
    return [];
  }
  const out = [lines[at]];
  for (
    let j = at + 1;
    j < lines.length && /^ {4}(?!return\b|goto\b)[A-Za-z_][^=()]* \**[A-Za-z_]\w*(?:\[\d*\])*;$/.test(lines[j]);
    j++
  ) {
    out.push(lines[j]);
  }
  return out;
}

/** Every habit above in one printed function: the tie-break's single number. */
export function shapeHabitCount(source: string): number {
  const lines = source.split('\n');
  const h = shapeHabits(lines, declarationLines(lines));
  return elseAfterReturnCount(source) + h.joinedReturn + h.shiftTruth + h.doWhileForable;
}
