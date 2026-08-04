// Where <HoverCard> puts its card — the part of a floating element a reader notices when it is
// wrong.
import { describe, expect, it } from 'vitest';

import { hoverCardPosition } from '../src/shared/components/hover-card-position';

const VIEWPORT = { width: 1000, height: 800 };
const WIDTH = 288;
const MIN_BELOW = 180;

const at = (left: number, top: number, height = 20) =>
  hoverCardPosition({ left, top, bottom: top + height }, VIEWPORT, WIDTH, MIN_BELOW);

describe('hoverCardPosition', () => {
  it('opens below the anchor when there is room', () => {
    const pos = at(100, 200);
    expect(pos.top).toBe(226); // anchor bottom + 6
    expect(pos.bottom).toBeUndefined();
    expect(pos.left).toBe(100);
  });

  it('flips above when the card would run off the bottom', () => {
    // an anchor in the last table row: 800 - 770 = 30px below, far under the 180 it needs
    const pos = at(100, 750);
    expect(pos.top).toBeUndefined();
    expect(pos.bottom).toBe(56); // viewport height - anchor top + 6
  });

  it('flips exactly at the threshold, not one pixel early', () => {
    expect(at(100, 800 - MIN_BELOW - 20 - 1).top).toBeDefined(); // 181px below — fits
    expect(at(100, 800 - MIN_BELOW - 20).top).toBeUndefined(); //    180px below — flips
  });

  it('clamps the left edge so a chip in the last column stays fully visible', () => {
    // aligning with this anchor would put the right edge at 1248, off a 1000px viewport
    expect(at(960, 200).left).toBe(1000 - WIDTH - 8);
  });

  it('never leaves the left margin, even on a viewport narrower than the card', () => {
    const pos = hoverCardPosition({ left: 4, top: 10, bottom: 30 }, { width: 200, height: 800 }, WIDTH, MIN_BELOW);
    expect(pos.left).toBe(8);
  });
});
