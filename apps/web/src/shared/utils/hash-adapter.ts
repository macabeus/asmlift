// The React glue of the fragment transport: the only part that touches `location` and `history`.
// The pure helpers it is built on live in hash-params.ts and are unit-tested there.
//
// This is a nuqs adapter, so every parser, `useQueryState`, `useQueryStates`, `urlKeys`,
// `history: 'push'` and the ~20 params of this app keep working untouched — nuqs hands an adapter
// a `URLSearchParams` and takes one back, and its contract says nothing about where they live.
// Modelled on nuqs's own `adapters/react`, minus everything a Vite SPA has no use for: no RSC, no
// SSR snapshot, no provider props, no full-page-navigation branch, no history monkey-patching.
import { type unstable_AdapterOptions, unstable_createAdapterProvider } from 'nuqs/adapters/custom';
import { useRef, useSyncExternalStore } from 'react';

import { hashToSearchParams, hashUrl, pickKeys } from './hash-params';

/** `history.pushState` fires NEITHER `popstate` NOR `hashchange`, so this adapter's own writes are
 *  invisible to the DOM. This set is the channel that tells every mounted subscriber about them —
 *  nuqs keeps a private emitter for exactly this reason. */
const listeners = new Set<() => void>();

/** Module-level, therefore stable, which is what stops `useSyncExternalStore` resubscribing on
 *  every render. Three change sources, three disjoint causes: our own writes (the set above),
 *  Back/Forward (`popstate`), and a hand-edited address bar (`hashchange`).
 *
 *  A `history.pushState` by code OUTSIDE this adapter is therefore invisible until the next
 *  event — nuqs's own React adapter behaves identically, which is what its opt-in
 *  `enableHistorySync`/`patchHistory` exists for, and neither adapter enables it. Nothing in this
 *  app writes history out of band, and the next adapter write re-syncs rather than clobbering,
 *  because `getSearchParamsSnapshot` below re-reads the live hash. */
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

/** Closes over nothing, so it is a module-level const rather than a `useMemo`.
 *
 *  nuqs's own adapter also resets its write queue on `popstate` (its internal `QueueReset`); that
 *  module is not exported, so this adapter drops it and inherits `autoResetQueueOnUpdate ?? true`
 *  (nuqs's default), i.e. only the popstate-specific abort is lost. Browser check 2 — one Back
 *  across a batched Explorer preset — is the observation that no stale queued write lands. */
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

/** The BASE every write is merged onto. nuqs's default is
 *  `new URLSearchParams(location.search)` (its `getSearchParamsSnapshotFromLocation`), which is
 *  empty under this transport — so without this, a write of one key would drop every OTHER key
 *  from the URL. Found in the browser, not by a test: clicking an Overview aggregate turned
 *  `#view=benchmark` into a URL with no `view` at all.
 *
 *  Audited on 2.10.1: `dist/index.js:533` is the ONE place nuqs still reads `location.search`
 *  behind an adapter's back (`grep -rn 'location\.search' node_modules/nuqs/dist/*.js`, ignoring
 *  the react-router adapter and the opt-in history patch). It is inert here because it sits in an
 *  `onCommittedPathname ||` short-circuit and we supply no `adapter.pathname`, so nuqs compares
 *  `location.pathname`, which never changes under fragment routing. Re-check on a nuqs upgrade. */
function getSearchParamsSnapshot(): URLSearchParams {
  return hashToSearchParams(window.location.hash);
}

function useHashAdapter(watchKeys: string[]) {
  const cache = useRef<{ key: string; search: URLSearchParams } | null>(null);
  // `useSyncExternalStore` compares snapshots with Object.is and throws "The result of getSnapshot
  // should be cached to avoid an infinite loop" on a fresh object each call, so cache on the
  // serialised watched keys — which also turns "the watched values did not change" into "the same
  // object", i.e. no re-render for a component watching `s` when `tab` moves.
  const snapshot = (): URLSearchParams => {
    const filtered = pickKeys(getSearchParamsSnapshot(), watchKeys);
    const key = filtered.toString();
    if (cache.current?.key === key) {
      return cache.current.search;
    }
    cache.current = { key, search: filtered };
    return filtered;
  };
  return {
    searchParams: useSyncExternalStore(subscribe, snapshot),
    updateUrl,
    getSearchParamsSnapshot,
  };
}

/** Drop-in replacement for nuqs's `NuqsAdapter`; wrap the app in it exactly the same way. */
export const NuqsHashAdapter = unstable_createAdapterProvider(useHashAdapter);
