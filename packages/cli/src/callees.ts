// asmlift — which callees this run has NO declared arity for.
//
// A callee still written in assembly carries no signature anywhere, so the frontend falls back to
// counting contiguous argument registers — and that guess is silent. `LoadBGTilemapData` scored
// 578 without `--proto '{"thunk_HeapFree":{"params":1}}'` against a 547 baseline: a plausible
// number, comparable to nothing, and indistinguishable in the log from a correct one. Over one
// working session 24 of the 79 ranked runs of that function were launched without the flag.
//
// So the CLI says which names it had to guess for. Purely textual: the asm the run was given, the
// `--proto` table it parsed, and the project ELF's callee signatures — no pipeline stage involved,
// and nothing here can change what is emitted.
import { byValueCallArgs, byValueRefusal } from '@asmlift/core/aggregate';
import type { Reloc } from '@asmlift/core/frontend/asmdata';
import { type CalleeBodyBound, asksCalleeBody } from '@asmlift/core/frontend/callee-body';
import { type Prototypes, calleeDeclaration, declaredCallArgs, variadicRefusal } from '@asmlift/core/proto';
import { helperPrototypes } from '@asmlift/core/runtime-helpers';
import { type SymbolMap, symbolsByName } from '@asmlift/core/symbols';
import type { TargetDescription } from '@asmlift/core/target';

/** A label DEFINED in this asm — `foo:` at the start of a line. */
const LABEL_DEF = /^\s*([A-Za-z_.$][\w.$]*)\s*:/;
/** The prefixes that sit in front of a mnemonic in the two dump formats this CLI also accepts:
 *  a pret-style `/* addr bytes *​/` block comment, and objdump's `  8004b60:\tf7ff fffe \t`. */
const PREFIX = /\/\*[\s\S]*?\*\//g;
const OBJDUMP_PREFIX = /^\s*[0-9a-fA-F]+:\s+(?:[0-9a-fA-F]{2,8} )*\s*/;
/** A DIRECT call and its target — the mnemonics that NAME the function they call, in both
 *  operand spellings: a bare symbol (`bl foo`, hand-written and compiler `.s`) and objdump's
 *  `8004b50 <foo>`.
 *
 *  Indirect calls are deliberately absent, because there is nothing here for them to report: PPC's
 *  `bctrl` branches to CTR and MIPS' `jalr` to a register, so the callee is not in the text and no
 *  arity can be asked for by name. */
const CALL = /^\s*(?:bl|blx|jal)\s+(?:[^<]*<([^>+]+)>|([A-Za-z_.$][\w.$]*))\s*(?:@|#|;|\/\/|$)/;

/** The names this asm CALLS, in first-appearance order.
 *
 *  A `bl` whose target is a label defined in the same asm is NOT a call: agbcc emits `bl` as an
 *  intra-function long branch (one klonoa function is 28 KB of it), and treating those targets as
 *  callees would bury the real ones. The function's own name is dropped for the same reason —
 *  a recursive call needs no external arity. */
export function calleeNames(asm: string, self?: string, relocs?: readonly Reloc[]): string[] {
  const all = asm.split('\n');
  const [from, to] = ownRange(all, self);
  const defined = new Set<string>();
  for (const line of all.slice(from, to)) {
    const m = LABEL_DEF.exec(line);
    if (m) {
      defined.add(m[1]);
    }
  }
  // The relocation against a call names its callee: the `<name>` objdump puts in the operand is
  // the address the unrelocated field holds — an O32 `jal 0` reads as the symbol at .text+0 — and
  // only a relocation against a section (`.text`, a static callee) leaves that one right. `objdump
  // -dr` prints it under the call (PowerPC); the MIPS dump has none, and the object's side table
  // (`relocs`) does, by section and offset.
  const relocAt = new Map((relocs ?? []).map((r) => [`${r.section} ${r.offset}`, r.sym]));
  let section: string | undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [i, line] of all.entries()) {
    section = SECTION.exec(line)?.[1] ?? section;
    if (i < from || i >= to) {
      continue;
    }
    const op = line.replace(PREFIX, ' ').replace(OBJDUMP_PREFIX, ' ');
    const m = CALL.exec(op);
    const at = /^\s*([0-9a-fA-F]+):/.exec(line)?.[1];
    const reloc = !CALL_OP.test(op)
      ? undefined
      : (RELOC.exec(all[i + 1] ?? '')?.[1] ??
        (at !== undefined && section !== undefined ? relocAt.get(`${section} ${parseInt(at, 16)}`) : undefined));
    const target = reloc !== undefined && !reloc.startsWith('.') ? reloc : (m?.[1] ?? m?.[2]);
    if (!target || defined.has(target) || target === self || seen.has(target)) {
      continue;
    }
    seen.add(target);
    out.push(target);
  }
  return out;
}

/** A direct call's mnemonic, whatever its operand spells. */
const CALL_OP = /^\s*(?:bl|blx|jal)\s/;
/** A relocation line of `objdump -dr`, and the symbol it is against. */
const RELOC = /^\s*[0-9a-fA-F]+:\s+R_\w+\s+([A-Za-z_.$][\w.$]*)(?:[+-]0x[0-9a-fA-F]+)?\s*$/;
/** An `objdump -d` function header, `00000030 <rt1>:`, and a section's. */
const OBJDUMP_HEADER = /^[0-9a-fA-F]+ <([^>]+)>:\s*$/;
const SECTION = /^Disassembly of section (\S+):\s*$/;

/** The lines of `self` in an objdump of a whole object — from its header to the next — where the
 *  dump has one; otherwise all of them. An object's disassembly holds every function in it, and a
 *  call another one makes is no callee of this lift. */
function ownRange(lines: readonly string[], self: string | undefined): [number, number] {
  const start = self === undefined ? -1 : lines.findIndex((l) => OBJDUMP_HEADER.exec(l)?.[1] === self);
  if (start < 0) {
    return [0, lines.length];
  }
  const end = lines.findIndex((l, i) => i > start && (OBJDUMP_HEADER.test(l) || SECTION.test(l)));
  return [start, end < 0 ? lines.length : end];
}

/** Of those callees, the ones whose arity this run had to GUESS: no `--proto` entry this can
 *  convert into argument registers, no signature in the target's runtime table or the C standard's
 *  behind it, and no signature in the project's own DWARF either.
 *
 *  `declaredCallArgs` IS THE READER, AND IT IS THE ONE THE FRONTEND ACTS ON, asked about the same
 *  target. Three declarations state nothing it can lay out — `params` omitted, `params` mistyped
 *  (`"2"`), and a typed list holding a spelling asmlift cannot size — and all three leave the
 *  frontend at its own arg-register scan. A reader that answered "declared" for the third would stay silent about the
 *  one case where the user HAS a header, believes it was read, and is looking at a guess.
 *
 *  The frontend's TIER decision asks a different question with a different reader
 *  (`declaresParams`): whether the project re-declared the callee at all, which decides if a
 *  runtime-helper or C-standard signature may answer for it. A list too vague to lay out is still
 *  a re-declaration.
 *
 *  A list with a struct passed by value is laid out by `byValueCallArgs` instead, where the
 *  declaration lays the struct out and the target passes it in argument words; where it does not
 *  (`byValueRefusal`), the frontend refuses the call rather than guess, so that callee is not
 *  guessed either — and a `params: N` count, which would read the struct as N separate words, is
 *  not advice to give for it. A variadic declaration whose fixed parameters are not all words
 *  (`variadicRefusal`) refuses the same way, and a count would only state its arity for one call. */
export function guessedArityCallees(
  asm: string,
  self: string,
  target: TargetDescription,
  prototypes?: Prototypes,
  symbols?: SymbolMap,
  relocs?: readonly Reloc[],
  bodyBound?: CalleeBodyBound,
): string[] {
  const declared = symbols ? symbolsByName(symbols) : undefined;
  const asked = askedBound(prototypes, bodyBound);
  const helpers = helperPrototypes(target);
  return calleeNames(asm, self, relocs).filter((n) => {
    // read at the declaration the lowering reads it at: a compiler's runtime helper (`__divsi3`,
    // `__addsf3`) and a C-standard function are signed by their table behind the project's own
    const at = calleeDeclaration(n, prototypes ?? {}, helpers);
    return (
      declaredCallArgs(at, target) === undefined &&
      byValueCallArgs(at, target) === undefined &&
      byValueRefusal(at, target) === undefined &&
      variadicRefusal(prototypes !== undefined && Object.hasOwn(prototypes, n) ? prototypes[n] : undefined) ===
        undefined &&
      declared?.get(n)?.signature === undefined &&
      asked(n) !== 0
    );
  });
}

/** The body bound as the lowering asks it (`asksCalleeBody`): only of a callee whose entry states no
 *  parameter list. Asked of every guessed callee, the note said a callee declared `(Mystery)` was
 *  called with no argument while the run emitted `rnd(5)`. */
function askedBound(prototypes: Prototypes | undefined, bodyBound: CalleeBodyBound | undefined) {
  return (n: string): number | undefined =>
    bodyBound !== undefined &&
    asksCalleeBody(prototypes !== undefined && Object.hasOwn(prototypes, n) ? prototypes[n] : undefined)
      ? bodyBound(n)
      : undefined;
}

/** The one stderr line, or '' when every callee's arity was declared. */
export function guessedArityNote(
  asm: string,
  self: string,
  target: TargetDescription,
  prototypes?: Prototypes,
  symbols?: SymbolMap,
  relocs?: readonly Reloc[],
  bodyBound?: CalleeBodyBound,
): string {
  const guessed = guessedArityCallees(asm, self, target, prototypes, symbols, relocs, bodyBound);
  const asked = askedBound(prototypes, bodyBound);
  // the callees the lowering called with no argument because their own body here reads none
  const unread = bodyBound
    ? guessedArityCallees(asm, self, target, prototypes, symbols, relocs).filter((n) => asked(n) === 0)
    : [];
  const named = guessed.map((n) => {
    const k = asked(n);
    return k === undefined || k >= target.argRegs.length ? n : `${n} (at most ${k}: its body here reads no more)`;
  });
  return (
    (guessed.length === 0
      ? ''
      : `asmlift: [proto] ${guessed.length} callee(s) have no declared arity, guessed from the argument registers: ` +
        `${named.join(', ')} — pass --proto '{"${guessed[0]}":{"params":N}}' if a guess is wrong\n`) +
    (unread.length === 0
      ? ''
      : `asmlift: [proto] ${unread.length} callee(s) have no declared arity and are called with no argument, ` +
        `as their own body in this input reads none: ${unread.join(', ')}\n`)
  );
}
