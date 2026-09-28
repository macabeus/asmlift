// A real row's callee prototypes: the declarations in the vendored context its candidates are
// compiled against (core `prototypesFromContext`), under the manifest's own `proto`, which wins per
// symbol. The context is the same one every candidate compiles in and m2c reads its signatures
// from, so asmlift lifts each call at the arity the compiler will check it against.
import type { Prototypes } from '@asmlift/core/proto';
import { prototypesFromContext } from '@asmlift/core/proto-context';

/** parsed contexts, keyed by dialect and text: the rows of one unit share a context */
const parsed = new Map<string, Prototypes>();

/** The row's prototype table. The function's OWN declaration is left out: the symbol map is read as
 *  if the function were still undecompiled (`asIfUndecompiled`), and a header's signature for it is
 *  that kind of fact — what the manifest states about it is kept. */
export function rowPrototypes(
  manifest: Prototypes | undefined,
  ctxI: string,
  language: 'c' | 'c++',
  sym: string,
): Prototypes | undefined {
  if (ctxI === '') {
    return manifest;
  }
  const key = `${language}\n${ctxI}`;
  let derived = parsed.get(key);
  if (derived === undefined) {
    derived = prototypesFromContext(ctxI, language);
    parsed.set(key, derived);
  }
  const { [sym]: _own, ...callees } = derived;
  const merged = { ...callees, ...manifest };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The entries a lift of `asm` can look up — the row's own symbol and every symbol the assembly
 *  names — which is what a row publishes and its reproduction script passes as `--proto`. */
export function referencedPrototypes(proto: Prototypes | undefined, asm: string, sym: string): Prototypes | undefined {
  if (proto === undefined) {
    return undefined;
  }
  const named = new Set(asm.match(/[A-Za-z_.$][\w.$]*/g) ?? []);
  const out: Prototypes = {};
  for (const [name, p] of Object.entries(proto)) {
    if (name === sym || named.has(name)) {
      out[name] = p;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
