// asmlift — what a callee whose body is in the same input can read of its arguments.
//
// A callee nobody declared is called at a guessed arity (frontend/call-plan.ts, `fallbackArgc`),
// and on most ABIs `g()` and `g(x)` compile to the same caller bytes whenever x is already in the
// first argument register — so the caller cannot decide it. Where the callee's own body is in the
// input, the body can: an argument it never reads is no argument it can tell from a missing one.
// That answers only a question about a register at or past what the body reads (frontend/ssa.ts
// `fallbackArgc`'s `bound`, and the dispatch pass-through gate in frontend/call-plan.ts). It never
// caps what the caller passes: a source call hands an unused parameter, or a K&R call extra
// arguments, all the same, and a register below the bound may be read.
//
// THE BOUND IS A LIFT OF THE CALLEE, NOT ITS LIFTED SIGNATURE. A callee's own lifted parameters
// rest on the same guess one level down: a forwarding thunk (`push {lr}; bl g; pop {r1}; bx r1`)
// lifts as `thk(void)` while g is undeclared, though it hands g every argument register it got. So
// every call inside the callee whose arity nothing lays out is taken at every argument register
// that may still hold the callee's own incoming value there (`LiftOptions.entryReadCalls`), and
// only then are the callee's entry parameters counted: an argument register or incoming stack word
// the body reads becomes one, and the frontend mints every argument slot below the highest one read
// (frontend/ssa.ts `mintArgSlotHoles`). That count is an UPPER bound on the argument words the
// callee reads. A register an earlier call destroyed on every path is not taken: it holds none of
// the callee's arguments, and a read of it would only make the lift refuse (`push {lr}; mov r0-r3,
// #0; bl g; bl h` lost its bound so, while it reads none).
//
// It answers nothing where:
//   - the callee is the function being lifted (its own declaration is a different question);
//   - the input defines no label of that name: a `name:` line, an objdump `<name>:` header or a
//     `glabel name` (the Thumb frontend lifts a text with no such label whole, as one function, so a
//     lift alone does not say the callee is here);
//   - the input marks the callee `.weak`, which another definition may replace at link time;
//   - the callee does not lift, inside or outside the input (a lift that fails proves nothing);
//   - the callee makes a call through a register, whose arity nothing here can force;
//   - the callee's entry declares a struct or union return: one handed back through memory takes a
//     hidden pointer the lift reads as no entry parameter, so its count is one argument word short
//     (`struct Big mk(x)` reads r0 and r1 and lifts one parameter);
//   - the callee takes a floating-point parameter: the count is of PARAMETERS, and the callers ask
//     it as an argument-register INDEX. One per word holds only where every parameter is a word in
//     its own register: o32 passes a leading double in $f12, which shadows a0 and a1, so
//     `int hdx(double d, int x)` lifts two parameters and reads x from a2, index 2.
// KNOWN GAP: an objdump listing (MIPS, PowerPC) shows no symbol binding, so a weak definition there
// is read as the one the link keeps. A weak copy of one inline definition is that definition; a weak
// default some other object overrides is not, and no row here has one.
import type { Fn } from '../ir/core';
import {
  type FnProto,
  type Prototypes,
  calleeDeclaration,
  declaredCallArgs,
  declaresAggregateReturn,
  declaresParams,
} from '../proto';
import { helperPrototypes } from '../runtime-helpers';
import type { TargetDescription } from '../target';

/** The argument words callee `callee`'s own body can read at most, or `undefined` where its body
 *  proves nothing (frontend/frontend.ts `LiftOptions.calleeBodyBound`). */
export type CalleeBodyBound = (callee: string) => number | undefined;

/** Whether a call to a callee with entry `entry` asks its body at all, where nothing lays the call
 *  out: only where the entry states no parameter list. A list nothing can size, or a variadic one,
 *  still states parameters the call must be handed. */
export function asksCalleeBody(entry: FnProto | undefined): boolean {
  return !declaresParams(entry) && entry?.variadicParams === undefined;
}

/** The bound, read off each callee's body as a call to it is first lowered and kept for the rest.
 *  `lift` lifts one function of the same input under a table, with no bound of its own: one level
 *  of bodies is read, never the callee's callees'. */
export function calleeBodyBounds(
  self: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes,
  lift: (callee: string, table: Prototypes, entryReadCalls: ReadonlySet<string>) => Fn,
): CalleeBodyBound {
  const memo = new Map<string, number | undefined>();
  return (callee) => {
    if (!memo.has(callee)) {
      memo.set(callee, bodyBound(self, callee, asm, target, prototypes, lift));
    }
    return memo.get(callee);
  };
}

/** Every name a `.weak` directive marks, in each spelling GNU as reads: one name or a comma-separated
 *  list (`.weak other, cb`), with a comment after it (`@` on ARM, `#` on MIPS and PowerPC). */
function weakNames(asm: string): Set<string> {
  const out = new Set<string>();
  for (const m of asm.matchAll(/^\s*\.weak\s+([^\n@#;]*)/gm)) {
    m[1]
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '')
      .forEach((n) => out.add(n));
  }
  return out;
}

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What a callee's entry says of its return, and nothing of its parameters or of its own context
 *  bound: those are what is being measured. */
const returnOnly = (p: FnProto | undefined): FnProto => {
  const out: FnProto = {};
  if (p?.returnsVoid !== undefined) {
    out.returnsVoid = p.returnsVoid;
  }
  if (p?.returns !== undefined) {
    out.returns = p.returns;
  }
  if (p?.returnLayout !== undefined) {
    out.returnLayout = p.returnLayout;
  }
  return out;
};

function bodyBound(
  self: string,
  callee: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes,
  lift: (callee: string, table: Prototypes, entryReadCalls: ReadonlySet<string>) => Fn,
): number | undefined {
  const name = escaped(callee);
  const defined = new RegExp(`^(?:\\s*${name}\\s*:|[0-9a-fA-F]+ <${name}>:|\\s*glabel\\s+${name}\\s*$)`, 'm');
  if (
    callee === self ||
    !defined.test(asm) ||
    weakNames(asm).has(callee) ||
    declaresAggregateReturn(Object.hasOwn(prototypes, callee) ? prototypes[callee] : undefined)
  ) {
    return undefined;
  }
  const helpers = helperPrototypes(target);
  const table: Prototypes = { ...prototypes, [callee]: returnOnly(prototypes[callee]) };
  const forced = new Set<string>();
  // Each round forces the calls the last lift guessed and lifts again; a round that forces nothing
  // new is the answer. The forced set only grows, so this ends.
  for (;;) {
    let fn: Fn;
    try {
      fn = lift(callee, table, forced);
    } catch {
      return undefined;
    }
    const guessed = new Set<string>();
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        if (op.opcode !== 'call') {
          continue;
        }
        const at = op.attrs.target;
        if (typeof at !== 'string') {
          return undefined;
        }
        if (!forced.has(at) && declaredCallArgs(calleeDeclaration(at, table, helpers), target) === undefined) {
          guessed.add(at);
        }
      }
    }
    if (guessed.size === 0) {
      const { params } = fn.blocks[0];
      return params.some((p) => p.type.kind === 'float') ? undefined : params.length;
    }
    // an entry whose parameter list nothing can lay out (an unsizable or variadic one) is dropped
    // too, so the call is taken at the incoming values rather than at what the guess counted
    for (const g of guessed) {
      forced.add(g);
      table[g] = returnOnly(Object.hasOwn(table, g) ? table[g] : undefined);
    }
  }
}
