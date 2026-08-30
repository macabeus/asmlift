// The pure half of the fragment transport: strings in, strings out. No `location`, no `history`,
// no React, and — enforced by the `hash-params-stays-pure` rule in .dependency-cruiser.cjs — no
// imports at all. That is what lets a pure page lib (benchmark/lib/explorer-url) reuse the
// `#`-strip without pulling in hash-adapter.ts, whose module top level builds a React provider.
//
// Why the app's URL state lives in the FRAGMENT: a playground permalink carries a whole `.s` file,
// and a query string is part of the HTTP request line (GitHub Pages answers 414 above ~8 KiB),
// while a fragment is never sent to the server at all.

/** `''` | `'#'` | `'#a=1'` | `'a=1'` -> params. Strips exactly one leading `#` — handing one to
 *  `URLSearchParams` would make an entry keyed `'#'` (and `'#a=1'` has no key `a` at all). */
export function hashToSearchParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/** href + params -> the URL to hand to `pushState`. Only the fragment changes; origin, path and
 *  any query survive.
 *
 *  `search.toString()`, not nuqs's `renderQueryString`: that one returns a `?`-prefixed string
 *  (so the fragment would read `#?view=…`) and calls `warnIfURLIsTooLong`, which measures a
 *  FRAGMENT as a query against `URL_MAX_LENGTH = 2e3` — a permanently false dev warning, firing
 *  exactly while testing the long links this transport exists to allow.
 *
 *  Taking the href as an argument is what keeps the write path testable without a DOM. */
export function hashUrl(href: string, search: URLSearchParams): string {
  const url = new URL(href);
  url.hash = search.toString();
  return url.toString();
}

/** Key isolation: a COPY of `search` holding only `keys`, so a hook watching `s` does not
 *  re-render when `tab` moves. nuqs's own `filterSearchParams` is internal (it appears in no
 *  `.d.ts` it ships), so this is a reimplementation of it with `copy` fixed to true.
 *  An empty `keys` means "watch everything": nuqs asks for that, and — as in nuqs — the input is
 *  then returned ALIASED rather than copied, which is safe only because every caller here passes
 *  a freshly parsed object. */
export function pickKeys(search: URLSearchParams, keys: string[]): URLSearchParams {
  if (keys.length === 0) {
    return search;
  }
  const filtered = new URLSearchParams(search);
  for (const key of Array.from(search.keys())) {
    if (!keys.includes(key)) {
      filtered.delete(key);
    }
  }
  return filtered;
}

/** The `useSyncExternalStore` snapshot, extracted from the hook so it can be tested in node.
 *  It compares snapshots with `Object.is` and throws *"The result of getSnapshot should be cached
 *  to avoid an infinite loop"* on a fresh object each call, so this caches on the serialised
 *  WATCHED keys. Two load-bearing properties, both pinned in hash-params.test.ts:
 *    - identity is PRESERVED when only an unwatched key moves (that is key isolation: no render);
 *    - identity CHANGES when a watched key moves (or the URL would update and the UI would not).
 *  The key is derived from the content, so a change of `watchKeys` that yields the same params
 *  correctly keeps the same object. One cache cell per caller — hence a factory. */
export function createSnapshotCache(): (hash: string, watchKeys: string[]) => URLSearchParams {
  let cached: { key: string; search: URLSearchParams } | null = null;
  return (hash, watchKeys) => {
    const filtered = pickKeys(hashToSearchParams(hash), watchKeys);
    const key = filtered.toString();
    if (cached?.key === key) {
      return cached.search;
    }
    cached = { key, search: filtered };
    return filtered;
  };
}
