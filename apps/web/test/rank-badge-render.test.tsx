// The progress BAR as it actually renders. apps/web has no jsdom and no @testing-library, but
// these components are plain functions of props, so `renderToStaticMarkup` gives the real markup
// without a DOM — enough to hold the two rules a bar breaks silently:
//   • an INDETERMINATE phase emits no `aria-valuenow` (that omission is the ARIA spelling of
//     indeterminate) and no fabricated denominator anywhere in the markup;
//   • a determinate bar's `aria-valuenow` is the EXACT count while its fill width never reads 100 %,
//     because sorting and the structured clone of a six-figure array still follow the last tick;
//   • the widget has an accessible NAME and the visible sentence is not inside it (`progressbar` is
//     a children-presentational role — anything inside it is pruned from the a11y tree);
//   • the indeterminate stripe only exists under `motion-safe`, because parked it is pixel-identical
//     to a determinate 33 % bar.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { RankBadge, RankCandidates } from '../src/pages/playground/RankPanel';
import type { Ranking } from '../src/pages/playground/useRanking';

const html = (r: Ranking) => renderToStaticMarkup(<RankBadge ranking={r} />);

describe('RankBadge progress', () => {
  test('an indeterminate phase is a progressbar with a text alternative and NO valuenow', () => {
    const out = html({ status: 'loading', phase: 'enumerating' });
    expect(out).toContain('role="progressbar"');
    expect(out).not.toContain('aria-valuenow');
    expect(out).not.toContain('aria-valuemax');
    expect(out).toContain('enumerating candidate spellings');
    expect(out).toContain('aria-valuetext="enumerating candidate spellings…"');
  });

  test('the progressbar has an accessible NAME, and the visible sentence sits OUTSIDE it', () => {
    // `progressbar` is children-presentational: a label inside it is pruned from the accessibility
    // tree, leaving an unnamed widget carrying only aria-valuetext. The sentence is a sibling.
    const out = html({ status: 'loading', phase: 'enumerating' });
    expect(out).toContain('aria-label="candidate ranking"');
    expect(out.indexOf('<span>enumerating candidate spellings…</span>')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('<span>enumerating')).toBeLessThan(out.indexOf('role="progressbar"'));
  });

  test('the indeterminate stripe TRAVELS or is not rendered — never a parked third of a track', () => {
    // animate-pulse fades opacity only, so `w-1/3 animate-pulse` was pixel-identical to a
    // determinate 33 % fill for the whole 62 s enumeration. It travels under motion-safe, and under
    // prefers-reduced-motion the track is simply empty.
    const out = html({ status: 'loading', phase: 'enumerating' });
    // Matched on the STRIPE's own class list: the track around it carries `overflow-hidden`, so a
    // bare `toContain('hidden')` passes even with the stripe's `hidden` deleted — i.e. with the
    // reduced-motion rule this test names broken.
    expect(out).toMatch(/class="hidden [^"]*motion-safe:block[^"]*motion-safe:animate-rank-indeterminate/);
    expect(out).not.toContain('animate-pulse');
  });

  test("the determinate width transition is motion-gated too — this is the app's only animation", () => {
    const out = html({ status: 'loading', phase: 'scoring', done: 5, total: 9 });
    expect(out).toContain('motion-safe:transition-[width]');
    expect(out).not.toMatch(/(?<!motion-safe:)transition-\[width\]/); // never ungated
  });

  test('scoring with a real total is determinate: exact aria counts, fill below 100%', () => {
    const out = html({ status: 'loading', phase: 'scoring', done: 117760, total: 117760 });
    expect(out).toContain('aria-valuemin="0"');
    expect(out).toContain('aria-valuemax="117760"');
    expect(out).toContain('aria-valuenow="117760"'); // exact, not clamped
    expect(out).toContain('scoring 117,760 / 117,760 candidates'); // grouped for the eye
    expect(out).not.toMatch(/width:\s*100%/); // the pixels never say "finished" over live work
    expect(out).toMatch(/width:\s*99%/);
  });

  test('the settled states carry no progressbar at all', () => {
    expect(html({ status: 'error', error: 'boom' })).not.toContain('progressbar');
    expect(html({ status: 'off' })).toBe('');
  });

  test('the Pipeline card shows the SAME sentence as the badge — one helper, no drift', () => {
    const r: Ranking = { status: 'loading', phase: 'scoring', done: 5, total: 9 };
    expect(renderToStaticMarkup(<RankCandidates ranking={r} />)).toContain('scoring 5 / 9 candidates');
  });
});
