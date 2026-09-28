// A real row's callee prototypes: the declarations in the vendored context its candidates are
// compiled against (core `prototypesFromContext`), under the symbol map's signatures and the
// manifest's own `proto`, each of which wins per symbol. The context is the same one every candidate compiles in and m2c reads its signatures
// from, so asmlift lifts each call at the arity the compiler will check it against.
import { type Prototypes, declaredWidth, declaresVoidReturn, spellableType } from '@asmlift/core/proto';
import { contextPrototypesUnder, prototypesFromContext } from '@asmlift/core/proto-context';
import type { SymbolMap } from '@asmlift/core/symbols';

/** parsed contexts, keyed by dialect and vendored file: the rows of one unit share a context */
const parsed = new Map<string, Prototypes>();

/** The row's prototype table. The function's OWN declaration is left out: the symbol map is read as
 *  if the function were still undecompiled (`asIfUndecompiled`), and a header's signature for it is
 *  that kind of fact — what the manifest states about it is kept. */
export function rowPrototypes(
  manifest: Prototypes | undefined,
  { ctxI, ctxFile }: { ctxI: string; ctxFile: string },
  language: 'c' | 'c++',
  sym: string,
  symbols: SymbolMap | undefined,
): Prototypes | undefined {
  if (ctxI === '') {
    return manifest;
  }
  const key = `${language} ${ctxFile}`;
  let derived = parsed.get(key);
  if (derived === undefined) {
    derived = prototypesFromContext(ctxI, language);
    parsed.set(key, derived);
  }
  const { [sym]: _own, ...callees } = contextPrototypesUnder(derived, symbols);
  const merged = { ...callees, ...manifest };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** The entries a lift can look up — the row's own symbol and every symbol `text` (the assembly, and
 *  the object dump that holds its relocations) names — which is what a row publishes and its
 *  reproduction script passes as `--proto`. */
export function referencedPrototypes(proto: Prototypes | undefined, text: string, sym: string): Prototypes | undefined {
  if (proto === undefined) {
    return undefined;
  }
  const named = new Set(text.match(/[A-Za-z_.$][\w.$]*/g) ?? []);
  const out: Prototypes = {};
  for (const [name, p] of Object.entries(proto)) {
    if (name === sym || named.has(name)) {
      out[name] = p;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The callee declarations m2c is given on a row where it is not given the project's context — the
 *  same entries asmlift's lift reads (`referencedPrototypes`), as C m2c's parser reads: every
 *  parameter it can size, a pointer — to data or a function — whose type it cannot spell written
 *  `void *` (m2c reads a
 *  declaration for its signature; its output is compiled against the project's own headers).
 *  An entry with a parameter or a return nothing sizes is left out, and so is a name the row's
 *  context already declares. */
export function m2cDeclarations(proto: Prototypes | undefined, sym: string, ctx: string | undefined): string {
  const lines: string[] = [];
  for (const [name, p] of Object.entries(proto ?? {})) {
    if (name === sym || !Array.isArray(p.params) || (ctx !== undefined && new RegExp(`\\b${name}\\s*\\(`).test(ctx))) {
      continue;
    }
    const ret = declaresVoidReturn(p)
      ? 'void'
      : p.returns !== undefined && spellableType(p.returns)
        ? p.returns
        : undefined;
    const pointer = (t: string): boolean => /\*\s*$/.test(t) || /\(\s*\*\s*\)/.test(t);
    const params = p.params.map((t) => (spellableType(t) ? t : pointer(t) ? 'void *' : undefined));
    if (ret === undefined || params.some((t) => t === undefined || declaredWidth(t) === undefined)) {
      continue;
    }
    lines.push(`${ret} ${name}(${params.length === 0 ? 'void' : params.join(', ')});`);
  }
  return lines.join('\n');
}
