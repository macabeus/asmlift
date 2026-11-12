// asmlift — print a function's parameters and locals under names a reader would give them.
//
// WHAT IT RENAMES. A parameter takes the name the function's own declaration gives it
// (`SFn.paramNames`, from proto-context.ts `ownParamNames`): `s16 F(u8 s, s16 x, s16 y);` in the
// context prints `F(u8 s, s16 x, s16 y)` where the lift alone prints `F(u8 a0, u16 a1, s16 a2)`.
//
// A NAME IS NO CODEGEN FACT. No compiler this project serves lays out, allocates or schedules by an
// identifier's spelling: a parameter's home is its position, a local's frame slot is its declaration
// RANK (l3/slotorder.ts), and a rename keeps both. Measured on agbcc (`-O2 -mthumb-interwork`): the
// same function with its parameters and locals renamed, two locals in reverse-alphabetical order
// included, compiled to the identical `.s`. What a rename CAN do is change what a name MEANS, and
// that is what every refusal below is about.
//
// WHY `emit` OWNS IT, as it owns the slot order (l3/slotorder.ts says why at length): every L3 pass
// and every respell variation keeps reading the structurer's names (`a0`, `v3`), several of them by
// position in the declaration list, and the seven `.emit(` call sites all print the same names. Run
// any earlier, a variation that appends a local would mint a name beside a renamed one.
//
// REFUSALS. A new name is printed only where it changes no meaning:
//   1. the declaration's parameters pair one to one with the lifted ones: `ownParamNames` hands
//      names over only where each is one argument word, and the lifted count must equal the
//      declared one (kleod's `sub_0803F68C` is declared with three and lifted with four);
//   2. the name is an identifier no compiler of this project defines as a macro (`RESERVED`);
//   3. the name appears NOWHERE in the function as printed — as a global, a callee, a type, a
//      member, a static, another local or parameter, or a label — so it can neither shadow what
//      the body reads nor be shadowed. Read off the printed text, which holds every identifier the
//      printer spells and nothing it does not, rather than off a walk of the tree that a new node
//      kind could slip past. A name the context declares and the function never mentions may be
//      shadowed: a block-scope name hides a file-scope one only where it is spelled;
//   4. no two renamed variables take one name;
//   5. the emitted dialect is C: the C++ backend binds its own parameter names to the mangled
//      signature (backend/cpp.ts).
import { type Expr, type SFn, type Stmt, mapExprChildren, mapStmtExprs, walkExprs } from './ast';

/** Identifiers a compiler this project serves predefines as macros outside the reserved namespace
 *  (`_` + a capital, or `__`), which a parameter or a local must not be spelled as: the host `cpp`
 *  every candidate goes through defines `linux` and `unix`, and IDO's defines `mips`, `sgi` and the
 *  `LANGUAGE_*` set. */
const RESERVED = new Set([
  'linux',
  'unix',
  'i386',
  'mips',
  'host_mips',
  'sgi',
  'sun',
  'sparc',
  'vax',
  'MIPSEB',
  'MIPSEL',
  'LANGUAGE_C',
  'LANGUAGE_ASSEMBLY',
  'LANGUAGE_FORTRAN',
  'LANGUAGE_PASCAL',
]);

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Whether `name` may be printed as a variable at all, before anything it might collide with. */
function printable(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^_[_A-Z]/.test(name) && !RESERVED.has(name);
}

/** The renames `fn` asks for, old name to new, before the collision check: the declaration's
 *  parameter names where they pair one to one. */
function proposed(fn: SFn): Map<string, string> {
  const out = new Map<string, string>();
  const names = fn.paramNames;
  if (names !== undefined && names.length === fn.params.length) {
    fn.params.forEach((p, k) => {
      if (names[k] !== p.name) {
        out.set(p.name, names[k]);
      }
    });
  }
  return out;
}

/** `fn` with its parameters and locals printed under the names this module gives them, or `fn`
 *  itself where it gives none. `printed` is `fn` as the backend prints it, asked for only where a
 *  rename is proposed: every identifier it spells is one no new name may take. */
export function nameVariables(fn: SFn, printed: () => string): SFn {
  if (fn.dialect === 'c++') {
    return fn;
  }
  const asked = proposed(fn);
  if (asked.size === 0) {
    return fn;
  }
  const spelled = new Set(printed().match(IDENTIFIER) ?? []);
  // a string callee is a name the body spells as a function, whatever it holds
  for (const e of walkExprs(fn.body)) {
    if (e.k === 'call' && typeof e.fn === 'string') {
      spelled.add(e.fn);
    }
  }
  const renames = new Map<string, string>();
  const taken = new Set<string>();
  for (const [from, to] of asked) {
    if (printable(to) && !spelled.has(to) && !taken.has(to)) {
      renames.set(from, to);
      taken.add(to);
    }
  }
  return renames.size === 0 ? fn : renamed(fn, renames);
}

/** `fn` with every variable `renames` names spelled under its new name: its declaration and each
 *  read, write, step and address of it. */
function renamed(fn: SFn, renames: ReadonlyMap<string, string>): SFn {
  const to = (n: string): string => renames.get(n) ?? n;
  const expr = (e: Expr): Expr => {
    const m = mapExprChildren(e, expr);
    return m.k === 'var' || m.k === 'postincr' || m.k === 'addr' ? { ...m, name: to(m.name) } : m;
  };
  const stmt = (s: Stmt): Stmt => {
    const m = mapStmtExprs(s, expr);
    return renameAssigns(m, to);
  };
  return {
    ...fn,
    params: fn.params.map((p) => ({ ...p, name: to(p.name) })),
    locals: fn.locals.map((l) => ({ ...l, name: to(l.name) })),
    body: fn.body.map(stmt),
  };
}

/** `s` with the target of every assignment in it, at any depth, renamed. `mapStmtExprs` maps
 *  expressions only, so the targets are a walk of their own. */
function renameAssigns(s: Stmt, to: (n: string) => string): Stmt {
  const list = (xs: Stmt[]): Stmt[] => xs.map((x) => renameAssigns(x, to));
  switch (s.k) {
    case 'assign':
      return { ...s, name: to(s.name) };
    case 'if':
      return { ...s, then: list(s.then), else: list(s.else) };
    case 'while':
    case 'dowhile':
      return { ...s, body: list(s.body) };
    case 'for':
      return { ...s, init: renameAssigns(s.init, to), inc: renameAssigns(s.inc, to), body: list(s.body) };
    case 'switch':
      return {
        ...s,
        cases: s.cases.map((c) => ({ ...c, body: list(c.body) })),
        ...(s.default ? { default: list(s.default) } : {}),
      };
    case 'store':
    case 'exprstmt':
    case 'return':
    case 'break':
    case 'continue':
    case 'goto':
    case 'caseEndGoto':
      return s;
  }
}
