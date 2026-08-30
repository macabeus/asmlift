// The progress BAR as it actually renders. apps/web has no jsdom and no @testing-library, but
// these components are plain functions of props, so `renderToStaticMarkup` gives the real markup
// without a DOM — enough to hold the two rules a bar breaks silently:
//   • an INDETERMINATE phase emits no `aria-valuenow` (that omission is the ARIA spelling of
//     indeterminate) and no fabricated denominator anywhere in the markup;
//   • a determinate bar's `aria-valuenow` is the EXACT count while its fill width never reads 100 %,
//     because sorting and the structured clone of a six-figure array still follow the last tick.
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
