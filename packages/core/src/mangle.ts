// asmlift — CodeWarrior (Metrowerks) C++ name mangling + demangling.
//
// objdiff aligns a candidate to its target by SYMBOL, and a C++ target's symbol is the MANGLED
// string (`Vec::dot(Vec*)` → `dot__3VecFP3Vec`). The backend GENERATES that symbol from the
// recovered signature (`mangle`); to name it idiomatically for a human it RECOVERS the
// scope/signature from the target symbol (`demangle`). Both directions are pure string
// transforms, fully offline-testable (test/mangle.test.ts) — no toolchain needed.
//
// Scheme (Metrowerks, NOT Itanium). A function symbol is `<name>__<qual><F><argcodes>`:
//   • free function      `f(int,int)`       → `f__Fii`
//   • member function    `Vec::dot(Vec*)`   → `dot__3VecFP3Vec`   (`3Vec` = class, len-prefixed)
//   • no-arg             `g()`              → `g__Fv`
// The implicit `this` of a member is NOT in the arg list. Type codes are below (CODE ↔ spelling).

/** A recovered C++ type: a base (builtin name or a class) with a pointer depth. */
export interface CppType {
  base: string;
  ptr: number;
} // e.g. {base:"Vec", ptr:1} = `Vec *`
export interface CppSig {
  name: string;
  cls?: string;
  params: CppType[];
}

// Builtin type ↔ Metrowerks code. Unsigned builtins take a `U` prefix; a class type is length-
// prefixed (`3Vec`), so builtins and classes are disambiguated by a leading digit.
const BUILTIN_CODE: Record<string, string> = {
  void: 'v',
  char: 'c',
  short: 's',
  int: 'i',
  long: 'l',
  'long long': 'x',
  float: 'f',
  double: 'd',
  bool: 'b',
  'unsigned char': 'Uc',
  'unsigned short': 'Us',
  'unsigned int': 'Ui',
  'unsigned long': 'Ul',
};
const CODE_BUILTIN: Record<string, string> = Object.fromEntries(Object.entries(BUILTIN_CODE).map(([k, v]) => [v, k]));

function mangleType(t: CppType): string {
  const base = BUILTIN_CODE[t.base] ?? `${t.base.length}${t.base}`; // builtin code OR `<len><name>`
  return 'P'.repeat(t.ptr) + base;
}

/** Mangle a recovered signature into its CodeWarrior symbol. */
export function mangle(sig: CppSig): string {
  const qual = sig.cls ? `${sig.cls.length}${sig.cls}` : '';
  const args = sig.params.length ? sig.params.map(mangleType).join('') : 'v'; // () ⇒ `v`
  return `${sig.name}__${qual}F${args}`;
}

/** Parse one argument type off the front of `s`, returning the type and the remaining string. */
function parseType(s: string): { t: CppType; rest: string } {
  let ptr = 0;
  while (s[0] === 'P') {
    ptr++;
    s = s.slice(1);
  }
  const digits = s.match(/^(\d+)/);
  if (digits) {
    // a class type: <len><name>
    const len = parseInt(digits[1], 10);
    const name = s.slice(digits[1].length, digits[1].length + len);
    // A length prefix that overruns the symbol is NOT a mangled type (e.g. the plain-C name
    // `map__Fill16`) — reject rather than fabricate an empty/truncated class name.
    if (len === 0 || name.length !== len) {
      throw new Error(`mangle: class-name length prefix overruns the symbol at '${s}'`);
    }
    return { t: { base: name, ptr }, rest: s.slice(digits[1].length + len) };
  }
  // a builtin: greedily match the longest code (the `U`-prefixed unsigned codes are 2 chars).
  for (const code of ['Uc', 'Us', 'Ui', 'Ul']) {
    if (s.startsWith(code)) {
      return { t: { base: CODE_BUILTIN[code], ptr }, rest: s.slice(2) };
    }
  }
  const one = s[0];
  if (CODE_BUILTIN[one]) {
    return { t: { base: CODE_BUILTIN[one], ptr }, rest: s.slice(1) };
  }
  throw new Error(`mangle: unrecognized type code at '${s}'`);
}

/** Demangle a CodeWarrior function symbol back into its recovered signature. Returns null if `sym`
 *  is not a mangled function name (e.g. an unmangled C symbol), so callers can treat it as plain C. */
export function demangle(sym: string): CppSig | null {
  const i = sym.indexOf('__');
  if (i <= 0) {
    return null;
  }
  const name = sym.slice(0, i);
  let rest = sym.slice(i + 2);
  let cls: string | undefined;
  // An optional class qualifier precedes `F` (a leading digit = the class-name length prefix).
  const q = rest.match(/^(\d+)/);
  if (q) {
    const len = parseInt(q[1], 10);
    cls = rest.slice(q[1].length, q[1].length + len);
    if (len === 0 || cls.length !== len) {
      return null;
    } // overrunning qualifier ⇒ not a mangled name
    rest = rest.slice(q[1].length + len);
  }
  if (rest[0] !== 'F') {
    return null;
  } // not a function signature
  rest = rest.slice(1);
  const params: CppType[] = [];
  if (rest === 'v') {
    rest = '';
  } // `Fv` = ()
  // A type code this scheme-subset doesn't model (const `C`, reference `R`, …) means the symbol is
  // outside our vocabulary, not malformed input — honor the documented contract and return null so
  // the caller treats it as un-recoverable rather than crashing.
  try {
    while (rest.length) {
      const { t, rest: r } = parseType(rest);
      params.push(t);
      rest = r;
    }
  } catch {
    return null;
  }
  return { name, cls, params };
}

/** Spell a CppType as C++ source (`Vec *`, `unsigned int`). */
export function spellType(t: CppType): string {
  return t.base + (t.ptr ? ' ' + '*'.repeat(t.ptr) : '');
}
