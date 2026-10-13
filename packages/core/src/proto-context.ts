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
  declaresVoidReturn,
  isFloatingSpelling,
  statesNoReturn,
  symbolPrototype,
  validatePrototypes,
} from './proto';
import type { SymbolMap, SymbolTypeFacts } from './symbols';
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

/** What a preprocessed declaration context states about the globals it declares, beyond their
 *  prototypes. The sets travel together: the aggregate spelling `*(T *)&g` is a cast, which drops
 *  the declaration's qualifiers, so a reader handed the aggregates without the volatile objects
 *  would print a plain read of a volatile one. */
export interface ContextGlobals {
  /** The objects declared as a struct, a union or an array. Such an object has no value a bare name
   *  reads: `v = gInfo;` over `extern struct Info gInfo;` is a compile error, and over
   *  `extern u8 gBuf[];` it reads the address. A project whose symbol map does not describe a
   *  global (one its linker script places has no DWARF) states it here, so the structurer reads
   *  this set where it would read the map's `shape`. A type this cannot resolve — an unexpanded
   *  macro — is left out, which keeps the usage-inferred spelling. */
  aggregates: ReadonlySet<string>;
  /** The objects any byte of which is volatile (`hasVolatileStorage`): the object, an array's
   *  element, a typedef in its chain, or a member of a struct or union in it, nested or anonymous.
   *  A body this cannot read counts as volatile. The set is not per byte: a read of the plain member
   *  of `struct { vu16 a; u16 b; }` is placed too, which costs at most a read the compiler kept that
   *  the source did not ask it to, never one it may drop. raise/declared-volatile.ts stamps every
   *  access to such an object the map does not lay out, and the structurer then puts the qualifier
   *  on the cast (`*(volatile u16 *)&gV`). Scalars are in it too: the header already qualifies
   *  `gReg` where it is spelled bare, and the stamp keeps the raising passes from merging two of its
   *  reads. */
  volatiles: ReadonlySet<string>;
  /** The objects declared as a pointer whose pointee has a volatile byte, read as `volatiles` reads
   *  an object: `extern volatile u16 *gP;`, `extern volatile struct V *gQ;`. The pointer itself is
   *  plain, so a read of `gP` is not placed; an access through the value it holds is, and the
   *  structurer puts the qualifier on the cast it is spelled through (`*(volatile u16 *)gP`).
   *  Without it, `while (*gP == 0);` lifts as a plain read the compiler hoists out of the loop. */
  pointeeVolatiles: ReadonlySet<string>;
}

/** The globals a preprocessed declaration context declares, read for {@link ContextGlobals}. */
export function globalsFromContext(src: string, language: Language): ContextGlobals {
  const ctx = parseDeclarations(src, language);
  const table = typeTable(ctx);
  const scope: VolatileScope = { table, typedefs: typedefTypes(ctx), bodies: tagBodies(ctx), ctx, read: new Map() };
  const aggregates = new Set<string>();
  const volatiles = new Set<string>();
  const pointeeVolatiles = new Set<string>();
  for (const d of ctx.declarations) {
    if (d.specifiers.typedef || d.body !== undefined) {
      continue;
    }
    for (const x of d.declarators) {
      if (x.name === undefined || !WORD.test(x.name)) {
        continue;
      }
      const t = declaredType(d.specifiers, x.derivations);
      if (isAggregate(t, table, scope.typedefs)) {
        aggregates.add(x.name);
      }
      if (hasVolatileStorage(t, scope, 0)) {
        volatiles.add(x.name);
      }
      // derivations run outermost first: the object is a pointer, and what it points at is the rest
      if (t.derivations[0]?.kind === 'pointer') {
        const pointee = { ...t, derivations: t.derivations.slice(1) };
        if (hasVolatileStorage(pointee, scope, 0)) {
          pointeeVolatiles.add(x.name);
        }
      }
    }
  }
  return { aggregates, volatiles, pointeeVolatiles };
}

/** Every struct, union and class body the context defines, by `keyword Tag` (and, in C++, by the bare
 *  tag, as C++ spells one), attributed or not, at the top level and nested in another body. */
function tagBodies(ctx: ParsedContext): Map<string, Range> {
  const out = new Map<string, Range>();
  const visit = (ds: readonly Declaration[], depth: number): void => {
    for (const d of ds) {
      const t = d.specifiers.type;
      if (t.kind !== 'tag' || t.keyword === 'enum' || t.body === undefined) {
        continue;
      }
      if (t.tag !== undefined && WORD.test(t.tag)) {
        out.set(`${t.keyword} ${t.tag}`, t.body);
        if (ctx.language === 'c++') {
          out.set(t.tag, t.body);
        }
      }
      const members = depth < 8 ? memberDeclarations(ctx, t.body) : undefined;
      if (members !== undefined) {
        visit(members, depth + 1);
      }
    }
  };
  visit(ctx.declarations, 0);
  return out;
}

/** Every typedef name the context declares, and the type it stands for as written: with the body a
 *  typedef defines (`typedef struct { vu8 a; } S;`), its qualifiers (`typedef volatile struct {…} S;`)
 *  and an array's bounds (`typedef vu8 Buf[4];`), none of which the type table keeps — it binds a
 *  body's name to the name itself, and it reads no typedef of an array. */
function typedefTypes(ctx: ParsedContext): Map<string, DeclaredType> {
  const out = new Map<string, DeclaredType>();
  for (const d of ctx.declarations) {
    if (!d.specifiers.typedef) {
      continue;
    }
    for (const x of d.declarators) {
      const t = declaredType(d.specifiers, x.derivations);
      // `typedef S S;` restates a name and keeps the type it already stands for
      const restates = t.type.kind === 'words' && t.type.words.length === 1 && t.type.words[0] === x.name;
      if (x.name !== undefined && WORD.test(x.name) && !(restates && t.derivations.length === 0)) {
        out.set(x.name, t);
      }
    }
  }
  return out;
}

/** What `hasVolatileStorage` reads a type through, and what it has already read: each typedef name
 *  and each body by its first token, so a type every member reaches through the same typedefs
 *  (`mActor_name_t`, then `u16`) is walked once, and a long chain of them costs no nesting depth. */
interface VolatileScope {
  table: TypeTable;
  typedefs: ReadonlyMap<string, DeclaredType>;
  bodies: ReadonlyMap<string, Range>;
  ctx: ParsedContext;
  read: Map<string, boolean>;
}

/** Whether any byte of an object of type `t` is volatile: the type or an array's element is
 *  qualified, through the typedef names it is built on, or a struct or union in it has such a member.
 *  A pointer ends the walk at its own qualifiers, since what it points at is no byte of the object.
 *  A body that cannot be read, or bodies nested past the bound, is read as volatile: a qualifier
 *  placed where none was declared only keeps a read the compiler may have dropped. A tag with no
 *  body here has no member to qualify.
 *  A name met again while it is being read is a cycle, read as volatile (`once`). */
function hasVolatileStorage(t: DeclaredType, scope: VolatileScope, depth: number): boolean {
  if (depth > 32) {
    return true;
  }
  for (const x of t.derivations) {
    if (x.kind === 'pointer') {
      return x.qualifiers.includes('volatile');
    }
    if (x.kind !== 'array') {
      return false;
    }
  }
  // GNU's alternate spellings, which the declaration parser keeps as words it does not know, or as
  // the type's own name when a typedef name follows (`__volatile__ u8 a;`)
  const words = t.type.kind === 'words' ? [...t.type.words, ...t.unknownWords] : t.unknownWords;
  if (t.qualifiers.includes('volatile') || words.some((w) => w === '__volatile' || w === '__volatile__')) {
    return true;
  }
  let body: Range | undefined;
  if (t.type.kind === 'tag') {
    if (t.type.keyword === 'enum') {
      return false;
    }
    body = t.type.body ?? (t.type.tag !== undefined ? scope.bodies.get(`${t.type.keyword} ${t.type.tag}`) : undefined);
  } else if (t.type.words.length === 1) {
    const name = t.type.words[0];
    const next = scope.typedefs.get(name);
    if (next !== undefined) {
      const resolves = next.type.kind === 'words' && next.type.words.length === 1 && next.type.words[0] === name;
      return !resolves && once(scope, `typedef ${name}`, () => hasVolatileStorage(next, scope, depth));
    }
    body = scope.table.named.get(name)?.body ?? scope.bodies.get(name);
  }
  if (body === undefined) {
    return false;
  }
  const members = memberDeclarations(scope.ctx, body);
  const bases = baseClause(scope.ctx, body);
  if (members === undefined || bases === undefined) {
    return true;
  }
  // a C++ member typedef names a type for the members after it, so they are read through it, in a
  // scope of their own. That scope also reads a body defined elsewhere through it, which can only
  // leave more out.
  const local = typedefTypes({ ...scope.ctx, declarations: members });
  const inner: VolatileScope =
    local.size === 0 ? scope : { ...scope, typedefs: new Map([...scope.typedefs, ...local]), read: new Map() };
  return once(
    scope,
    `body ${body.from}`,
    () =>
      // a C++ base's members are bytes of the object too, and a base with no body here (one a
      // namespace defines, which this does not read) is read as volatile
      bases.some((b) => !definesBody(b, inner) || hasVolatileStorage(b, inner, depth + 1)) ||
      members.some((m) =>
        // a C++ member typedef or static member is no byte of the object
        m.specifiers.typedef || m.specifiers.storage.includes('static')
          ? false
          : m.declarators.length === 0
            ? hasVolatileStorage(declaredType(m.specifiers, []), inner, depth + 1)
            : m.declarators.some((x) =>
                hasVolatileStorage(declaredType(m.specifiers, x.derivations), inner, depth + 1),
              ),
      ),
  );
}

/** The C++ base classes ahead of `body`, each as the type its name spells, or undefined when a
 *  clause holds anything else (a qualified name, a template argument list, `decltype`), which the
 *  caller reads as volatile. Read backwards from the `{` to the clause's `:`; reaching the
 *  tag keyword first means there is no clause. */
function baseClause(ctx: ParsedContext, body: Range): DeclaredType[] | undefined {
  if (ctx.language !== 'c++') {
    return [];
  }
  const t = ctx.tokens;
  let k = body.from - 2;
  for (; k >= 0 && !t.is(k, ':'); k--) {
    if (TAG_KEYWORDS.has(t.text(k))) {
      return [];
    }
    if (t.kind(k) !== 'identifier' && !t.is(k, '::') && !t.is(k, ',')) {
      // an attribute, a template argument list: a `:` between it and the tag keyword is a clause
      // this does not read, and none means there is no clause
      for (let j = k; j >= 0 && !t.is(j, ';') && !t.is(j, '}') && !t.is(j, '{') && !TAG_KEYWORDS.has(t.text(j)); j--) {
        if (t.is(j, ':')) {
          return undefined;
        }
      }
      return [];
    }
  }
  if (k < 0) {
    return [];
  }
  const out: DeclaredType[] = [];
  let last: string | undefined;
  for (let j = k + 1; j < body.from; j++) {
    if (t.is(j, ',') || j === body.from - 1) {
      if (last === undefined) {
        return undefined;
      }
      out.push({
        qualifiers: [],
        type: { kind: 'words', words: [last] },
        unknownWords: [],
        spelling: last,
        derivations: [],
      });
      last = undefined;
    } else if (t.is(j, '::')) {
      return undefined;
    } else if (t.kind(j) === 'identifier' && !BASE_WORDS.has(t.text(j))) {
      last = t.text(j);
    }
  }
  return out;
}

/** Whether the base `b` names a typedef or a body this context defines. */
function definesBody(b: DeclaredType, scope: VolatileScope): boolean {
  const name = b.spelling;
  return scope.typedefs.has(name) || scope.table.named.get(name)?.body !== undefined || scope.bodies.has(name);
}

const TAG_KEYWORDS: ReadonlySet<string> = new Set(['struct', 'class', 'union', 'enum']);
const BASE_WORDS: ReadonlySet<string> = new Set(['public', 'protected', 'private', 'virtual']);

/** `read()`, remembered under `key`. A key met again while it is being read is a cycle no compiler
 *  lays out (`typedef T U; typedef U T;`, which C11 and C++ accept), read as volatile, for the same
 *  reason as an unreadable body. */
function once(scope: VolatileScope, key: string, read: () => boolean): boolean {
  const known = scope.read.get(key);
  if (known !== undefined) {
    return known;
  }
  scope.read.set(key, true);
  const v = read();
  scope.read.set(key, v);
  return v;
}

/** Whether `t` is a struct, union, class or array type, through the typedef names it is built on.
 *  A typedef the type table does not read — one of an array, `typedef u16 Arr4[4];` — is followed
 *  as written (`typedefTypes`), or `extern Arr4 gTB;` reads as a scalar whose offset-0 read is
 *  spelled `gTB`, the array's address. */
function isAggregate(t: DeclaredType, table: TypeTable, written: ReadonlyMap<string, DeclaredType>): boolean {
  let cur = t;
  for (let hops = 0; hops < 16; hops++) {
    const [first] = cur.derivations;
    if (first !== undefined) {
      return first.kind === 'array';
    }
    if (cur.type.kind === 'tag') {
      return cur.type.keyword !== 'enum';
    }
    const name = nameOf(cur);
    if (name === undefined) {
      return false;
    }
    if (table.named.has(name)) {
      return true;
    }
    const next = table.typedefs.get(name) ?? written.get(name);
    if (next === undefined || nameOf(next) === name) {
      return false;
    }
    cur = next;
  }
  return false;
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
 *  false` as nothing) keeps the context's return by `contextReturnUnder`'s rule: a struct return
 *  always — it is what says argument 0 may be a hidden pointer, and an entry stating only the arity
 *  would otherwise hand that pointer to the call as its first argument; a register return only
 *  where the stated `params` number as many as the header's parameters. A list is parameters; a
 *  COUNT is argument registers (`FnProto.params`), and it is compared with the header's parameter
 *  count all the same, so under a 64-bit parameter a correct register count keeps no return. That
 *  costs a lift, never a wrong one: a return kept is the header's own, and one dropped declines as
 *  an undeclared callee does. `{ returnsVoid: false }` alone states no count, so it keeps no
 *  register return. */
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
      // `heard` is the entry as the map left it: its return, where it has one, is either the whole
      // context entry's or one `contextPrototypesUnder` already checked against the map
      out[name] = { ...p, ...contextReturnUnder(heard ?? undefined, p.params, undefined) };
    }
  }
  return out;
}

const same = (a: FnProto | null, b: FnProto): boolean => a !== null && JSON.stringify(a) === JSON.stringify(b);

/** A context's prototypes, less the entries the symbol map states better. `prototypesFromSymbols`
 *  lets any entry it is handed shadow the map's signature for that name, so what reaches it decides
 *  which source wins, per name: a context entry that sizes every parameter wins — it is the
 *  declaration the candidate is compiled against, and its spellings are the ones a C++ call's casts
 *  need; it is taken whole, its return included, and the map is not consulted for it. An entry that
 *  cannot size one yields to a map signature that can be spelled, which sizes by byte count what a
 *  declaration names (a by-value struct of a register's width); and where the map spells nothing
 *  either, the context entry stays.
 *
 *  AN ENTRY THAT YIELDS ITS PARAMETERS KEEPS THE RETURN IT STATES where `contextReturnUnder` says
 *  it may, because the map's signature carries no `returns`. DWARF does say that a pointer, or a
 *  signed or unsigned base type, comes back in a register; `symbolPrototype` chooses not to spell it
 *  (`FnProto.returns`: a header states it and nothing derives it), because a spelled return also
 *  types the call's result and prints in the candidate's declarations, and the map's `void *` is not
 *  the header's `u8 *` — C++ does not convert it implicitly. So a map-only lift (no context) still
 *  declines this shape, and a context entry dropped whole leaves every non-void call to that name
 *  undeclared — and a frame address handed to an undeclared callee may be its hidden struct-return
 *  pointer (`returnsWithoutHiddenPointer`). pokeemerald's `u8 *ConvertIntToDecimalStringN(u8 *,
 *  s32, enum StringConvertMode, u8)` is the case: its enum parameter has no width here, so the
 *  entry yields its parameters and keeps its `u8 *`. */
function contextPrototypesUnder(
  context: Prototypes,
  symbols: SymbolMap | undefined,
  target: Pick<TargetDescription, 'doubleArgWords'>,
): Prototypes {
  if (symbols === undefined) {
    return context;
  }
  const mapped = new Map<string, { signed: FnProto; returned: SymbolTypeFacts | null }>();
  for (const infos of symbols.values()) {
    for (const info of infos) {
      const signed = symbolPrototype(info);
      if (signed?.params !== undefined && info.signature !== undefined && !mapped.has(info.name)) {
        mapped.set(info.name, { signed, returned: info.signature.returns });
      }
    }
  }
  return Object.fromEntries(
    Object.entries(context).flatMap(([name, p]): [string, FnProto][] => {
      const map = mapped.get(name);
      if (declaredCallArgs(p, target) !== undefined || map === undefined) {
        return [[name, p]];
      }
      const kept = contextReturnUnder(p, map.signed.params, map.returned);
      return kept === undefined ? [] : [[name, { ...map.signed, ...kept }]];
    }),
  );
}

/** The return a context entry `p` keeps under parameters another source states (`under`: the
 *  map's signature, or a stated entry that says nothing of the return) — or `undefined` when it
 *  keeps none. `returned` is the map's DWARF return where the map's signature is the other source,
 *  `null` for a map that says `void`, and `undefined` where the map is not consulted.
 *
 *  A `void` return is not kept: whether the callee returns is the map's to state.
 *
 *  A STRUCT RETURN is kept as stated: DWARF names no struct, so the map states one only by its size
 *  (`symbolPrototype`), and never its members; and keeping it is the safe direction, since it only
 *  says argument 0 may be a hidden pointer.
 *
 *  A REGISTER RETURN says argument 0 is NOT one, so it is the direction that lifts, and it is kept
 *  only where it is the same fact as the parameters it sits under:
 *  - the context states every parameter, and as many as `under` does — a count `under` is read as
 *    a number of parameters here, though it states registers (`withContextPrototypes`). A variadic
 *    declaration, and a K&R one, state none (`readSignature`), and the map's DWARF parameters
 *    leave the `...` out — so `int pr(char *, const char *, ...)` under a two-parameter map
 *    signature would lower `pr(buf, s, a, b)` as `pr(buf, s)`. Dropped whole, the call declines;
 *  - the return has a width (`declaredWidth`). `float` and `double` have none here, cannot say
 *    anything about a hidden pointer the map's word does not, and on a target with an FPU make
 *    call-plan refuse every call to the name (`$f0`, `f1`), whose result is used or not;
 *  - the map, where it is consulted, does not contradict it: a return the map calls `void`, or a
 *    width its byte size disagrees with (`int` declared, `u8` defined). This is a rule of the merged entry only — its parameters are the map's and its
 *    return the header's, and the two are one fact a table must not hold half of. A context entry
 *    taken whole (it sizes every parameter) never meets the map, and keeps its return unchecked.
 *  Each refusal leaves the call undeclared (`FnProto.returns`). */
function contextReturnUnder(
  p: FnProto | undefined,
  under: FnProto['params'],
  returned: SymbolTypeFacts | null | undefined,
): Pick<FnProto, 'returns' | 'returnLayout'> | undefined {
  if (p === undefined || returned === null || statesNoReturn(p) || declaresVoidReturn(p)) {
    return undefined;
  }
  const kept = {
    ...(p.returns !== undefined ? { returns: p.returns } : {}),
    ...(p.returnLayout !== undefined ? { returnLayout: p.returnLayout } : {}),
  };
  if (declaresAggregateReturn(p)) {
    return kept;
  }
  const arity = typeof under === 'number' ? under : under?.length;
  if (!Array.isArray(p.params) || p.params.length !== arity) {
    return undefined;
  }
  const width = p.returns === undefined ? undefined : declaredWidth(p.returns);
  if (width === undefined) {
    return undefined;
  }
  return returned !== undefined && returned.size !== null && returned.size * 8 !== width ? undefined : kept;
}
