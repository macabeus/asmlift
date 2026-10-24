// asmlift — what a callee whose body is in the same input can read of its arguments.
//
// A callee nobody declared is called at a guessed arity (frontend/call-plan.ts, `fallbackArgc`),
// and on most ABIs `g()` and `g(x)` compile to the same caller bytes whenever x is already in the
// first argument register — so the caller cannot decide it. Where the callee's own body is in the
// input, the body can: an argument it never reads is no argument it can tell from a missing one.
//
// THE BOUND IS A LIFT OF THE CALLEE, NOT ITS LIFTED SIGNATURE. A callee's own lifted parameters
// rest on the same guess one level down: a forwarding thunk (`push {lr}; bl g; pop {r1}; bx r1`)
// lifts as `thk(void)` while g is undeclared, though it hands g every argument register it got. So
// every call inside the callee whose arity nothing lays out is taken at the full argument-register
// count, which reads every argument register at the call, and only then are the callee's entry
// parameters counted: an argument register or incoming stack word the body reads becomes one, and
// the frontend mints every argument slot below the highest one read (frontend/ssa.ts
// `mintArgSlotHoles`). That count is an UPPER bound on the argument words the callee reads.
//
// It answers nothing where:
//   - the callee is the function being lifted (its own declaration is a different question);
//   - the input marks the callee `.weak`, which another definition may replace at link time;
//   - the callee does not lift, inside or outside the input (a lift that fails proves nothing);
//   - the callee makes a call through a register, whose arity nothing here can force.
// KNOWN GAP: an objdump listing (MIPS, PowerPC) shows no symbol binding, so a weak definition there
// is read as the one the link keeps. A weak copy of one inline definition is that definition; a weak
// default some other object overrides is not, and no row here has one.
import type { Fn } from '../ir/core';
import { type FnProto, type Prototypes, calleeDeclaration, declaredCallArgs } from '../proto';
import { helperPrototypes } from '../runtime-helpers';
import type { TargetDescription } from '../target';

/** The argument words callee `callee`'s own body can read at most, or `undefined` where its body
 *  proves nothing (frontend/frontend.ts `LiftOptions.calleeBodyBound`). */
export type CalleeBodyBound = (callee: string) => number | undefined;

/** The bound, read off each callee's body as a call to it is first lowered and kept for the rest.
 *  `lift` lifts one function of the same input under a table, with no bound of its own: one level
 *  of bodies is read, never the callee's callees'. */
export function calleeBodyBounds(
  self: string,
  asm: string,
  target: TargetDescription,
  prototypes: Prototypes,
  lift: (callee: string, table: Prototypes) => Fn,
): CalleeBodyBound {
  const memo = new Map<string, number | undefined>();
  return (callee) => {
    if (!memo.has(callee)) {
      memo.set(callee, bodyBound(self, callee, asm, target, prototypes, lift));
    }
    return memo.get(callee);
  };
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
  lift: (callee: string, table: Prototypes) => Fn,
): number | undefined {
  if (callee === self || new RegExp(`^\\s*\\.weak\\s+${escaped(callee)}\\s*$`, 'm').test(asm)) {
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
      fn = lift(callee, table);
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
      return fn.blocks[0].params.length;
    }
    for (const g of guessed) {
      forced.add(g);
      table[g] = { ...returnOnly(Object.hasOwn(table, g) ? table[g] : undefined), params: target.argRegs.length };
    }
  }
}
