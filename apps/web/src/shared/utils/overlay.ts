// Behaviour for STACKED overlays: a tag chip inside the row drawer opens the definition drawer over
// it, and the naive per-drawer version breaks as soon as two are open.
//
//   - the scroll lock is REF-COUNTED, or closing the top drawer unlocks the page behind the one
//     still open.
//   - Escape closes only the TOPMOST. Two `window` listeners both fire, so one keypress would
//     dismiss the whole stack; the top overlay listens in the capture phase and stops the event
//     before the ones underneath see it.
//
// Which overlay is on top is tracked here, so neither drawer has to know the other exists.
import { useEffect, useRef, useSyncExternalStore } from 'react';

// ── the layer stack ─────────────────────────────────────────────────────────────────────────────

let stack: number[] = [];
let nextId = 1;
const subscribers = new Set<() => void>();

const emit = () => subscribers.forEach((f) => f());
const subscribe = (f: () => void) => {
  subscribers.add(f);
  return () => void subscribers.delete(f);
};
const topOfStack = () => stack[stack.length - 1];

/** True while this overlay is the newest one mounted. */
function useTopmost(): boolean {
  const id = useRef(0);
  if (id.current === 0) {
    id.current = nextId++;
  }
  const self = id.current;
  useEffect(() => {
    stack = [...stack, self];
    emit();
    return () => {
      stack = stack.filter((x) => x !== self);
      emit();
    };
  }, [self]);
  return useSyncExternalStore(subscribe, topOfStack) === self;
}

// ── the pieces ──────────────────────────────────────────────────────────────────────────────────

let locks = 0;

/** Lock body scroll while mounted; the page unlocks only when the LAST holder unmounts. */
function useScrollLock(): void {
  useEffect(() => {
    if (locks++ === 0) {
      document.body.style.overflow = 'hidden';
    }
    return () => {
      if (--locks === 0) {
        document.body.style.overflow = '';
      }
    };
  }, []);
}

function useEscapeToClose(onClose: () => void, topmost: boolean): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && topmost) {
        e.stopPropagation(); // exactly one overlay closes per keypress
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, { capture: topmost });
    return () => window.removeEventListener('keydown', onKey, { capture: topmost });
  }, [onClose, topmost]);
}

/** Everything a modal overlay needs: a ref-counted scroll lock, and Escape that closes only this
 *  overlay when it is the one on top. */
export function useOverlay(onClose: () => void): void {
  const topmost = useTopmost();
  useScrollLock();
  useEscapeToClose(onClose, topmost);
}
