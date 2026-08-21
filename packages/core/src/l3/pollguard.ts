// L3 re-spelling lever: an EMPTY bottom-tested loop regrows its own guard.
//
//     do { } while (dma[2] & 0x80000000);   →   if (dma[2] & 0x80000000) { do { } while (…); }
//
// For an empty body the two forms compile to the SAME instructions — gcc collapses the guard
// into the bottom test late (jump optimization), AFTER flow has counted the guard's reads — so
// the choice leaves no instruction trace, only a register-allocation ripple: the extra
// source-level read raises the condition operands' ref counts, which re-orders the allocator's
// priorities for the WHOLE function (the busy-wait's base landing in a low reg vs `ip`). Which
// form the source spelled is unrecoverable from the bytes; both are emitted and the differ
// referees.
//
// SCOPE (decline over approximate): only a `dowhile` with an EMPTY body regrows a guard. For a
// pure condition the wrap is exactly equivalent; for a volatile poll the C-abstract semantics
// gain one read on entry — a distinction the busy-wait discards by construction (it reads until
// a bit clears; the compiler provably emits identical bytes) and the shape real GBA sources
// spell. Declines (null) when no empty do-while exists.
import type { SFn, Stmt } from './ast';

export function pollGuards(sfn: SFn): SFn | null {
  let changed = false;
  const rewrite = (s: Stmt): Stmt => {
    switch (s.k) {
      case 'dowhile':
        if (s.body.length === 0) {
          changed = true;
          return { k: 'if', cond: s.cond, then: [s], else: [] };
        }
        return { ...s, body: s.body.map(rewrite) };
      case 'while':
        return { ...s, body: s.body.map(rewrite) };
      case 'for':
        return { ...s, body: s.body.map(rewrite) };
      case 'if':
        return { ...s, then: s.then.map(rewrite), else: s.else.map(rewrite) };
      case 'switch':
        return {
          ...s,
          cases: s.cases.map((c) => ({ ...c, body: c.body.map(rewrite) })),
          ...(s.default ? { default: s.default.map(rewrite) } : {}),
        };
      default:
        return s;
    }
  };
  const body = sfn.body.map(rewrite);
  return changed ? { ...sfn, body } : null;
}
