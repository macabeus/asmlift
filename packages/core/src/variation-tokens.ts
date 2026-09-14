// asmlift — the VARIATION REGISTRY: every variation a candidate's name can carry, as data.
//
// A candidate is named by the variations it applied, an ordered list: its signedness first, then
// its lift, structure and respell variations, then the symbol-map variation, e.g.
// `['unsigned', 'defsite', 'raw-globals']`. Joined with `/` — `unsigned/defsite/raw-globals` — the
// list is how a name is PRINTED and typed back (`bench fan --show`), and nothing else: the list is
// the name. A few variations are applied to something the entry has to name — `coalesce-v0-v1`
// merges `v0` into `v1`, `volatile-p1` qualifies `p1` — and that trailing `-…` is the variation's
// SUBJECT.
//
// WHY A CLOSED TABLE. The entries are minted as `/`-prefixed suffix strings in `rank.ts` and
// `rank-variations.ts`, several of them parameterized (`${suffix}-${c.merged}`, `homesplit-${tag}`,
// `sense-${m}`), so the set of names is open by construction and nothing but this table closes it.
// Three checks hold the table to the code: a static scan of the mint literals
// (`packages/core/test/variation-tokens.test.ts`), every name the committed benchmark artifact
// publishes, and every name the enumerated corpus mints (both in `apps/benchmark/test`). What each
// name means to a reader is `variation-definitions.ts`, keyed by `VariationName` below.
//
// WHY A TEST PREDICATE GOES THROUGH HERE. A predicate written as a substring —
// `name.includes('/regcopy-ret')` inside `.toEqual([])` — keeps passing after the variation is
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
 *  behaviour: enumeration order is decided in `rank.ts` and `rank-variations.ts`, never here. */
const TOKENS = [
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
  { name: 'coalesce', variationKind: 'respell', subject: LOCALS },
  { name: 'indexed', variationKind: 'respell' },
  { name: 'livebase', variationKind: 'respell' },
  { name: 'livebase-block', variationKind: 'respell' },
  { name: 'basefold', variationKind: 'respell' },
  { name: 'unfolded', variationKind: 'respell' },
  { name: 'orderbase', variationKind: 'respell' },
  { name: 'orderbase-scoped', variationKind: 'respell' },
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
] as const satisfies readonly VariationToken[];

/** A registered variation's name. `variation-definitions.ts` keys its definitions by this type, so a
 *  registry entry without a definition, or a definition for a name the registry does not hold, is a
 *  type error. */
export type VariationName = (typeof TOKENS)[number]['name'];

export const VARIATION_TOKENS: readonly (VariationToken & { name: VariationName })[] = TOKENS;

/** A registered variation that names what it was applied to. */
export type SubjectVariationName = Extract<(typeof TOKENS)[number], { subject: RegExp }>['name'];

declare const subjectFitted: unique symbol;

/** A subject-taking variation applied to a subject, `coalesce-v0-v1`. Only `withSubject` makes one,
 *  so its subject fits the registered pattern. */
export type SubjectVariation = `${SubjectVariationName}-${string}` & { readonly [subjectFitted]: true };

/** One part of a candidate's name as enumeration mints it. */
export type Variation = VariationName | SubjectVariation;

const BY_NAME = new Map<string, VariationToken & { name: VariationName }>(VARIATION_TOKENS.map((t) => [t.name, t]));

/** Each subject pattern, anchored. */
const SUBJECT = new Map<string, RegExp>(
  VARIATION_TOKENS.flatMap((t) => (t.subject === undefined ? [] : [[t.name, new RegExp(`^(?:${t.subject.source})$`)]])),
);

/** `name` applied to `subject`: `withSubject('coalesce', 'v0-v1')` is `coalesce-v0-v1`. Throws on a
 *  subject the registered pattern does not fit. */
export function withSubject(name: SubjectVariationName, subject: string): SubjectVariation {
  if (!SUBJECT.get(name)!.test(subject)) {
    throw new Error(`'${name}' takes no subject '${subject}' (packages/core/src/variation-tokens.ts)`);
  }
  return `${name}-${subject}` as SubjectVariation;
}

/** The registry entry for a name, or a throw naming what is registered. */
export function variationToken(name: string): VariationToken & { name: VariationName } {
  const t = BY_NAME.get(name);
  if (t === undefined) {
    throw new Error(`'${name}' is not a registered variation (packages/core/src/variation-tokens.ts)`);
  }
  return t;
}

/** One part of a candidate's name, split into the variation it names and that variation's subject.
 *  The longest registered name wins, so `livebase-block` is never `livebase` applied to `block`.
 *  Throws on a part no registered variation spells. */
export function parseVariation(part: string): { name: VariationName; subject?: string } {
  const exact = BY_NAME.get(part);
  if (exact !== undefined) {
    return { name: exact.name };
  }
  let best: { name: VariationName; subject: string } | undefined;
  for (const t of VARIATION_TOKENS) {
    if (t.subject === undefined || !part.startsWith(`${t.name}-`)) {
      continue;
    }
    const subject = part.slice(t.name.length + 1);
    if (SUBJECT.get(t.name)!.test(subject) && (best === undefined || t.name.length > best.name.length)) {
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
  if (typeof subject === 'string' && !(SUBJECT.get(t.name)?.test(subject) ?? false)) {
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

/** A candidate's variations as ONE string, `/`-joined: how a name is printed, typed back, hashed
 *  and used as a key. Throws on an empty entry and on an entry that contains `/`, so the join is
 *  injective — `['a/b']` and `['a', 'b']` can never print, key or hash alike. */
export function joinVariations(variations: readonly string[]): string {
  if (variations.length === 0) {
    throw new Error('a candidate applies at least its signedness variation');
  }
  for (const v of variations) {
    if (v === '' || v.includes('/')) {
      throw new Error(`'${v}' cannot be one variation: an entry is non-empty and holds no '/'`);
    }
  }
  return variations.join('/');
}

/** The inverse of `joinVariations`: a printed name (`unsigned/defsite`) back to its variations.
 *  Throws on an empty entry (`unsigned//defsite`, a leading or trailing `/`). */
export function splitVariations(name: string): string[] {
  const variations = name.split('/');
  joinVariations(variations);
  return variations;
}

/** How many of one fan's candidates carry one variation. `candidates` counts the whole fan —
 *  scored, dropped and withheld alike — and `dropped` and `withheld` are the refused part of that
 *  count, each absent when 0. */
export interface VariationTally {
  candidates: number;
  dropped?: number;
  withheld?: number;
}

interface NamedCandidate {
  variations: readonly string[];
}

/** Every variation a fan carried, keyed by its REGISTERED name, with how many of the fan's
 *  candidates carry it. A variation applied to a subject counts under its registered name
 *  (`coalesce-v0-v1` and `coalesce-v2-v3` are both `coalesce`), and a candidate counts once under
 *  each name it carries however many subjects it applies it to.
 *
 *  `fan` is ranking's three-way partition, which puts every enumerated candidate in exactly one
 *  list, so each signedness entry's `candidates` sums with the other's to the fan size.
 *
 *  A tally, not a factorisation: enumeration gates prune the fan, so the counts do not multiply to
 *  its size. Keys run in kind order, then by name, so two tallies of one fan serialize to the same
 *  bytes whatever order the fan was listed in. Throws on a variation the registry does not hold. */
export function tallyFanVariations(fan: {
  candidates: readonly NamedCandidate[];
  dropped: readonly NamedCandidate[];
  withheld: readonly NamedCandidate[];
}): Record<string, VariationTally> {
  const registeredName = new Map<string, string>();
  const nameOf = (part: string): string => {
    let name = registeredName.get(part);
    if (name === undefined) {
      name = parseVariation(part).name;
      registeredName.set(part, name);
    }
    return name;
  };
  const counts = new Map<string, { candidates: number; dropped: number; withheld: number }>();
  const add = (list: readonly NamedCandidate[], refusal: 'dropped' | 'withheld' | undefined): void => {
    for (const c of list) {
      for (const name of new Set(c.variations.map(nameOf))) {
        let n = counts.get(name);
        if (n === undefined) {
          n = { candidates: 0, dropped: 0, withheld: 0 };
          counts.set(name, n);
        }
        n.candidates++;
        if (refusal !== undefined) {
          n[refusal]++;
        }
      }
    }
  };
  add(fan.candidates, undefined);
  add(fan.dropped, 'dropped');
  add(fan.withheld, 'withheld');
  const kindIndex = (name: string): number => VARIATION_KINDS.indexOf(variationToken(name).variationKind);
  const names = [...counts.keys()].sort((a, b) => kindIndex(a) - kindIndex(b) || (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(
    names.map((name) => {
      const n = counts.get(name)!;
      return [
        name,
        {
          candidates: n.candidates,
          ...(n.dropped ? { dropped: n.dropped } : {}),
          ...(n.withheld ? { withheld: n.withheld } : {}),
        },
      ];
    }),
  );
}
