// The AUTHORED facts a real-tier row hands its decompilers, cross-checked against the compiler's
// own view of the same function.
//
// A row feeds its two decompilers separate, hand-written inputs. asmlift gets `proto` — void-ness,
// callee arities, declared parameter types. m2c gets the function's own prototype line,
// reconstructed from `funcC` by cases/real.ts's `m2cFnPrototype` and appended to its context.
// Both are authored, nothing held them against each other, and a row that got one wrong scored a
// decompiler down FOR OBEYING IT: marioparty3:func_80056254_56E54 published
// `"returnsVoid": true` four lines under `void *func_80056254_56E54(…) { return (*arg0)->unk0C; }`,
// and asmlift's faithful `return;` cost it a byte-exact match while m2c — which never reads
// `proto` — matched.
//
// The oracle is NEITHER authored field: it is the row's VENDORED PREPROCESSED TU, the exact text
// the reference compiler saw with every macro expanded. `proto` and `funcC` are each checked
// against what was actually compiled, so a contradiction can never be reconciled by editing the
// reference source — which DEFINES the target and is never the field to tune.
//
// What this does NOT check: whether a fact is USEFUL, or whether a row should carry one at all. A
// missing `proto` is not a defect here; only a present one that the compiled function refutes.
import { declaredWidth } from '@asmlift/core/proto';

import type { RealFunction } from './manifests';

/** One function's signature as the reference compiler saw it. */
export interface CompiledSignature {
  /** return type, macros expanded, storage class and attributes removed (`void`, `void *`) */
  returnType: string;
  /** declared parameter types; `(void)` and `()` normalize to the empty list */
  params: string[];
}

/** Attribute-like macros a project writes BETWEEN the return type and the function name. They are
 *  invisible to the compiler (they expand to an `__attribute__` or to nothing), so `funcC` can
 *  carry one where the preprocessed TU does not — pokeemerald's `static void UNUSED Set…`.
 *
 *  Unlisted spellings are deliberately NOT ignored: an unknown token in that position fails the
 *  return-type check BY NAME and the fix is to add it here. A pattern that skipped anything
 *  ALL-CAPS would also skip `UNK_8085D14`, which is a type.
 *
 *  cases/real.ts strips these from the prototype line it hands m2c: m2c's context parser is a real
 *  C parser and hard-fails on the unexpanded macro (`Syntax error when parsing C context`). */
export const ATTRIBUTE_MACROS: ReadonlySet<string> = new Set(['UNUSED']);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Index of the `)` closing the `(` at `open`, or -1 when unbalanced. */
export function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') {
      depth++;
    } else if (text[i] === ')' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Drop every `__attribute__((…))`, balanced, however nested. */
function stripAttributes(s: string): string {
  for (;;) {
    const at = s.indexOf('__attribute__');
    if (at < 0) {
      return s;
    }
    const open = s.indexOf('(', at);
    const close = open < 0 ? -1 : matchParen(s, open);
    if (close < 0) {
      return s.slice(0, at);
    }
    s = `${s.slice(0, at)} ${s.slice(close + 1)}`;
  }
}

/** Remove the ATTRIBUTE_MACROS tokens from a declarator prefix — what makes a hand-quoted
 *  signature comparable to the preprocessed one, and what keeps the prototype line handed to m2c
 *  parseable as C. */
export function stripAttributeMacros(s: string): string {
  return s
    .split(/\b/)
    .map((t) => (ATTRIBUTE_MACROS.has(t) ? ' ' : t))
    .join('');
}

/** A declarator prefix reduced to its return type: cpp line markers, attributes, storage classes
 *  and attribute macros removed, whitespace collapsed, `*` spaced canonically. */
export function returnTypeOf(head: string): string {
  return stripAttributeMacros(
    stripAttributes(
      head
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .join(' '),
    ).replace(/\b(?:static|extern|inline|__inline__|__inline|register|auto)\b/g, ' '),
  )
    .replace(/\s*\*\s*/g, ' * ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ \* /g, ' *')
    .replace(/ \*$/, ' *');
}

/** Split a parameter list on top-level commas. `(void)` and `()` are the empty list. */
export function splitParams(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === ']') {
      depth--;
    }
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) {
    out.push(cur.trim());
  }
  return out.length === 1 && out[0].replace(/\s+/g, '') === 'void' ? [] : out;
}

const normParam = (t: string): string =>
  t
    .replace(/\s*\*\s*/g, ' * ')
    .replace(/\s+/g, ' ')
    .trim();

/** Where a `sym (…)` occurrence sits and what follows it, for the two finders below. */
function* occurrences(
  text: string,
  sym: string,
): Generator<{ nameAt: number; open: number; close: number; next: string }> {
  const at = new RegExp(`\\b${escapeRe(sym)}\\s*\\(`, 'g');
  for (let m = at.exec(text); m; m = at.exec(text)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close < 0) {
      continue;
    }
    let k = close + 1;
    while (k < text.length && /\s/.test(text[k])) {
      k++;
    }
    yield { nameAt: m.index, open, close, next: text[k] ?? '' };
  }
}

/** The declarator prefix in front of a `sym (…)` occurrence: back to the previous statement
 *  boundary or cpp line marker. NOT back to the previous newline — a signature may wrap — so the
 *  marker lines the slice may swallow are dropped by `returnTypeOf`. */
function headBefore(text: string, nameAt: number): string {
  const start = Math.max(text.lastIndexOf(';', nameAt), text.lastIndexOf('}', nameAt), text.lastIndexOf('\n#', nameAt));
  return text.slice(start + 1, nameAt);
}

/** Every DEFINITION of `sym` in a preprocessed TU — a `sym (…)` whose parameter list is followed
 *  by `{`. The caller must handle "not exactly one": no oracle means nothing was checked, and
 *  that has to be said out loud rather than pass silently. */
export function definitionsOf(tu: string, sym: string): CompiledSignature[] {
  const found: CompiledSignature[] = [];
  for (const o of occurrences(tu, sym)) {
    if (o.next !== '{') {
      continue; // a declaration or a call site
    }
    found.push({
      returnType: returnTypeOf(headBefore(tu, o.nameAt)),
      params: splitParams(tu.slice(o.open + 1, o.close)),
    });
  }
  return found;
}

/** Every DECLARATION or definition of `sym` in a preprocessed TU — used for CALLEE protos, whose
 *  subject is not the row's own function. Returns [] when the TU only ever calls the symbol
 *  (K&R implicit declaration), in which case the callee's arity has no oracle here. */
export function declarationsOf(tu: string, sym: string): CompiledSignature[] {
  const found: CompiledSignature[] = [];
  for (const o of occurrences(tu, sym)) {
    if (o.next !== '{' && o.next !== ';') {
      continue;
    }
    const head = returnTypeOf(headBefore(tu, o.nameAt));
    if (!head || /[=(,[]$/.test(head)) {
      continue; // a call in expression position that happens to end a statement
    }
    found.push({ returnType: head, params: splitParams(tu.slice(o.open + 1, o.close)) });
  }
  return found;
}

/** The `funcC` signature reduced the same way: its return type and its declared parameters.
 *  `null` when the quoted source has no signature at all. */
export function quotedSignature(funcC: string): CompiledSignature | null {
  const brace = funcC.indexOf('{');
  const sig = (brace < 0 ? funcC : funcC.slice(0, brace)).trim();
  const close = sig.lastIndexOf(')');
  if (close < 0) {
    return null;
  }
  let open = -1;
  for (let i = close, depth = 0; i >= 0; i--) {
    if (sig[i] === ')') {
      depth++;
    } else if (sig[i] === '(' && --depth === 0) {
      open = i;
      break;
    }
  }
  if (open < 0) {
    return null;
  }
  // strip the declarator itself: either `NAME` or a macro call `MACRO(NAME)`
  let head = sig.slice(0, open).trimEnd();
  if (head.endsWith(')')) {
    let macroOpen = -1;
    for (let i = head.length - 1, depth = 0; i >= 0; i--) {
      if (head[i] === ')') {
        depth++;
      } else if (head[i] === '(' && --depth === 0) {
        macroOpen = i;
        break;
      }
    }
    head = macroOpen < 0 ? head : head.slice(0, macroOpen).replace(/[A-Za-z_]\w*\s*$/, '');
  } else {
    head = head.replace(/[A-Za-z_]\w*\s*$/, '');
  }
  return { returnType: returnTypeOf(head), params: splitParams(sig.slice(open + 1, close)) };
}

const isPointer = (t: string): boolean => t.includes('*');

/** Every way one row's authored facts contradict its own compiled function. Empty = consistent. */
export function authoredFactProblems(project: string, fn: RealFunction, tu: string): string[] {
  const where = `${project}:${fn.sym}`;
  const defs = definitionsOf(tu, fn.sym);
  if (defs.length !== 1) {
    return [
      `${where}: the vendored TU holds ${defs.length} definitions of \`${fn.sym}\` — no oracle, so ` +
        `none of this row's authored facts were checked (re-run \`bench vendor\`)`,
    ];
  }
  const [real] = defs;
  const problems: string[] = [];
  const realVoid = real.returnType === 'void';

  // ── the reference source, which DEFINES the target and is also m2c's prototype line ──────────
  const quoted = quotedSignature(fn.funcC);
  if (!quoted) {
    problems.push(`${where}: \`funcC\` has no parseable signature`);
  } else {
    if (quoted.returnType !== real.returnType) {
      problems.push(
        `${where}: \`funcC\` returns \`${quoted.returnType}\` but the compiled function returns ` +
          `\`${real.returnType}\`` +
          (/[A-Z_]{2,}/.test(quoted.returnType)
            ? ` — if the extra token is an attribute macro, list it in ATTRIBUTE_MACROS`
            : ''),
      );
    }
    if (quoted.params.length !== real.params.length) {
      problems.push(
        `${where}: \`funcC\` declares ${quoted.params.length} parameter(s), the compiled function ` +
          `takes ${real.params.length}`,
      );
    }
  }

  // ── the prototype table asmlift receives ─────────────────────────────────────────────────────
  const proto = fn.proto ?? {};
  const own = proto[fn.sym];
  if (own?.returnsVoid !== undefined && own.returnsVoid !== realVoid) {
    problems.push(
      `${where}: proto says \`returnsVoid: ${own.returnsVoid}\` but the compiled function returns ` +
        `\`${real.returnType}\` — asmlift obeys the declaration, so this row scores it for a lie`,
    );
  }
  if (own?.params !== undefined) {
    const declared = typeof own.params === 'number' ? own.params : own.params.length;
    if (declared !== real.params.length) {
      problems.push(
        `${where}: proto declares ${declared} parameter(s), the compiled function takes ${real.params.length}`,
      );
    } else if (Array.isArray(own.params)) {
      own.params.forEach((p, i) => {
        const r = real.params[i];
        if (isPointer(p) !== isPointer(r)) {
          problems.push(
            `${where}: proto parameter ${i} is \`${normParam(p)}\`, the compiled one is \`${normParam(r)}\``,
          );
          return;
        }
        const dp = declaredWidth(p);
        const dr = declaredWidth(r);
        if (dp !== undefined && dr !== undefined && dp !== dr) {
          problems.push(
            `${where}: proto parameter ${i} \`${normParam(p)}\` is ${dp}-bit, the compiled ` +
              `\`${normParam(r)}\` is ${dr}-bit`,
          );
        }
      });
    }
  }

  // ── callee entries: the row may only describe functions it actually calls ────────────────────
  for (const [callee, entry] of Object.entries(proto)) {
    if (callee === fn.sym) {
      continue;
    }
    if (![...occurrences(tu, callee)].length) {
      problems.push(
        `${where}: proto describes \`${callee}\`, which the compiled function never mentions ` +
          `(check the macro-expanded name — \`CpuCopy32\` calls \`CpuSet\`)`,
      );
      continue;
    }
    const decls = declarationsOf(tu, callee);
    const arities = new Set(decls.map((d) => d.params.length));
    if (entry.params !== undefined && arities.size === 1) {
      const declared = typeof entry.params === 'number' ? entry.params : entry.params.length;
      const [actual] = [...arities];
      if (declared !== actual) {
        problems.push(`${where}: proto gives \`${callee}\` ${declared} parameter(s); its declaration takes ${actual}`);
      }
    }
    if (entry.returnsVoid !== undefined && decls.length > 0) {
      const voids = new Set(decls.map((d) => d.returnType === 'void'));
      if (voids.size === 1 && [...voids][0] !== entry.returnsVoid) {
        problems.push(
          `${where}: proto says \`${callee}\` returnsVoid: ${entry.returnsVoid}; it is declared ` +
            `\`${decls[0].returnType}\``,
        );
      }
    }
  }
  return problems;
}
