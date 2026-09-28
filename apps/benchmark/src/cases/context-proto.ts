// A real row's callee prototypes: the declarations in the vendored context its candidates are
// compiled against (core `prototypesFromContext`), so asmlift lifts each call at the arity the
// compiler will check it against — and, on a row m2c is given no project context, the same
// declarations rendered as the C m2c reads (`m2cDeclarations`).
import { PRELUDE_TYPEDEFS, type Prototypes, declaredWidth, declaresVoidReturn } from '@asmlift/core/proto';
import { prototypesFromContext, withContextPrototypes } from '@asmlift/core/proto-context';
import type { SymbolMap } from '@asmlift/core/symbols';

/** parsed contexts, keyed by dialect and vendored file: the rows of one unit share a context */
const parsed = new Map<string, Prototypes>();

/** The row's prototype table: the manifest's `proto` over its vendored context
 *  (`withContextPrototypes`, which says whose entry wins and why the row's own is left out). */
export function rowPrototypes(
  manifest: Prototypes | undefined,
  { ctxI, ctxFile }: { ctxI: string; ctxFile: string },
  language: 'c' | 'c++',
  sym: string,
  symbols: SymbolMap | undefined,
): Prototypes | undefined {
  if (ctxI === '') {
    return manifest;
  }
  const key = `${language} ${ctxFile}`;
  let derived = parsed.get(key);
  if (derived === undefined) {
    derived = prototypesFromContext(ctxI, language);
    parsed.set(key, derived);
  }
  const merged = withContextPrototypes(manifest, derived, sym, symbols);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The entries a lift can look up — the row's own symbol and every symbol `text` (the assembly, and
 *  the object dump that holds its relocations) names — which is what a row publishes and its
 *  reproduction script passes as `--proto`. */
export function referencedPrototypes(proto: Prototypes | undefined, text: string, sym: string): Prototypes | undefined {
  if (proto === undefined) {
    return undefined;
  }
  const named = new Set(text.match(/[A-Za-z_.$][\w.$]*/g) ?? []);
  const out: Prototypes = {};
  for (const [name, p] of Object.entries(proto)) {
    if (name === sym || named.has(name)) {
      out[name] = p;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The callee declarations m2c is given on a row where it is not given the project's context — the
 *  same entries asmlift's lift reads (`referencedPrototypes`), as C m2c's parser reads. Each keeps the
 *  header's own spelling, and each project type a spelling names is declared opaque ahead of them
 *  (`typedef struct OSMutex OSMutex;`): m2c reads a declaration for its signature, and its output is
 *  compiled against the project's own headers, where a pointer of another type than the declared
 *  one is a C++ compile error. An entry with a parameter or a return nothing sizes is left out, and
 *  so is a name the row's context already declares.
 *
 *  This admits more than core's `spellableProto`, which prints a declaration into the candidate's
 *  own translation unit and so only spells types that unit is sure to know. m2c's declarations are
 *  read for their signatures alone, and a project type they name is declared opaque right here. */
export function m2cDeclarations(proto: Prototypes | undefined, sym: string, ctx: string | undefined): string {
  const opaque = new Map<string, string>();
  const lines: string[] = [];
  for (const [name, p] of Object.entries(proto ?? {})) {
    if (name === sym || !Array.isArray(p.params) || (ctx !== undefined && declaredIn(ctx, name))) {
      continue;
    }
    const ret = declaresVoidReturn(p) ? 'void' : p.returns;
    if (ret === undefined || p.params.some((t) => declaredWidth(t) === undefined)) {
      continue;
    }
    const params = p.params.map(unnamed);
    for (const t of [ret, ...params]) {
      for (const [spelled, decl] of projectTypes(t)) {
        opaque.set(spelled, decl);
      }
    }
    lines.push(`${ret} ${name}(${params.length === 0 ? 'void' : params.join(', ')});`);
  }
  return [...opaque.values(), ...lines].join('\n');
}

/** whether `text` declares or calls `name` — a `name(` not inside a longer identifier */
const declaredIn = (text: string, name: string): boolean =>
  new RegExp(`(?<![\\w$.])${name.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&')}\\s*\\(`).test(text);

const C_WORDS = new Set([
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
]);

/** A function-pointer declarator's own parameters without their names: `void (*)(s32 channel)` →
 *  `void (*)(s32)`, the spelling a prototype's parameter list takes. */
function unnamed(t: string): string {
  const fn = /^(.*\(\s*\*\s*\)\s*)\((.*)\)$/.exec(t);
  if (!fn) {
    return t;
  }
  const inner = fn[2].split(',').map((q) => {
    const words = q.replace(/\*/g, ' * ').trim().split(/\s+/);
    const last = words[words.length - 1];
    if (words.length > 1 && /^[A-Za-z_]\w*$/.test(last) && !C_WORDS.has(last) && !PRELUDE_TYPEDEFS.has(last)) {
      words.pop();
    }
    return words.join(' ').replace(/ \*/g, ' *');
  });
  return `${fn[1]}(${inner.join(', ')})`;
}

/** The standard names a declaration spells a width with and m2c's parser does not know, as C89
 *  typedefs of the same width. */
const STANDARD_TYPEDEFS: ReadonlyMap<string, string> = new Map([
  ['size_t', 'unsigned int'],
  ['ssize_t', 'int'],
  ['ptrdiff_t', 'int'],
  ['intptr_t', 'int'],
  ['uintptr_t', 'unsigned int'],
  ['int8_t', 'signed char'],
  ['uint8_t', 'unsigned char'],
  ['int16_t', 'short'],
  ['uint16_t', 'unsigned short'],
  ['int32_t', 'int'],
  ['uint32_t', 'unsigned int'],
  ['int64_t', 'long long'],
  ['uint64_t', 'unsigned long long'],
]);

/** The project types a spelling names, each with the declaration m2c is given for it. */
function projectTypes(t: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of t.matchAll(/\b(struct|union|enum)?\s*([A-Za-z_]\w*)\b/g)) {
    const [, tag, word] = m;
    const standard = STANDARD_TYPEDEFS.get(word);
    if (tag !== undefined) {
      out.push([`${tag} ${word}`, `${tag} ${word};`]);
    } else if (standard !== undefined) {
      out.push([word, `typedef ${standard} ${word};`]);
    } else if (!C_WORDS.has(word) && !PRELUDE_TYPEDEFS.has(word) && declaredWidth(word) === undefined) {
      out.push([word, `typedef struct ${word} ${word};`]);
    }
  }
  return out;
}
