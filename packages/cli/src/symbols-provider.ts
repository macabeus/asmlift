// asmlift — the ELF symbol-map provider (research/symbol-map-plan-2026-07-22.md).
//
// Reads the ONE file `tools.asmlift.elf` names and produces the core `SymbolMap`:
//   names+addresses+kind from `.symtab` (always), declaration shapes from the DWARF
//   types-sidecar the project links in (when present — `hasTypeInfo` is the detector; absent
//   ⇒ names-only, gracefully). The join is by NAME: the sidecar's variable DIEs carry
//   name→type (declarations, no addresses), the symtab carries name→address.
//
// Alias policy (addresses are NOT unique in real projects): every symbol at an address is
// kept, ordered so `[0]` is the canonical pick — header-declared (DIE-joined) names first,
// placeholder names (`sub_08xxxxxx` rename leftovers, declared in no header) last.
//
// CAPABILITY GATE (`assertShapeFactsPresent`): shape recovery needs facts — member signedness and
// the cv-qualifier flags — that an older @gba-kit/debug-info does not report. Such a package DOES
// export `variableShape`, so a method-existence check passes while the facts silently go missing,
// and the emitted map is PARTIAL: every `volatile` MMIO global loses its qualifier and every
// struct member loses its signedness, which are exactly the facts the declaration synthesis needs
// to spell bytes correctly. That is the plausible-but-wrong class this project refuses, so the
// provider REFUSES LOUDLY instead (the CLI converts the throw to exit 66). Probed by KEY
// PRESENCE, never by version string — the shipped package labelling is not a reliable witness of
// its own capability, so `UPGRADE` names the required version in ONE place, as remediation advice
// rather than as the test. `assertPointeeFactPresent` and `assertPointeeCapabilityWitnessed` are
// the same gate one release later, for the facts an INTERIOR spelling through a pointer global
// needs (what it points at, and which of a layout's members are arrays).
import type { SymbolInfo, SymbolMap, SymbolStructField } from '@asmlift/core/symbols';
import { readFileSync } from 'node:fs';

/** `variableShape` result — declared structurally so this package does not depend on
 *  @gba-kit/debug-info's exported types. The cv-qualifier flags are OPTIONAL at this boundary
 *  only because the type must describe both a qualified and an unqualified declaration; their
 *  runtime AVAILABILITY is asserted separately (assertShapeFactsPresent). */
type DwarfShape =
  | { kind: 'scalar'; size: number | null; signed: boolean | null; volatile?: boolean; const?: boolean }
  | {
      kind: 'pointer';
      /** the struct/union the pointer targets (null = it targets something else), with the
       *  qualifiers of the TARGET type — independent of this pointer variable's own, below.
       *  OPTIONAL at this boundary only because the type must also describe a package that
       *  predates the fact; its runtime AVAILABILITY is asserted separately
       *  (assertPointeeFactPresent). */
      pointee?: { structName: string | null; size: number | null; volatile?: boolean; const?: boolean } | null;
      volatile?: boolean;
      const?: boolean;
    }
  | {
      kind: 'array';
      elemSize: number | null;
      elemSigned: boolean | null;
      length: number | null;
      volatile?: boolean;
      const?: boolean;
    }
  | { kind: 'struct'; structName: string | null; size: number | null; volatile?: boolean; const?: boolean };
type ShapeCapable = {
  variableShape?: (name: string) => DwarfShape | null;
  /** present from the release that reads subprogram DIEs; absent ⇒ no signatures, gracefully */
  functionSignature?: (name: string) => DwarfSignature | null;
};

/** `functionSignature`'s result, declared structurally for the same reason as DwarfShape. */
interface DwarfSignature {
  returns: { size: number | null; signed: boolean | null; pointer?: true } | null;
  params: { size: number | null; signed: boolean | null; pointer?: true }[];
}

/** `struct()`'s member — same structural declaration, same reason. Every fact but name/offset/size
 *  is optional here so the type also describes a member that simply is not a pointer/array. */
interface DwarfMember {
  name: string;
  offset: number;
  size: number | null;
  signed?: boolean | null;
  pointer?: true;
  pointeeSize?: number;
  pointeeSigned?: boolean;
  volatile?: true;
  const?: true;
  bitWidth?: number;
  elemSize?: number;
  elemSigned?: boolean;
  length?: number;
}

/** `sub_08xxxxxx` / `_08xxxxxx`-style placeholder names — real symbols, but names no header
 *  declares; emitting one produces non-compiling output, so they never win the canonical pick. */
export const PLACEHOLDER = /^(?:sub_|_)[0-9A-Fa-f]{6,8}$/;

const UPGRADE = 'upgrade @gba-kit/debug-info to >= 0.4.0 (or drop tools.asmlift.elf to run without a map)';

/** The cv-qualifier facts, probed on the first shaped variable. A 0.3-era package returns the
 *  same object KINDS from `variableShape` but never sets `volatile`/`const`, so a
 *  method-existence check passes while every volatile MMIO global silently loses the qualifier
 *  its correct declaration needs. Key presence is the only honest witness — an unreleased build
 *  still carries its PREVIOUS version in package.json while already reporting the facts, so a
 *  version comparison would be wrong in both directions. */
function assertShapeFactsPresent(sh: DwarfShape, elfPath: string): void {
  if (!('volatile' in sh)) {
    throw new Error(
      `cannot build a symbol map from ${elfPath}: the installed @gba-kit/debug-info reports no ` +
        `cv-qualifier facts (variableShape() result has no 'volatile' key), so every volatile ` +
        `global would silently lose its qualifier — ${UPGRADE}`,
    );
  }
}

/** The same probe for struct MEMBERS: without per-member signedness a synthesized member is
 *  declared at a guessed signedness, which changes the bytes a load compiles to. */
function assertMemberFactsPresent(m: object, elfPath: string): void {
  if (!('signed' in m)) {
    throw new Error(
      `cannot build a symbol map from ${elfPath}: the installed @gba-kit/debug-info reports no ` +
        `struct-member signedness (member has no 'signed' key), so synthesized struct fields ` +
        `would be declared at a guessed signedness — ${UPGRADE}`,
    );
  }
}

/** The same probe for the POINTER arm's pointee — but this fact cannot be witnessed on every
 *  variable, so the witness is tracked across the whole load and settled by
 *  {@link assertPointeeCapabilityWitnessed}. A pointer shape carries `pointee` whatever it points
 *  at (null when the target is not a struct), so a pointer variable witnesses it directly. */
function assertPointeeFactPresent(sh: DwarfShape, elfPath: string): void {
  if (sh.kind === 'pointer' && !('pointee' in sh)) {
    throw new Error(
      `cannot build a symbol map from ${elfPath}: the installed @gba-kit/debug-info reports no ` +
        `pointer target facts (a pointer variableShape() result has no 'pointee' key), so every ` +
        `pointer global would lose the layout it addresses — ${UPGRADE}`,
    );
  }
}

/** Settle the pointee-release capability once the whole ELF has been read. The probe above only
 *  runs on a POINTER variable, so an ELF with none never exercises it — and the release's other
 *  facts, the member-level `elemSize`/`elemSigned`/`length`, can never be witnessed by absence at
 *  all (a non-array member legitimately has none). So the witness has to be POSITIVE, and either
 *  fact serves as one: a pointer shape carrying `pointee`, or any member carrying `elemSize`.
 *
 *  Seeing NEITHER while layouts were nonetheless consumed leaves the capability unproven, and the
 *  failure it hides is silent: with `elemSize` missing every array member reads as a plain one, so
 *  a one-element array matches an exact-width field lookup and gets spelled `->x` for a member
 *  that is not an lvalue of that width. That is the plausible-but-wrong class, so an unproven
 *  package is refused rather than degraded. */
export function assertPointeeCapabilityWitnessed(witnessed: boolean, layoutsSeen: number, elfPath: string): void {
  if (!witnessed && layoutsSeen > 0) {
    throw new Error(
      `cannot build a symbol map from ${elfPath}: the installed @gba-kit/debug-info never ` +
        `demonstrated the pointer-target/array-member facts (${layoutsSeen} struct layout(s) read, ` +
        `none carrying a member 'elemSize' and no pointer global to probe for 'pointee'), so an ` +
        `array member would be indistinguishable from a plain one — ${UPGRADE}`,
    );
  }
}

/** A named type's sidecar layout, mapped to the core `SymbolStructField[]` — the ONE copy, shared
 *  by a struct global's own layout and by a pointer global's pointee.
 *
 *  Bitfield members are excluded: their read width never equals a field size, so they must fall
 *  through to the honest cast spelling, never a wrong field name. `signed` must be REPORTED by the
 *  package (assertMemberFactsPresent); a reported null value is a genuine "DWARF didn't say" and
 *  stays absent rather than guessed. `pointer`/`volatile` and the array element facts are kept
 *  only when the package states them, same rule — an absent `elemSize` means "not an array", which
 *  is exactly what the field rules read it as. */
export function layoutOf(
  di: { struct(name: string): { members: DwarfMember[] } | null },
  name: string | null,
  elfPath: string,
): SymbolStructField[] | null {
  const layout = name ? di.struct(name) : null;
  if (!layout) {
    return null;
  }
  return layout.members
    .filter((m) => m.bitWidth === undefined)
    .map((m) => {
      assertMemberFactsPresent(m, elfPath);
      return {
        name: m.name,
        offset: m.offset,
        size: m.size,
        ...(typeof m.signed === 'boolean' ? { signed: m.signed } : {}),
        ...(m.pointer === true ? { pointer: true } : {}),
        // POINTER member: what it points AT, when the DWARF resolves that to a base type.
        // Pointer arithmetic scales by this width, so dropping it declares `void *` and makes
        // `p - 4` address different bytes than the header's `u16 *` does.
        ...(typeof m.pointeeSize === 'number' ? { pointeeSize: m.pointeeSize } : {}),
        ...(typeof m.pointeeSigned === 'boolean' ? { pointeeSigned: m.pointeeSigned } : {}),
        ...(m.volatile === true ? { volatile: true } : {}),
        ...(m.const === true ? { const: true } : {}),
        ...(typeof m.elemSize === 'number' ? { elemSize: m.elemSize } : {}),
        ...(typeof m.elemSigned === 'boolean' ? { elemSigned: m.elemSigned } : {}),
        ...(typeof m.length === 'number' ? { length: m.length } : {}),
      };
    });
}

export async function loadSymbolMap(elfPath: string): Promise<SymbolMap> {
  const { DebugInfo, STT_FUNC } = await import('@gba-kit/debug-info');
  const di = DebugInfo.fromElf(readFileSync(elfPath));
  const types = di.types as unknown as ShapeCapable;
  const shapeOf =
    di.hasTypeInfo && typeof types.variableShape === 'function'
      ? (name: string) => types.variableShape!(name)
      : (): DwarfShape | null => null;
  const signatureOf =
    di.hasTypeInfo && typeof types.functionSignature === 'function'
      ? (name: string) => types.functionSignature!(name)
      : (): DwarfSignature | null => null;

  // The pointee-release capability witness (see assertPointeeCapabilityWitnessed): counted across
  // the whole ELF because no single variable can be relied on to exercise it.
  let pointeeWitnessed = false;
  let layoutsSeen = 0;

  const map: SymbolMap = new Map();
  for (const s of di.symbols.symbols) {
    // ARM mapping symbols ($t/$d/$a) and local labels are not project names
    if (!s.name || s.name.startsWith('$') || s.name.startsWith('.')) {
      continue;
    }
    const kind: SymbolInfo['kind'] = s.type === STT_FUNC ? 'code' : 'data';
    const info: SymbolInfo = { name: s.name, kind };
    if (kind === 'code') {
      // The declared signature, when this ELF compiled the function from C. Absent for anything
      // still hand-written assembly — which is exactly the function a user is decompiling, so
      // this channel only ever supplies CALLEE facts to them (see SymbolSignature).
      const sig = signatureOf(s.name);
      if (sig) {
        info.signature = { returns: sig.returns, params: sig.params };
      }
    }
    if (kind === 'data') {
      // Sized symtabs (GC/Wii-class projects carry st_size on every object symbol) enable
      // interior attribution from the symtab alone; GBA ldscript ABS symbols are size-0 and
      // skip this — their sizes come from the sidecar DWARF below, which also overrides.
      if (s.size > 0) {
        info.size = s.size;
      }
      const sh = shapeOf(s.name);
      if (sh) {
        assertShapeFactsPresent(sh, elfPath);
        assertPointeeFactPresent(sh, elfPath);
        if (sh.kind === 'pointer') {
          pointeeWitnessed = true; // the probe above ran and passed on a real pointer shape
        }
        info.declared = true;
        // cv-qualifiers ride every shape (declaration-fidelity for the synthesis layer:
        // volatile is load-bearing for MMIO codegen, const is the ROM-table spelling)
        if (sh.volatile) {
          info.volatile = true;
        }
        if (sh.const) {
          info.const = true;
        }
        if (sh.kind === 'array') {
          info.shape = 'array';
          if (sh.elemSize !== null) {
            info.elemSize = sh.elemSize;
          }
          if (sh.elemSigned !== null) {
            info.elemSigned = sh.elemSigned;
          }
          if (sh.elemSize !== null && sh.length !== null) {
            info.size = sh.elemSize * sh.length;
          }
        } else if (sh.kind === 'struct') {
          info.shape = 'struct';
          if (sh.size !== null) {
            info.size = sh.size; // DWARF wins over st_size — it is the declaration's own size
          }
          if (sh.structName !== null) {
            info.structName = sh.structName; // the real tag, for a readable synthesized decl
          }
          const layout = layoutOf(di, sh.structName, elfPath);
          if (layout) {
            info.layout = layout;
            layoutsSeen++;
          }
        } else if (sh.kind === 'pointer') {
          info.shape = 'pointer';
          // The pointee is carried WHOLE — its name, its size, and the layout that name resolves
          // to — because the interior spelling through a loaded pointer needs all three: the name
          // to declare it, the size to bound it, the layout to name a field at an offset. A
          // pointee the DWARF names but has no layout for reports the name alone; core then finds
          // no field and falls through to the honest cast forms.
          const pointee = sh.pointee ?? null;
          if (pointee) {
            const layout = layoutOf(di, pointee.structName, elfPath);
            if (layout) {
              layoutsSeen++;
            }
            // The TARGET's own cv-qualifiers, kept apart from the cell's (`volatile struct S *g`
            // qualifies what is pointed AT; `struct S *volatile g` qualifies the variable). They
            // are separate declarations of separate objects, and synthesis reproduces both.
            info.pointee = {
              ...(pointee.structName !== null ? { structName: pointee.structName } : {}),
              ...(pointee.size !== null ? { size: pointee.size } : {}),
              ...(pointee.volatile === true ? { volatile: true } : {}),
              ...(pointee.const === true ? { const: true } : {}),
              ...(layout ? { layout } : {}),
            };
          }
        } else {
          info.shape = 'scalar';
          if (sh.size !== null) {
            info.size = sh.size;
          }
          if (sh.signed !== null) {
            info.signed = sh.signed; // types the synthesized `extern T name;` decl
          }
        }
      }
    }
    const at = map.get(s.address);
    if (at) {
      at.push(info);
    } else {
      map.set(s.address, [info]);
    }
  }
  // Any member carrying `elemSize` is the OTHER positive witness of the same release.
  for (const infos of map.values()) {
    infos.sort(canonicalOrder);
    if (!pointeeWitnessed) {
      pointeeWitnessed = infos.some((i) =>
        [...(i.layout ?? []), ...(i.pointee?.layout ?? [])].some((f) => f.elemSize !== undefined),
      );
    }
  }
  assertPointeeCapabilityWitnessed(pointeeWitnessed, layoutsSeen, elfPath);
  return map;
}

/** declared-first, placeholders-last, then name — a deterministic canonical pick. Exported so
 *  the alias policy is pinned by an offline test rather than only by the ELF path. */
export function canonicalOrder(a: SymbolInfo, b: SymbolInfo): number {
  const declared = Number(b.declared ?? false) - Number(a.declared ?? false);
  if (declared !== 0) {
    return declared;
  }
  const placeholder = Number(PLACEHOLDER.test(a.name)) - Number(PLACEHOLDER.test(b.name));
  if (placeholder !== 0) {
    return placeholder;
  }
  return a.name.localeCompare(b.name);
}
