// asmlift — the C++ language backend. Emits IDIOMATIC, de-mangled C++ — a member function with
// scope resolution (`Vec::dot`), an implicit `this`, and named member access — reusing the
// shared C-family printer (backend/cfamily.ts) for the body VERBATIM, because a CodeWarrior
// member function's body is byte-identical to the same C with `this` explicit. Only the
// DIVERGENT C++ surface lives here: the scoped/`this` signature, the class declaration, member
// access, and the mangled SYMBOL (src/mangle.ts) that objdiff aligns the candidate by.
//
// What it consumes beyond the neutral SFn — supplied like `prototypes` (a decomp project has its
// class layouts in headers, exactly as it has function prototypes): the owning class + method
// name, the explicit parameter names/types, and the field layout of each class touched (so an
// indexed load `this[1]` becomes the named `y`).
//
// Scope: free functions and non-virtual member functions with scalar/pointer params and named
// field access. Virtual dispatch, references, and constructors/destructors are deliberately not
// built ahead of an inhabitant.
import { Expr, LanguageBackend, SFn, walkExprs } from '../l3/ast';
import { type CppType, declareCpp, mangle, spellType } from '../mangle';
import type { TargetDescription } from '../target';
import { LeafHook, cComment, emitCFamily } from './cfamily';

/** How the target's argument slots hold floats (`TargetDescription.fpu`). */
type FloatSlots = NonNullable<TargetDescription['fpu']>['slots'];

export interface CppClass {
  fields: { name: string; type: CppType }[];
} // field i at word offset i
export interface CppFnSpec {
  method: string; // idiomatic function / method name
  cls?: string; // owning class (member fn); omit for a free fn
  retType: CppType;
  params: { name: string; type: CppType }[]; // EXPLICIT params (the implicit `this` excluded)
  classes?: Record<string, CppClass>; // layouts for named member access
}

/** The mangled CodeWarrior symbol this spec compiles to — the objdiff alignment key. */
export function cppSymbol(spec: CppFnSpec): string {
  return mangle({ name: spec.method, cls: spec.cls, params: spec.params.map((p) => p.type) });
}

/** The lifted parameter each EXPLICIT spec parameter is (its SFn name), for a member function after
 *  `this` (SFn.params[0]). How depends on the target's float slot model (`TargetDescription.fpu`),
 *  because the lifted order is the ABI sort's (frontend/fpu.ts `fpuArgSlots`):
 *   - `'separate'` (PowerPC EABI): by register FILE, then by position within it. The files count
 *     independently and every float argument sorts after the integers, so `float g(float x, int n)`
 *     lifts as `(s32 a0, float a1)`. A float the body never reads leaves no hole, so the spec may
 *     have MORE floats than the lift (`int m(int n, float x)` lifts as `(s32 a0)`), never fewer.
 *   - `'leading'` (MIPS o32), and a target with no float file: by POSITION. The lifted order is the
 *     slot order, which is the source order, and an unread leading float is minted as an integer
 *     hole — so binding by file would hand `int k(float x, int n)`'s `n` the hole `a0`.
 *  NULL when the two contradict: a lifted float the spec has no float for, or has one of the other
 *  precision for. No binding of the rest is then trustworthy. The precision is part of the
 *  contradiction because the body is spelled over the spec's types: a lifted `double` bound to a
 *  `float a, float b` prints `a + b`, which is a single-precision add where the machine did a
 *  double one.
 *
 *  THE PRECISION IS AN OPERATION'S, so only a parameter the body reads has one to contradict. A
 *  frontend types every float register of a function at the function's one precision
 *  (frontend/fpu.ts `fpPrecision`), and that includes an argument slot the body never reads, which
 *  it mints only to hold the later arguments' places: `float f1(double a, float b){ return b + b; }`
 *  is `fadds f1,f2,f2`, and its `a` is a single-precision hole that nothing states the width of. So
 *  is a lifted float of no stated precision (`T.fUnstated`) anywhere. Either binds a spec float of
 *  both widths, and the spec's is the one to print.
 *
 *  EXCEPT WHERE THE HOLE'S WIDTH PLACED THE PARAMETERS AFTER IT. Under `'leading'` a float takes one
 *  integer slot for a single and two for a double, counted at the function's precision
 *  (`fpuArgSlots`), so an unread hole of the other width than the spec's moves every integer after
 *  it: `float m2(double a, float b, int *p, int *q){ *p = 0; return b + b; }` (gcc2.7.2kmc) is
 *  `sw zero,0(a3)` with `a` laid out as ONE slot, and binding by position would name `a3` `q`. So
 *  there an unread float followed by an integer parameter keeps its precision.
 *
 *  A spec `double` bound to a lifted NON-float is the same misplacement. A double takes two integer
 *  slots under o32 and on a target with no float file (agbcc passes one in r0:r1), so a body that
 *  reads no FPU register mints it as two 32-bit holes: `void n1(double d, int *p, int *q){ *p = 0; }`
 *  (gcc2.7.2kmc) is `sw zero,0(a2)` and lifts as `(s32 a0, s32 a1, s32 *a2)`, where binding by
 *  position would name `a2` `q`. Only a lifted 64-bit parameter holds both slots, so a spec double
 *  over a narrower one refuses when a lifted parameter follows it, and when the body reads it — a
 *  read half would print as the whole double (agbcc `int u1(int a, double d)` returning the word
 *  `((int *)&d)[0]` is `add r0,r1,#0`). The one binding kept is the spec's last parameter over slots
 *  the body never reads, which is IDO homing a trailing double it never uses (`int o1(int a, double
 *  d){ return a; }` spills `a2`/`a3`): nothing then binds past it. */
export function bindSpecParams(
  spec: Pick<CppFnSpec, 'cls' | 'params'>,
  lifted: Pick<SFn, 'params' | 'body'>,
  floatSlots: FloatSlots | undefined,
): (string | undefined)[] | null {
  const floatBits = (t: CppType) => (t.ptr !== 0 ? null : t.base === 'float' ? 32 : t.base === 'double' ? 64 : null);
  const isFloat = (t: CppType) => floatBits(t) !== null;
  const read = new Set<string>();
  for (const e of walkExprs(lifted.body)) {
    if (e.k === 'var') {
      read.add(e.name);
    }
  }
  const clashes = (p: SFn['params'][number], t: CppType | undefined, laysOut: boolean) =>
    p.type.kind === 'float' &&
    (t === undefined ||
      floatBits(t) === null ||
      (p.type.width !== null && (laysOut || read.has(p.name)) && floatBits(t) !== p.type.width));
  const explicit = lifted.params.slice(spec.cls ? 1 : 0);
  const lastAndUnread = (i: number) =>
    i === spec.params.length - 1 && explicit.slice(i).every((p) => !read.has(p.name));
  if (floatSlots !== 'separate') {
    const clash = explicit.some((p, i) => {
      const t = spec.params[i]?.type;
      const later = explicit.slice(i + 1);
      const oneSlot = p.type.kind !== 'float' && !('width' in p.type && p.type.width === 64);
      return (
        clashes(
          p,
          t,
          later.some((q) => q.type.kind !== 'float'),
        ) ||
        (t !== undefined &&
          floatBits(t) === 64 &&
          oneSlot &&
          (later.length > 0 || read.has(p.name)) &&
          !lastAndUnread(i))
      );
    });
    return clash ? null : spec.params.map((_, i) => explicit[i]?.name);
  }
  const floats = explicit.filter((p) => p.type.kind === 'float');
  const others = explicit.filter((p) => p.type.kind !== 'float');
  const specFloats = spec.params.filter((p) => isFloat(p.type));
  if (specFloats.length < floats.length || floats.some((p, i) => clashes(p, specFloats[i].type, false))) {
    return null;
  }
  let f = 0;
  let o = 0;
  return spec.params.map((p) => (isFloat(p.type) ? floats[f++] : others[o++])?.name);
}

/** Build a C++ backend for one function, parameterized by its recovered C++ signature and the float
 *  slot model of the target it was lifted for. For a member function SFn.params[0] is `this`; the
 *  rest bind to `params` by `bindSpecParams`. */
export function cppBackend(spec: CppFnSpec, floatSlots: FloatSlots | undefined): LanguageBackend {
  return {
    id: 'cpp',
    spellsSwitchFallthrough: true,
    emit(fn: SFn): string {
      // Map each lifted param var → its C++ meaning: `this` (bare member access) or a named param
      // (a pointer-to-class param uses `->`). A pointer-to-known-class param is a member receiver.
      const thisVar = spec.cls ? fn.params[0]?.name : undefined;
      const rename = new Map<string, string>(); // lifted var → C++ name
      const recv = new Map<string, { cls: string; via: 'this' | string }>(); // var → member receiver
      if (thisVar) {
        rename.set(thisVar, 'this');
        recv.set(thisVar, { cls: spec.cls!, via: 'this' });
      }
      const bound = bindSpecParams(spec, fn, floatSlots);
      if (!bound) {
        throw new Error(
          `cpp backend: the spec's floating-point parameters do not match the lifted function's — ` +
            `supply a signature whose float and integer parameters are the ones it takes`,
        );
      }
      spec.params.forEach((p, i) => {
        const v = bound[i];
        if (!v) {
          return;
        }
        rename.set(v, p.name);
        if (p.type.ptr === 1 && spec.classes?.[p.type.base]) {
          recv.set(v, { cls: p.type.base, via: p.name });
        }
      });

      const field = (cls: string, k: number): string => {
        const fields = spec.classes?.[cls]?.fields ?? [];
        // The lifted index `k` counts WORD offsets. It coincides with the sequential field
        // position ONLY when every field is word-sized (4 bytes), so a `short`/`char`/mixed-width
        // struct would map `k` to the WRONG field. Rather than emit silently-wrong idiomatic C++,
        // fail LOUD: a mixed layout needs byte-offset field resolution, which is follow-on work.
        if (!fields.every((f) => typeWidth(f.type) === 4)) {
          throw new Error(
            `cpp backend: class ${cls} has a sub-word/mixed field layout — member access needs byte-offset recovery (not yet supported)`,
          );
        }
        const f = fields[k];
        if (!f) {
          throw new Error(`cpp backend: no field at word offset ${k} of class ${cls}`);
        }
        return f.name;
      };
      // Leaf hook: rewrite an indexed access on a receiver into named member access, and a bare
      // receiver/param var into its C++ name. Everything else falls through to shared C spelling.
      //
      // The member rewrite fires ONLY for a WORD access (`width === 4`): the word-index `field()`
      // mapping assumes idx counts words, and the all-word-layout guard above checks the CLASS,
      // not the ACCESS — a sub-word access on a word field (`lhz` from offset 4) would map its
      // byte-scaled idx to the wrong member and read the wrong width, silently. The sub-word
      // receiver access is spelled HERE too (the honest reinterpret cast, `((s16 *)this)[2]`):
      // it cannot fall through to the shared legalization, because the hook RENAMES the receiver
      // — the shared printer would judge the SFn var's recovered type while the reader sees the
      // class pointer, and print an unscaled `this[2]` that C++ strides by sizeof(class).
      // Correct bytes over idiomatic spelling, never the reverse.
      const leaf: LeafHook = (e: Expr) => {
        // `lead` (a multidimensional array global) is not a receiver access and must not be
        // rewritten to one — the hook returns text, so a dropped subscript would be silent.
        if (e.k === 'index' && e.base.k === 'var' && e.idx.k === 'const' && !e.lead?.length) {
          const r = recv.get(e.base.name);
          if (r) {
            if (e.width === 4) {
              return r.via === 'this' ? field(r.cls, e.idx.value) : `${r.via}->${field(r.cls, e.idx.value)}`;
            }
            if (e.width === 1 || e.width === 2) {
              return `((${e.signed ? 's' : 'u'}${e.width * 8} *)${r.via === 'this' ? 'this' : r.via})[${e.idx.value}]`;
            }
            // any other width is a struct-array STRIDE (a dot-form base) — not this rewrite's
            // shape; fall through to the shared spelling so `.field` stays intact.
          }
        }
        if (e.k === 'var') {
          const nm = rename.get(e.name);
          if (nm) {
            return nm;
          }
        }
        return null;
      };

      const paramList = spec.params.map((p) => declareCpp(p.type, p.name)).join(', ');
      const decls = classDecls(spec, paramList);
      const signature = `${spellType(spec.retType)} ${spec.cls ? spec.cls + '::' : ''}${spec.method}(${paramList})`;
      return (decls ? decls + '\n' : '') + emitCFamily(signature, fn, leaf);
    },
    comment: cComment, // C++ shares C's block-comment spelling
  };
}

// Byte width of a C++ type (a pointer is always word-sized). Used to reject a sub-word field layout
// the word-index member-access mapping cannot represent.
function typeWidth(t: CppType): number {
  if (t.ptr > 0) {
    return 4;
  }
  return (
    { char: 1, bool: 1, 'unsigned char': 1, short: 2, 'unsigned short': 2, 'long long': 8, double: 8 }[t.base] ?? 4
  );
}

// The class declaration(s) a member/field-accessing function needs to compile: fields in word-offset
// order, plus the method prototype inside its owning class.
function classDecls(spec: CppFnSpec, paramList: string): string {
  const out: string[] = [];
  for (const [cname, cdef] of Object.entries(spec.classes ?? {})) {
    const fields = cdef.fields.map((f) => `${declareCpp(f.type, f.name)};`).join(' ');
    const method = cname === spec.cls ? ` ${spellType(spec.retType)} ${spec.method}(${paramList});` : '';
    out.push(`struct ${cname} { ${fields}${method} };`);
  }
  return out.join('\n');
}
