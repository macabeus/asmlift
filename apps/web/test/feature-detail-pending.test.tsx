// A `pending` definition is one the vocabulary carries AHEAD of the rows that will use it. The
// picker filters those out, but a see-also link reaches one in a click — and the drawer's "In this
// benchmark" panel would then read `0 rows` above a button whose only effect is to empty the table.
// So the panel says what a pending tag is, and offers no filter.
import { FEATURES } from '@asmlift/bench-schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { FeatureDetail } from '../src/pages/benchmark/components/FeatureDetail';

const html = (id: string) =>
  renderToStaticMarkup(
    <FeatureDetail id={id} rows={[]} onClose={() => {}} onOpenFeature={() => {}} onExplore={() => {}} />,
  );

const pending = FEATURES.find((f) => f.pending)!;
const live = FEATURES.find((f) => !f.pending && !f.deprecated)!;

describe('the definition drawer on a tag with no rows yet', () => {
  test('there is a pending definition to render', () => {
    expect(pending).toBeDefined();
  });

  test('a pending tag says so, and offers no filter that would empty the table', () => {
    const out = html(pending.id);
    expect(out).toContain('No row carries this tag yet');
    expect(out).not.toContain('Filter the table to these');
  });

  test('a live tag still offers its filter', () => {
    const out = html(live.id);
    expect(out).toContain('Filter the table to these');
    expect(out).not.toContain('No row carries this tag yet');
  });

  test('a see-also link can reach a pending definition, which is why the panel matters', () => {
    const reachable = FEATURES.flatMap((f) =>
      (f.seeAlso ?? []).filter((s) => FEATURES.some((g) => g.id === s && g.pending)),
    );
    expect(reachable.length).toBeGreaterThan(0);
  });
});
