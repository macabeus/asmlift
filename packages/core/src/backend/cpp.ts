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
import { Expr, LanguageBackend, SFn } from '../l3/ast';
import { type CppType, mangle, spellType } from '../mangle';
import { LeafHook, cComment, emitCFamily } from './cfamily';

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

/** Build a C++ backend for one function, parameterized by its recovered C++ signature. The lifted
 *  SFn params are positional: for a member function SFn.params[0] is `this`, the rest are `params`. */
export function cppBackend(spec: CppFnSpec): LanguageBackend {
  return {
    id: 'cpp',
    emit(fn: SFn): string {
      // Map each lifted param var → its C++ meaning: `this` (bare member access) or a named param
      // (a pointer-to-class param uses `->`). A pointer-to-known-class param is a member receiver.
      const thisVar = spec.cls ? fn.params[0]?.name : undefined;
      const explicitStart = spec.cls ? 1 : 0;
      const rename = new Map<string, string>(); // lifted var → C++ name
      const recv = new Map<string, { cls: string; via: 'this' | string }>(); // var → member receiver
      if (thisVar) {
        rename.set(thisVar, 'this');
        recv.set(thisVar, { cls: spec.cls!, via: 'this' });
      }
      spec.params.forEach((p, i) => {
        const v = fn.params[explicitStart + i]?.name;
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
        if (e.k === 'index' && e.base.k === 'var' && e.idx.k === 'const') {
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

      const paramList = spec.params.map((p) => `${spellType(p.type)} ${p.name}`).join(', ');
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
    const fields = cdef.fields.map((f) => `${spellType(f.type)} ${f.name};`).join(' ');
    const method = cname === spec.cls ? ` ${spellType(spec.retType)} ${spec.method}(${paramList});` : '';
    out.push(`struct ${cname} { ${fields}${method} };`);
  }
  return out.join('\n');
}
