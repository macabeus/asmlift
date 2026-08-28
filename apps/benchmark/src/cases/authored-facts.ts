// The AUTHORED facts a row hands its decompilers, cross-checked against the function the compiler
// actually compiled.
//
// A row feeds its two decompilers separate, hand-written inputs. asmlift gets `proto` — void-ness,
// callee arities, declared parameter types. m2c gets whatever a hand-written `ctx` declares, and on
// a row with a vendored context the one prototype line cases/real.ts's `m2cOwnPrototype` derives
// from that SAME `proto` (it used to reconstruct it from `funcC`, the answer, which is the leakage
// that removal closed). Nothing held any of them against each other, and a
// row that got one wrong scored a decompiler down FOR OBEYING IT: marioparty3:func_80056254_56E54
// published `"returnsVoid": true` four lines under a `funcC` returning `(*arg0)->unk0C`, and
// asmlift's faithful `return;` cost it a byte-exact match while m2c, which never reads `proto`,
// matched.
//
// THE ORACLE IS THE ROW'S COMPILED TEXT — the real tier's vendored preprocessed TU, the synthetic
// tier's `src` — and what that is worth has a precise limit. The TU is `cpp(project headers +
// prependC + funcC)` (cases/vendor.ts), so it is NOT independent of `funcC`. What it is independent
// of is `proto`, which is the axis the seed defect lived on, and the property that keeps `funcC`
// from being the field someone tunes is a different one: the same blob IS the target
// (compile/real.ts), so moving the reference source to agree with a wrong prototype moves the bytes
// the row scores against. Against `funcC` this therefore checks two narrower things, both real: a
// signature that disagrees with its own TU after macro expansion, and a `funcC` edited without
// re-vendoring — a stale target, which nothing else here notices.
//
// What this does NOT check: whether a fact is USEFUL, or whether a row should carry one at all. A
// `proto` a row simply lacks is not a defect against the oracle; only a present one the compiled
// function refutes. The one place a MISSING entry is a defect is between the two authored inputs
// themselves — a callee a row declares to m2c in its own `ctx` and not to asmlift — and that
// comparison lives in the test, on `declaredFunctionNames` below.
import type { Prototypes } from '@asmlift/core/proto';

import type { RealFunction } from './manifests';

/** One function's signature as the reference compiler saw it. */
export interface CompiledSignature {
  /** return type, macros expanded, storage class and attributes removed (`void`, `void *`) */
  returnType: string;
  /** declared parameter types; `(void)` and `()` normalize to the empty list */
  params: string[];
}

/** Attribute-like macros a project writes inside a signature. They are invisible to the compiler
 *  (they expand to an `__attribute__` or to nothing), so `funcC` can carry one where the
 *  preprocessed TU does not — pokeemerald's `static void UNUSED Set…`. Both the bare form and the
 *  parameterized one (`ALIGNED(4)`) are removed with their argument list.
 *
 *  Unlisted spellings are deliberately NOT ignored: an unknown token in a signature fails the
 *  check BY NAME and the fix is to add it here. A pattern that skipped anything ALL-CAPS would
 *  also skip `UNK_8085D14`, which is a type. The names listed here are reserved dataset-wide: the
 *  token is blanked wherever it appears in a signature, so one may not double as a parameter name.
 *
 *  cases/real.ts strips these from the prototype line it hands m2c: m2c's context parser is a real
 *  C parser and hard-fails on the unexpanded macro (`Syntax error when parsing C context`). */
export const ATTRIBUTE_MACROS: ReadonlySet<string> = new Set(['UNUSED']);

/** A callee prototype whose subject the row's own TU never DECLARES: the project declares it in a
 *  `.c` the TU does not include, so the compiler itself saw only an implicit declaration and the
 *  vendored blob holds no oracle. The remedy is not to skip the entry — that silence passed a
 *  `ValidateSave` declared with six parameters — but to move the oracle here: `decl` is the
 *  declaration copied from the pinned checkout at `cite`, and the row's `proto` is then checked
 *  against IT exactly as it would be against a TU. What stays uncovered is one hand-copied line
 *  per entry, and adding one is deliberate. */
export interface CitedDeclaration {
  /** the declaration as the project spells it, checkable C */
  decl: string;
  /** where it was read from, so the next reader can re-check it */
  cite: string;
}

/** Keyed `project:sym:callee`. */
export const UNVERIFIABLE_CALLEE_PROTOS: ReadonlyMap<string, CitedDeclaration> = new Map([
  [
    'sa3:sub_8001FD4:ValidateSave',
    { decl: 'void ValidateSave(SaveGame *save);', cite: 'macabeus/sa3 src/code_0_0.c:15' },
  ],
  [
    'sa3:sub_8001FD4:PackSaveSector',
    { decl: 'void PackSaveSector(SaveSectorData *sector, SaveGame *save);', cite: 'macabeus/sa3 src/code_0_0.c:440' },
  ],
  [
    'sa3:sub_8001FD4:WriteSaveSector',
    { decl: 's32 WriteSaveSector(s16 sectorId, SaveSectorData *sector);', cite: 'macabeus/sa3 src/code_0_0.c:362' },
  ],
  ['sa3:sub_8001FD4:sub_8001A90', { decl: 's16 sub_8001A90(void);', cite: 'macabeus/sa3 src/code_0_0.c:672' }],
]);

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

/** Remove the ATTRIBUTE_MACROS tokens — WITH their argument list where they take one — from a
 *  signature. This is what makes a hand-quoted signature comparable to the preprocessed one, and
 *  what keeps the prototype line handed to m2c parseable as C: blanking `ALIGNED` and leaving the
 *  `(4)` behind produces `void (4) DoThing(…)`, which is neither. */
export function stripAttributeMacros(s: string): string {
  for (const macro of ATTRIBUTE_MACROS) {
    const re = new RegExp(`\\b${escapeRe(macro)}\\b`);
    for (let m = re.exec(s); m; m = re.exec(s)) {
      let end = m.index + macro.length;
      let k = end;
      while (k < s.length && /\s/.test(s[k])) {
        k++;
      }
      if (s[k] === '(') {
        const close = matchParen(s, k);
        end = close < 0 ? end : close + 1;
      }
      s = `${s.slice(0, m.index)} ${s.slice(end)}`;
    }
  }
  return s;
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

/** Where a `sym (…)` occurrence sits and what follows it, for the finders below. */
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

/** Does the compiled text call or declare `sym` at all? */
function mentions(text: string, sym: string): boolean {
  for (const _ of occurrences(text, sym)) {
    return true;
  }
  return false;
}

/** The declarator prefix in front of a `sym (…)` occurrence: back to the previous statement
 *  boundary or cpp line marker. NOT back to the previous newline — a signature may wrap — so the
 *  marker lines the slice may swallow are dropped by `returnTypeOf`. */
function headBefore(text: string, nameAt: number): string {
  const start = Math.max(text.lastIndexOf(';', nameAt), text.lastIndexOf('}', nameAt), text.lastIndexOf('\n#', nameAt));
  return text.slice(start + 1, nameAt);
}

/** Keywords that can only open a STATEMENT. Their presence is what separates a declarator prefix
 *  from a slice of function body, which is the difference between `int` and `else { return`. */
const STATEMENT_KEYWORDS: ReadonlySet<string> = new Set([
  'return',
  'if',
  'else',
  'while',
  'for',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'goto',
  'sizeof',
]);

/** Is `head` a plausible C declarator prefix — a type, not the tail of an expression? Anything
 *  bracketed, operated on, or opened by a statement keyword is a CALL SITE that happened to follow
 *  a `;`, and reading one as a declaration is worse than finding nothing: it both rejects correct
 *  entries (quoting `else { return` as "its declaration") and accepts wrong ones. */
function isDeclaratorHead(head: string): boolean {
  if (!head) {
    return false; // K&R implicit declaration, or a call with no prefix at all
  }
  if (/[^\w\s*]/.test(head)) {
    return false;
  }
  return head.split(/[\s*]+/).every((t) => !STATEMENT_KEYWORDS.has(t));
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
 *  subject is not the row's own function. Returns [] when the TU only ever CALLS the symbol (the
 *  project declares it in a `.c` the TU does not include, so the compiler saw an implicit
 *  declaration too); the caller must not read that as agreement. */
export function declarationsOf(tu: string, sym: string): CompiledSignature[] {
  const found: CompiledSignature[] = [];
  for (const o of occurrences(tu, sym)) {
    if (o.next !== '{' && o.next !== ';') {
      continue;
    }
    const head = returnTypeOf(headBefore(tu, o.nameAt));
    if (!isDeclaratorHead(head)) {
      continue;
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

/** Does a DECLARED type name the same type the compiler compiled? The compiled parameter is
 *  `TYPE` or `TYPE name`, and a declared type is the type text alone, so the two agree when the
 *  compiled one is the declared one plus at most a declarator.
 *
 *  Compared as TEXT rather than as pointer-ness plus width, which is what the first version did and
 *  which cannot see a wrong pointee: 8 synthetic specs declared `void *` to asmlift where their own
 *  `ctx` told m2c `s32 *`, and every width- and pointer-based reading of that pair says they agree. */
function declaredTypeMatches(declared: string, compiled: string): boolean {
  const a = normParam(declared);
  const b = normParam(compiled ?? '');
  return a === b || (b.startsWith(`${a} `) && /^\w+$/.test(b.slice(a.length + 1)));
}

const TYPE_KEYWORDS: ReadonlySet<string> = new Set([
  'const',
  'volatile',
  'struct',
  'union',
  'enum',
  'unsigned',
  'signed',
  'long',
  'short',
  'int',
  'char',
  'float',
  'double',
  'void',
  'register',
]);

/** The PARAMETER NAME a declared type text carries, or null when it is a type and nothing else.
 *  `proto.params` is documented as the type text alone (`"s32"`, `"Player *"`) and core's
 *  `declaredWidth` answers a declarator it cannot parse with `undefined`, which its one consumer
 *  reads as NO OPINION — so `"s32 arg0"` does not declare a narrower width, it declares nothing,
 *  silently. */
export function declaratorNameIn(type: string): string | null {
  const t = type.replace(/\[[^\]]*\]/g, ' ').trim();
  const star = t.lastIndexOf('*');
  if (star >= 0) {
    const tail = t
      .slice(star + 1)
      .replace(/\b(?:const|volatile)\b/g, ' ')
      .trim();
    return tail === '' ? null : tail.split(/\s+/)[0];
  }
  const names = t.split(/[\s*]+/).filter((w) => w && !TYPE_KEYWORDS.has(w));
  return names.length > 1 ? names[names.length - 1] : null;
}

/** The function names a hand-written C context DECLARES — a prototype, `… name(…);`, which is the
 *  only shape either decompiler reads as "this callee exists and looks like this".
 *
 *  Deliberately conservative: an identifier immediately followed by `(` is not enough (`typedef
 *  void (*Fn)(int);` would name `void`, `extern int (*t[4])(int);` would name `int`), so keywords
 *  and reserved `__` spellings are dropped and the match must run to `);`. It can MISS a callee
 *  spelled unusually; it must not INVENT one, because the caller's finding is "this row tells one
 *  decompiler something it does not tell the other" and a phantom name makes that finding false. */
export function declaredFunctionNames(ctx: string): string[] {
  return [...ctx.matchAll(/\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*;/g)]
    .map((m) => m[1])
    .filter((n) => !TYPE_KEYWORDS.has(n) && !STATEMENT_KEYWORDS.has(n) && !n.startsWith('__') && n !== 'typedef');
}

/** The compiled signature of `sym`, or the reason there is no oracle for it. Both tiers: the real
 *  tier's oracle is its vendored preprocessed TU, the synthetic tier's is the `src` it compiles
 *  verbatim. */
export function oracleFor(where: string, sym: string, tu: string): CompiledSignature | string {
  const defs = definitionsOf(tu, sym);
  return defs.length === 1
    ? defs[0]
    : `${where}: the compiled source holds ${defs.length} definitions of \`${sym}\` — no oracle, so ` +
        `none of this row's authored facts were checked (real tier: re-run \`bench vendor\`)`;
}

/** Every way one row's `proto` — the table asmlift receives — contradicts the function the
 *  compiler actually saw. Tier-agnostic: `tu` is the compiled text, whatever produced it.
 *
 *  `ctx` is the row's hand-written m2c context where it has one. It is a SECOND source of callee
 *  declarations and nothing else: a callee still has to be one the compiled function actually
 *  calls. Reading it here is what makes the two authored inputs answerable to each other — the
 *  seed defect's own shape, pointed at the callee half. */
export function protoFactProblems(
  where: string,
  sym: string,
  proto: Prototypes | undefined,
  tu: string,
  ctx = '',
): string[] {
  const oracle = oracleFor(where, sym, tu);
  if (typeof oracle === 'string') {
    return [oracle];
  }
  const problems: string[] = [];
  const table = proto ?? {};
  const own = table[sym];
  if (own?.returnsVoid !== undefined && own.returnsVoid !== (oracle.returnType === 'void')) {
    problems.push(
      `${where}: proto says \`returnsVoid: ${own.returnsVoid}\` but the compiled function returns ` +
        `\`${oracle.returnType}\` — asmlift obeys the declaration, so this row scores it for a lie`,
    );
  }
  for (const [name, entry] of Object.entries(table)) {
    for (const p of Array.isArray(entry.params) ? entry.params : []) {
      const declarator = declaratorNameIn(p);
      if (declarator !== null) {
        problems.push(
          `${where}: proto declares \`${name}\` parameter \`${normParam(p)}\`, which carries the ` +
            `parameter NAME \`${declarator}\` — a declared type is the type text alone (\`s32\`, ` +
            `\`Player *\`), and core's declaredWidth reads a declarator as no opinion at all`,
        );
      }
    }
  }
  if (own?.params !== undefined) {
    const declared = typeof own.params === 'number' ? own.params : own.params.length;
    if (declared !== oracle.params.length) {
      problems.push(
        `${where}: proto declares ${declared} parameter(s), the compiled function takes ${oracle.params.length}`,
      );
    } else if (Array.isArray(own.params)) {
      own.params.forEach((p, i) => {
        if (!declaredTypeMatches(p, oracle.params[i])) {
          problems.push(
            `${where}: proto parameter ${i} is \`${normParam(p)}\`, the compiled one is ` +
              `\`${normParam(oracle.params[i])}\``,
          );
        }
      });
    }
  }

  // callee entries: a row may only describe functions it actually calls, and must describe them
  // the way they are declared where the compiled text declares them at all
  for (const [callee, entry] of Object.entries(table)) {
    if (callee === sym) {
      continue;
    }
    if (!mentions(tu, callee)) {
      problems.push(
        `${where}: proto describes \`${callee}\`, which the compiled function never mentions ` +
          `(check the macro-EXPANDED name — \`CpuCopy32(…)\` in the source is \`CpuSet(…)\` here)`,
      );
      continue;
    }
    let decls = [...declarationsOf(tu, callee), ...(ctx ? declarationsOf(ctx, callee) : [])];
    if (decls.length === 0) {
      const cited = UNVERIFIABLE_CALLEE_PROTOS.get(`${where}:${callee}`);
      if (!cited) {
        problems.push(
          `${where}: the compiled source CALLS \`${callee}\` and neither it nor this row's \`ctx\` ` +
            `declares it, so the entry's arity and void-ness have no oracle — declare it in \`ctx\` ` +
            `(m2c needs it too), or copy the declaration off the pinned checkout into ` +
            `UNVERIFIABLE_CALLEE_PROTOS, keyed \`${where}:${callee}\` and cited`,
        );
        continue;
      }
      decls = declarationsOf(cited.decl, callee);
      if (decls.length !== 1) {
        problems.push(
          `${where}: UNVERIFIABLE_CALLEE_PROTOS's \`${callee}\` declaration (${cited.cite}) does not ` +
            `parse as one declaration of it: ${JSON.stringify(cited.decl)}`,
        );
        continue;
      }
    }
    const arities = new Set(decls.map((d) => d.params.length));
    if (entry.params !== undefined && arities.size === 1) {
      const declared = typeof entry.params === 'number' ? entry.params : entry.params.length;
      const [actual] = [...arities];
      if (declared !== actual) {
        problems.push(`${where}: proto gives \`${callee}\` ${declared} parameter(s); its declaration takes ${actual}`);
      }
    }
    const voids = new Set(decls.map((d) => d.returnType === 'void'));
    if (entry.returnsVoid !== undefined && voids.size === 1 && [...voids][0] !== entry.returnsVoid) {
      problems.push(
        `${where}: proto says \`${callee}\` returnsVoid: ${entry.returnsVoid}; it is declared ` +
          `\`${decls[0].returnType}\``,
      );
    }
  }
  return problems;
}

/** Every way one REAL row's authored facts contradict its own compiled function: its `proto`, plus
 *  the reference source `funcC` — which is quoted out of the project by hand, DEFINES the target,
 *  and is, on every row that gets a vendored context, also the prototype line the harness hands
 *  m2c. That last use is why the PARAMETER TYPES are compared and not merely counted: a parameter
 *  list the target refutes is spliced verbatim into m2c's context, which is the seed defect again
 *  with the other decompiler as the victim. */
export function authoredFactProblems(project: string, fn: RealFunction, tu: string): string[] {
  const where = `${project}:${fn.sym}`;
  const oracle = oracleFor(where, fn.sym, tu);
  if (typeof oracle === 'string') {
    return [oracle];
  }
  const problems: string[] = [];
  const quoted = quotedSignature(fn.funcC);
  const macroHint = (t: string): string =>
    /[A-Z_]{2,}/.test(t) ? ' — if the extra token is an attribute macro, list it in ATTRIBUTE_MACROS' : '';
  if (!quoted) {
    problems.push(`${where}: \`funcC\` has no parseable signature`);
  } else {
    if (quoted.returnType !== oracle.returnType) {
      problems.push(
        `${where}: \`funcC\` returns \`${quoted.returnType}\` but the compiled function returns ` +
          `\`${oracle.returnType}\`${macroHint(quoted.returnType)}`,
      );
    }
    if (quoted.params.length !== oracle.params.length) {
      problems.push(
        `${where}: \`funcC\` declares ${quoted.params.length} parameter(s), the compiled function ` +
          `takes ${oracle.params.length}`,
      );
    } else {
      quoted.params.forEach((p, i) => {
        const q = normParam(stripAttributeMacros(p));
        const r = normParam(oracle.params[i]);
        if (q !== r) {
          problems.push(`${where}: \`funcC\` parameter ${i} is \`${q}\`, the compiled one is \`${r}\`${macroHint(q)}`);
        }
      });
    }
  }
  return [...problems, ...protoFactProblems(where, fn.sym, fn.proto, tu, fn.ctx ?? '')];
}
