import { constantValue, integerLiteral } from './cdecl/constant';
import type { Tokens } from './cdecl/lex';
import {
  type Attribute,
  type Declaration,
  type Declarator,
  type DeclaredType,
  type Derivation,
  type Language,
  type Parameter,
  type ParsedContext,
  type Qualifier,
  type Range,
  type TypeSpecifier,
  declaredType,
  memberDeclarations,
  parseDeclarations,
} from './cdecl/parse';
import { asParameter, spellType } from './cdecl/spell';
import type { AggregateLayout, AggregateMember, FnProto, ParamType, Prototypes } from './proto';
import {
  declaredCallArgs,
  declaredWidth,
  declaresAggregateReturn,
  isFloatingSpelling,
  statesNoReturn,
  symbolPrototype,
  validatePrototypes,
} from './proto';
import type { SymbolMap } from './symbols';
import type { TargetDescription } from './target';

// asmlift — callee prototypes read out of a DECLARATION CONTEXT: the preprocessed headers a
// candidate is compiled against (a decomp project's `ctx.h`, m2c's `--context`). The compiler
// checks every candidate's calls against those declarations, so a call asmlift writes at a guessed
// arity is a candidate the context then refuses; read here, the declarations decide the arity
// instead of the argument-register scan.
//
// WHAT IS READ is what the parser reads (`cdecl/parse.ts`). Of it, this takes the functions the top
// level declares or defines, and the typedefs, tags and bodies their types name.
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
// a struct or enum keeps its name, which sizes to nothing and makes the list abstain. Resolution
// is on the parsed type, never its spelling: a typedef name stands for its base and derivations,
// and the name's own qualifiers qualify the derivation they bind (`const Cb` is
// `void (* const)(s32)`).
//
// A TYPEDEF WITH AN ATTRIBUTE NAMES NO TYPE HERE: the attribute may make it a different type from
// the one it spells (`realigns`), so no spelling resolves through it. One on a parameter of a
// function the typedef points at is that parameter's (`ownAttributes`).

/** The layout of the struct or union a type names, at a nesting depth. */
type LayoutOf = (t: DeclaredType, depth: number) => AggregateLayout | undefined;

/** The callee prototypes a preprocessed declaration context states. `language` decides what an
 *  empty parameter list means: none in C++, unstated in C (a pre-ANSI declaration). */
export function prototypesFromContext(src: string, language: Language): Prototypes {
  const ctx = parseDeclarations(src, language);
  const table = typeTable(ctx);
  return functionPrototypes(ctx, table, layoutReader(ctx, table));
}

const WORD = /^[A-Za-z_]\w*$/;

/** `mode(…)` in an attribute, in either spelling: it retypes what it is written on */
const MODE = /\b(?:__)?mode(?:__)?\s*\(/;

function typeTable(ctx: ParsedContext): TypeTable {
  const table: TableBuilder = {
    typedefs: new Map(),
    tagged: new Map(),
    named: new Map(),
    unspelledPointers: new Set(),
    enums: new Set(),
    unsizedEnums: new Set(),
    wideEnumerators: new Set(),
    realigned: false,
  };
  for (const d of ctx.declarations) {
    const tag = d.specifiers.type.kind === 'tag' ? d.specifiers.type : undefined;
    const attributes = d.specifiers.typedef || tag?.body !== undefined ? ownAttributes(d) : [];
    table.realigned ||= realigns(d, attributes);
    const unsizedEnum = tag !== undefined && readTag(table, d, tag, laysOut(d, attributes), ctx);
    if (d.specifiers.typedef && attributes.length === 0) {
      readTypedefs(table, d, unsizedEnum);
    }
  }
  return table;
}

/** What the declarations say about the types a prototype or a layout spells, while they are read. */
interface TableBuilder {
  /** each typedef name, and the type it stands for, before resolution */
  typedefs: Map<string, DeclaredType>;
  /** struct and union bodies by `struct Tag` spelling; none for a body an attribute lays out
   *  (`laysOut`) */
  tagged: Map<string, Range | undefined>;
  /** struct and union bodies by a typedef name bound to a body, which resolves to itself and spells
   *  no keyword — as C++ spells every tag, a declared one with no body included */
  named: Map<string, { kind: AggregateLayout['kind']; body?: Range }>;
  /** a typedef name for a pointer to a body nothing else names: a word, and no spelling of its own */
  unspelledPointers: Set<string>;
  /** a typedef name bound to an enum body */
  enums: Set<string>;
  /** an enum, by `enum Tag` or typedef name, that is not the target's enumBytes: `packed` makes it
   *  the smallest integer its values fit (agbcc c-common.c:446, c-decl.c:6123), and so does a value
   *  an int cannot hold (`enumMayWiden`) */
  unsizedEnums: Set<string>;
  /** the enumerators of an enum wider than an int, which widen any enum that names one */
  wideEnumerators: Set<string>;
  /** a typedef changed a type after its layout (`realigns`), which moves the layout of whatever
   *  holds it, so no layout is read */
  realigned: boolean;
}

/** What the declarations say about the types a prototype or a layout spells, once read. */
type TypeTable = Readonly<Omit<TableBuilder, 'wideEnumerators'>>;

/** What a struct, union, enum or class specifier says about its tag; whether it defines an enum
 *  the target does not size (`unsizedEnums`). `attributed`: an attribute lays its body out. */
function readTag(
  table: TableBuilder,
  d: Declaration,
  tag: Extract<TypeSpecifier, { kind: 'tag' }>,
  attributed: boolean,
  ctx: ParsedContext,
): boolean {
  const name = tag.tag !== undefined && WORD.test(tag.tag) ? tag.tag : undefined;
  const { body, keyword } = tag;
  const aggregate = keyword === 'struct' || keyword === 'union' ? keyword : undefined;
  if (aggregate !== undefined && body !== undefined && name !== undefined && !tag.base) {
    table.tagged.set(`${aggregate} ${name}`, attributed ? undefined : body);
  }
  // In C++ a class is a struct too. Its body (access labels, member functions), or one after a
  // base clause, whose members start past the base's, is none this lays out: the kind is known and
  // the members are not. A forward declaration states the kind alone, so a definition after it
  // replaces it, and nothing replaces a definition.
  if (
    ctx.language === 'c++' &&
    keyword !== 'enum' &&
    name !== undefined &&
    (body !== undefined || forwardDeclares(d)) &&
    table.named.get(name)?.body === undefined
  ) {
    const layable = aggregate !== undefined && !tag.base && !attributed;
    table.named.set(name, { kind: keyword === 'union' ? 'union' : 'struct', body: layable ? body : undefined });
  }
  if (keyword !== 'enum' || body === undefined) {
    return false;
  }
  const wide = enumMayWiden(ctx.tokens, body, table.wideEnumerators);
  if (wide) {
    for (const e of enumerators(ctx.tokens, body)) {
      table.wideEnumerators.add(e);
    }
  }
  if ((attributed || wide) && name !== undefined) {
    table.unsizedEnums.add(`enum ${name}`);
  }
  return attributed || wide;
}

/** Every name a typedef declares, into the table. `unsizedEnum`: the body it names is an enum the
 *  target does not size. */
function readTypedefs(table: TableBuilder, d: Declaration, unsizedEnum: boolean): void {
  const { type } = d.specifiers;
  const keyword = type.kind === 'tag' ? type.keyword : undefined;
  for (const td of typedefNames(d)) {
    table.typedefs.set(td.name, td.type);
    if (td.names === 'unspelled pointer') {
      table.unspelledPointers.add(td.name);
    } else if (td.names === 'body' && (keyword === 'struct' || keyword === 'union')) {
      table.named.set(td.name, { kind: keyword, body: type.kind === 'tag' ? type.body : undefined });
    } else if (td.names === 'body' && keyword === 'enum') {
      table.enums.add(td.name);
      if (unsizedEnum) {
        table.unsizedEnums.add(td.name);
      }
    }
  }
}

/** Whether the declaration states a tag and nothing else: `struct Fwd;`. */
function forwardDeclares(d: Declaration): boolean {
  const s = d.specifiers;
  return (
    d.declarators.length === 0 &&
    !s.typedef &&
    s.storage.length === 0 &&
    s.qualifiers.length === 0 &&
    s.attributes.length === 0 &&
    s.unknownWords.length === 0
  );
}

/** One name a `typedef` declares: the type it stands for (before resolution), and whether it names
 *  the struct, union or enum body the declaration defines, or a pointer to one that has no other name
 *  to spell it by. */
interface TypedefName {
  name: string;
  type: DeclaredType;
  names: 'body' | 'unspelled pointer' | 'other';
}

/** The type a lone name spells, which resolves to itself. */
const named = (name: string): DeclaredType => ({
  qualifiers: [],
  type: { kind: 'words', words: [name] },
  unknownWords: [],
  spelling: name,
  derivations: [],
});

/** The one name `t` is, where it is a name and nothing else: what a typedef may have declared. */
const nameOf = (t: DeclaredType): string | undefined =>
  t.derivations.length === 0 && t.unknownWords.length === 0 && t.type.kind === 'words' && t.type.words.length === 1
    ? t.type.words[0]
    : undefined;

/** `struct Tag`, `union Tag` or `enum Tag` where `t` is that tag and nothing else, qualifiers aside. */
const tagOf = (t: DeclaredType): string | undefined =>
  t.derivations.length === 0 &&
  t.unknownWords.length === 0 &&
  t.type.kind === 'tag' &&
  t.type.tag !== undefined &&
  WORD.test(t.type.tag)
    ? `${t.type.keyword} ${t.type.tag}`
    : undefined;

const isPointer = (x: Derivation): boolean => x.kind === 'pointer' && x.member === undefined;

/** The derivations of what a function pointer returns, where `derivations` are a plain `(*)` to a
 *  function returning the base or a pointer to it; otherwise undefined. */
function functionPointer(derivations: readonly Derivation[]): readonly Derivation[] | undefined {
  const [first, second, ...returns] = derivations;
  return first?.kind === 'pointer' &&
    first.qualifiers.length === 0 &&
    isPointer(first) &&
    second?.kind === 'function' &&
    returns.every(isPointer)
    ? returns
    : undefined;
}

/** Every name a `typedef` declares (`typedef struct R {…} R, *RP;` declares two). A plain declarator
 *  of a body names that body, qualified or not (`} const CR;`), and resolves to itself. A pointer
 *  declarator is a pointer to the body, qualifiers and all, spelled by the body's tag or by a plain
 *  name the same declaration gives it, and resolves to itself where the body has neither
 *  (`typedef struct {…} *PS;`). Without a body, a name is read when its type is the specifiers'
 *  own, a pointer to it (`u8 *`, `u8 * const *`) or a function pointer (`void (*)(s32)`); any other
 *  type, an array's or one that groups more than a function pointer, is not read. */
function typedefNames(d: Declaration): TypedefName[] {
  const s = d.specifiers;
  const declared = d.declarators.flatMap((x) =>
    x.name !== undefined && WORD.test(x.name) ? [{ ...x, name: x.name }] : [],
  );
  if (s.type.kind === 'tag' && s.type.body !== undefined) {
    // a plain name stands for the body with its qualifiers; a tag, without them
    const plain = declared.find((x) => x.derivations.length === 0)?.name;
    const tag = tagOf({ ...declaredType(s, []), unknownWords: [] });
    const pointee =
      tag !== undefined
        ? { ...declaredType(s, []), unknownWords: [], spelling: tag }
        : plain !== undefined
          ? named(plain)
          : undefined;
    return declared.flatMap((x): TypedefName[] => {
      if (x.derivations.length === 0) {
        return [{ name: x.name, type: named(x.name), names: 'body' }];
      }
      if (!x.derivations.every(isPointer)) {
        return [];
      }
      return [
        pointee === undefined
          ? { name: x.name, type: named(x.name), names: 'unspelled pointer' }
          : { name: x.name, type: { ...pointee, derivations: x.derivations }, names: 'other' },
      ];
    });
  }
  return declared
    .filter((x) => x.derivations.every(isPointer) || functionPointer(x.derivations) !== undefined)
    .map((x) => ({ name: x.name, type: declaredType(s, x.derivations), names: 'other' }));
}

/** The attributes a declaration writes on what it declares: among its specifiers and on its
 *  declarators. One inside a parameter list is the parameter's, and compiled, agbcc lets it reach no
 *  type outside it: it refuses `aligned` there and ignores `packed`. */
function ownAttributes(d: Declaration): Attribute[] {
  return [...d.specifiers.attributes, ...d.declarators.flatMap((x) => x.attributes)];
}

/** The attributes a declaration writes on what it declares and on the parameters of each function it
 *  declares, each parameter's own. One inside a parameter's own parameter list is that inner
 *  parameter's, and no parameter of the function. */
function parameterAttributes(d: Declaration): Attribute[] {
  return [
    ...ownAttributes(d),
    ...d.declarators.flatMap((x) => {
      const fn = x.derivations[0];
      return fn?.kind === 'function'
        ? (fn.params ?? []).flatMap((p) => [...p.specifiers.attributes, ...p.declarator.attributes])
        : [];
    }),
  ];
}

/** Whether an attribute in this declaration can move the layout of the body it defines. One in the
 *  specifier — ahead of the body or straight after it — lays that body out (c-parse.in:1464-1503).
 *  One elsewhere on a variable reaches that variable alone; one elsewhere in a typedef is read as
 *  moving it too, whatever it says (`realigns` has what it may do). */
function laysOut(d: Declaration, attributes: readonly Attribute[]): boolean {
  return d.specifiers.typedef
    ? attributes.length > 0
    : d.specifiers.attributes.some((a) => a.site === 'before-body' || a.site === 'after-body');
}

/** Whether a typedef in this declaration may change, after its layout, a type no body here stands
 *  for. An attribute outside a body's specifier is applied to the type the typedef names (c-common.c:
 *  392-399, 444-446, 623-624), whatever spelling it takes (`aligned`, `__aligned__`, :345-351): a
 *  struct tag, a pointer or a scalar such as `unsigned int` is re-aligned, which lays anything that
 *  holds it out anew, and an enum whose body comes later is packed. Compiled, `typedef struct R *RP
 *  __attribute__((aligned(8)))` makes `struct { struct R *p; }` 8 bytes, and `typedef enum E EA
 *  __attribute__((packed))` ahead of `enum E {…}` makes it 1. mwcc's `__declspec` is such an
 *  attribute too: compiled with mwcc 4.3, `typedef __declspec(align(8)) int AI` lays `struct { char c;
 *  AI a; }` out in 16 bytes. Which type that is, is not worked out here. Where the declaration's plain
 *  declarators name its own body, `laysOut` leaves that body unread instead — unless one attribute is
 *  `mode`, which hands every attribute after it a shared scalar type in place of the body
 *  (c-common.c:563, 996-1000): compiled, `typedef struct R {…} A __attribute__((mode(SI),
 *  aligned(8)))` makes every `int` 8-aligned. */
function realigns(d: Declaration, attributes: readonly Attribute[]): boolean {
  if (!d.specifiers.typedef || attributes.length === 0) {
    return false;
  }
  if (attributes.some((a) => MODE.test(a.text))) {
    return true;
  }
  const { type } = d.specifiers;
  const ownBody = type.kind === 'tag' && type.keyword !== 'class' && type.body !== undefined;
  return !(ownBody && d.declarators.length > 0 && d.declarators.every((x) => x.derivations.length === 0));
}

/** Whether agbcc may lay an enum with this body out wider than an int. It does for a value past 32
 *  bits (c-decl.c:6116-6123): a literal past 32 bits or of type `long long`, or an enumerator of an
 *  enum already that wide (`wide`). Compiled, `enum {B0, B1 = 0x100000000LL}` is 8 bytes, and so is
 *  `enum {C0, C1 = B1}`, where `enum {N0 = -1, N1 = 0xFFFFFFFF}` is 4. */
function enumMayWiden(tokens: Tokens, body: Range, wide: ReadonlySet<string>): boolean {
  for (let k = body.from; k < body.to; k++) {
    const kind = tokens.kind(k);
    const literal = kind === 'number' ? integerLiteral(tokens.text(k)) : undefined;
    if (literal !== undefined && (literal.value > 0xffffffffn || /l.*l/i.test(literal.suffix))) {
      return true;
    }
    if (
      kind === 'identifier' &&
      ((wide.size > 0 && wide.has(tokens.text(k))) || (tokens.is(k, 'long') && tokens.is(k + 1, 'long')))
    ) {
      return true;
    }
  }
  return false;
}

/** The names an enum body declares: the word that starts it, and each word after a comma. */
function enumerators(tokens: Tokens, body: Range): string[] {
  const out: string[] = [];
  for (let k = body.from; k < body.to; k++) {
    if ((k === body.from || tokens.is(k - 1, ',')) && tokens.kind(k) === 'identifier') {
      out.push(tokens.text(k));
    }
  }
  return out;
}

/** `t` with the typedef names it is built on resolved, each to the same type, until `declaredWidth`
 *  can size it: a pointer resolves what it points at, and a typedef name is replaced by the type it
 *  stands for. An array, a function, a reference or a pointer to member is kept as declared. */
function resolve(t: DeclaredType, typedefs: ReadonlyMap<string, DeclaredType>, tokens: Tokens): DeclaredType {
  const [first, ...rest] = t.derivations;
  if (first !== undefined) {
    if (!isPointer(first)) {
      return t;
    }
    const pointee = resolve({ ...t, derivations: rest }, typedefs, tokens);
    return { ...pointee, derivations: [first, ...pointee.derivations] };
  }
  let cur = t;
  for (let hops = 0; hops < 16 && declaredWidth(spellType(cur, tokens)) === undefined; hops++) {
    const name = nameOf(cur);
    const next = name === undefined ? undefined : typedefs.get(name);
    if (next === undefined || nameOf(next) === name) {
      break;
    }
    cur = qualified(next, cur.qualifiers);
  }
  return cur;
}

/** `t` qualified by `q`, as a typedef name's qualifiers qualify the type it stands for: the derivation
 *  nearest the name, or the base where there is none. An array's qualifier is its element's, and a
 *  function or a reference takes none. */
function qualified(t: DeclaredType, q: readonly Qualifier[]): DeclaredType {
  const union = (own: readonly Qualifier[]): Qualifier[] => [...q, ...own.filter((x) => !q.includes(x))];
  const [first, ...rest] = t.derivations;
  if (q.length === 0 || first?.kind === 'function' || first?.kind === 'reference') {
    return t;
  }
  if (first === undefined) {
    return { ...t, qualifiers: union(t.qualifiers) };
  }
  if (first.kind === 'pointer') {
    return { ...t, derivations: [{ ...first, qualifiers: union(first.qualifiers) }, ...rest] };
  }
  const element = qualified({ ...t, derivations: rest }, q);
  return { ...element, derivations: [first, ...element.derivations] };
}

/** A pointer to `t`, or `t` where it is a pointer already. */
const pointerTo = (t: DeclaredType): DeclaredType =>
  t.derivations.length > 0 && t.derivations.every(isPointer)
    ? t
    : { ...t, derivations: [{ kind: 'pointer', qualifiers: [] }, ...t.derivations] };

/** The layout of each struct or union a type names, read from its body when asked for.
 *  Memoised per type and depth: a body whose members point at bodies is walked once per depth, not
 *  once per path to it — each pointer member lays its pointee out, and K of them to depth 8 is K^8
 *  walks. */
function layoutReader(ctx: ParsedContext, table: TypeTable): LayoutOf {
  const laidOut = new Map<string, AggregateLayout | undefined>();
  const layoutOf: LayoutOf = (t, depth) => {
    const keyword = t.type.kind === 'tag' ? t.type.keyword : undefined;
    const tag = keyword === 'struct' || keyword === 'union' ? tagOf(t) : undefined;
    const name = tag ?? nameOf(t);
    if (name === undefined) {
      return undefined;
    }
    const key = `${depth} ${name}`;
    if (laidOut.has(key)) {
      return laidOut.get(key);
    }
    const kind = tag !== undefined ? (keyword as AggregateLayout['kind']) : table.named.get(name)?.kind;
    let layout: AggregateLayout | undefined;
    if (kind !== undefined) {
      const body = tag !== undefined ? table.tagged.get(tag) : table.named.get(name)?.body;
      const members = body === undefined || table.realigned ? undefined : readMembers(body, depth);
      layout = members === undefined ? { kind } : { kind, members };
    }
    laidOut.set(key, layout);
    return layout;
  };
  // A body's members, or undefined when one of them is a type this cannot lay out — a project
  // typedef that resolves to nothing sized, a nested aggregate with no body here, a flexible extent
  // or one that is not a constant expression — or carries an attribute of its own, which may place it
  // anywhere. Bounded in depth, since a body may name its own tag.
  const readMembers = (body: Range, depth: number): AggregateMember[] | undefined => {
    const declarations = depth > 8 ? undefined : memberDeclarations(ctx, body);
    if (declarations === undefined) {
      return undefined;
    }
    const out: AggregateMember[] = [];
    for (const m of declarations) {
      const read = members(m, depth);
      if (read === undefined) {
        return undefined;
      }
      out.push(...read);
    }
    return out;
  };
  // One member declaration's members: a static, a typedef or a declaration of no name is none this
  // places.
  const members = (m: Declaration, depth: number): AggregateMember[] | undefined => {
    const s = m.specifiers;
    if (s.typedef || s.storage.length > 0 || m.declarators.length === 0 || ownAttributes(m).length > 0) {
      return undefined;
    }
    let inline: AggregateLayout | undefined;
    if (s.type.kind === 'tag' && s.type.body !== undefined) {
      const kind = s.type.keyword;
      if (kind !== 'struct' && kind !== 'union') {
        return undefined;
      }
      const read = readMembers(s.type.body, depth + 1);
      if (read === undefined) {
        return undefined;
      }
      inline = { kind, members: read };
    }
    const out: AggregateMember[] = [];
    for (const d of m.declarators) {
      const shape = memberShape(d, ctx.tokens);
      const type =
        shape === undefined ? undefined : (inline ?? memberType(declaredType(s, shape.returns), shape.pointer, depth));
      if (shape === undefined || type === undefined || (typeof type !== 'string' && shape.bits !== undefined)) {
        return undefined;
      }
      out.push({
        name: shape.name,
        type: shape.pointer && typeof type !== 'string' ? 'void *' : type,
        ...(shape.dims ? { dims: shape.dims } : {}),
        ...(shape.bits !== undefined ? { bits: shape.bits } : {}),
      });
    }
    return out;
  };
  // The type of a member of `base`, or of a pointer to one (`pointer`), or undefined where it cannot
  // be laid out.
  const memberType = (base: DeclaredType, pointer: boolean, depth: number): ParamType | AggregateLayout | undefined => {
    const t = resolve(base, table.typedefs, ctx.tokens);
    const spelled = spellType(t, ctx.tokens);
    const spell = (x: DeclaredType): string => spellType(pointer ? pointerTo(x) : x, ctx.tokens);
    if (declaredWidth(spelled) !== undefined || spelled === 'float' || spelled === 'double') {
      return spell(t);
    }
    if (table.unspelledPointers.has(spelled)) {
      return 'void *';
    }
    if (table.unsizedEnums.has(spelled)) {
      return undefined;
    }
    // an enum, which the target sizes whatever it is called: spelled `enum` and its name
    if (table.enums.has(spelled)) {
      return spell(named(`enum ${spelled}`));
    }
    if (t.qualifiers.length === 0 && t.type.kind === 'tag' && t.type.keyword === 'enum' && tagOf(t) !== undefined) {
      return spell(t);
    }
    const nested = layoutOf(t, depth + 1);
    if (nested?.members !== undefined) {
      return nested;
    }
    // a pointer to it is still a word; anything else of it cannot be laid out
    return pointer ? spell(t) : undefined;
  };
  return layoutOf;
}

/** One member declarator: its name, whether it declares a pointer, its extents, its bit width, and
 *  the derivations of what a function pointer returns, which belong to the type it points at. Its
 *  extents are arrays of what it holds, and what it holds is the base, a pointer to it or a function
 *  pointer. */
function memberShape(
  d: Declarator,
  tokens: Tokens,
): { name: string; pointer: boolean; dims?: number[]; bits?: number; returns: readonly Derivation[] } | undefined {
  if (d.bits !== undefined) {
    const bits = constantValue(tokens, d.bits);
    return d.derivations.length > 0 || bits === undefined
      ? undefined
      : { name: d.name ?? '', pointer: false, bits, returns: [] };
  }
  if (d.name === undefined || !WORD.test(d.name)) {
    return undefined;
  }
  const returns = functionPointer(d.derivations);
  if (returns !== undefined) {
    return { name: d.name, pointer: true, returns };
  }
  const dims: number[] = [];
  let k = 0;
  for (let x = d.derivations[k]; x?.kind === 'array'; x = d.derivations[++k]) {
    const n = x.size === undefined ? undefined : constantValue(tokens, x.size);
    if (n === undefined || n === 0) {
      return undefined;
    }
    dims.push(n);
  }
  const stars = d.derivations.slice(k);
  if (!stars.every(isPointer)) {
    return undefined;
  }
  return { name: d.name, pointer: stars.length > 0, ...(dims.length > 0 ? { dims } : {}), returns: [] };
}

/** Every function the declarations name by a plain identifier, keyed by it. A declaration that
 *  spells no type is a constructor's, a destructor's or a conversion operator's; one that defines a
 *  body, or spells a `class`, declares no C function. */
function functionPrototypes(ctx: ParsedContext, table: TypeTable, layoutOf: LayoutOf): Prototypes {
  const found = new Map<string, FnProto | null>();
  // a function one of whose declarations retypes a parameter with `mode`, which gives it the type
  // the mode names in place of the one spelled (c-common.c:563): compiled, `int x
  // __attribute__((mode(DI)))` takes a register pair. Its parameters are not read, in any
  // declaration of it; its return is.
  const unreadParams = new Set<string>();
  const returnOnly = ({ params: _unread, ...rest }: FnProto): FnProto => rest;
  for (const d of ctx.declarations) {
    const s = d.specifiers;
    if (
      s.typedef ||
      (s.spelling === '' && s.qualifiers.length === 0) ||
      (s.type.kind === 'tag' && (s.type.body !== undefined || s.type.keyword === 'class'))
    ) {
      continue;
    }
    const retyped = parameterAttributes(d).some((a) => MODE.test(a.text));
    for (const x of d.declarators) {
      const [fn, ...returns] = x.derivations;
      if (
        fn?.kind !== 'function' ||
        x.name === undefined ||
        !WORD.test(x.name) ||
        !returns.every((r) => r.kind === 'pointer' || r.kind === 'reference')
      ) {
        continue;
      }
      if (retyped) {
        unreadParams.add(x.name);
      }
      const read = readSignature(declaredType(s, returns), fn, ctx, table.typedefs, (t) => layoutOf(t, 0));
      const proto = unreadParams.has(x.name) ? returnOnly(read) : read;
      const prior = found.get(x.name);
      const had = prior && unreadParams.has(x.name) ? returnOnly(prior) : prior;
      found.set(x.name, had === undefined || same(had, proto) ? proto : null);
    }
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

function readSignature(
  ret: DeclaredType,
  fn: Extract<Derivation, { kind: 'function' }>,
  { tokens, language }: ParsedContext,
  typedefs: ReadonlyMap<string, DeclaredType>,
  layoutOf: (t: DeclaredType) => AggregateLayout | undefined,
): FnProto {
  const proto: FnProto = {};
  const resolved = resolve(ret, typedefs, tokens);
  const r = spellType(resolved, tokens);
  // A struct or union returned by value is kept, spelled as the header spells it: it is the fact
  // that moves every argument one register up on a target that returns it through a hidden pointer.
  // A spelling that names one and reads as no type (`struct Blob64 EWRAM_FN`, a macro this never
  // expands) still returns one, and says nothing else about it.
  //
  // A floating return is kept as its keyword: where the FPU carries it, it is what refuses a call
  // that reads the general return register (frontend/call-plan.ts).
  //
  // A spelling that reads as no type and names no aggregate states nothing, and the parameters are
  // kept: in a vendored context that is an enum typedef, whose arguments sit where they are
  // declared. KNOWN GAP: a typedef this never saw (`Blob64T`, defined behind an
  // `#include` that the lexer skips) may be a struct returned through memory, whose hidden pointer
  // is then read as argument 0; a symbol map that sizes the return closes it
  // (`prototypesFromSymbols`).
  const layout = declaredWidth(r) === undefined ? layoutOf(resolved) : undefined;
  const keyword = resolved.type.kind === 'tag' ? resolved.type.keyword : undefined;
  if (r === 'void') {
    proto.returnsVoid = true;
  } else if (declaredWidth(r) !== undefined || isFloatingSpelling(r)) {
    proto.returns = r;
  } else if (layout !== undefined) {
    proto.returns = r;
    proto.returnLayout = layout;
  } else if (keyword !== undefined && keyword !== 'enum' && resolved.derivations.length === 0) {
    proto.returnLayout = { kind: keyword === 'union' ? 'union' : 'struct' };
  }
  const { params } = fn;
  if (params === undefined) {
    return proto;
  }
  if (params.length === 0 && !fn.variadic) {
    if (language === 'c++') {
      proto.params = [];
    }
    return proto;
  }
  if (fn.list.to === fn.list.from + 1 && tokens.is(fn.list.from, 'void')) {
    proto.params = [];
    return proto;
  }
  if (fn.variadic) {
    return proto;
  }
  proto.params = params.map((p) => parameterType(p, tokens, typedefs));
  return proto;
}

/** A parameter's type, its name taken off: an array or a function nearest the name is a pointer, and
 *  the typedef names it is built on resolve as a return's do. */
function parameterType(p: Parameter, tokens: Tokens, typedefs: ReadonlyMap<string, DeclaredType>): ParamType {
  const t = asParameter(declaredType(p.specifiers, p.declarator.derivations));
  return spellType(resolve(t, typedefs, tokens), tokens);
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
  target: Pick<TargetDescription, 'doubleArgWords'>,
): Prototypes {
  const { [own]: _own, ...callees } = contextPrototypesUnder(context, symbols, target);
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
function contextPrototypesUnder(
  context: Prototypes,
  symbols: SymbolMap | undefined,
  target: Pick<TargetDescription, 'doubleArgWords'>,
): Prototypes {
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
      if (declaredCallArgs(p, target) !== undefined || signed === undefined) {
        return [[name, p]];
      }
      return declaresAggregateReturn(p) && signed.returnsVoid !== true
        ? [[name, { ...signed, ...aggregateReturnOf(p) }]]
        : [];
    }),
  );
}
