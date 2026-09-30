import type { AggregateLayout, AggregateMember, FnProto, ParamType, Prototypes } from './proto';
import {
  declaredArgWidths,
  declaredWidth,
  declaresAggregateReturn,
  statesNoReturn,
  symbolPrototype,
  validatePrototypes,
} from './proto';
import type { SymbolMap } from './symbols';

// asmlift — callee prototypes read out of a DECLARATION CONTEXT: the preprocessed headers a
// candidate is compiled against (a decomp project's `ctx.h`, m2c's `--context`). The compiler
// checks every candidate's calls against those declarations, so a call asmlift writes at a guessed
// arity is a candidate the context then refuses; read here, the declarations decide the arity
// instead of the argument-register scan.
//
// WHAT IS READ. Top-level function declarations and definitions, and the typedefs their spellings
// name. A block that is not `extern "C"` — a struct, class, namespace or function body — is
// skipped whole: what it declares has C++ linkage or is a member, and its symbol is mangled.
//
// KEYED BY THE DECLARED NAME, which is the symbol a call in the assembly names only for C linkage:
// a C++ free function is called by its mangled symbol, so linkage decides itself at the lookup. A
// name declared twice with different signatures (an overload) is dropped: the table cannot say which
// one a call means.
//
// A TYPEDEF RESOLVES ONLY TO THE SAME TYPE. A spelling here is printed into candidates beside the
// project's own headers (`declare.ts`), where a different type is a conflicting declaration. So a
// typedef resolves along its chain only until `declaredWidth` can size the spelling (`BOOL` →
// `int`); a function-pointer typedef resolves to its own abstract declarator (`void (*)(s32)`);
// a struct or enum keeps its name, which sizes to nothing and makes the list abstain.

/** One top-level statement's text, with every skipped block collapsed to `{}`. */
interface Statement {
  text: string;
  /** it ended in a block, not a `;` — a function definition's header */
  definition: boolean;
  /** the text of each block collapsed to `{}` in `text`, in order */
  bodies: string[];
}

/** The source with every comment and preprocessor line (continuation lines included) blanked, and
 *  every brace, parenthesis and semicolon inside a string or character literal blanked — so what
 *  follows counts only the ones that are code, and still reads `extern "C"`. */
function clean(src: string): string {
  let out = '';
  let lineStart = true;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        i++;
      }
      i--;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
      out += ' ';
      continue;
    }
    if (ch === '#' && lineStart) {
      while (i < src.length && !(src[i] === '\n' && src[i - 1] !== '\\')) {
        i++;
      }
      out += '\n';
      lineStart = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        j += src[j] === '\\' ? 2 : 1;
      }
      out += src.slice(i, j + 1).replace(/[{}();]/g, ' ');
      i = j;
      lineStart = false;
      continue;
    }
    out += ch;
    if (ch === '\n') {
      lineStart = true;
    } else if (!/\s/.test(ch)) {
      lineStart = false;
    }
  }
  return out;
}

/** Top-level statements, descending into `extern "C"` blocks and skipping every other block. */
function statements(src: string): Statement[] {
  const text = clean(src);
  const out: Statement[] = [];
  let cur = '';
  let bodies: string[] = [];
  const flush = (definition: boolean): void => {
    const t = cur.replace(/\s+/g, ' ').trim();
    if (t !== '') {
      out.push({ text: t, definition, bodies });
    }
    cur = '';
    bodies = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ';') {
      flush(false);
    } else if (ch === '}') {
      // the end of an `extern "C"` block: it holds no statement of its own
      flush(false);
    } else if (ch === '{') {
      if (/\bextern\s*"C"\s*$/.test(cur)) {
        cur = '';
        continue;
      }
      let depth = 1;
      let j = i + 1;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === '{') {
          depth++;
        } else if (text[j] === '}') {
          depth--;
        }
      }
      const body = text.slice(i + 1, j - 1);
      i = j - 1;
      if (/^\s*(?:namespace\b|extern\s*"C\+\+")/.test(cur)) {
        // a namespace or C++-linkage block ends with its brace, not a `;`
        cur = '';
      } else if (/\)\s*(?:const\s*)?$/.test(cur.trim())) {
        flush(true);
      } else {
        cur += ' {} ';
        bodies.push(body);
      }
    } else {
      cur += ch;
    }
  }
  flush(false);
  return out;
}

/** Split at the commas no parenthesis encloses. */
function topLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(' || s[i] === '[' || s[i] === '<') {
      depth++;
    } else if (s[i] === ')' || s[i] === ']' || s[i] === '>') {
      depth--;
    } else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim());
}

/** Words that are part of a type, never a declarator's name. */
const TYPE_WORDS = new Set([
  'void',
  'char',
  'short',
  'int',
  'long',
  'float',
  'double',
  'signed',
  'unsigned',
  'const',
  'volatile',
  'struct',
  'union',
  'enum',
  'bool',
  '_Bool',
]);

/** Storage and function specifiers, which say nothing about a type. */
const SPECIFIERS = /\b(?:extern|static|inline|__inline|__inline__|virtual|explicit|friend|register|asm|__asm)\b/g;

/** A parameter's type with its name taken off, or `null` for one this does not read. */
function parameterType(p: string): string | null {
  const s = p.replace(/=.*$/, '').replace(SPECIFIERS, ' ').replace(/\s+/g, ' ').trim();
  const fn = /^(.+?)\(\s*\*\s*\w*\s*\)\s*\((.*)\)$/.exec(s);
  if (fn) {
    return `${fn[1].trim()} (*)(${fn[2].trim()})`;
  }
  if (/[()]/.test(s)) {
    return null;
  }
  const array = /^(.*?)\s*\w*\s*\[[^\]]*\]$/.exec(s);
  const base = array ? `${array[1]} *` : s;
  const tokens = base.replace(/\*/g, ' * ').replace(/&/g, ' & ').trim().split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (tokens.length > 1 && /^[A-Za-z_]\w*$/.test(last) && !TYPE_WORDS.has(last)) {
    tokens.pop();
  }
  return tokens.join(' ').replace(/ \*/g, ' *').replace(/\* \*/g, '**').trim();
}

/** One name a `typedef` declares: the type it stands for (as a spelling, before resolution), and
 *  whether it names the struct, union or enum body the statement defines, or a pointer to one that
 *  has no other name to spell it by. */
interface TypedefName {
  name: string;
  type: string;
  names: 'body' | 'unspelled pointer' | 'other';
}

/** A `typedef` statement → every name it declares (`typedef struct R {…} R, *RP;` declares two). A
 *  plain declarator of a body names that body, qualified or not (`} const CR;`), and resolves to
 *  itself. A pointer declarator is a pointer to the base, spelled by the base's tag or by a plain
 *  name the same statement gives it, and resolves to itself where the body has neither
 *  (`typedef struct {…} *PS;`). An array declarator is not read. */
function readTypedef(t: string): TypedefName[] {
  const body = t.replace(/^typedef\s+/, '');
  const fn = /^(.+?)\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\((.*)\)$/.exec(body);
  if (fn) {
    return [{ name: fn[2], type: `${fn[1].trim()} (*)(${fn[3].trim()})`, names: 'other' }];
  }
  if (/[()]/.test(body)) {
    return [];
  }
  // qualifiers of the base, then the stars and their own qualifiers, then the name
  const declarator = /^((?:(?:const|volatile)\b\s*)*)((?:\*\s*(?:(?:const|volatile)\b\s*)*)*)([A-Za-z_]\w*)$/;
  const withBody = /^((?:(?:const|volatile)\s+)*(?:struct|union|enum)\b[^{]*\{\})\s*(.*)$/.exec(body);
  let base: string;
  let declarators: string[];
  if (withBody) {
    base = withBody[1];
    declarators = topLevelCommas(withBody[2]);
  } else {
    const parts = topLevelCommas(body);
    const first = /^(.*?[^\s*])\s*((?:\*\s*(?:(?:const|volatile)\b\s*)*)*[A-Za-z_]\w*)$/.exec(parts[0]);
    if (!first) {
      return [];
    }
    base = first[1];
    declarators = [first[2], ...parts.slice(1)];
  }
  const read = declarators
    .map((d) => declarator.exec(d.trim()))
    .map((m) => (m === null || /^(?:const|volatile)$/.test(m[3]) ? null : m));
  const plain = read.find((m) => m !== null && m[2] === '')?.[3];
  const tag = /^(?:(?:const|volatile)\s+)*((?:struct|union|enum)\s+[A-Za-z_]\w*)\s*\{\}$/.exec(base)?.[1];
  const out: TypedefName[] = [];
  for (const m of read) {
    if (m === null) {
      continue;
    }
    const qualifiers = m[1].replace(/\s+/g, ' ').trim();
    const stars = m[2].replace(/\s+/g, ' ').trim();
    const name = m[3];
    if (withBody && stars === '') {
      out.push({ name, type: name, names: 'body' });
    } else if (withBody) {
      const pointee = tag ?? plain;
      out.push(
        pointee === undefined
          ? { name, type: name, names: 'unspelled pointer' }
          : { name, type: [qualifiers, pointee, stars].filter((w) => w !== '').join(' '), names: 'other' },
      );
    } else {
      const spelled = [qualifiers, base.replace(/\s+/g, ' ').trim(), stars].filter((w) => w !== '').join(' ');
      out.push({ name, type: spelled.replace(/\*\s+\*/g, '**'), names: 'other' });
    }
  }
  return out;
}

/** Resolve a spelling through the typedef table until `declaredWidth` can size it, keeping it the
 *  same type throughout; a pointer resolves its pointee the same way. */
function resolve(t: string, typedefs: ReadonlyMap<string, string>): string {
  const s = t.replace(/\s+/g, ' ').trim();
  // a pointer resolves its pointee, qualifiers and all, and keeps its own
  const pointer = /^(.*?)\s*\*\s*((?:\b(?:const|volatile)\b\s*)*)$/.exec(s);
  if (pointer) {
    return `${resolve(pointer[1], typedefs)} *${pointer[2] ? ` ${pointer[2].trim()}` : ''}`;
  }
  const qualifiers = (s.match(/\b(?:const|volatile)\b/g) ?? []).join(' ');
  let cur = s
    .replace(/\b(?:const|volatile)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let hops = 0; hops < 16 && declaredWidth(cur) === undefined; hops++) {
    const next = typedefs.get(cur);
    if (next === undefined || next === cur) {
      break;
    }
    cur = next.replace(/\s+/g, ' ').trim();
  }
  return qualifiers ? `${qualifiers} ${cur}` : cur;
}

/** The callee prototypes a preprocessed declaration context states. `language` decides what an
 *  empty parameter list means: none in C++, unstated in C (a pre-ANSI declaration). */
export function prototypesFromContext(src: string, language: 'c' | 'c++'): Prototypes {
  const stmts = statements(src);
  const typedefs = new Map<string, string>();
  // struct and union bodies: by `struct Tag` spelling, and by a typedef name bound to a body, which
  // resolves to itself and spells no keyword — as C++ spells every tag, a declared one with no body
  // included
  const tagged = new Map<string, string>();
  const named = new Map<string, { kind: AggregateLayout['kind']; body?: string }>();
  // a typedef name for a pointer to a body nothing else names: a word, and no spelling of its own
  const unspelledPointers = new Set<string>();
  // a typedef name bound to an enum body
  const enums = new Set<string>();
  for (const s of stmts) {
    const def = /^(?:typedef\s+)?(?:(?:const|volatile)\s+)*(struct|union)\s+([A-Za-z_]\w*)\s*\{\}/.exec(s.text);
    if (def) {
      tagged.set(`${def[1]} ${def[2]}`, s.bodies[0]);
    }
    // In C++ a class is a struct too. Its body (access labels, member functions), or one after a
    // base clause, whose members start past the base's, is none this lays out: the kind is known and
    // the members are not. A forward declaration states the kind alone, so a definition after it
    // replaces it, and nothing replaces a definition.
    const cpp =
      language === 'c++'
        ? (/^(?:typedef\s+)?(?:(?:const|volatile)\s+)*(struct|union|class)\s+([A-Za-z_]\w*)\s*(:[^{]*)?\{\}/.exec(
            s.text,
          ) ?? /^(struct|union|class)\s+([A-Za-z_]\w*)$/.exec(s.text))
        : null;
    if (cpp && named.get(cpp[2])?.body === undefined) {
      const layable = def !== null && cpp[1] !== 'class' && cpp[3] === undefined;
      named.set(cpp[2], { kind: cpp[1] === 'union' ? 'union' : 'struct', body: layable ? s.bodies[0] : undefined });
    }
    if (/^typedef\b/.test(s.text)) {
      const aggregate = /^typedef\s+(?:(?:const|volatile)\s+)*(struct|union)\b[^{]*\{\}/.exec(s.text);
      for (const td of readTypedef(s.text)) {
        typedefs.set(td.name, td.type);
        if (aggregate && td.names === 'body') {
          named.set(td.name, { kind: aggregate[1] as AggregateLayout['kind'], body: s.bodies[0] });
        }
        if (td.names === 'body' && /^typedef\s+(?:(?:const|volatile)\s+)*enum\b/.test(s.text)) {
          enums.add(td.name);
        }
        if (td.names === 'unspelled pointer') {
          unspelledPointers.add(td.name);
        }
      }
    }
  }
  // Memoised per type and depth: a body whose members point at bodies is walked once per depth,
  // not once per path to it — each pointer member lays its pointee out, and K of them to depth 8
  // is K^8 walks.
  const laidOut = new Map<string, AggregateLayout | undefined>();
  const layoutOf = (t: string, depth: number): AggregateLayout | undefined => {
    const bare = t
      .replace(/\b(?:const|volatile)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const key = `${depth} ${bare}`;
    if (laidOut.has(key)) {
      return laidOut.get(key);
    }
    const tag = /^(struct|union) [A-Za-z_]\w*$/.exec(bare);
    const kind = (tag?.[1] as AggregateLayout['kind'] | undefined) ?? named.get(bare)?.kind;
    let layout: AggregateLayout | undefined;
    if (kind !== undefined) {
      const body = tag ? tagged.get(bare) : named.get(bare)?.body;
      const members = body === undefined ? undefined : readMembers(body, depth);
      layout = members === undefined ? { kind } : { kind, members };
    }
    laidOut.set(key, layout);
    return layout;
  };
  // A body's members, or undefined when one of them is a type this cannot lay out — a project
  // typedef that resolves to nothing sized, a nested aggregate with no body here, a flexible extent
  // or one that is not a constant expression. Bounded in depth, since a body may name its own tag.
  const readMembers = (body: string, depth: number): AggregateMember[] | undefined => {
    if (depth > 8) {
      return undefined;
    }
    const out: AggregateMember[] = [];
    for (const decl of splitMembers(body)) {
      let type: ParamType | AggregateLayout;
      let rest: string;
      const inline = /^(struct|union)\s*(?:[A-Za-z_]\w*)?\s*\{/.exec(decl);
      if (inline) {
        const close = matchingBrace(decl, inline[0].length - 1);
        const members = close < 0 ? undefined : readMembers(decl.slice(inline[0].length, close), depth + 1);
        if (members === undefined) {
          return undefined;
        }
        type = { kind: inline[1] as AggregateLayout['kind'], members };
        rest = decl.slice(close + 1);
      } else {
        const split = baseAndDeclarators(decl);
        if (split === undefined) {
          return undefined;
        }
        const base = resolve(split.base, typedefs);
        if (declaredWidth(base) !== undefined || base === 'float' || base === 'double') {
          type = base;
        } else if (unspelledPointers.has(base)) {
          type = 'void *';
        } else if (/^enum [A-Za-z_]\w*$/.test(base) || enums.has(base)) {
          // an enum, which the target sizes whatever it is called: spelled `enum` and its name
          type = enums.has(base) ? `enum ${base}` : base;
        } else {
          const nested = layoutOf(base, depth + 1);
          if (nested?.members === undefined) {
            // a pointer to it is still a word; anything else of it cannot be laid out
            type = `${base} *`;
            if (!split.declarators.every((d) => /^\*|^\(/.test(d.trim()))) {
              return undefined;
            }
          } else {
            type = nested;
          }
        }
        rest = split.declarators.join(',');
      }
      for (const d of topLevelCommas(rest)) {
        const m = memberDeclarator(d);
        if (m === undefined) {
          return undefined;
        }
        const t: ParamType | AggregateLayout = m.pointer
          ? typeof type === 'string'
            ? `${type.replace(/ \*$/, '')} *`
            : 'void *'
          : type;
        if (typeof t !== 'string' && m.bits !== undefined) {
          return undefined;
        }
        out.push({
          name: m.name,
          type: t,
          ...(m.dims ? { dims: m.dims } : {}),
          ...(m.bits !== undefined ? { bits: m.bits } : {}),
        });
      }
    }
    return out;
  };
  const found = new Map<string, FnProto | null>();
  for (const s of stmts) {
    const t = s.text
      .replace(/\bextern\s*"C(?:\+\+)?"/g, ' ')
      .replace(SPECIFIERS, ' ')
      .replace(/__attribute__\s*\(\(.*?\)\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // an `=` outside the parentheses is a variable's initializer; inside them, a default argument
    const outside = t.replace(/\([^()]*\)/g, '()').replace(/\([^()]*\)/g, '()');
    if (/^(?:typedef|template|using|namespace|class)\b/.test(t) || /\boperator\b|::/.test(t) || outside.includes('=')) {
      continue;
    }
    const m = /^(.+?)\b([A-Za-z_]\w*)\s*\((.*)\)\s*(?:const)?$/.exec(t);
    if (!m || /[(){}]/.test(m[1]) || TYPE_WORDS.has(m[2])) {
      continue;
    }
    const proto = readSignature(m[1], m[3], language, typedefs, (t) => layoutOf(t, 0));
    const prior = found.get(m[2]);
    found.set(m[2], prior === undefined || same(prior, proto) ? proto : null);
  }
  const out: Prototypes = {};
  for (const [name, p] of found) {
    const valid = p === null ? undefined : admissible(name, p);
    if (valid !== undefined) {
      out[name] = valid;
    }
  }
  return out;
}

/** The entry as a table `validatePrototypes` accepts, the check every `--proto` table passes, so a
 *  context's prototypes can travel as one: a `returns` it refuses is dropped — a return wider than a
 *  register with a parameter list that cannot be printed — and the entry with it if that is not
 *  enough. */
function admissible(name: string, p: FnProto): FnProto | undefined {
  if (validatePrototypes({ [name]: p }).length === 0) {
    return p;
  }
  const { returns: _dropped, ...rest } = p;
  return validatePrototypes({ [name]: rest }).length === 0 ? rest : undefined;
}

/** A struct body's member declarations: its `;`-separated statements, a nested body kept whole. */
function splitMembers(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      depth++;
    } else if (body[i] === '}') {
      depth--;
    } else if (body[i] === ';' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out
    .map((d) =>
      d
        .replace(/__attribute__\s*\(\(.*?\)\)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((d) => d !== '');
}

/** The index of the `}` closing the `{` at `open`, or -1. */
function matchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') {
      depth++;
    } else if (s[i] === '}' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** A member declaration's base type and its declarators (`u8 a, *b, c[4]` → `u8`, three). */
function baseAndDeclarators(decl: string): { base: string; declarators: string[] } | undefined {
  const parts = topLevelCommas(decl);
  const fnptr = /^(.+?)\s*(\(\s*\*.*)$/.exec(parts[0]);
  const plain =
    /^(.*?[^\s*])\s*((?:\*\s*(?:(?:const|volatile)\s*)*)*[A-Za-z_]\w*\s*(?:\[[^\]]*\]\s*)*|[A-Za-z_]\w*\s*:\s*\w+|:\s*\w+)$/.exec(
      parts[0],
    );
  const m = fnptr ?? plain;
  if (!m || TYPE_WORDS.has(m[2].replace(/[\s*]/g, ''))) {
    return undefined;
  }
  return { base: m[1].trim(), declarators: [m[2], ...parts.slice(1)] };
}

/** The value of an integer constant expression of literals, `+ - * /` and parentheses — the
 *  `u8 pad3[0x4 - 0x3]` a decomp header sizes its padding with — or undefined for anything else. A
 *  literal reads as C reads it: `0x` hexadecimal, a leading `0` octal. */
function constantValue(text: string): number | undefined {
  const tokens = text.match(/0x[0-9a-f]+[ul]*|\d+[ul]*|[-+*/()]|\S/gi) ?? [];
  let at = 0;
  const primary = (): number | undefined => {
    const t = tokens[at++];
    if (t === '(') {
      const v = sum();
      return tokens[at++] === ')' ? v : undefined;
    }
    if (t === '-') {
      const v = primary();
      return v === undefined ? undefined : -v;
    }
    return t !== undefined && /^(?:0x[0-9a-f]+|0[0-7]*|[1-9]\d*)[ul]*$/i.test(t)
      ? Number.parseInt(t, /^0x/i.test(t) ? 16 : /^0\d/.test(t) ? 8 : 10)
      : undefined;
  };
  const product = (): number | undefined => {
    let v = primary();
    while (v !== undefined && (tokens[at] === '*' || tokens[at] === '/')) {
      const op = tokens[at++];
      const r = primary();
      v = r === undefined || (op === '/' && r === 0) ? undefined : op === '*' ? v * r : Math.trunc(v / r);
    }
    return v;
  };
  const sum = (): number | undefined => {
    let v = product();
    while (v !== undefined && (tokens[at] === '+' || tokens[at] === '-')) {
      const op = tokens[at++];
      const r = product();
      v = r === undefined ? undefined : op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return at === tokens.length ? v : undefined;
}

/** One member declarator: its name, whether it declares a pointer, its extents, its bit width. */
function memberDeclarator(d: string): { name: string; pointer: boolean; dims?: number[]; bits?: number } | undefined {
  const s = d.trim();
  const literal = constantValue;
  const fnptr = /^\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(.*\)$/.exec(s);
  if (fnptr) {
    return { name: fnptr[1], pointer: true };
  }
  const bit = /^([A-Za-z_]\w*)?\s*:\s*(\w+)$/.exec(s);
  if (bit) {
    const bits = literal(bit[2]);
    return bits === undefined ? undefined : { name: bit[1] ?? '', pointer: false, bits };
  }
  const plain = /^((?:\*\s*(?:(?:const|volatile)\s*)*)*)([A-Za-z_]\w*)\s*((?:\[[^\]]*\]\s*)*)$/.exec(s);
  if (!plain) {
    return undefined;
  }
  const dims = [...plain[3].matchAll(/\[([^\]]*)\]/g)].map((x) => literal(x[1]));
  if (dims.some((n) => n === undefined || n === 0)) {
    return undefined;
  }
  return {
    name: plain[2],
    pointer: plain[1].includes('*'),
    ...(dims.length > 0 ? { dims: dims as number[] } : {}),
  };
}

function readSignature(
  ret: string,
  params: string,
  language: 'c' | 'c++',
  typedefs: ReadonlyMap<string, string>,
  layoutOf: (t: string) => AggregateLayout | undefined,
): FnProto {
  const proto: FnProto = {};
  const r = resolve(ret.trim(), typedefs);
  // A struct or union returned by value is kept, spelled as the header spells it: it is the fact
  // that moves every argument one register up on a target that returns it through a hidden pointer.
  // A spelling that names one and reads as no type (`struct Blob64 EWRAM_FN`, a macro this never
  // expands) still returns one, and says nothing else about it.
  //
  // A spelling that reads as no type and names no aggregate states nothing, and the parameters are
  // kept: in a vendored context that is a float, a double or an enum typedef, whose arguments sit
  // where they are declared. KNOWN GAP: a typedef this never saw (`Blob64T`, defined behind an
  // `#include` that `clean` blanks) may be a struct returned through memory, whose hidden pointer
  // is then read as argument 0; a symbol map that sizes the return closes it
  // (`prototypesFromSymbols`).
  const layout = declaredWidth(r) === undefined ? layoutOf(r) : undefined;
  const keyword = /\b(struct|union|class)\b/.exec(r);
  if (r === 'void') {
    proto.returnsVoid = true;
  } else if (declaredWidth(r) !== undefined) {
    proto.returns = r;
  } else if (layout !== undefined) {
    proto.returns = r;
    proto.returnLayout = layout;
  } else if (keyword && !r.includes('*')) {
    proto.returnLayout = { kind: keyword[1] === 'union' ? 'union' : 'struct' };
  }
  const list = params.trim();
  if (list === '' ? language === 'c++' : list === 'void') {
    proto.params = [];
    return proto;
  }
  if (list === '') {
    return proto;
  }
  const parts = topLevelCommas(list);
  if (parts.includes('...')) {
    return proto;
  }
  const types: ParamType[] = [];
  for (const p of parts) {
    const pt = parameterType(p);
    if (pt === null) {
      return proto;
    }
    types.push(resolve(pt, typedefs));
  }
  proto.params = types;
  return proto;
}

/** The prototypes a lift of `own` reads when a context is in hand: `stated` — a caller's own
 *  prototypes, which win per name — over the context's declarations less those the symbol map
 *  states better (`contextPrototypesUnder`). `own`'s declaration is left out, as the map's is
 *  (`asIfUndecompiled`): a header's signature for the function being decompiled is that kind of
 *  fact, and only what the caller states about it is kept.
 *
 *  A stated entry that says nothing of the return (`statesNoReturn`, which counts `returnsVoid:
 *  false` as nothing) keeps a struct return the context states: it is what says argument 0 may be
 *  a hidden pointer, and an entry stating only the arity would otherwise hand that pointer to the
 *  call as its first argument. */
export function withContextPrototypes(
  stated: Prototypes | undefined,
  context: Prototypes,
  own: string,
  symbols: SymbolMap | undefined,
): Prototypes {
  const { [own]: _own, ...callees } = contextPrototypesUnder(context, symbols);
  const out: Prototypes = { ...callees, ...stated };
  for (const [name, p] of Object.entries(stated ?? {})) {
    const heard = Object.hasOwn(callees, name) ? callees[name] : undefined;
    if (p && statesNoReturn(p)) {
      out[name] = { ...p, ...aggregateReturnOf(heard) };
    }
  }
  return out;
}

/** The keys that state `p`'s struct or union return, or none where it states no such return. */
function aggregateReturnOf(p: FnProto | undefined): Pick<FnProto, 'returns' | 'returnLayout'> {
  if (p === undefined || !declaresAggregateReturn(p)) {
    return {};
  }
  return {
    ...(p.returns !== undefined ? { returns: p.returns } : {}),
    ...(p.returnLayout !== undefined ? { returnLayout: p.returnLayout } : {}),
  };
}

const same = (a: FnProto | null, b: FnProto): boolean => a !== null && JSON.stringify(a) === JSON.stringify(b);

/** A context's prototypes, less the entries the symbol map states better. `prototypesFromSymbols`
 *  lets any entry it is handed shadow the map's signature for that name, so what reaches it decides
 *  which source wins, per name: a context entry that sizes every parameter wins — it is the
 *  declaration the candidate is compiled against, and its spellings are the ones a C++ call's casts
 *  need; an entry that cannot size one yields to a map signature that can be spelled, which sizes by
 *  byte count what a declaration names (a by-value struct of a register's width); and where the map
 *  spells nothing either, the context entry stays. */
function contextPrototypesUnder(context: Prototypes, symbols: SymbolMap | undefined): Prototypes {
  if (symbols === undefined) {
    return context;
  }
  const mapped = new Map<string, FnProto>();
  for (const infos of symbols.values()) {
    for (const info of infos) {
      const signed = symbolPrototype(info);
      if (signed?.params !== undefined && !mapped.has(info.name)) {
        mapped.set(info.name, signed);
      }
    }
  }
  // An entry that yields keeps a struct return it states, over the map's parameters: DWARF names no
  // struct, so the map states one only by its size (`symbolPrototype`), and never its members.
  return Object.fromEntries(
    Object.entries(context).flatMap(([name, p]): [string, FnProto][] => {
      const signed = mapped.get(name);
      if (declaredArgWidths(p) !== undefined || signed === undefined) {
        return [[name, p]];
      }
      return declaresAggregateReturn(p) && signed.returnsVoid !== true
        ? [[name, { ...signed, ...aggregateReturnOf(p) }]]
        : [];
    }),
  );
}
