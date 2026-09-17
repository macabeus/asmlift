// A `pending` definition is one the vocabulary carries AHEAD of the rows that will use it. The
// picker filters those out, but a see-also link reaches one in a click — and the drawer's "In this
// benchmark" panel would then read `0 rows` above a button whose only effect is to empty the table.
// So the panel says what a pending tag is, and offers no filter.
//
// WHICH TAGS ARE PENDING IS DATA, and today none is: the GameCube rounds landed the first carrier of
// every one. The drawer's two shapes are what this pins, so the vocabulary is STUBBED — a test that
// went vacuous the moment the last flag was dropped would stop guarding the branch exactly when
// nothing else did, and the next tag authored ahead of its rows would find it unguarded.
import { FEATURES, type FeatureDef } from '@asmlift/bench-schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

/** a definition the vocabulary does not carry, minted pending so the drawer's other shape renders */
const PROBE = 'pending-probe';
const live = FEATURES.find((f) => !f.pending && !f.deprecated)!;

vi.mock('@asmlift/bench-schema', async (importOriginal) => {
  const real = await importOriginal<typeof import('@asmlift/bench-schema')>();
  const base = real.FEATURES.find((f) => !f.pending && !f.deprecated)!;
  const probe: FeatureDef = { ...base, id: 'pending-probe', pending: true, seeAlso: [] };
  return { ...real, FEATURE_BY_ID: new Map([...real.FEATURE_BY_ID, ['pending-probe', probe]]) };
});

const { FeatureDetail } = await import('../src/pages/benchmark/components/FeatureDetail');

const html = (id: string) =>
  renderToStaticMarkup(
    <FeatureDetail id={id} rows={[]} onClose={() => {}} onOpenFeature={() => {}} onExplore={() => {}} />,
  );

describe('the definition drawer on a tag with no rows yet', () => {
  test('a pending tag says so, and offers no filter that would empty the table', () => {
    const out = html(PROBE);
    expect(out).toContain('No row carries this tag yet');
    expect(out).not.toContain('Filter the table to these');
  });

  test('a live tag still offers its filter', () => {
    const out = html(live.id);
    expect(out).toContain('Filter the table to these');
    expect(out).not.toContain('No row carries this tag yet');
  });
});
