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
import { type Prototypes, protoArity } from '@asmlift/core/proto';
import { type SymbolMap, symbolsByName } from '@asmlift/core/symbols';

/** A label DEFINED in this asm — `foo:` at the start of a line. */
const LABEL_DEF = /^\s*([A-Za-z_.$][\w.$]*)\s*:/;
/** The prefixes that sit in front of a mnemonic in the two dump formats this CLI also accepts:
 *  a pret-style `/* addr bytes *​/` block comment, and objdump's `  8004b60:\tf7ff fffe \t`. */
const PREFIX = /\/\*[\s\S]*?\*\//g;
const OBJDUMP_PREFIX = /^\s*[0-9a-fA-F]+:\s+(?:[0-9a-fA-F]{2,8} )*\s*/;
/** A call and its target. Every backend's call mnemonic, and both operand spellings: a bare
 *  symbol (`bl foo`, hand-written and compiler `.s`) and objdump's `8004b50 <foo>`. */
const CALL = /^\s*(?:bl|blx|jal|bctrl|bctrlx)\s+(?:[^<]*<([^>+]+)>|([A-Za-z_.$][\w.$]*))\s*(?:@|#|;|\/\/|$)/;

/** The names this asm CALLS, in first-appearance order.
 *
 *  A `bl` whose target is a label defined in the same asm is NOT a call: agbcc emits `bl` as an
 *  intra-function long branch (one klonoa function is 28 KB of it), and treating those targets as
 *  callees would bury the real ones. The function's own name is dropped for the same reason —
 *  a recursive call needs no external arity. */
export function calleeNames(asm: string, self?: string): string[] {
  const defined = new Set<string>();
  for (const line of asm.split('\n')) {
    const m = LABEL_DEF.exec(line);
    if (m) {
      defined.add(m[1]);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of asm.split('\n')) {
    const m = CALL.exec(line.replace(PREFIX, ' ').replace(OBJDUMP_PREFIX, ' '));
    const target = m?.[1] ?? m?.[2];
    if (!target || defined.has(target) || target === self || seen.has(target)) {
      continue;
    }
    seen.add(target);
    out.push(target);
  }
  return out;
}

/** Of those callees, the ones whose arity this run had to GUESS: no `--proto` entry with a
 *  readable `params`, and no signature in the project's own DWARF either. `protoArity` is the
 *  same reader the frontend uses, so a mistyped `params: "2"` counts as guessed here exactly as
 *  it does there. */
export function guessedArityCallees(asm: string, self: string, prototypes?: Prototypes, symbols?: SymbolMap): string[] {
  const declared = symbols ? symbolsByName(symbols) : undefined;
  return calleeNames(asm, self).filter(
    (n) => protoArity(prototypes?.[n]) === undefined && declared?.get(n)?.signature === undefined,
  );
}

/** The one stderr line, or '' when every callee's arity was declared. */
export function guessedArityNote(asm: string, self: string, prototypes?: Prototypes, symbols?: SymbolMap): string {
  const guessed = guessedArityCallees(asm, self, prototypes, symbols);
  return guessed.length === 0
    ? ''
    : `asmlift: [proto] ${guessed.length} callee(s) have no declared arity, guessed from the argument registers: ` +
        `${guessed.join(', ')} — pass --proto '{"${guessed[0]}":{"params":N}}' if a guess is wrong\n`;
}
