// Deterministic readability heuristic (0..100, higher = more readable). Readability is subjective,
// so this is a transparent proxy — every penalty is counted and reported, and the webapp shows the
// code side-by-side so a human can judge. Penalized signals:
//   • undecompiled glue  — M2C_ERROR / M2C_UNK / unknown-type `? (` / opaque  (strongest signal)
//   • goto / labels      — structured control flow lost
//   • raw memory casts   — `*(T*)(p + N)` instead of `p->field` / `p[i]` (no type recovery)
//   • excess casts       — noise (project-idiom ADDRESS casts exempt — see below)
//
// FAIRNESS: m2c's `var_X`/`temp_X` and asmlift's `a0`/`v0` are each decompiler's normal
// generic-local idiom (neither recovers real names without context) — NOT penalized. Only genuine
// failure markers count as glue.
import type { QualityHabits, QualityScore } from '@asmlift/bench-schema';
import { elseAfterReturnCount, shapeHabits } from '@asmlift/core/shape-habits';

const GLUE_PATTERNS = [
  /M2C_ERROR/g,
  /M2C_UNK/g,
  /\/\* Decompilation failure/g,
  /ASMLIFT_ERROR/g, // asmlift annotate-mode gap marker
  /\bopaque[A-Za-z0-9_]*/g,
  /\?\s*\(\s*\*+/g, // `? (*fn)` — m2c unknown type
  /unknown instruction/g,
];

function countAll(src: string, re: RegExp): number {
  return (src.match(re) ?? []).length;
}

// Project-idiom ADDRESS casts are EXEMPT from the casts count: `(u32)&gSym` / `(s32)&gSym`
// (core's addr-intify — integer arithmetic/compares on a link-time address) and `(u32)Func`
// (a code address stored as an integer) are the CORRECT source spelling of that construct,
// not cast noise — the decomp projects themselves write them. Textual discipline for the
// bare-identifier form: the identifier must not be a generic LOCAL (asmlift's a0/v0, m2c's
// var_X/temp_X/phi_X/argN/spN) — a u32 cast of a local is a value truncation, still noise —
// and must not be a call (`(u32)F(x)` casts the RESULT, not the address). The `&` forms are
// address spellings by construction, exempt for any identifier.
const ADDR_CAST_EXEMPT = /\(\s*[us]32\s*\)\s*&\s*[A-Za-z_]\w*|\(\s*u32\s*\)\s*([A-Za-z_]\w*)(?!\w)(?!\s*\()/g;
const GENERIC_LOCAL = /^(?:[av]\d+|arg\d+|sp\d*|var_\w+|temp_\w+|phi_\w+)$/;

/** How many of the counted casts are exempt address spellings (always a subset of the casts
 *  regex's matches — each starts with a `(u32)`/`(s32)` that regex counts).
 *
 *  "Is this identifier a local?" is answered by its NAME's shape and, past that, by the declarations
 *  the source itself prints (its parameter list and the declarations opening its body): a decompiler
 *  that names a local or a parameter (`(u32)count`) truncates a value exactly as `(u32)v0` does, and
 *  reading the name alone would exempt that cast as an address spelling. */
function countAddrCastExemptions(src: string, declared: ReadonlySet<string>): number {
  let n = 0;
  for (const m of src.matchAll(ADDR_CAST_EXEMPT)) {
    if (m[1] === undefined || !(GENERIC_LOCAL.test(m[1]) || declared.has(m[1]))) {
      n++;
    }
  }
  return n;
}

/** The function's text split at its body: the signature line (the last line that opens a brace
 *  after a parameter list, at column 0), the declarations that open the body, and the statements
 *  after them. A source with no recognizable signature (a failure stub) has an empty body. */
interface FnParts {
  signature: string;
  decls: { line: string; name: string }[];
  stmts: string[];
}

const DECL_LINE =
  /^ {4}(?:static |volatile |const |struct |union |unsigned |signed )*[A-Za-z_]\w*(?:\s+|\s*\*+\s*)\**([A-Za-z_]\w*)(?:\[[^\]]*\])*(?: = [^;]*)?;$/;
const NOT_A_DECL = /^\s*(?:return|goto|break|continue|case|default)\b/;

function fnParts(src: string): FnParts {
  const lines = src.split('\n');
  const at = lines.findIndex((l) => /^[A-Za-z_].*\)\s*\{\s*$/.test(l));
  if (at < 0) {
    return { signature: '', decls: [], stmts: [] };
  }
  const decls: { line: string; name: string }[] = [];
  let j = at + 1;
  for (; j < lines.length; j++) {
    const m = DECL_LINE.exec(lines[j]);
    if (!m || NOT_A_DECL.test(lines[j]) || /\(/.test(lines[j].split(' = ')[0])) {
      break;
    }
    decls.push({ line: lines[j], name: m[1] });
  }
  return { signature: lines[at], decls, stmts: lines.slice(j) };
}

/** The parameter names a signature line declares, in order. The list is split at its top-level
 *  commas only, so a function-pointer parameter's own list stays whole, and each name is read
 *  past an array suffix (`u8 a0[4]`) or out of a parenthesized pointer declarator, a function
 *  pointer's (`void (*a1)(s32)`) or a pointer to an array's (`s32 (*a1)[4]`). An unnamed
 *  parameter and `(void)` give no name. */
function paramNames(signature: string): string[] {
  const params = /\((.*)\)\s*\{\s*$/.exec(signature)?.[1] ?? '';
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < params.length; i++) {
    const c = params[i];
    if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
    } else if (c === ',' && depth === 0) {
      pieces.push(params.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(params.slice(start));
  const out: string[] = [];
  for (const p of pieces) {
    const m =
      /\(\s*\*+\s*([A-Za-z_]\w*)\s*(?:\[[^\]]*\])*\s*\)\s*[([]/.exec(p) ??
      /([A-Za-z_]\w*)\s*(?:\[[^\]]*\])*\s*$/.exec(p.trim());
    if (m && m[1] !== 'void') {
      out.push(m[1]);
    }
  }
  return out;
}

/** Parameter and local names the source declares (`fnParts`). */
function declaredNames(parts: FnParts): Set<string> {
  const out = new Set(parts.decls.map((d) => d.name));
  for (const name of paramNames(parts.signature)) {
    out.add(name);
  }
  return out;
}

/** Does `rhs` hold, outside parentheses, an operator that binds LOOSER than `+`/`-`? Then
 *  `x = x + rhs` printed flat groups as `(x + a) << 2`, and is no compound assignment. */
function hasLooseTopLevelOp(rhs: string): boolean {
  let depth = 0;
  for (let i = 0; i < rhs.length; i++) {
    const c = rhs[i];
    if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
    } else if (depth === 0 && /[<>=!&|^?]/.test(c) && !(c === '>' && rhs[i - 1] === '-')) {
      return true;
    }
  }
  return false;
}

/** The index of the `(` that opens the group closed at `close`, or -1. */
function openingParen(s: string, close: number): number {
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    if (s[k] === ')') {
      depth++;
    } else if (s[k] === '(') {
      depth--;
      if (depth === 0) {
        return k;
      }
    }
  }
  return -1;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The habit counters (`QualityHabits`), each a textual reading of the statements. */
function assessHabits(parts: FnParts): QualityHabits {
  const body = parts.stmts.join('\n');
  const isVoid = /^(?:static\s+)?void\s/.test(parts.signature);

  // `*p` beside `p[k]`: a deref is a `*` with no space before the name (the printer spaces a
  // multiplication) that is not itself subscripted, called or a member access.
  const subscripted = new Set([...body.matchAll(/\b([A-Za-z_]\w*)\[(?:0x[0-9a-fA-F]+|\d+)\]/g)].map((m) => m[1]));
  let ptrDeref0 = 0;
  for (const m of body.matchAll(/(?<![\w)\]])\*([A-Za-z_]\w*)\b(?!\s*[[(.]|->)/g)) {
    if (subscripted.has(m[1])) {
      ptrDeref0++;
    }
  }

  const dec = '(?<![\\w.])[1-9]\\d+(?![\\w.])';
  const decimalMasks = [
    new RegExp(`(?<![&|])[&|^](?![&|=])\\s*(?:\\([\\w ]+\\)\\s*)?${dec}`, 'g'),
    new RegExp(`${dec}\\s*[&|^](?![&|=])`, 'g'),
    new RegExp(`~\\s*${dec}`, 'g'),
    new RegExp(`${dec}\\s*(?:<<|>>)`, 'g'),
    new RegExp(`\\*\\s*\\)\\s*${dec}`, 'g'),
  ].reduce((n, re) => n + countAll(body, re), 0);

  const incrStmts = countAll(body, /(?:^\s*|; )([A-Za-z_]\w*) = \1 [+-] 1(?:;$|\)(?= \{$))/gm);
  let compoundStmts = 0;
  for (const m of body.matchAll(/^\s*([^=;\n]+?) = ([^;\n]+);$/gm)) {
    const lv = m[1];
    const rest = m[2];
    if (!rest.startsWith(`${lv} + `) && !rest.startsWith(`${lv} - `)) {
      continue;
    }
    const rhs = rest.slice(lv.length + 3);
    if (rhs !== '1' && !hasLooseTopLevelOp(rhs)) {
      compoundStmts++;
    }
  }

  let voidTail = 0;
  if (isVoid) {
    const stmts = parts.stmts.filter((l) => l.trim().length > 0);
    if (stmts.length >= 2 && stmts[stmts.length - 2] === '    return;') {
      voidTail++;
    }
    voidTail += countAll(body, /^ {4}default:\n\s*(?:return;|break;)\n {4}\}\n\}/gm);
  }

  const elseAfterReturn = elseAfterReturnCount(body);

  let callNeZero = 0;
  for (const m of body.matchAll(/\) != 0(?=\)| &&| \|\|)/g)) {
    const open = openingParen(body, m.index);
    const before = body.slice(0, open);
    if (open > 0 && /(?:\bif \(|\bwhile \(|&& |\|\| |; |!\()[A-Za-z_]\w*$/.test(before)) {
      callNeZero++;
    }
  }

  const vs = [...new Set(parts.decls.map((d) => /^v(\d+)$/.exec(d.name)?.[1]).filter((v) => v !== undefined))]
    .map(Number)
    .sort((a, b) => a - b);
  const localGaps = vs.length === 0 ? 0 : vs[vs.length - 1] + 1 - vs.length;
  const unusedLocals = parts.decls.filter((d) => !new RegExp(`\\b${escapeRe(d.name)}\\b`).test(body)).length;

  const placeholderParams = paramNames(parts.signature).filter((n) => /^a\d+$/.test(n)).length;
  // a loop's test: a `while (…)` (a `do`'s closing one included) or a `for`'s middle clause
  let genericCounters = 0;
  for (const m of body.matchAll(/\b(?:while \((.*)\)(?: \{|;)$|for \([^;]*;([^;]*);)/gm)) {
    if (/\bv\d+\b/.test(m[1] ?? m[2])) {
      genericCounters++;
    }
  }

  return {
    ...shapeHabits(parts.stmts, [parts.signature, ...parts.decls.map((d) => d.line)]),
    ptrDeref0,
    decimalMasks,
    incrStmts,
    compoundStmts,
    voidTail,
    elseAfterReturn,
    callNeZero,
    localGaps,
    unusedLocals,
    placeholderParams,
    genericCounters,
  };
}

export function assessQuality(src: string): QualityScore {
  const parts = fnParts(src);
  const lines = src.split('\n').filter((l) => l.trim().length > 0).length;
  const gotos = countAll(src, /\bgoto\b/g);
  const labels = countAll(src, /^\s*[A-Za-z_]\w*:\s*$/gm);
  const casts =
    countAll(
      src,
      /\(\s*(?:un)?signed\b[^)]*\)|\((?:u8|u16|u32|s8|s16|s32|int|char|short|long|void|float|double)\s*\**\s*\)/g,
    ) - countAddrCastExemptions(src, declaredNames(parts));
  const rawMem = countAll(src, /\*\(\s*[A-Za-z_][\w ]*\*+\s*\)\s*\(/g); // *(T*)( ... )
  // *(T*)0xADDR — an absolute-address deref (typically MMIO): the symbol/global was not
  // recovered. Counted for the report but NOT score-penalized (the score formula is pinned).
  const addrDeref = countAll(src, /\*\s*\(\s*[A-Za-z_][\w ]*\*+\s*\)\s*0[xX][0-9a-fA-F]+/g);
  const unkGlue = GLUE_PATTERNS.reduce((n, re) => n + countAll(src, re), 0);

  let score = 100;
  if (unkGlue) {
    score -= Math.min(50, unkGlue * 12);
  }
  if (gotos) {
    score -= Math.min(24, gotos * 8);
  }
  if (labels) {
    score -= Math.min(12, labels * 4);
  }
  if (rawMem) {
    score -= Math.min(20, rawMem * 4);
  }
  if (casts > 2) {
    score -= Math.min(12, (casts - 2) * 2);
  }
  score = Math.max(0, Math.min(100, score));

  return { score, lines, gotos, casts, unkGlue, rawMem, addrDeref, habits: assessHabits(parts) };
}
