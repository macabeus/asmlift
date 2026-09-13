// ROW IDENTITY — what makes two benchmark rows the same row.
//
// A row's `id` (`project:sym:toolchain`) is PRESENTATION: it is what a person reads in a PR, a
// doc, a citation and the webapp. It is not what joins rows, because a real row's `sym` is its
// upstream project's name for the function, and upstream renames functions (a decomp names
// `sub_08XXXXXX` as it learns what they do). Keyed by name, every such rename would read as one
// row removed and another added, and every citation of the old name would stop resolving.
//
// So a REAL row is keyed by its address — the symbol's value in the project's linked ELF (GBA:
// the ROM-mapped `0x08…` address, Thumb bit clear; N64: the VRAM address), which a rename cannot
// move. `rowIdentity` is that key. The names a row has had before are kept on the row as
// `aliases`, so a citation, a permalink or a brief that names the old spelling still resolves to
// the row (`rowNames`, `resolveRow`). A rename is then a DATA change: `sym` takes the new name and
// the old one moves into `aliases`.
//
// SYNTHETIC rows have no address — they are not functions of any binary — and keep name identity:
// their key IS their id.
//
// The address is the join key and never prose: nothing here renders it for a reader.

/** The fields identity is computed from — a subset of `FunctionResult`, spelled out so this module
 *  stays importable by both the harness and the browser without dragging the whole row type in. */
export interface Identifiable {
  id: string;
  project: string;
  sym: string;
  toolchain: string;
  tier: 'synthetic' | 'real';
  /** real tier: the function's address, `0x` + 8 lowercase hex digits (see ADDR_PATTERN) */
  addr?: string;
  /** real tier: names this row was published under before, oldest first */
  aliases?: string[];
  sourceUrl?: string;
}

/** The one spelling of an address: `0x` and eight lowercase hex digits — the same spelling the
 *  vendored symbol maps key their entries by, so a row's `addr` can be looked up there verbatim. */
export const ADDR_PATTERN = /^0x[0-9a-f]{8}$/;

/** The key two rows are compared by. A real row with an address is keyed by it; everything else
 *  (synthetic rows, and a real row from an artifact that predates addresses) by its id. The two
 *  shapes cannot collide: an id's middle segment is an identifier, and never starts with a digit. */
export const rowIdentity = (r: Identifiable): string =>
  r.tier === 'real' && r.addr !== undefined ? `${r.project}:${r.addr}:${r.toolchain}` : r.id;

/** Every `project:name:toolchain` spelling a row answers to: its id first, then its aliases. */
export const rowNames = (r: Identifiable): string[] => [
  r.id,
  ...(r.aliases ?? []).map((a) => `${r.project}:${a}:${r.toolchain}`),
];

/** The GitHub `owner/name` a row's reference source is cited from, when it has one. */
export const sourceRepo = (r: Identifiable): string | undefined =>
  r.sourceUrl === undefined ? undefined : /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(r.sourceUrl)?.[1];

/** Find the row a reference names. A reference is any of: a row identity
 *  (`project:0x…:toolchain`), an id, an alias id, or — without the toolchain — `project:name`,
 *  which must name exactly one row. Returns undefined when nothing, or more than one row, answers. */
export function resolveRow<R extends Identifiable>(rows: readonly R[], ref: string): R | undefined {
  const hits = new Set<R>();
  for (const r of rows) {
    if (rowIdentity(r) === ref) {
      return r;
    }
    const names = rowNames(r);
    if (names.includes(ref)) {
      return r;
    }
    if (names.some((n) => n.slice(0, n.lastIndexOf(':')) === ref)) {
      hits.add(r);
    }
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

/** How rows of two artifacts are joined, and how many needed the name bridge to join at all.
 *
 *  THE BRIDGE. An artifact published before rows carried addresses keys every row by name, and
 *  one published after keys real rows by address — so a plain key comparison of the two reports
 *  every real row missing on one side and added on the other, which is a gate that checked
 *  nothing. A row WITHOUT an address therefore takes the identity of the row on the other side
 *  that answers to its id (by id or alias) — but only when both rows cite their reference source
 *  from the SAME repository. A name is a claim about one decompilation: the same name in a
 *  different decomp is a different author's reading of maybe-the-same bytes, and joining the two
 *  would police a row against a measurement of another dataset. */
export interface ArtifactJoin {
  baseKey: (r: Identifiable) => string;
  headKey: (r: Identifiable) => string;
  /** rows (counted on the base side) that carried no address and joined through a name */
  bridged: number;
}

export function joinArtifacts(base: readonly Identifiable[], head: readonly Identifiable[]): ArtifactJoin {
  const byName = (rows: readonly Identifiable[]): Map<string, Identifiable> => {
    const m = new Map<string, Identifiable>();
    for (const r of rows) {
      for (const n of rowNames(r)) {
        m.set(n, r);
      }
    }
    return m;
  };
  const baseNames = byName(base);
  const headNames = byName(head);
  const bridge = (r: Identifiable, other: Map<string, Identifiable>): string | undefined => {
    if (r.tier !== 'real' || r.addr !== undefined) {
      return undefined;
    }
    const o = rowNames(r)
      .map((n) => other.get(n))
      .find((x) => x !== undefined);
    return o !== undefined && o.tier === 'real' && o.addr !== undefined && sourceRepo(o) === sourceRepo(r)
      ? rowIdentity(o)
      : undefined;
  };
  const baseKeys = new Map<Identifiable, string>();
  let bridged = 0;
  for (const r of base) {
    const b = bridge(r, headNames);
    if (b !== undefined) {
      bridged++;
    }
    baseKeys.set(r, b ?? rowIdentity(r));
  }
  const headKeys = new Map<Identifiable, string>();
  for (const r of head) {
    headKeys.set(r, bridge(r, baseNames) ?? rowIdentity(r));
  }
  return {
    baseKey: (r) => baseKeys.get(r) ?? rowIdentity(r),
    headKey: (r) => headKeys.get(r) ?? rowIdentity(r),
    bridged,
  };
}
