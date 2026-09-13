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

/** Every `project:name:toolchain` spelling an id answers to: the id first, then the same id with
 *  each alias in the name's place. Takes the id rather than a row so a reader holding only an id
 *  and the aliases (the sweep's fan guard, a `Case`) spells aliases exactly as `rowNames` does. */
export const idNames = (id: string, aliases?: readonly string[]): string[] => {
  const head = id.slice(0, id.indexOf(':') + 1);
  const tail = id.slice(id.lastIndexOf(':'));
  return [id, ...(aliases ?? []).map((a) => `${head}${a}${tail}`)];
};

/** Every `project:name:toolchain` spelling a row answers to: its id first, then its aliases. */
export const rowNames = (r: Identifiable): string[] => idNames(r.id, r.aliases);

// ROW SELECTION. The harness has two selection semantics on purpose, and ONE alias rule across
// both. `--only` (`bench run`, `sweep`, `fidelity`) is a substring of the function NAME, never of
// the project or toolchain; `bench fan` and `bench gates --only` name a row by id, exact first,
// then a substring of the id. Both answer to every name the row has had. Measured before this
// rule, on a row renamed with its old name in `aliases`: `bench target Old` resolved the row while
// `bench fan Old`, `bench sweep --only Old` and `bench run --only Old` selected nothing, silently,
// because each of those readers matched `sym` or `id` alone.

/** `--only`: does this substring select a row named `sym` (formerly `aliases`)? An absent or empty
 *  filter selects everything. */
export const onlySelects = (only: string | undefined, sym: string, aliases?: readonly string[]): boolean =>
  !only || [sym, ...(aliases ?? [])].some((n) => n.includes(only));

/** Name a row by id: every row one of whose names (`idNames`) IS the query, else every row one of
 *  whose names CONTAINS it. Exact-first so a row whose whole id is a substring of another's still
 *  resolves to itself. Returns every hit, so the caller reports an ambiguity instead of guessing. */
export function selectByRef<R extends { id: string; aliases?: readonly string[] }>(
  rows: readonly R[],
  query: string,
): R[] {
  const exact = rows.filter((r) => idNames(r.id, r.aliases).includes(query));
  return exact.length > 0 ? exact : rows.filter((r) => idNames(r.id, r.aliases).some((n) => n.includes(query)));
}

/** The GitHub `owner/name` a row's reference source is cited from, when it has one. */
export const sourceRepo = (r: Identifiable): string | undefined =>
  r.sourceUrl === undefined ? undefined : /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(r.sourceUrl)?.[1];

// RETIREMENT. A row the dataset stops carrying on purpose — its project's source moved to another
// decompilation — is RETIRED, and `dataset/retired-rows.json` records it with the address and the
// source URL it was measured under. Retirement is part of identity, not a citation allowlist: a
// regression gate joins the register, so a registered row reads `retired` rather than `missing`,
// and a row that vanished WITHOUT being registered still fails. Before this, the kleod swap's gate
// exited 1 on 42 expected `MISSING` lines, and exited 1 identically when a pokeemerald row was also
// silently skipped: 43 lines, same verdict, told apart only by a person reading them.
//
// Keyed by identity AND id, each qualified by the repository the source is cited from — never by
// id alone. Two decompilations of one ROM reuse both: six kleod names (MultiplyQ8, …) are a live
// row and a retired row at once, and 35 of the 42 new rows sit at a retired row's address.
// Unqualified, the register could not list those six rows, and a future row that took a retired
// name would force deleting the entry and silently re-attach every dated citation to the new row.

/** A row the dataset no longer carries, as `dataset/retired-rows.json` records it. */
export interface RetiredRow {
  id: string;
  addr: string;
  sourceUrl: string;
}

/** A register entry as the fields identity is computed from. */
export const retiredIdentifiable = (e: RetiredRow): Identifiable => {
  const parts = e.id.split(':');
  return {
    id: e.id,
    project: parts[0],
    sym: parts.slice(1, -1).join(':'),
    toolchain: parts[parts.length - 1],
    tier: 'real',
    addr: e.addr,
    sourceUrl: e.sourceUrl,
  };
};

/** The keys a real row is retired under: its identity and its id, each `@` the repository its source
 *  is cited from. Empty for a row that cites no repository, so such a row can never be excused as
 *  retired: it stays `missing`. The id form is what lets an artifact from before addresses meet the
 *  register. */
export const retirementKeys = (r: Identifiable): string[] => {
  const repo = sourceRepo(r);
  return r.tier !== 'real' || repo === undefined ? [] : [...new Set([rowIdentity(r), r.id])].map((k) => `${k}@${repo}`);
};

/** Every key the register retires, for `retirementKeys(row).some(k => set.has(k))`. */
export const retiredKeySet = (register: readonly RetiredRow[]): Set<string> =>
  new Set(register.flatMap((e) => retirementKeys(retiredIdentifiable(e))));

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
  const headByKey = new Map<string, Identifiable>();
  for (const r of head) {
    const k = bridge(r, baseNames) ?? rowIdentity(r);
    headKeys.set(r, k);
    headByKey.set(k, r);
  }
  // THE SAME RULE ON THE ADDRESS PATH. An address is a fact about the binary, and two
  // decompilations of one ROM put different authors' source at the same address: when kleod's rows
  // moved from one decomp to another, 37 of the 42 new rows sat at an old row's address, and keyed
  // by address alone a regression gate read "same row, match → nonmatch" for rows that had never
  // been measured. So two real rows that meet at an address but cite their source from two
  // different repositories are two rows, each keyed apart by its repository — exactly what the
  // name bridge above refuses. A fork MOVE (one decomp under a new owner) reads as removed + added
  // too; that is honest, and rarer than a re-pin.
  for (const r of base) {
    const k = baseKeys.get(r)!;
    const h = headByKey.get(k);
    const br = sourceRepo(r);
    const hr = h === undefined ? undefined : sourceRepo(h);
    if (h !== undefined && r.tier === 'real' && br !== undefined && hr !== undefined && br !== hr) {
      baseKeys.set(r, `${k}@${br}`);
      headKeys.set(h, `${k}@${hr}`);
    }
  }
  return {
    baseKey: (r) => baseKeys.get(r) ?? rowIdentity(r),
    headKey: (r) => headKeys.get(r) ?? rowIdentity(r),
    bridged,
  };
}
