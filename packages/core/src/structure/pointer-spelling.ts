// asmlift structurer — POINTER/INTEGER SPELLING: whether a value the asm did arithmetic on, or
// assigned into a temp or a pointer cell, is written as a pointer or as an integer, and through
// which cast. A global's C type is the project header's, which this pass cannot read, so each
// rule spells the asm's bytes under every declaration that header may carry; its doc names the
// declarations it covers and its known gaps.
//
// The arithmetic is decided in three steps. Each operand gets a ROLE (`Role`) before the op is
// printed, read from the operand as lowered: a constant, a global's address, a bare name with what
// the declarations and the IR say of it, a member, or a value this rule already spelled, which
// carries what it is made of. One table (`ARITH_ROWS`) maps the operator, the two roles and the IR
// result type to a plan: which cast each side takes, and the pointer type the sum goes back to.
// The plan is printed once. The operand order of a commutative load pair is decided before the
// table, by its own predicate (`pointerSide`), whose doc says which sides it keeps and where it
// reads other facts than the table.
//
// The factory takes its dependencies EXPLICITLY (`PointerSpellingDeps`), the switch-recover
// pattern. `varType` is captured as a LIVE reference: the naming pipeline is still declaring
// temps when the factory is created, and every rule types an expression over the declarations
// that exist at call time.
import { Op, type Value } from '../ir/core';
import { MEM_BASE_OPS } from '../ir/opcodes';
import { type IrType, T, typeEquals } from '../ir/types';
import { type BinOp, Expr } from '../l3/ast';
import { pointerCellValue } from '../l3/ptrcell';
import { exprCType, ptrElemBytes } from '../l3/typing';
import { type SymbolInfo, isScalarCellSize, scalarCellType } from '../symbols';
import type { TargetDescription } from '../target';
import { ARITH_TO_BIN } from './arith-ops';
import { type MemberLookup, ptrMemberDecl } from './globalaccess';

/** The slice of structure.ts's symbol-map rendering context these rules read. */
export interface PointerSpellingSymCtx extends MemberLookup {
  info(name: string): SymbolInfo | undefined;
}

export interface PointerSpellingDeps {
  /** absent ⇒ no map. */
  sym: PointerSpellingSymCtx | undefined;
  /** the globals the map declares pointers, for a structuring that does not spell from the map
   *  (the `pointerGlobals` structure option). */
  pointerGlobals: ReadonlySet<string> | undefined;
  /** the scalar globals the IR loads as a pointer at least once (structure.ts). */
  pointerLoadedGlobals: ReadonlySet<string>;
  /** the scalar globals the IR loads as a word (structure.ts). */
  wordLoadedGlobals: ReadonlySet<string>;
  /** each declared variable's type — LIVE, read at call time. */
  varType: ReadonlyMap<string, IrType>;
  /** the compiler behaviors a row is guarded on (`ArithRow.when`); absent ⇒ none holds. */
  compiler?: ArithCompilerFacts;
  /** each value's readers (analysis.ts `useSitesOf`); absent ⇒ none. */
  useSitesOf?: ReadonlyMap<Value, readonly { op: Op }[]>;
  /** whether a name holds the value — LIVE, read at call time; absent ⇒ none does. */
  isNamed?: (v: Value) => boolean;
}

/** The compiler behaviors (target.ts `compilerBehaviors`) the table's rows may be guarded on. A row
 *  guarded on another one adds its name here; `StructureOptions` extends this type, so the behavior
 *  reaches the table from the target with no further edit. */
export type ArithCompilerFacts = Pick<TargetDescription['compilerBehaviors'], 'keepsPointerSumAddend'>;

/** Which globals a fact holds of: some global, and whether one of them is a global no map
 *  declaration types. */
interface GlobalFact {
  readonly any: boolean;
  readonly undeclared: boolean;
}
const NOT: GlobalFact = { any: false, undeclared: false };
const either = (...fs: GlobalFact[]): GlobalFact => ({
  any: fs.some((f) => f.any),
  undeclared: fs.some((f) => f.undeclared),
});

/** What the declarations and the IR say of a bare name. A name that is no global (a temp, a
 *  parameter) is no pointer value, loads nothing and is declared by nothing this pass reads. */
interface NameFacts {
  /** a POINTER VALUE: see `pointerValue` in the factory */
  readonly pointer: boolean;
  /** no declaration this pass can read types it (the map's, or a `pointerGlobals` one) */
  readonly undeclared: boolean;
  /** the map has no declaration of it */
  readonly mapUndeclared: boolean;
  readonly pointerLoaded: boolean;
  readonly wordLoaded: boolean;
}

/** What a value this rule spelled is made of, recorded when it is built so no later op has to
 *  read it back out of the printed C. */
interface Made {
  /** every leaf is a constant */
  readonly constant: boolean;
  /** a global's address is in it (`(u32)&g`, a sum of one) */
  readonly address: boolean;
  /** `(u8 *)g`: a global's value as a byte pointer */
  readonly globalBytes: GlobalFact;
  /** `(u32)g`, `(u32)(u8 *)g`, or a byte sum of a global as its word */
  readonly globalWord: GlobalFact;
  /** a sum one of whose terms is a global's byte pointer (or a restored integer sum) */
  readonly byteSum: GlobalFact;
  /** a sum one of whose terms is a global's word */
  readonly intSum: GlobalFact;
  /** an integer sum of a global's word, cast back to the byte pointer it stands for */
  readonly restored: GlobalFact;
}
const NOTHING_MADE: Made = {
  constant: false,
  address: false,
  globalBytes: NOT,
  globalWord: NOT,
  byteSum: NOT,
  intSum: NOT,
  restored: NOT,
};

/** What an arithmetic operand IS, decided before the op is printed. It is read from the operand
 *  AS LOWERED, by its expression kind: a `const` (an IR constant, or the immediate of a
 *  one-operand op), an `addr` (a `gaddr`), a `var` (a scalar global's bare name, a temp, a
 *  parameter), a `field` (a member), and anything else, a `value` typed by the C it renders. A
 *  `cast` or a `sum` is one this rule spelled, found by the identity of the expression `arith`
 *  returned: a copy of it reads as a `value`, whose facts are read back out of its C
 *  (`constantExpr`, `carriesAddress`). So does a `(u8 *)g` another rule printed: it carries no
 *  global, and an op over it keeps the pointer sum where the table spells the integer sum in the
 *  asm's operand order. Each operand structure.ts hands `arith` is lowered from its IR value, and
 *  no lowering prints a global as a byte pointer; one that does goes through `arith`. */
export type Role =
  | { readonly k: 'literal'; readonly e: Extract<Expr, { k: 'const' }> }
  | { readonly k: 'address'; readonly e: Expr }
  | { readonly k: 'name'; readonly e: Expr; readonly facts: NameFacts }
  | { readonly k: 'member'; readonly e: Expr; readonly pointer: boolean }
  | { readonly k: 'value'; readonly e: Expr; readonly made: Made }
  | { readonly k: 'cast'; readonly e: Expr; readonly of: Role; readonly made: Made }
  | {
      readonly k: 'sum';
      readonly e: Expr;
      readonly op: BinOp;
      readonly l: Role;
      readonly r: Role;
      readonly made: Made;
    };

/** An expression every leaf of which is a constant (an unfolded `1 << 2`, a narrowed constant). */
const constantExpr = (x: Expr): boolean =>
  x.k === 'const' || (x.k === 'cast' && constantExpr(x.e)) || (x.k === 'bin' && constantExpr(x.l) && constantExpr(x.r));
/** An expression whose value carries a global's address: `&g`, a cast of one, a sum with one. */
const carriesAddress = (x: Expr): boolean =>
  x.k === 'addr' ||
  (x.k === 'cast' && carriesAddress(x.e)) ||
  (x.k === 'bin' && (x.op === '+' || x.op === '-') && (carriesAddress(x.l) || carriesAddress(x.r)));

const made = (x: Role): Made =>
  x.k === 'cast' || x.k === 'sum' || x.k === 'value'
    ? x.made
    : x.k === 'literal'
      ? { ...NOTHING_MADE, constant: true }
      : x.k === 'address'
        ? { ...NOTHING_MADE, address: true }
        : NOTHING_MADE;

/** The facts of one side of an arithmetic op the table reads. */
export type SideFact =
  /** an IR constant */
  | 'literal'
  /** a literal that is a whole number of the other side's pointee (wider than a byte) */
  | 'exact'
  /** renders a pointer */
  | 'pointer'
  /** renders a pointer whose pointee is not one byte */
  | 'wide'
  /** a pointer global's value or a pointer member (`pointerValue`) */
  | 'pointerValue'
  /** a bare name no map declaration types */
  | 'undeclared'
  /** a global's word no declaration types (`untypedWord`) */
  | 'untyped'
  | 'constant'
  /** an additive expression with a constant term (`x + K`, `x - K`, `K + x`) */
  | 'addend'
  /** a global's address is in it */
  | 'address'
  /** renders an integer, or is a bare name nothing types that is no pointer value, and holds no
   *  address */
  | 'integer'
  /** an integer sum of a global this rule cast back to the byte pointer */
  | 'restored'
  /** a sum this rule made with a global's byte pointer in it */
  | 'byteSum'
  /** a `byteSum` with the byte pointer of a global no map declaration types in it */
  | 'undeclaredByteSum'
  /** an additive sum this rule made, uncast */
  | 'sum';

/** What each side of the op becomes, in order, each step applied to the last one's result:
 *  - `bytes`: `(u8 *)x`;
 *  - `elements`: the literal in elements of the other side's pointee;
 *  - `word`: a global's value as its word (`globalWord`);
 *  - `words`: each untyped global word in it as its word (`untypedWords`);
 *  - `integer`: the integer the value is under an operator C takes no pointer of (`integer`);
 *  - `partner`: the integer an integer sum's partner is (`partner`);
 *  - `asInt`: a byte sum as the integer it also is (`byteSumAsInt`). */
export type SideSpell = 'bytes' | 'elements' | 'word' | 'words' | 'integer' | 'partner' | 'asInt';

/** The pointer type the sum goes back to: the byte pointer, or the type the left or the right
 *  side renders. */
export type Restore = 'bytes' | 'left' | 'right';

export interface ArithRow {
  /** the operator: `±` is both additive ones, `logical` is `&&`/`||`, `bitwise` is the rest */
  readonly op: '+' | '-' | '±' | 'logical' | 'bitwise';
  /** the row holds only where the compiler has this behavior */
  readonly when?: keyof ArithCompilerFacts;
  /** the row holds only where the sum is a value: held in a name, or read other than as the
   *  address of a load or store (`inlinedAccessBase`) */
  readonly value?: true;
  /** the IR types the op's result a pointer */
  readonly resultPointer?: true;
  readonly l?: Readonly<Partial<Record<SideFact, boolean>>>;
  readonly r?: Readonly<Partial<Record<SideFact, boolean>>>;
  /** what each side becomes */
  readonly lSpell?: readonly SideSpell[];
  readonly rSpell?: readonly SideSpell[];
  readonly restore?: Restore;
}

/** THE ARITHMETIC TABLE, first match wins. An address operand is its word under every operator
 *  before the table is read (`(u32)&g`): its C type comes from the PROJECT's declaration, which
 *  makes `&gSym + K` byte-inexact (C scales K by sizeof(gSym)) and `&gSym & K` ill-formed; the
 *  deref folds look through that cast, so every access that can spell a named element or field
 *  still does.
 *
 *  POINTER STRIDE. C pointer arithmetic is ELEMENT-scaled, but the asm added BYTES: a constant that
 *  is a whole number of the pointee's elements is divided by its size; any other offset on a
 *  pointer whose pointee is not one byte walks a byte pointer, `(u8 *)p + 62`, the same address in
 *  every world. Keyed on the RENDERED C type, never the IR value's recovered one: C scales by the
 *  type of the expression it sees, and a value recovered `s32*` can render as an int-typed tree,
 *  where dividing would bake in a wrong address. A RUNTIME offset has no element spelling at all,
 *  and the sum then goes back to the pointer type it started as, so the walk changes the
 *  arithmetic and nothing else: a bare `u8 *` sum would be a different C type from the slot it
 *  lands in (`v4 = (u8 *)a0 + (v1 << 2)` into an `s32 *` — an mwcc error). An inexact constant's
 *  sum is not cast back: a deref supplies its own cast, and intoDeclaredTemp's casts a temp's.
 *
 *  TWO POINTERS. `ptr - ptr` is C's ELEMENT difference, where the asm subtracted bytes: agbcc
 *  compiles `(q - p) + m` on an `int *` to `sub; asr #2; add`. Both sides go byte pointers, the
 *  byte count in every world, unless both already are. `ptr + ptr` is not C; `ptr + (s32)ptr` is,
 *  so the left side is the base and walks as above.
 *
 *  A POINTER VALUE (`gPtr`, `gSym.pBuf`, see `pointerValue`). C scales `gPtr + K` by
 *  sizeof(*gPtr) — 1 under the map's synthesized `void *`, but whatever the PROJECT's header
 *  declares in the world a user recompiles in. So the stride is made explicit, CAST-THEN-ADD,
 *  `(u8 *)gPtr + K`; add-then-cast (`(u8 *)(gPtr + K)`) is byte-correct in one world only. A
 *  MEMBER has no world where the raw spelling is right: the map declares its pointee width. Not
 *  foldable into the deref index either: `((u8 *)gPtr)[K + off]` re-scales K by the access width.
 *  `ptr + ptr` and `int - ptr` are not C, so the second pointer value goes its word.
 *
 *  A global's value no declaration types, added to an integer, is a pointer value too when the IR
 *  types the SUM a pointer: `(u8 *)g + x` is the asm's address under every declaration of `g` once
 *  `x` renders an integer. An integer side that holds an address (`(u32)&gArr + gIdx`) says the
 *  address is the base and the global its index. Its partner is added as an integer, which it is
 *  under an integer declaration and a pointer one alike.
 *
 *  THE INTEGER SUM. `x + (u8 *)g` is pointer arithmetic, and gcc makes the pointer the first
 *  operand of the add, which swaps the asm's. So under an integer left side, the value of a global
 *  no map declaration types, or a byte sum of one, is added as an integer in the asm's order, and
 *  the sum goes back to the byte pointer it would have been. The same global LEFT of a runtime
 *  offset is added as an integer too: CodeWarrior at -O4 puts the index first in every pointer
 *  sum, where an integer sum keeps the source's order, so `(u8 *)g + x` is the asm's order on
 *  agbcc, KMC gcc and IDO only. The partner goes integer with it, or a pointer partner would scale
 *  the sum. Except where the compiler keeps a pointer sum's constant addend and moves an integer
 *  sum's (`keepsPointerSumAddend`) and the offset has a constant term: the gcc family folds
 *  `(u32)g + (x + K)` to `(g + K) + x` and keeps the pointer sum's `g + (x + K)`, so there the
 *  offset keeps the pointer sum. Only where the sum is a VALUE, a call argument or a temp: spelled
 *  inside the load or store it is the address of, agbcc moves the constant out of both sums into
 *  the access, the pointer sum's as `(x + g) + K` and the integer sum's as `(g + x) + K`, so neither
 *  is the asm's `g + (x + K)` and the integer sum keeps its base-first order. A constant offset
 *  folds into the access and keeps `(u8 *)g + K`. A declared pointer keeps `x + (u8 *)p`, the
 *  operand the element and field spellings read.
 *
 *  A byte sum less an integer sum of globals no declaration types: bare, `gB2 - gB3` is an element
 *  count under a wider pointer declaration of them, where the asm subtracted bytes.
 *
 *  KNOWN GAP: a global's word no declaration types is left bare wherever no row casts it: beside an
 *  integer under an op the IR types an integer (`gW + x`, `gW + 4`), beside a global's address
 *  (`gW + (u32)&gArr`), left of a pointer it subtracts under an integer result or from an address
 *  (`gW - (s32)p`), and right of a byte pointer or a byte difference (`pb + gW`,
 *  `(u8 *)gPtr - (u8 *)gQ - gW`). That is the asm's integer under an integer declaration, the candidate's
 *  own world; under a wider pointer declaration C scales the other side or rejects the two
 *  pointers, and under a float one it is float math.
 *
 *  C rejects a pointer operand under the non-additive operators (& | ^ << >> * / %), so there the
 *  asm's 32-bit integer math on the address is what is spelled. `&&`/`||` take a pointer operand
 *  legally — a truth test, no arithmetic. A pointer value under a COMPARISON needs nothing here: an
 *  icmp_s* pins every operand that does not provably render signed (structure.ts pinSigned). */
export const ARITH_ROWS: readonly ArithRow[] = [
  { op: 'logical' },
  { op: 'bitwise', lSpell: ['integer'], rSpell: ['integer'] },
  // a literal right operand: the stride
  { op: '±', r: { exact: true }, rSpell: ['elements'] },
  { op: '±', l: { wide: true }, r: { literal: true }, lSpell: ['bytes'] },
  { op: '±', l: { pointerValue: true }, r: { literal: true }, lSpell: ['bytes'] },
  { op: '±', resultPointer: true, l: { untyped: true }, r: { literal: true }, lSpell: ['bytes'] },
  { op: '±', r: { literal: true } },
  // a literal left of `+`
  { op: '+', l: { exact: true }, lSpell: ['elements'] },
  { op: '+', l: { literal: true }, r: { wide: true }, rSpell: ['bytes'] },
  { op: '+', l: { literal: true }, r: { pointer: true, undeclaredByteSum: true }, rSpell: ['asInt'], restore: 'bytes' },
  { op: '+', l: { literal: true }, r: { pointerValue: true, undeclared: true }, rSpell: ['word'], restore: 'bytes' },
  { op: '+', l: { literal: true }, r: { pointerValue: true }, rSpell: ['bytes'] },
  { op: '+', resultPointer: true, l: { literal: true }, r: { untyped: true }, rSpell: ['word'], restore: 'bytes' },
  { op: '+', l: { literal: true } },
  // a rendered pointer left of `+`: the right side as an integer, and a wider pointer walked
  { op: '+', l: { wide: true }, lSpell: ['bytes'], rSpell: ['integer'], restore: 'left' },
  { op: '+', l: { pointer: true }, rSpell: ['integer'] },
  // a rendered pointer left of `-`
  { op: '-', l: { pointer: true }, r: { wide: true }, lSpell: ['bytes'], rSpell: ['bytes'] },
  { op: '-', l: { wide: true }, r: { pointer: true }, lSpell: ['bytes'], rSpell: ['bytes'] },
  { op: '-', l: { pointer: true }, r: { pointer: true } },
  { op: '-', l: { wide: true }, r: { pointerValue: true }, lSpell: ['bytes'], rSpell: ['bytes'] },
  { op: '-', l: { pointer: true }, r: { pointerValue: true }, rSpell: ['bytes'] },
  { op: '-', l: { wide: true }, lSpell: ['bytes'], restore: 'left' },
  { op: '-', l: { pointer: true, byteSum: true }, r: { sum: true }, rSpell: ['words'] },
  { op: '-', l: { pointer: true } },
  // `int - ptr`: the pointer goes its integer. A restored byte sum is that integer sum, which
  // leaves a global the left side takes bare a pointer under a pointer declaration, which the
  // integer would scale; a word, it is the asm's under any integer or pointer one.
  { op: '-', l: { pointerValue: true, untyped: false }, r: { restored: true }, lSpell: ['bytes'], rSpell: ['integer'] },
  { op: '-', r: { restored: true }, lSpell: ['words'], rSpell: ['integer'] },
  { op: '-', l: { pointerValue: true }, r: { pointer: true }, lSpell: ['bytes'], rSpell: ['integer'] },
  {
    op: '-',
    resultPointer: true,
    l: { untyped: true },
    r: { pointer: true, address: false },
    lSpell: ['bytes'],
    rSpell: ['integer'],
  },
  { op: '-', r: { pointer: true }, rSpell: ['integer'] },
  // a pointer value left of `+`: one no map declares goes its word into the integer sum
  {
    op: '+',
    l: { pointerValue: true, undeclared: true },
    r: { wide: true, constant: false },
    lSpell: ['word'],
    rSpell: ['bytes', 'partner'],
    restore: 'right',
  },
  {
    op: '+',
    when: 'keepsPointerSumAddend',
    value: true,
    l: { pointerValue: true, undeclared: true },
    r: { integer: true, addend: true, constant: false },
    lSpell: ['bytes'],
    rSpell: ['words'],
  },
  {
    op: '+',
    l: { pointerValue: true, undeclared: true },
    r: { constant: false },
    lSpell: ['word'],
    rSpell: ['partner'],
    restore: 'bytes',
  },
  { op: '+', l: { pointerValue: true }, r: { wide: true }, lSpell: ['word'], rSpell: ['bytes'], restore: 'right' },
  { op: '+', l: { pointerValue: true }, r: { pointer: true }, lSpell: ['word'] },
  // a rendered pointer right of `+`
  { op: '+', r: { wide: true }, rSpell: ['bytes'], restore: 'right' },
  { op: '+', r: { pointer: true, undeclaredByteSum: true }, lSpell: ['words'], rSpell: ['asInt'], restore: 'bytes' },
  { op: '+', r: { pointer: true } },
  // no rendered pointer: `+`
  { op: '+', l: { pointerValue: true }, r: { pointerValue: true }, lSpell: ['bytes'], rSpell: ['word'] },
  { op: '+', l: { pointerValue: true }, lSpell: ['bytes'] },
  { op: '+', r: { pointerValue: true, undeclared: true }, lSpell: ['words'], rSpell: ['word'], restore: 'bytes' },
  { op: '+', r: { pointerValue: true }, rSpell: ['bytes'] },
  {
    op: '+',
    resultPointer: true,
    l: { untyped: true },
    r: { integer: true, constant: false },
    lSpell: ['word'],
    rSpell: ['words'],
    restore: 'bytes',
  },
  { op: '+', resultPointer: true, l: { untyped: true }, r: { integer: true }, lSpell: ['bytes'] },
  {
    op: '+',
    resultPointer: true,
    l: { integer: true },
    r: { untyped: true },
    lSpell: ['words'],
    rSpell: ['word'],
    restore: 'bytes',
  },
  { op: '+' },
  // no rendered pointer: `-`
  { op: '-', l: { pointerValue: true }, r: { pointerValue: true }, lSpell: ['bytes'], rSpell: ['bytes'] },
  { op: '-', l: { pointerValue: true }, lSpell: ['bytes'] },
  { op: '-', r: { pointerValue: true }, rSpell: ['word'] },
  { op: '-', resultPointer: true, l: { untyped: true }, r: { integer: true }, lSpell: ['bytes'], rSpell: ['words'] },
  { op: '-', l: { byteSum: true }, r: { sum: true }, rSpell: ['words'] },
  { op: '-' },
];

const ROW_TESTS = ARITH_ROWS.map((row) => ({
  row,
  l: Object.entries(row.l ?? {}) as [SideFact, boolean][],
  r: Object.entries(row.r ?? {}) as [SideFact, boolean][],
}));

export interface PointerSpelling {
  /** The declared shape of a global as the pointer-value rules read it: the map's, or `'pointer'`
   *  for a `pointerGlobals` name. */
  declaredShape(name: string): SymbolInfo['shape'];
  needsIntSpelling(x: Expr): boolean;
  intoDeclaredTemp(name: string, value: Expr): Expr;
  intoPtrCell(lval: Expr, value: Expr): Expr;
  /** The integer arithmetic op `d` (ARITH_TO_BIN) over its operands as lowered, spelled for the
   *  address the asm computed. `loadPairReversed`: `d` is commutative and its operands are a load
   *  pair the compiler evaluated right first (structure.ts), which re-spells them in that order
   *  unless `pointerSide` keeps them. */
  arith(d: Op, l: Expr, r: Expr, loadPairReversed: boolean): Expr;
  /** What an operand is, by the same reading `arith` makes. */
  roleOf(x: Expr): Role;
}

const BYTE_PTR = T.ptr(T.u(8));

export function makePointerSpelling(deps: PointerSpellingDeps): PointerSpelling {
  const {
    sym,
    pointerGlobals,
    pointerLoadedGlobals,
    wordLoadedGlobals,
    varType,
    compiler = {},
    useSitesOf,
    isNamed = () => false,
  } = deps;
  const ctype = (e0: Expr): IrType | undefined => exprCType(e0, (n) => varType.get(n));

  /** The op's result is spelled inside the loads and stores it is the address of, and nowhere
   *  else: no name holds it, and it has readers, each a load or store reading it as its base
   *  (operand 0) and as nothing else. */
  const inlinedAccessBase = (d: Op): boolean => {
    const v = d.results[0];
    const sites = v === undefined || isNamed(v) ? [] : (useSitesOf?.get(v) ?? []);
    return sites.length > 0 && sites.every(({ op }) => MEM_BASE_OPS.has(op.opcode) && op.operands.lastIndexOf(v) === 0);
  };

  /** The declared shape of a global as the pointer-value rules read it: the map's, or a pointer
   *  the map declares to a structuring that does not spell from it (`pointerGlobals`). The
   *  operand-order rules read `mapUndeclared` instead: a declared pointer keeps `x + (u8 *)p` for
   *  the element and field spellings to read, and a `pointerGlobals` name has no pointee for them,
   *  so its sum is spelled in the asm's order like any other undeclared global's. */
  const declaredShape = (name: string): SymbolInfo['shape'] =>
    sym?.info(name)?.shape ?? (pointerGlobals?.has(name) ? 'pointer' : undefined);

  /** A bare name's facts. A POINTER VALUE is one whose type the project's header owns: a bare
   *  `gSym` naming a pointer global (the VALUE of a pointer cell). Load, store and compare of such
   *  a 4-byte cell are identical for any object-pointer type, so the declared pointee never matters
   *  to THEM; arithmetic on the loaded value is the opposite case, where the pointee's size scales
   *  what is added. `ctype` cannot see any of this: it types only params/locals.
   *
   *  A bare global is one when its declared shape is `'pointer'`, or when no declaration this pass
   *  can read says anything (no map, a symtab-only name, entries that disagree and were dropped to
   *  the bare name, a name the map lacks) and the IR loads it as a pointer at least once. A map
   *  `shape:'scalar'` is a declaration and is excluded; so is a global the IR never loads as a
   *  pointer (`gCount + 1`, or the `u8` index in `gIdx + gItems`), where casting would make a
   *  pointer of an integer the source added as one. */
  const nameFacts = (name: string): NameFacts => {
    const shape = declaredShape(name);
    const pointerLoaded = pointerLoadedGlobals.has(name);
    return {
      pointer: shape === 'pointer' || (shape === undefined && pointerLoaded),
      undeclared: shape === undefined,
      mapUndeclared: sym?.info(name)?.shape === undefined,
      pointerLoaded,
      wordLoaded: wordLoadedGlobals.has(name),
    };
  };

  /** The values this rule spelled, by the expression it returned, so an op over one reads what it
   *  is made of. */
  const spelled = new WeakMap<Expr, Role>();
  const roleOf = (x: Expr): Role => {
    const built = spelled.get(x);
    if (built !== undefined) {
      return built;
    }
    switch (x.k) {
      case 'const':
        return { k: 'literal', e: x };
      case 'addr':
        return { k: 'address', e: x };
      case 'var':
        return { k: 'name', e: x, facts: nameFacts(x.name) };
      case 'field':
        // a member the map declares a pointer (`gSym.pBuf`, `gPtr->pBuf`)
        return { k: 'member', e: x, pointer: ptrMemberDecl(x, sym) !== null };
      default:
        return { k: 'value', e: x, made: { ...NOTHING_MADE, constant: constantExpr(x), address: carriesAddress(x) } };
    }
  };

  /** A pointer value whose type the project's header owns (`nameFacts`), or a named member whose
   *  declaration is a pointer. */
  const pointerValue = (x: Role): boolean => (x.k === 'name' && x.facts.pointer) || (x.k === 'member' && x.pointer);
  /** A global's word value that no declaration this pass can read types, whatever the IR loaded
   *  it as. */
  const untypedWord = (x: Role): boolean => x.k === 'name' && x.facts.wordLoaded && x.facts.undeclared;

  const castTo = (to: IrType, of: Role): Role => {
    const m = made(of);
    const globalOf = (x: Role): GlobalFact =>
      x.k === 'name' && (pointerValue(x) || untypedWord(x)) ? { any: true, undeclared: x.facts.mapUndeclared } : NOT;
    const additive = of.k === 'sum' && (of.op === '+' || of.op === '-');
    const bytes = typeEquals(to, BYTE_PTR);
    const restored = bytes && additive ? m.intSum : NOT;
    return {
      k: 'cast',
      e: { k: 'cast', to, e: of.e },
      of,
      made: {
        constant: m.constant,
        address: m.address,
        globalBytes: bytes ? globalOf(of) : NOT,
        globalWord: typeEquals(to, T.u(32))
          ? either(m.globalBytes, of.k === 'sum' ? m.byteSum : NOT, globalOf(of))
          : NOT,
        byteSum: restored,
        intSum: NOT,
        restored,
      },
    };
  };
  const sumOf = (op: BinOp, l: Role, r: Role): Role => {
    const [ml, mr] = [made(l), made(r)];
    const additive = op === '+' || op === '-';
    return {
      k: 'sum',
      e: { k: 'bin', op, l: l.e, r: r.e },
      op,
      l,
      r,
      made: {
        constant: ml.constant && mr.constant,
        address: additive && (ml.address || mr.address),
        globalBytes: NOT,
        globalWord: NOT,
        byteSum: additive ? either(ml.globalBytes, mr.globalBytes, ml.byteSum, mr.byteSum) : NOT,
        intSum: additive ? either(ml.globalWord, mr.globalWord, ml.intSum, mr.intSum) : NOT,
        restored: NOT,
      },
    };
  };

  /** A pointer value or a global's word as the integer the asm added. A global no declaration
   *  types and the IR never loads as a pointer may be declared a float, whose value `(u32)g`
   *  converts, so it goes through `(u8 *)` first: `(u32)(u8 *)g` is `(u32)g`'s bytes under every
   *  integer and pointer declaration, and no C under a float one. KNOWN GAP: under an array or a
   *  function declaration `g` decays to its address, which this spells with no diagnostic; only a
   *  pun reads the word there, and intoDeclaredTemp's KNOWN GAP says why none is spelled. */
  const globalWord = (x: Role): Role =>
    castTo(T.u(32), x.k === 'name' && x.facts.undeclared && !x.facts.pointerLoaded ? castTo(BYTE_PTR, x) : x);
  /** An integer operand with every untyped global word it adds or subtracts made a word as well:
   *  bare, `a0 + g` is pointer arithmetic under a pointer declaration of g. Other operators reject
   *  a pointer operand, and a load or a cast types its own value. */
  const untypedWords = (x: Role): Role =>
    untypedWord(x)
      ? globalWord(x)
      : x.k === 'sum' && (x.op === '+' || x.op === '-')
        ? sumOf(x.op, untypedWords(x.l), untypedWords(x.r))
        : x;
  /** The integer a byte sum is. Every global it adds bare goes a word with it. A lone global it
   *  subtracts stays the pointer difference, `(u32)((u8 *)g + x - gB)`: the asm's integer under an
   *  integer or a byte-pointer declaration of `gB`, and no C under a wider pointer or array, a
   *  function or a float one, where the word `(u32)(u8 *)gB` would subtract an address. Under a byte
   *  array it subtracts the array's address: globalWord's KNOWN GAP. A difference has one operand
   *  order, so the asm's needs no integer sum.
   *
   *  KNOWN GAP: an integer READER of a byte sum converts a pointer to an integer. The backend casts
   *  it where the reader's type is known (an assignment, a store through a typed slot, a return:
   *  cfamily `legalizePointerWrites`), and a compare against an integer compares it as a `u32`. A
   *  call argument and a global no declaration types keep the pointer, which agbcc and KMC gcc warn
   *  about and CodeWarrior rejects; only a pointer cell's sum passed to a parameter the prototype
   *  declares an integer is converted (l3/ptrcell.ts). The integer sum is no fix: gcc orders a
   *  pointer sum's operands and an integer sum's differently, so the bytes differ. */
  const byteSumAsInt = (x: Role): Role => {
    if (x.k === 'cast' && x.made.restored.any) {
      return x.of;
    }
    if (x.k === 'cast' && x.made.globalBytes.any) {
      return globalWord(x.of);
    }
    if (x.k === 'sum' && x.made.byteSum.any) {
      return x.op === '-' && untypedWord(x.r) ? castTo(T.u(32), x) : sumOf(x.op, byteSumAsInt(x.l), byteSumAsInt(x.r));
    }
    return untypedWords(x);
  };

  /** A side's spelling step (`SideSpell`); `other` is the op's other side. */
  const spell = (s: SideSpell, x: Role, other: Role): Role => {
    switch (s) {
      case 'bytes':
        return castTo(BYTE_PTR, x);
      case 'elements': {
        const t = ctype(other.e) as Extract<IrType, { kind: 'ptr' }>;
        return {
          k: 'literal',
          e: { k: 'const', value: (x.e as Extract<Expr, { k: 'const' }>).value / ptrElemBytes(t.to) },
        };
      }
      case 'word':
        return globalWord(x);
      case 'words':
        return untypedWords(x);
      case 'integer':
        return x.k === 'cast' && x.made.restored.any
          ? x.of
          : ctype(x.e)?.kind === 'ptr'
            ? castTo(T.s(32), x)
            : pointerValue(x)
              ? globalWord(x)
              : x;
      case 'partner':
        return pointerValue(x)
          ? globalWord(x)
          : ctype(x.e)?.kind === 'ptr'
            ? made(x).byteSum.any
              ? byteSumAsInt(x)
              : castTo(T.u(32), x)
            : untypedWords(x);
      case 'asInt':
        return byteSumAsInt(x);
    }
  };

  const sideFacts = (x: Role, other: Role): Record<SideFact, boolean> => {
    const t = ctype(x.e);
    const ot = ctype(other.e);
    const m = made(x);
    const pv = pointerValue(x);
    const es = ot?.kind === 'ptr' ? ptrElemBytes(ot.to) : 0;
    return {
      literal: x.k === 'literal',
      exact: x.k === 'literal' && es > 1 && x.e.value % es === 0,
      pointer: t?.kind === 'ptr',
      wide: t?.kind === 'ptr' && ptrElemBytes(t.to) !== 1,
      pointerValue: pv,
      undeclared: x.k === 'name' && x.facts.mapUndeclared,
      untyped: untypedWord(x),
      constant: m.constant,
      addend: x.e.k === 'bin' && (x.e.op === '+' || x.e.op === '-') && (constantExpr(x.e.l) || constantExpr(x.e.r)),
      address: m.address,
      integer: !m.address && (t?.kind === 'int' || (x.k === 'name' && t === undefined && !pv)),
      restored: m.restored.any,
      byteSum: m.byteSum.any,
      undeclaredByteSum: m.byteSum.undeclared,
      sum: x.k === 'sum' && (x.op === '+' || x.op === '-'),
    };
  };

  /** A side the evaluation-order re-spelling may not move: a rendered pointer, or a global's
   *  value no map declaration types (a `pointerGlobals` name's too) that the IR loads as a pointer,
   *  or as a word into an op the IR types a pointer. Beside an integer the table spells such a
   *  global as its word in an integer sum, `(u32)gPtr + x` or `(u32)(u8 *)gIdx + (u32)(u8 *)gPtr`,
   *  and the IR's operand order is then the asm's where the IR evaluated the right side first: IDO
   *  7.1 compiles `usep(gJ + gP)` after `use(*gP)`, and `use(*(gIdx + gPtr))`, from the integer sum
   *  in that order, where the evaluation order changes the code.
   *
   *  It reads other facts than the table's rows. A pointer global the map declares is moved,
   *  though beside an integer the table spells it as a pointer, `x + (u8 *)gP`: a pointer sum,
   *  whose operand order is the compiler's own (THE INTEGER SUM in the table's doc). */
  const pointerSide = (x: Role, resultPointer: boolean): boolean =>
    ctype(x.e)?.kind === 'ptr' ||
    (x.k === 'name' && x.facts.mapUndeclared && (x.facts.pointerLoaded || (resultPointer && x.facts.wordLoaded)));

  const arith = (d: Op, l0: Expr, r0: Expr, loadPairReversed: boolean): Expr => {
    const op = ARITH_TO_BIN[d.opcode];
    const resultPointer = d.results[0]?.type.kind === 'ptr';
    let l = roleOf(l0);
    let r = roleOf(r0);
    if (loadPairReversed && !pointerSide(l, resultPointer) && !pointerSide(r, resultPointer)) {
      [l, r] = [r, l];
    }
    const addressWord = (x: Role): Role => (x.k === 'address' ? castTo(T.u(32), x) : x);
    l = addressWord(l);
    r = addressWord(r);
    const opClass = op === '+' || op === '-' ? op : op === '&&' || op === '||' ? 'logical' : 'bitwise';
    const lf = sideFacts(l, r);
    const rf = sideFacts(r, l);
    const { row } = ROW_TESTS.find(
      (w) =>
        (w.row.op === opClass || (w.row.op === '±' && (opClass === '+' || opClass === '-'))) &&
        (w.row.when === undefined || compiler[w.row.when] === true) &&
        (w.row.value === undefined || !inlinedAccessBase(d)) &&
        (w.row.resultPointer === undefined || resultPointer) &&
        w.l.every(([f, v]) => lf[f] === v) &&
        w.r.every(([f, v]) => rf[f] === v),
    )!;
    const ls = (row.lSpell ?? []).reduce((x, s) => spell(s, x, r), l);
    const rs = (row.rSpell ?? []).reduce((x, s) => spell(s, x, l), r);
    const sum = sumOf(op, ls, rs);
    const restoreTo =
      row.restore === 'bytes'
        ? BYTE_PTR
        : row.restore === 'left'
          ? ctype(l.e)
          : row.restore === 'right'
            ? ctype(r.e)
            : undefined;
    const out = restoreTo ? castTo(restoreTo, sum) : sum;
    spelled.set(out.e, out);
    return out.e;
  };

  /** Operands `-`/`~` cannot take as spelled: a rendered pointer, a bare `&gSym`, a pointer
   *  global's value. All three are ill-formed C under a unary arithmetic operator — the asm did
   *  32-bit integer math on the address, so that is what gets spelled. */
  const needsIntSpelling = (x: Expr): boolean => {
    const role = roleOf(x);
    return ctype(x)?.kind === 'ptr' || role.k === 'address' || pointerValue(role);
  };

  /** A value assigned into a TEMP THIS PASS DECLARES, spelled so the assignment is legal against
   *  that declaration. Two inhabitants, one argument: the value's type comes from somewhere this
   *  pass does not control, and the temp's comes from here.
   *
   *  `&gSym` assigned to a `T *` local: the address of an AGGREGATE is not a pointer to its
   *  element. `&gArr` is `T (*)[n]`, `&gStruct` is `struct S *`, and neither is assignable to
   *  `T *` — yet the IR's `gaddr` value legitimately has type `T *`, because that is what the asm
   *  loaded. The bare spelling therefore states a type the project's own header contradicts.
   *
   *  It survived because agbcc only WARNS ("assignment from incompatible pointer type") and
   *  computes the right address anyway. That leniency is not something to rely on: the Klonoa
   *  project's own build template treats these as fatal, so the row's emitted C does not build
   *  where its author would put it. The cast is the always-valid spelling — the same fallback
   *  `bareArrayLead` documents for the indexed form — and it is byte-identical, so no benchmark row
   *  moves either way and the rule that decides it is pinned in test/deref-typing.test.ts instead.
   *
   *  The test is whether `&gSym`'s rendered type PROVABLY equals the destination's, not whether the
   *  symbol looks like an aggregate. A SHAPE ENUMERATION MISSES THREE WAYS, each real:
   *  `shape:'pointer'` declares a pointer cell (`void *gSym`, or `struct Tag *gSym` when the pointee
   *  has a declarable layout), so `&gSym` is a pointer-to-pointer either way; a `shape:'scalar'`
   *  whose width differs from the destination's pointee gives `s32 *` for a `u16 *` slot; and a
   *  NAME-ONLY symbol is synthesized as `extern u32 gSym;` (declare.ts), which is `u32 *`. So the
   *  default is to CAST, and the cast is omitted only
   *  where the declared cell type is known and matches exactly. Byte-identical either way, so the
   *  cost of casting one time too many is a redundant `(T *)`, never a wrong address. */
  const intoDeclaredTemp = (name: string, value: Expr): Expr => {
    const t = varType.get(name);
    if (t === undefined) {
      return value;
    }
    // ── pointer values whose type this side of the program does not own ────────────────────────
    // A `gaddr` at least states a type the IR knows. `gSym.pBuf` and a pointer global's own value
    // (pointerValue) state one only the project's header knows, and `ctype` — which types params
    // and locals — reads them as `undefined`, so the test above cannot see them at all. Assigning
    // one bare declares that the temp's type and the project's declaration of that pointer are the
    // same type, which nothing here established: the project's header says
    // `struct Unk_03005284 *` where the recovered temp says `struct Struct0 *`, and `-Werror` makes
    // the mismatch fatal in the tree the source is pasted into. The destination's type is the one
    // this pass DID choose, so unlike the map-declared cells below it can be named exactly rather
    // than defused through `void *`. That holds for an INTEGER temp too, and there the diagnostic
    // is the mirror one, `assignment makes integer from pointer without a cast` — same site, same
    // argument, same `(T)` answer.
    //
    // A value that RENDERS a pointer of another type is the same assignment with its type in plain
    // sight: the arithmetic table spells `(u8 *)gPtr + 3544` and `(u8 *)a0 + 2` for the address
    // alone, and a `u16 *` or `s32 *` temp takes neither without the cast.
    //
    // KNOWN GAP: a global no declaration types, read at offset 0 only, may be declared an ARRAY
    // (`u16 *gArr[4]`, the asm reading `gArr[0]`). Its value spelling is then the array's address,
    // and this cast compiles that wrong value with no diagnostic, where the bare value keeps
    // agbcc's `incompatible pointer type`, fatal under -Werror. The cast is load-bearing all the
    // same: a substitution variation (`/unmerge`) carries the temp's value into the arithmetic it
    // feeds, and bare, that arithmetic scales by the declared pointee. A pun, `*(T *)&gArr`, is no
    // fix: where the declaration is not exactly T it loses gcc's fold of the read (agbcc
    // c-typeck.c), it drops a `volatile` declaration's qualifier, and agbcc's strict aliasing at
    // -O2 moves it past a store through the declared type.
    const vt = ctype(value);
    if (pointerValue(roleOf(value)) || (vt?.kind === 'ptr' && !typeEquals(vt, t))) {
      return { k: 'cast', to: t, e: value };
    }
    if (t.kind !== 'ptr' || value.k !== 'addr') {
      return value;
    }
    // The only provably-redundant case: a NON-VOLATILE scalar cell whose DECLARED type is the
    // destination's pointee, where `&gSym` already denotes exactly `T *`.
    //
    // `scalarCellType` and not `scalarTypeForAccess`: the latter answers what an ACCESS of that
    // width reads and collapses every 4-byte access to `s32`, so it called a `u32` cell equal to an
    // `s32 *` destination and let the incompatible assignment through. And a `volatile` cell makes
    // `&gSym` a `volatile T *`, so omitting the cast would DISCARD the qualifier — the same class of
    // fatal-under-a-strict-build defect this rule exists to remove.
    const si = sym?.info(value.name);
    if (si?.shape === 'scalar' && !si.volatile && isScalarCellSize(si.size)) {
      if (typeEquals(scalarCellType(si.size, si.signed), t.to)) {
        return value;
      }
    }
    return { k: 'cast', to: t, e: value };
  };

  /** A pointer VALUE assigned into a pointer CELL (pointerValue), spelled so the assignment is
   *  legal against ANY pointer declaration of that cell. The arithmetic table renders such a
   *  right-hand side `(u8 *)gS.pBuf + K` — the right ADDRESS in every world, which is the whole
   *  point of it, and a `u8 *` where the declaration says `u16 *`. READING one is fine (C converts
   *  an object pointer freely under a deref, a call argument or a compare); ASSIGNING one is
   *  `warning: assignment from incompatible pointer type`, and this project's own `-Werror`
   *  compiler template makes that FATAL — so a source that scores clean here fails to build in the
   *  tree a user pastes it into, which no score gate can observe.
   *
   *  `void *`, NOT the map's declared pointee: it is the one target assignment-compatible with any
   *  object-pointer declaration, the same "same answer in every world" property the byte
   *  arithmetic exists for. Trusting the map's pointee would put the spelling back in one world. It
   *  costs nothing: agbcc compiles `p = (void *)((u8 *)p + 4)` and the warning-carrying
   *  `p = (u8 *)p + 4` to BYTE-IDENTICAL objects (`-mthumb-interwork -Wimplicit -O2 -fhex-asm
   *  -fprologue-bugfix`), so the fix is invisible to the differ and visible to the compiler.
   *
   *  A project may still declare a cell no map types an INTEGER (`u32 gSym;`), where `(void *)`
   *  makes an integer from a pointer: agbcc warns, CodeWarrior rejects it. The candidate's own world
   *  declares the cell `void *` (l3/symbol-refs.ts), and `/int-cell` (l3/intcell.ts) spells the
   *  integer declaration's source, published only at a byte-exact score. */
  const intoPtrCell = (lval: Expr, value: Expr): Expr => {
    if (!pointerValue(roleOf(lval))) {
      return value;
    }
    const vt = ctype(value);
    // BOTH ways a pointer value reaches here. `ctype` types params and locals, so it sees the
    // table's own `(u8 *)…` and nothing else: a bare `gSym.pBuf` or a pointer global's value —
    // the population this rule exists for — reads `undefined` there. An already-`void *` value is
    // assignable as it stands.
    const isPtr = pointerValue(roleOf(value)) || (vt?.kind === 'ptr' && vt.to.kind !== 'void');
    return isPtr ? pointerCellValue(value) : value;
  };

  return { declaredShape, needsIntSpelling, intoDeclaredTemp, intoPtrCell, arith, roleOf };
}

/** The IR around a value that `holdsPointerWord` and `declaresBytePointer` read. */
export interface PointerWordIr {
  defOf(v: Value): Op | undefined;
  /** a block parameter's in-edge values; undefined for any other value */
  inArgs(v: Value): readonly Value[] | undefined;
  /** the ops that read `v`, a terminator passing it on an edge included */
  usesOf(v: Value): readonly Op[];
}

/** Whether `v` only ever holds the value of a pointer cell a declaration types: a whole-word load
 *  at offset 0 of a global whose declared shape is `'pointer'`, or a block parameter every in-edge
 *  value of which is one.
 *
 *  A temp holding such a value may be declared `u8 *` where the IR types it an integer
 *  (`declaresBytePointer` says when), on a compiler whose integer sum loses the source's
 *  association and whose pointer sum keeps it (`compilerBehaviors.keepsPointerSumAddend`,
 *  structure.ts). Byte arithmetic is the asm's address under every pointer declaration of the
 *  global; a declared pointee would scale it, and `void *` arithmetic is a GNU extension. A global
 *  no declaration types may be an integer cell (`/int-cell`), so it is not one. */
export function holdsPointerWord(
  v: Value,
  ir: Pick<PointerWordIr, 'defOf' | 'inArgs'>,
  declaredShape: (name: string) => SymbolInfo['shape'],
  seen: Set<Value> = new Set(),
): boolean {
  if (seen.has(v)) {
    return true;
  }
  seen.add(v);
  const d = ir.defOf(v);
  if (d !== undefined) {
    const g = d.opcode === 'load' && d.attrs.off === 0 && d.attrs.width === 4 ? ir.defOf(d.operands[0]) : undefined;
    return g?.opcode === 'gaddr' && declaredShape(g.attrs.sym as string) === 'pointer';
  }
  const ins = ir.inArgs(v);
  return ins !== undefined && ins.length > 0 && ins.every((a) => holdsPointerWord(a, ir, declaredShape, seen));
}

/** Whether a temp whose values are `values` is declared `u8 *` where the IR types it an integer.
 *
 *  Every value holds a declared pointer word (`holdsPointerWord`), and one of them is the base of a
 *  sum with a constant addend, `t + (x + K)`, where `x + K` may be merged across arms. There the
 *  integer temp's sum loses the source's association and the byte pointer's keeps it. Without an
 *  addend the two compile alike, so the temp keeps the integer the IR gives it.
 *
 *  A use the byte pointer would print wrong refuses it:
 *  - a sum whose other operand comes first: `x + t` is a pointer sum the gcc family orders pointer
 *    first, the swap of the asm's `x + t` (ARITH_ROWS, THE INTEGER SUM);
 *  - a sum with a global's address or a pointer: `t + gArr` prints the subscript `gArr[t]`, which C
 *    rejects for a pointer index, and two pointers do not add;
 *  - the temp, or a sum it is the base of, as a switch selector or an array index, which C rejects
 *    for a pointer;
 *  - the temp itself as a call argument or a word written to a global. The backend casts a pointer
 *    into a declared integer local or slot, and not into a callee's parameter or a global (cfamily
 *    `legalizePointerWrites`), so the write warns where the integer temp's compiles clean, and the
 *    byte pointer buys such a write nothing. A SUM written there keeps the byte pointer: its
 *    association is the point, and the uncast pointer sum into an integer global is the shape the
 *    map-declared pointer row already prints without a temp. */
export function declaresBytePointer(
  values: readonly Value[],
  ir: PointerWordIr,
  declaredShape: (name: string) => SymbolInfo['shape'],
): boolean {
  const isGlobal = (x: Value): boolean => ir.defOf(x)?.opcode === 'gaddr';
  const intoGlobal = (x: Value, u: Op): boolean =>
    u.opcode === 'store' && u.operands[1] === x && isGlobal(u.operands[0]);
  const integerOnly = (x: Value, u: Op): boolean =>
    u.opcode === 'switch_br' || ((u.opcode === 'aload' || u.opcode === 'astore') && u.operands[1] === x);
  const baseOf = (t: Value, u: Op): boolean => {
    const [l, r] = u.operands;
    return l === t && r !== t && !isGlobal(r) && r.type.kind !== 'ptr';
  };
  const okUse = (t: Value, u: Op): boolean =>
    u.opcode === 'add'
      ? baseOf(t, u) && !ir.usesOf(u.results[0]).some((w) => integerOnly(u.results[0], w))
      : u.opcode !== 'call' && !integerOnly(t, u) && !intoGlobal(t, u);
  // `x + K`, or a merge every in-edge of which passes one
  const hasAddend = (x: Value, path: Set<Value> = new Set()): boolean => {
    const d = ir.defOf(x);
    if (d !== undefined) {
      return (d.opcode === 'add' || d.opcode === 'sub') && d.operands.some((o) => isConstant(o, ir));
    }
    const ins = ir.inArgs(x);
    if (path.has(x) || ins === undefined || ins.length === 0) {
      return false;
    }
    path.add(x);
    return ins.every((a) => hasAddend(a, path));
  };
  return (
    values.every((t) => holdsPointerWord(t, ir, declaredShape) && ir.usesOf(t).every((u) => okUse(t, u))) &&
    values.some((t) => ir.usesOf(t).some((u) => u.opcode === 'add' && hasAddend(u.operands[1])))
  );
}

/** Ops whose value is a constant when every operand's is. */
const CONSTANT_FOLDING = new Set(['shl', 'add', 'sub', 'mul', 'or', 'and', 'xor']);

/** Whether `v` is a constant: a `const`, a fold of constants, or a block parameter every in-edge
 *  of which passes one. A loop back to a parameter is not, as a counter is not. */
function isConstant(v: Value, ir: Pick<PointerWordIr, 'defOf' | 'inArgs'>, path: Set<Value> = new Set()): boolean {
  if (path.has(v)) {
    return false;
  }
  const d = ir.defOf(v);
  if (d?.opcode === 'const') {
    return true;
  }
  const from = d === undefined ? ir.inArgs(v) : CONSTANT_FOLDING.has(d.opcode) ? d.operands : undefined;
  if (from === undefined || from.length === 0) {
    return false;
  }
  path.add(v);
  const all = from.every((x) => isConstant(x, ir, path));
  path.delete(v);
  return all;
}
