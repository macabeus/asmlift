// Floating content shown next to whatever it wraps, on hover or keyboard focus — for anchors whose
// explanation needs markup or a link, which the native `title` cannot hold.
//
// Portalled to <body> and positioned from the anchor's viewport rect, because anchors sit in scroll
// containers: the benchmark's table wrapper is `overflow-x-auto`, and a container that is `auto` on
// one axis stops being `visible` on the other, so an absolutely positioned card would be clipped by
// the row it belongs to.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { type CardPosition, hoverCardPosition } from './hover-card-position';

/** Grace period before closing, so the pointer can travel from the anchor onto the card. */
const CLOSE_DELAY_MS = 120;
/** Below this much room underneath, the card opens upward instead. */
const MIN_SPACE_BELOW = 180;

export function HoverCard({
  content,
  children,
  width = 288,
  className = '',
}: {
  /** what the card shows — omit to render the anchor with no card at all */
  content?: ReactNode;
  children: ReactNode;
  width?: number;
  /** classes for the inline wrapper around `children` */
  className?: string;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<CardPosition | null>(null);
  const isOpen = pos !== null;
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Recompute the card's position from the anchor's current rect. */
  const measure = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) {
      setPos(hoverCardPosition(rect, { width: window.innerWidth, height: window.innerHeight }, width, MIN_SPACE_BELOW));
    }
  };
  const open = () => {
    clearTimeout(closing.current);
    measure();
  };
  const close = () => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => setPos(null), CLOSE_DELAY_MS);
  };
  // Deferred out of the current dispatch: this runs in the capture phase, so unmounting
  // synchronously would remove the element whose own bubble-phase onClick has not run yet.
  const dismiss = () => {
    clearTimeout(closing.current);
    setTimeout(() => setPos(null), 0);
  };

  useEffect(() => () => clearTimeout(closing.current), []);

  // Scrolling or resizing invalidates a viewport measurement, so RE-MEASURE rather than dismiss.
  // The listener must capture (an anchor inside a scroll container moves when that container
  // scrolls, and those events do not bubble to window), which means it hears every scroll on the
  // page — including the ones an `overflow-auto` code pane emits as its highlighting resolves.
  // Re-measuring makes those harmless; dismissing on them makes the card vanish unprompted.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [isOpen]);

  return (
    <span
      ref={anchor}
      onMouseEnter={content ? open : undefined}
      onMouseLeave={content ? close : undefined}
      onFocus={content ? open : undefined}
      onBlur={content ? close : undefined}
      onClickCapture={dismiss}
      className={`inline-block ${className}`}
    >
      {children}
      {content &&
        pos &&
        createPortal(
          <div
            role="tooltip"
            onMouseEnter={open}
            onMouseLeave={close}
            style={{ position: 'fixed', ...pos, width }}
            // above the detail drawers (z-40), so an anchor inside one can still explain itself
            className="z-50 rounded-lg border border-slate-700 bg-slate-900 p-3 text-left shadow-xl"
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
