// rank.ts states several of its arguments as PROPERTIES of the published winner labels — "no
// label carries both of these", "this arm's winners all ride inside that pairing", "exactly one
// row wins under this axis". Written as prose those decay silently: the corpus grows, an axis is
// widened, and the paragraph still reads as verified because nothing re-derives it.
//
// So each property is asserted here, against the COMMITTED artifact, and each message names the
// rank.ts paragraph it guards. A count is deliberately not what is asserted (a count moves with
// every row added and would fail for reasons the paragraph is not about) — what is asserted is
// the property the paragraph's argument rests on.
//
// WHAT THIS CANNOT DO, the same limit citations.test.ts states for itself: results.json holds
// each row's winner, not what the row would win with an axis ablated. A green assertion here says
// the property still holds, never that the mechanism behind it is still load-bearing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const rows = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'results', 'results.json'), 'utf8')).results as {
  id: string;
  asmlift?: { candidateLabel?: string };
}[];

/** Every row that published a winning label, as `id` → `candidateLabel`. A row with no winner
 *  (declined, or every candidate failed to build) says nothing about any of these properties. */
const winners = rows.flatMap((r) =>
  r.asmlift?.candidateLabel !== undefined ? [{ id: r.id, label: r.asmlift.candidateLabel }] : [],
);

const carrying = (token: string) => winners.filter((w) => w.label.includes(token));

describe('the winner-label properties rank.ts argues from', () => {
  it('nothing at all published a label, or the artifact is not the one these assertions are about', () => {
    // The guard on every assertion below: they are all "no winner does X", which an empty list
    // satisfies vacuously.
    expect(winners.length).toBeGreaterThan(0);
  });

  it('no winner carries both /orderbase and /setup-args — the corpus gate cannot see the per-FUNCTION licence reading', () => {
    // Guards the paragraph at the `admissions` roster in rank.ts, "AND THE SAME SKIP KEYED ON THE
    // LICENCE ITSELF WOULD BUY NOTHING": three wrong readings of an `orderLicensedGlobals` skip
    // delete the same four candidates, and a per-row label/source diff catches two of them. It
    // cannot catch the PER-FUNCTION one, and this is why — that reading needs both tokens in one
    // label to be observable, and no published winner carries both.
    const both = winners.filter((w) => w.label.includes('/orderbase') && w.label.includes('/setup-args'));
    expect(both.map((w) => `${w.id}  ${w.label}`)).toEqual([]);
  });

  it('every /unreduce and /ptr-field winner rides inside a /vol-store pairing', () => {
    // Guards the `/vol-store` × `/unreduce` (× `/ptr-field`) pairing note: "neither of the two
    // levers ever wins one of the artifact's rows alone". The standalone `respell`s are kept so a
    // lever can LOSE on its own terms, which is only observable while the single-lever spelling is
    // in the fan — but a winner would mean the note's premise had changed.
    const unpaired = [...carrying('/unreduce'), ...carrying('/ptr-field')].filter(
      (w) => !w.label.includes('/vol-store'),
    );
    expect(unpaired.map((w) => `${w.id}  ${w.label}`)).toEqual([]);
  });

  it('exactly one winner carries /no-ptr-elem, and it is the synthetic row the axis was built for', () => {
    // Guards the `/no-ptr-elem` census paragraph, "EXACTLY ONE WINNING LABEL IN THE ARTIFACT
    // CARRIES `/no-ptr-elem` — READ THAT ONE, NOT A ZERO". The paragraph's whole point is that a
    // zero over the REAL tier is 0 of ONE reaching row, so the axis's two-sidedness has to be read
    // off the synthetic row that inhabits it. A second winner would not be a failure of the axis,
    // but it would make that paragraph's framing wrong.
    expect(carrying('/no-ptr-elem').map((w) => w.id)).toEqual(['synthetic:ptrelem:agbcc']);
  });
});
