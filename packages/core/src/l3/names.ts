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
//   5. in a unit compiled as C++ (`SFn.dialect`), the name is no C++ keyword (`CXX_KEYWORDS`): a C
//      header may name a parameter `new` or `class`. A C++ unit prints through the C backend
//      too, so it takes the role names like any other; the receiver and the mangled signature
//      are refused upstream (`ownParamNames`: a mangled name or an implicit argument names none).
//
// Both C-family backends apply these names (backend/cfamily.ts `emitCFamily`). The C++ backend
// names the parameters from its own spec, so it asks only for the locals' role names. The Pascal
// backend applies none: its identifiers are case-insensitive, so the collision check over the
// printed text would not hold.
import { type Expr, type SFn, type Stmt, exprChildren, renameVariables, stmtExprs, stmtLists, walkExprs } from './ast';

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

/** The keywords C++ reserves that C does not: a name C accepts and a C++ unit cannot declare. */
const CXX_KEYWORDS = new Set([
  'and',
  'and_eq',
  'asm',
  'bitand',
  'bitor',
  'bool',
  'catch',
  'class',
  'compl',
  'const_cast',
  'delete',
  'dynamic_cast',
  'explicit',
  'export',
  'false',
  'friend',
  'inline',
  'mutable',
  'namespace',
  'new',
  'not',
  'not_eq',
  'operator',
  'or',
  'or_eq',
  'private',
  'protected',
  'public',
  'reinterpret_cast',
  'static_cast',
  'template',
  'this',
  'throw',
  'true',
  'try',
  'typeid',
  'typename',
  'using',
  'virtual',
  'wchar_t',
  'xor',
  'xor_eq',
]);

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Whether `name` may be printed as a variable of `fn` at all, before anything it might collide
 *  with. */
function printable(name: string, fn: SFn): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !/^_[_A-Z]/.test(name) &&
    !RESERVED.has(name) &&
    (fn.dialect !== 'c++' || !CXX_KEYWORDS.has(name))
  );
}

/** One rename `fn` asks for, before the collision check: the variable, and the names it may take
 *  in order of preference, the first one free winning. */
interface Proposal {
  from: string;
  to: readonly string[];
}

/** The counter names, by how many counted loops enclose the loop: `i`, then `j`, then `k`. */
const COUNTERS = ['i', 'j', 'k'] as const;

/** The renames `fn` asks for: the declaration's parameter names where they pair one to one, then
 *  each loop counter's name, then `result`. */
function proposed(fn: SFn): Proposal[] {
  const out: Proposal[] = [];
  const names = fn.paramNames;
  if (names !== undefined && names.length === fn.params.length) {
    fn.params.forEach((p, k) => {
      if (names[k] !== p.name) {
        out.push({ from: p.name, to: [names[k]] });
      }
    });
  }
  const roles = fn.roleNames ? roleNames(fn) : { counters: new Map<string, readonly string[]>() };
  for (const [from, to] of roles.counters) {
    out.push({ from, to });
  }
  if (roles.result !== undefined) {
    out.push({ from: roles.result, to: ['result'] });
  }
  return out;
}

/** `fn` with its parameters and locals printed under the names this module gives them, or `fn`
 *  itself where it gives none. `printed` is `fn` as the backend prints it, asked for only where a
 *  rename is proposed: every identifier it spells is one no new name may take. */
export function nameVariables(fn: SFn, printed: () => string): SFn {
  const asked = proposed(fn);
  if (asked.length === 0) {
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
  for (const { from, to } of asked) {
    const free = to.find((n) => printable(n, fn) && !spelled.has(n) && !taken.has(n));
    if (free !== undefined) {
      renames.set(from, free);
      taken.add(free);
    }
  }
  return renames.size === 0 ? fn : renamed(fn, renames);
}

// ── role names ───────────────────────────────────────────────────────────────────────────────────
//
// A COUNTER is a local a loop's condition reads whose every write is either ONE initialization
// ahead of the loop — the `for`'s own init, or an assignment earlier in the statement list the loop
// sits in — or a step of one inside the loop's own body, not inside a loop nested in it:
// `v = v + 1`, `v = v - 1`, `v = v + -1` (the decrement mwcc, kmc and IDO lifts print; under a
// cast to its own type too), `v++` or `v--`. A counter is an INTEGER: a pointer stepped by one
// is a cursor walking memory (`while (*p != 255) { …; p = p + 1; }`), not an index. A local written
// anywhere else, or initialized twice — the coalescer's one carrier for two loops' counters, which
// is a variable with two roles — is no counter. A loop takes the first counter its condition
// reads, named `i` where no counted loop encloses it, `j` under one, `k` under two; one that cannot
// have that name (taken, or spelled) takes the next free one, and a fourth level takes none.
//
// THE RESULT is the one local every `return` returns, read bare, the last statement of the
// function being one of those returns — and no counter or cursor, which would give it two roles:
// not a loop's counter, not a pointer stepped by one inside a loop (a cursor returned where it
// stopped, ac-decomp's `mMck_search_sep`), and not an integer stepped by one inside a loop whose
// condition reads it. An integer stepped in a loop that does not test it (a tally) stays one. No
// local is the result of a function whose own declaration returns void (`SFn.declaredVoid`):
// kleod's `void EepromTimerIntr(void);` lifts returning r0's leftover, and `result` would call that
// leftover the function's value.
//
// Both are print-only like the parameter names: a local's name is no codegen fact, and the
// collision check is the same.

type Loop = Extract<Stmt, { k: 'while' | 'dowhile' | 'for' }>;

/** One write of a local: where it sits, and what it is. */
interface Write {
  /** the loops enclosing it, outermost first (a `for`'s own init is outside its loop) */
  loops: readonly Loop[];
  /** a step of the local by one */
  step: boolean;
  /** the statement list and index holding it, for an `assign` statement */
  at?: { list: readonly Stmt[]; index: number };
  /** the `for` whose init it is */
  initOf?: Loop;
}

/** The locals a role name may be given: scalar locals with no frame object, no initializer and no
 *  qualifier, whose address nothing takes. */
function candidates(fn: SFn): Set<string> {
  const out = new Set(
    fn.locals
      .filter(
        (l) =>
          (l.type.kind === 'int' || l.type.kind === 'ptr') &&
          l.frame === undefined &&
          l.uninit === undefined &&
          l.volatile === undefined &&
          l.pointeeVolatile === undefined &&
          l.init === undefined,
      )
      .map((l) => l.name),
  );
  for (const e of walkExprs(fn.body)) {
    if (e.k === 'addr') {
      out.delete(e.name);
    }
  }
  return out;
}

/** Whether `value`, assigned to `name`, steps it by one: `name ± 1`, `name ± -1` or `±1 + name`,
 *  under any integer cast. */
function stepsByOne(name: string, value: Expr): boolean {
  const e = value.k === 'cast' && value.to.kind === 'int' ? value.e : value;
  if (e.k !== 'bin' || (e.op !== '+' && e.op !== '-')) {
    return false;
  }
  const isVar = (x: Expr) => x.k === 'var' && x.name === name;
  const isOne = (x: Expr) => x.k === 'const' && (x.value === 1 || x.value === -1);
  return (isVar(e.l) && isOne(e.r)) || (e.op === '+' && isOne(e.l) && isVar(e.r));
}

/** The counter and result names `fn` asks for (see above). */
function roleNames(fn: SFn): { counters: Map<string, readonly string[]>; result?: string } {
  const eligible = candidates(fn);
  const counters = new Map<string, readonly string[]>();
  if (eligible.size === 0) {
    return { counters };
  }
  const writes = new Map<string, Write[]>();
  const record = (name: string, w: Write) => {
    if (eligible.has(name)) {
      (writes.get(name) ?? writes.set(name, []).get(name)!).push(w);
    }
  };
  const loopsOrder: { loop: Loop; loops: readonly Loop[] }[] = [];
  const steps = (e: Expr, loops: readonly Loop[]) => {
    const stack = [e];
    while (stack.length > 0) {
      const x = stack.pop()!;
      if (x.k === 'postincr') {
        record(x.name, { loops, step: true });
      }
      stack.push(...exprChildren(x));
    }
  };
  const visit = (list: readonly Stmt[], loops: readonly Loop[]) => {
    list.forEach((s, index) => {
      if (s.k === 'for') {
        // the init runs once, outside the loop; the step runs with the body
        const inner = [...loops, s];
        if (s.init.k === 'assign') {
          record(s.init.name, { loops, step: false, initOf: s });
          steps(s.init.value, loops);
        } else {
          visit([s.init], loops);
        }
        loopsOrder.push({ loop: s, loops });
        steps(s.cond, inner);
        visit([s.inc], inner);
        visit(s.body, inner);
        return;
      }
      if (s.k === 'assign') {
        record(s.name, { loops, step: stepsByOne(s.name, s.value), at: { list, index } });
      }
      for (const e of stmtExprs(s)) {
        steps(e, s.k === 'while' || s.k === 'dowhile' ? [...loops, s] : loops);
      }
      if (s.k === 'while' || s.k === 'dowhile') {
        loopsOrder.push({ loop: s, loops });
        visit(s.body, [...loops, s]);
        return;
      }
      for (const l of stmtLists(s)) {
        visit(l, loops);
      }
    });
  };
  visit(fn.body, []);

  // the locals each loop's condition reads, in the order it reads them — a step there reads its
  // local too (`while (i++ <= n)`)
  const tested = new Map<Loop, string[]>();
  for (const { loop } of loopsOrder) {
    const read: string[] = [];
    for (const e of walkExprs([{ k: 'exprstmt', value: loop.cond }])) {
      if ((e.k === 'var' || e.k === 'postincr') && !read.includes(e.name)) {
        read.push(e.name);
      }
    }
    tested.set(loop, read);
  }
  const integer = new Set(fn.locals.filter((l) => l.type.kind === 'int').map((l) => l.name));
  // which loop each counted local counts, in the order the loops are written
  const counterOf = new Map<Loop, string>();
  for (const { loop } of loopsOrder) {
    const counter = tested
      .get(loop)!
      .find((v) => integer.has(v) && !counters.has(v) && counts(writes.get(v) ?? [], loop));
    if (counter !== undefined) {
      counterOf.set(loop, counter);
      counters.set(counter, []);
    }
  }
  for (const { loop, loops } of loopsOrder) {
    const v = counterOf.get(loop);
    if (v !== undefined) {
      const depth = loops.filter((l) => counterOf.has(l)).length;
      counters.set(v, COUNTERS.slice(depth));
    }
  }
  // a local stepped inside a loop that is a cursor (any pointer) or the loop's own tested index
  const walks = (v: string) =>
    (writes.get(v) ?? []).some((w) => w.step && w.loops.some((l) => !integer.has(v) || tested.get(l)!.includes(v)));
  return { counters, result: resultOf(fn, eligible, (v) => counters.has(v) || walks(v)) };
}

/** Whether `ws`, every write of one local, makes it `loop`'s counter (see above). */
function counts(ws: readonly Write[], loop: Loop): boolean {
  const inside = ws.filter((w) => w.loops.includes(loop));
  const outside = ws.filter((w) => !w.loops.includes(loop));
  if (inside.length === 0 || !inside.every((w) => w.step && w.loops[w.loops.length - 1] === loop)) {
    return false;
  }
  if (outside.length !== 1 || outside[0].step) {
    return false;
  }
  const [init] = outside;
  if (init.initOf !== undefined) {
    return init.initOf === loop;
  }
  // an assignment earlier in the list the loop sits in, no `for` init of its own beside it
  return (
    init.at !== undefined &&
    (loop.k !== 'for' || loop.init.k !== 'assign') &&
    init.at.list.indexOf(loop) > init.at.index
  );
}

/** The local every `return` of `fn` returns, bare, where the last statement is one of them, it
 *  plays no other role (`otherRole`) and the function's own declaration is not void. */
function resultOf(fn: SFn, eligible: ReadonlySet<string>, otherRole: (v: string) => boolean): string | undefined {
  const last = fn.body[fn.body.length - 1];
  if (fn.declaredVoid || last?.k !== 'return' || last.value?.k !== 'var') {
    return undefined;
  }
  const r = last.value.name;
  if (!eligible.has(r) || otherRole(r)) {
    return undefined;
  }
  const visit = (list: readonly Stmt[]): boolean =>
    list.every(
      (s) =>
        (s.k !== 'return' || (s.value?.k === 'var' && s.value.name === r)) &&
        (s.k !== 'for' || visit([s.init, s.inc])) &&
        stmtLists(s).every(visit),
    );
  return visit(fn.body) ? r : undefined;
}

/** `fn` with every variable `renames` names spelled under its new name: its declaration and each
 *  read, write, step and address of it (ast.ts `renameVariables`). */
function renamed(fn: SFn, renames: ReadonlyMap<string, string>): SFn {
  const to = (n: string): string => renames.get(n) ?? n;
  return {
    ...fn,
    params: fn.params.map((p) => ({ ...p, name: to(p.name) })),
    locals: fn.locals.map((l) => ({ ...l, name: to(l.name) })),
    body: renameVariables(fn.body, renames),
  };
}
