// asmlift — the VARIATION REGISTRY: every variation a candidate's name can carry, as data.
//
// A candidate is named by the variations it applied, in a fixed order: its signedness first, then
// its lift, structure and respell variations, then the symbol-map variation. Each `/`-separated
// part names exactly one variation, e.g. `unsigned/defsite/raw-globals`. A few variations are
// applied to something the part has to name — `coalesce-v0-v1` merges `v0` into `v1`,
// `volatile-p1` qualifies `p1` — and that trailing `-…` is the variation's SUBJECT.
//
// WHY A CLOSED TABLE. The parts are minted by string concatenation in `rank.ts` and
// `rank-axes.ts`, several of them parameterized (`${label}-${c.merged}`, `homesplit-${tag}`,
// `sense-${m}`), so the set of names is open by construction and nothing but this table closes it.
// Three checks hold the table to the code: a static scan of the mint literals
// (`packages/core/test/variation-tokens.test.ts`), every name the committed benchmark artifact
// publishes, and every name the enumerated corpus mints (both in `apps/benchmark/test`).
//
// WHY A TEST PREDICATE GOES THROUGH HERE. A predicate written as a substring —
// `label.includes('/regcopy-ret')` inside `.toEqual([])` — keeps passing after the variation is
// spelled differently, and then asserts nothing. `hasVariation` throws on a name this table does
// not register, so a stale predicate fails instead. It also compares whole variations, never
// substrings: `hasVariation(v, 'livebase')` is false on `livebase-block`, so a predicate about a
// family of variations names each member.
//
// Pure data and pure functions: this module stays browser-safe.

/** The variation kinds, in the order their variations appear in a candidate's name. */
export const VARIATION_KINDS = ['signedness', 'lift', 'structure', 'respell', 'symbol-map'] as const;
export type VariationKind = (typeof VARIATION_KINDS)[number];

export interface VariationToken {
  /** the registered spelling; a `-` inside it is part of the name (`livebase-block`, `vol-slot`) */
  name: string;
  variationKind: VariationKind;
  /** what may follow `name-` when the variation names what it was applied to; absent for a
   *  variation that takes no subject. Anchored by `parseVariation`, never here. */
  subject?: RegExp;
}

/** The local names a multi-result variation's subject lists, `-`-joined: `v0-v1`, `p0-p1-p2`. */
const LOCALS = /[a-z]+\d+(?:-[a-z]+\d+)*/;

/** Every variation, grouped by kind in name order. The order of this table is not published
 *  behaviour: enumeration order is decided in `rank.ts` and `rank-axes.ts`, never here. */
export const VARIATION_TOKENS: readonly VariationToken[] = [
  // signedness: always the first part of a name, because both answers are enumerated
  { name: 'unsigned', variationKind: 'signedness' },
  { name: 'signed', variationKind: 'signedness' },
  // lift: the assembly lifted or raised again
  { name: 'setup-args', variationKind: 'lift' },
  { name: 'connective', variationKind: 'lift' },
  { name: 'shared-ret', variationKind: 'lift' },
  { name: 'shared-tail', variationKind: 'lift' },
  // structure: `structure()` re-run with other options
  { name: 'flip-branch', variationKind: 'structure' },
  { name: 'defsite', variationKind: 'structure' },
  { name: 'loop-entry', variationKind: 'structure' },
  { name: 'flip-join', variationKind: 'structure' },
  { name: 'sense', variationKind: 'structure', subject: /\d+/ },
  { name: 'no-bitfield', variationKind: 'structure' },
  { name: 'no-ptr-elem', variationKind: 'structure' },
  { name: 'flat-rank', variationKind: 'structure' },
  { name: 'reread-globals', variationKind: 'structure' },
  { name: 'inplace', variationKind: 'structure' },
  { name: 'merge-names', variationKind: 'structure' },
  { name: 'addr-home', variationKind: 'structure' },
  { name: 'expr-home', variationKind: 'structure' },
  { name: 'derived-home', variationKind: 'structure' },
  { name: 'merge-home', variationKind: 'structure' },
  { name: 'uns-cmp', variationKind: 'structure' },
  { name: 'fresh-merge', variationKind: 'structure' },
  { name: 'copy-defpos', variationKind: 'structure' },
  { name: 'site-sense', variationKind: 'structure' },
  // respell: the structured tree rewritten
  { name: 'unmerge', variationKind: 'respell' },
  { name: 'argbase', variationKind: 'respell' },
  { name: 'zerosub', variationKind: 'respell' },
  { name: 'volatile', variationKind: 'respell', subject: LOCALS },
  { name: 'vol-slot', variationKind: 'respell' },
  { name: 'vol-store', variationKind: 'respell' },
  { name: 'unreduce', variationKind: 'respell' },
  { name: 'ptr-field', variationKind: 'respell' },
  { name: 'offmember', variationKind: 'respell' },
  { name: 'inlinebase', variationKind: 'respell' },
  { name: 'scopebase', variationKind: 'respell' },
  { name: 'regionbase', variationKind: 'respell' },
  { name: 'scopebase-coalesce', variationKind: 'respell', subject: LOCALS },
  { name: 'coalesce', variationKind: 'respell', subject: LOCALS },
  { name: 'indexed', variationKind: 'respell' },
  { name: 'livebase', variationKind: 'respell' },
  { name: 'livebase-block', variationKind: 'respell' },
  { name: 'basefold', variationKind: 'respell' },
  { name: 'unfolded', variationKind: 'respell' },
  { name: 'orderbase', variationKind: 'respell' },
  { name: 'scoped', variationKind: 'respell' },
  { name: 'homesplit', variationKind: 'respell', subject: /[^/,\s]+/ },
  { name: 'mulfirst', variationKind: 'respell' },
  { name: 'nearbase', variationKind: 'respell' },
  { name: 'advance', variationKind: 'respell' },
  { name: 'parkfirst', variationKind: 'respell' },
  { name: 'sinkinit', variationKind: 'respell' },
  { name: 'regcopy', variationKind: 'respell', subject: /ret|ret-fresh/ },
  { name: 'initfirst', variationKind: 'respell' },
  { name: 'pollguard', variationKind: 'respell' },
  { name: 'pollread', variationKind: 'respell' },
  // symbol map: the map's shaped spellings withheld; always the last part
  { name: 'raw-globals', variationKind: 'symbol-map' },
];

const BY_NAME = new Map(VARIATION_TOKENS.map((t) => [t.name, t]));

/** The registry entry for a name, or a throw naming what is registered. */
export function variationToken(name: string): VariationToken {
  const t = BY_NAME.get(name);
  if (t === undefined) {
    throw new Error(`'${name}' is not a registered variation (packages/core/src/variation-tokens.ts)`);
  }
  return t;
}

/** One part of a candidate's name, split into the variation it names and that variation's subject.
 *  The longest registered name wins, so `livebase-block` is never `livebase` applied to `block`.
 *  Throws on a part no registered variation spells. */
export function parseVariation(part: string): { name: string; subject?: string } {
  if (BY_NAME.has(part)) {
    return { name: part };
  }
  let best: { name: string; subject: string } | undefined;
  for (const t of VARIATION_TOKENS) {
    if (t.subject === undefined || !part.startsWith(`${t.name}-`)) {
      continue;
    }
    const subject = part.slice(t.name.length + 1);
    if (
      new RegExp(`^(?:${t.subject.source})$`).test(subject) &&
      (best === undefined || t.name.length > best.name.length)
    ) {
      best = { name: t.name, subject };
    }
  }
  if (best === undefined) {
    throw new Error(`'${part}' names no registered variation (packages/core/src/variation-tokens.ts)`);
  }
  return best;
}

/** Does this candidate apply the variation `name`? An omitted `subject` matches any subject
 *  (`hasVariation(v, 'volatile')` is true on `volatile` and on `volatile-p0-p1`); `null` matches
 *  only the variation applied with no subject (`regcopy`, not `regcopy-ret`). Throws when `name` is
 *  not registered, when a string `subject` is given for a variation that takes none or does not fit
 *  its pattern, and when any of the candidate's own variations is unregistered. */
export function hasVariation(variations: readonly string[], name: string, subject?: string | null): boolean {
  const t = variationToken(name);
  if (
    typeof subject === 'string' &&
    (t.subject === undefined || !new RegExp(`^(?:${t.subject.source})$`).test(subject))
  ) {
    throw new Error(`'${name}' takes no subject '${subject}' (packages/core/src/variation-tokens.ts)`);
  }
  return variations.some((part) => {
    const p = parseVariation(part);
    return p.name === name && (subject === undefined || p.subject === (subject ?? undefined));
  });
}

/** Does this candidate apply the variations `names` consecutively, in that order — e.g.
 *  `['basefold', 'sinkinit']`? Each entry matches any subject. Throws like `hasVariation`. */
export function hasVariations(variations: readonly string[], names: readonly string[]): boolean {
  names.forEach(variationToken);
  if (names.length === 0) {
    throw new Error('hasVariations needs at least one name');
  }
  const parsed = variations.map((part) => parseVariation(part).name);
  for (let i = 0; i + names.length <= parsed.length; i++) {
    if (names.every((n, j) => parsed[i + j] === n)) {
      return true;
    }
  }
  return false;
}
