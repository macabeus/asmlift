// The app's URL state lives in the FRAGMENT, not the query string: a playground permalink carries
// a whole `.s` file, and a query string is part of the HTTP request line (GitHub Pages answers
// 414 above ~8 KiB), while a fragment is never sent to the server at all.
//
// This is a nuqs adapter, so every parser, `useQueryState`, `useQueryStates`, `urlKeys`,
// `history: 'push'` and the ~20 params of this app keep working untouched — nuqs hands an adapter
// a `URLSearchParams` and takes one back, and its contract says nothing about where they live.
// Modelled on nuqs's own `adapters/react`, minus everything a Vite SPA has no use for: no RSC, no
// SSR snapshot, no provider props, no full-page-navigation branch, no history monkey-patching.
//
// The helpers above the glue are pure and tested (apps/web/test/hash-adapter.test.ts); the glue
// below touches `location`/`history` and is covered by the browser checks instead.
import { type unstable_AdapterOptions, unstable_createAdapterProvider } from 'nuqs/adapters/custom';
import { useRef, useSyncExternalStore } from 'react';

// --- the pure halves: strings in, strings out, no `location`, no `history`.

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

// --- the React glue: the only part that touches `location` and `history`.

/** `history.pushState` fires NEITHER `popstate` NOR `hashchange`, so this adapter's own writes are
 *  invisible to the DOM. This set is the channel that tells every mounted subscriber about them —
 *  nuqs keeps a private emitter for exactly this reason. */
const listeners = new Set<() => void>();

/** Module-level, therefore stable, which is what stops `useSyncExternalStore` resubscribing on
 *  every render. Three change sources, three disjoint causes: our own writes (the set above),
 *  Back/Forward (`popstate`), and a hand-edited address bar (`hashchange`). */
function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  window.addEventListener('popstate', onStoreChange);
  window.addEventListener('hashchange', onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener('popstate', onStoreChange);
    window.removeEventListener('hashchange', onStoreChange);
  };
}

/** Closes over nothing, so it is a module-level const rather than a `useMemo`. */
function updateUrl(search: URLSearchParams, options: Required<unstable_AdapterOptions>): void {
  const url = hashUrl(window.location.href, search);
  (options.history === 'push' ? history.pushState : history.replaceState).call(history, history.state, '', url);
  for (const listener of listeners) {
    listener();
  }
  if (options.scroll) {
    window.scrollTo({ top: 0 });
  }
}

function useHashAdapter(watchKeys: string[]) {
  const cache = useRef<{ key: string; search: URLSearchParams } | null>(null);
  // `useSyncExternalStore` compares snapshots with Object.is and throws "The result of getSnapshot
  // should be cached to avoid an infinite loop" on a fresh object each call, so cache on the
  // serialised watched keys — which also turns "the watched values did not change" into "the same
  // object", i.e. no re-render for a component watching `s` when `tab` moves.
  const snapshot = (): URLSearchParams => {
    const filtered = pickKeys(hashToSearchParams(window.location.hash), watchKeys);
    const key = filtered.toString();
    if (cache.current?.key === key) {
      return cache.current.search;
    }
    cache.current = { key, search: filtered };
    return filtered;
  };
  return { searchParams: useSyncExternalStore(subscribe, snapshot), updateUrl };
}

/** Drop-in replacement for nuqs's `NuqsAdapter`; wrap the app in it exactly the same way. */
export const NuqsHashAdapter = unstable_createAdapterProvider(useHashAdapter);
