// The app's URL state lives in the FRAGMENT, not the query string: a playground permalink carries
// a whole `.s` file, and a query string is part of the HTTP request line (GitHub Pages answers
// 414 above ~8 KiB), while a fragment is never sent to the server at all.
//
// These are the pure, testable halves of the nuqs adapter below: strings in, strings out, no
// `location`, no `history`.

/** `''` | `'#'` | `'#a=1'` | `'a=1'` -> params. Strips exactly one leading `#` — handing one to
 *  `URLSearchParams` would make an entry keyed `'#'` (and `'#a=1'` has no key `a` at all). */
export function hashToSearchParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/** params -> the fragment WITHOUT its `#`; `''` for an empty set, which clears the fragment. */
export function searchParamsToHash(search: URLSearchParams): string {
  return search.toString();
}

/** href + params -> the URL to hand to `pushState`. Only the fragment changes; origin, path and
 *  any query survive. Taking the href as an argument is what keeps the write path testable. */
export function hashUrl(href: string, search: URLSearchParams): string {
  const url = new URL(href);
  url.hash = searchParamsToHash(search);
  return url.toString();
}

/** Key isolation: a COPY of `search` holding only `keys`, so a hook watching `s` does not
 *  re-render when `tab` moves. nuqs's own `filterSearchParams` is internal (it appears in no
 *  `.d.ts` it ships), so this is a reimplementation of it with `copy` fixed to true.
 *  An empty `keys` means "watch everything", which is what nuqs asks for. */
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
