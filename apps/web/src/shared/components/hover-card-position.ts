// Where a <HoverCard> puts its card. Pure, so it can be unit-tested without a DOM.

export interface Viewport {
  width: number;
  height: number;
}

/** A fixed-position box: `top` XOR `bottom` is set, depending on which way the card opened. */
export interface CardPosition {
  left: number;
  top?: number;
  bottom?: number;
}

/** Distance kept from the viewport edges. */
const MARGIN = 8;
/** Gap between the anchor and the card. */
const OFFSET = 6;

/** Place a card of `width` next to `anchor`, in viewport (fixed-position) coordinates: below when
 *  at least `minSpaceBelow` pixels remain there, flipped above otherwise, with the left edge
 *  clamped into the viewport so a chip in the last column stays readable. */
export function hoverCardPosition(
  anchor: { top: number; bottom: number; left: number },
  viewport: Viewport,
  width: number,
  minSpaceBelow: number,
): CardPosition {
  const below = viewport.height - anchor.bottom > minSpaceBelow;
  // `Math.max` last, so a viewport narrower than the card yields the left margin, not a negative
  const left = Math.max(MARGIN, Math.min(anchor.left, viewport.width - width - MARGIN));
  return below ? { left, top: anchor.bottom + OFFSET } : { left, bottom: viewport.height - anchor.top + OFFSET };
}
