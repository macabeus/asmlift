// The pure half of the fragment transport: strings in, strings out, and — enforced by the
// `hash-params-stays-pure` rule in .dependency-cruiser.cjs — no imports at all, so every decision
// it makes runs in vitest's node environment, the only one apps/web has. React glue: hash-adapter.
//
// Why the FRAGMENT: a playground permalink carries a whole `.s` file, and a query string is part
// of the HTTP request line — GitHub Pages answers `414 URI Too Long` above ~8,180 characters,
// while 200,000 characters of fragment come back 200, never having been sent.

/** Strips exactly one leading `#`: handing one to `URLSearchParams` makes an entry keyed `'#'`,
 *  and `'#a=1'` then has no key `a` at all. */
export function hashToSearchParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/** The URL to hand to `pushState`: `href` with `search` as its fragment and the rest of it — the
 *  query string included — untouched. This app reads no query param, and ignoring someone else's
 *  is not the same as deleting it. `href` is an argument so the write path stays testable.
 *
 *  `search.toString()`, not nuqs's `renderQueryString`: that one returns a `?`-prefixed string (so
 *  the fragment would read `#?view=…`) and calls `warnIfURLIsTooLong`, which measures a FRAGMENT
 *  against `URL_MAX_LENGTH = 2e3` — a false dev warning firing on exactly the long links this
 *  transport exists to allow. */
export function hashUrl(href: string, search: URLSearchParams): string {
  const url = new URL(href);
  url.hash = search.toString();
  return url.toString();
}

/** Key isolation: a COPY of `search` holding only `keys`, so a hook watching `s` does not re-render
 *  when `tab` moves. nuqs's own `filterSearchParams` is internal (it appears in no `.d.ts` it
 *  ships), so this reimplements it. Empty `keys` means "watch everything" — nuqs asks for that —
 *  and then returns the input ALIASED, safe only because every caller passes a fresh parse. */
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

/** The `useSyncExternalStore` snapshot. That hook compares with `Object.is` and throws *"The result
 *  of getSnapshot should be cached to avoid an infinite loop"* on a fresh object each call, so this
 *  caches on the serialised WATCHED keys: identity survives a move of an unwatched key (that is the
 *  isolation — no render), and changes when a watched one moves (or the URL would update and the UI
 *  would not). One cell per caller, hence a factory. */
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
