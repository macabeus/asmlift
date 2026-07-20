// C++ output needs a CppFnSpec (class, method, params, field layouts) — a decomp project reads
// it from headers; the playground derives a best-effort one instead:
//   1. the user's JSON (the textarea) when present — the full-fidelity path;
//   2. else the MANGLED SYMBOL (real mwcc C++ symbols carry class + param types) + a synthesized
//      all-word field layout (`field_K`) sized by the member accesses actually in the function;
//   3. else a free function with the lifted param names/types.
import type { CppFnSpec } from '@asmlift/core/backend/cpp';
import type { IrType } from '@asmlift/core/ir/types';
import { type Expr, type SFn, type Stmt, exprChildren, stmtChildren, stmtExprs } from '@asmlift/core/l3/ast';
import { type CppType, demangle } from '@asmlift/core/mangle';

const INT: CppType = { base: 'int', ptr: 0 };
const BUILTINS = new Set([
  'void',
  'bool',
  'char',
  'signed char',
  'unsigned char',
  'short',
  'unsigned short',
  'int',
  'unsigned int',
  'long',
  'unsigned long',
  'long long',
  'float',
  'double',
]);

export function irToCpp(t: IrType): CppType {
  switch (t.kind) {
    case 'int': {
      const byWidth: Record<number, [string, string]> = {
        8: ['char', 'unsigned char'],
        16: ['short', 'unsigned short'],
        32: ['int', 'unsigned int'],
        64: ['long long', 'unsigned long long'],
      };
      const [s, u] = byWidth[t.width] ?? byWidth[32];
      return { base: t.signed ? s : u, ptr: 0 };
    }
    case 'ptr': {
      const inner = irToCpp(t.to);
      return { base: inner.base, ptr: inner.ptr + 1 };
    }
    case 'struct':
      return { base: t.name, ptr: 0 };
    case 'void':
      return { base: 'void', ptr: 0 };
    default:
      return INT; // unknown/array — the playground's safe default
  }
}

/** Parse + structurally validate a user-supplied CppFnSpec. Throws with a readable message. */
export function parseSpec(json: string): CppFnSpec {
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch (e) {
    throw new Error(`spec is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  const s = o as CppFnSpec;
  const isType = (t: unknown): t is CppType =>
    !!t && typeof t === 'object' && typeof (t as CppType).base === 'string' && typeof (t as CppType).ptr === 'number';
  if (typeof s.method !== 'string' || !s.method) {
    throw new Error('spec needs a "method" name');
  }
  if (s.cls !== undefined && typeof s.cls !== 'string') {
    throw new Error('"cls" must be a string');
  }
  if (!isType(s.retType)) {
    throw new Error('"retType" must be {base, ptr} (e.g. {"base":"int","ptr":0})');
  }
  if (!Array.isArray(s.params) || s.params.some((p) => typeof p?.name !== 'string' || !isType(p?.type))) {
    throw new Error('"params" must be [{name, type:{base,ptr}}, …]');
  }
  if (s.classes !== undefined) {
    for (const [cn, c] of Object.entries(s.classes)) {
      if (!Array.isArray(c?.fields) || c.fields.some((f) => typeof f?.name !== 'string' || !isType(f?.type))) {
        throw new Error(`class "${cn}" needs fields: [{name, type:{base,ptr}}, …]`);
      }
    }
  }
  return s;
}

/** Best-effort spec from the symbol + the typed neutral AST (see the module header). */
export function deriveSpec(name: string, sfn: SFn): CppFnSpec {
  const freeFn = (): CppFnSpec => ({
    method: name,
    retType: irToCpp(sfn.retType),
    params: sfn.params.map((p) => ({ name: p.name, type: irToCpp(p.type) })),
  });
  const sig = demangle(name);
  if (!sig) {
    return freeFn();
  }
  // ARITY CROSS-CHECK: a plain C symbol shaped `x__F<codes>` demangles too (`buf__Fill` →
  // "buf(int, long, long)"). The lifted function knows its real arity — a mismatch means the
  // demangle was a false positive, so fall back to the (sound) mangled-C free function rather
  // than fabricate a C++ signature. Strict equality: a real C++ fn with UNUSED params also
  // falls back — ugly but sound; the spec textarea is the full-fidelity path.
  if (sfn.params.length !== (sig.cls ? 1 : 0) + sig.params.length) {
    return freeFn();
  }
  const letters = 'abcdefghij';
  const spec: CppFnSpec = {
    method: sig.name,
    retType: irToCpp(sfn.retType),
    params: sig.params.map((t, i) => ({ name: letters[i] ?? `p${i}`, type: t })),
  };
  if (sig.cls) {
    spec.cls = sig.cls;
  }

  // Synthesize all-word layouts (`field_K`, K = word offset) for every class the function touches,
  // sized by the largest constant index actually applied to that class's receiver vars.
  const recv = new Map<string, string>(); // lifted var → class
  if (sig.cls && sfn.params[0]) {
    recv.set(sfn.params[0].name, sig.cls);
  }
  const explicitStart = sig.cls ? 1 : 0;
  spec.params.forEach((p, i) => {
    const v = sfn.params[explicitStart + i]?.name;
    if (v && p.type.ptr === 1 && !BUILTINS.has(p.type.base)) {
      recv.set(v, p.type.base);
    }
  });
  if (recv.size === 0) {
    return spec;
  }

  // SUB-WORD GUARD. The synthesized layout is all-word `int` fields, and cppBackend's own
  // sub-word loud-fail checks the SPEC's widths — so feeding it an all-int layout would
  // structurally bypass that guard. The evidence lives in the recovered types: a receiver
  // dereferenced at sub-word width types as `s16*`/`u8*`…, and one lifted through struct
  // recovery types as a struct pointer. Either way word-index synthesis would be silently
  // WRONG member access — decline and ask for a real signature instead.
  for (const [v, cls] of recv) {
    const t = sfn.params.find((p) => p.name === v)?.type;
    const pointee = t?.kind === 'ptr' ? t.to : undefined;
    const wordSafe =
      pointee === undefined || pointee.kind === 'unknown' || (pointee.kind === 'int' && pointee.width === 32);
    if (!wordSafe) {
      throw new Error(
        `cannot auto-derive a field layout for class ${cls}: its receiver is accessed at sub-word width ` +
          `(or as a recovered struct), which a synthesized all-int layout would mis-map — ` +
          `supply the C++ signature with real field types instead`,
      );
    }
  }

  const maxIdx = new Map<string, number>([...recv.values()].map((c) => [c, -1]));
  const visitE = (e: Expr): void => {
    if (e.k === 'index' && e.base.k === 'var' && e.idx.k === 'const') {
      const cls = recv.get(e.base.name);
      if (cls !== undefined) {
        maxIdx.set(cls, Math.max(maxIdx.get(cls) ?? -1, e.idx.value));
      }
    }
    // A bare deref `*p` is lifted as index 0 only sometimes; a `field` node means a REAL recovered
    // struct — the user spec path handles those better, but field_0 coverage keeps this sound.
    exprChildren(e).forEach(visitE);
  };
  const visitS = (s: Stmt): void => {
    stmtExprs(s).forEach(visitE);
    stmtChildren(s).forEach(visitS);
  };
  sfn.body.forEach(visitS);

  spec.classes = Object.fromEntries(
    [...maxIdx.entries()].map(([cls, max]) => [
      cls,
      {
        fields: Array.from({ length: max + 1 }, (_, k) => ({ name: `field_${k}`, type: INT })),
      },
    ]),
  );
  return spec;
}
