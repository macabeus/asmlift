import { FEATURE_BY_ID, type FunctionResult, type Outcome } from '@asmlift/bench-schema';

import { featureOutcomes, headline, outcomeCounts, outcomesBy } from '../lib/stats';
import { LOC_BUCKETS, locBucketOf, readabilityStats } from '../lib/stats';
import { OUTCOME_COLOR, OUTCOME_GLOSS, OUTCOME_LABEL, OUTCOME_ORDER, TOOLCHAIN_LABEL, TOOLCHAIN_ORDER } from '../theme';
import type { ExplorerPreset } from './Explorer';
import { OutcomeBars, OutcomeLegend } from './charts/OutcomeBars';
import { Card, Panel } from './ui/Section';
import { Stat } from './ui/Stat';

const TIER_LABEL = (k: string) => (k === 'synthetic' ? 'Synthetic' : 'Real');

export function Overview({
  rows,
  onExplore,
}: {
  rows: FunctionResult[];
  /** deep-link into the Function Explorer with a filter preset (charts + tiles are clickable) */
  onExplore: (preset: ExplorerPreset) => void;
}) {
  const h = headline(rows);
  const outcomes = outcomeCounts(rows, 'asmlift');
  const byToolchain = outcomesBy(rows, (r) => r.toolchain, TOOLCHAIN_ORDER);
  const byTier = outcomesBy(rows, (r) => r.tier, ['synthetic', 'real']);
  const byLoc = outcomesBy(rows, locBucketOf, [...LOC_BUCKETS]);
  const matchShare = (r: { total: number; counts: { match: number } }) => r.counts.match / r.total;
  const topFeatures = featureOutcomes(rows)
    .slice(0, 15)
    .sort((a, b) => matchShare(a) - matchShare(b));
  const readability = readabilityStats(rows, 'asmlift');
  const explore = (preset: ExplorerPreset, outcome: Outcome) =>
    onExplore({ ...preset, outcomeDecompiler: 'asmlift', outcome });

  return (
    <div className="space-y-6">
      {/* Headline stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Stat label="Functions" value={h.total} accent="#2dd4bf" />
        <Stat label="Toolchains" value={h.toolchains} />
        <Stat label="Projects" value={h.projects} />
        <Stat label="Synthetic" value={h.synthetic} hint="authored probes" />
        <Stat label="Real" value={h.real} hint="from decomp projects" />
      </div>

      <Panel
        title="Outcomes"
        subtitle="Every function lands in one of five outcomes. Hover a tile for its definition; click it to list its functions."
      >
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {OUTCOME_ORDER.map((o) => (
            <OutcomeTile key={o} outcome={o} count={outcomes[o]} total={h.total} onClick={() => explore({}, o)} />
          ))}
        </div>
      </Panel>

      <Panel
        title="Outcomes by toolchain"
        subtitle="Per (ISA × compiler) target, grouped by ISA — ARM (GBA), MIPS (N64), PowerPC (GC). Click a segment to list its functions."
      >
        <OutcomeLegend />
        <OutcomeBars
          data={byToolchain}
          labelOf={(k) => TOOLCHAIN_LABEL[k]}
          onSegmentClick={(k, o) => explore({ toolchain: k }, o)}
        />
      </Panel>

      <Panel
        title="Outcomes by difficulty"
        subtitle="Authored probes against real game code, and reference-source size buckets — separates wins on trivia from real capability."
      >
        <OutcomeLegend />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <p className="mb-1 text-xs font-medium text-slate-400">synthetic vs real</p>
            <OutcomeBars data={byTier} labelOf={TIER_LABEL} onSegmentClick={(k, o) => explore({ tier: k }, o)} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-slate-400">function size</p>
            <OutcomeBars data={byLoc} labelOf={(k) => k} />
          </div>
        </div>
      </Panel>

      <Panel
        title="Outcomes by feature"
        subtitle="The 15 most frequent feature tags, lowest match rate first. A function counts toward every tag it carries."
      >
        <OutcomeLegend />
        <OutcomeBars
          data={topFeatures}
          labelOf={(k) => FEATURE_BY_ID.get(k)?.label ?? k}
          onSegmentClick={(k, o) => explore({ feature: [k] }, o)}
        />
      </Panel>

      <Panel
        title="Readability of compiling output"
        subtitle={`Over asmlift's ${readability.n} compiling outputs — lower is better.`}
      >
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <Stat
            label="Gotos"
            value={readability.gotosPer100Lines.toFixed(1)}
            hint="per 100 lines — structured control flow lost"
          />
          <Stat label="Casts" value={readability.castsPer100Lines.toFixed(1)} hint="per 100 lines — type noise" />
          <Stat
            label="Raw memory casts"
            value={readability.rawMemPer100Lines.toFixed(1)}
            hint="per 100 lines — type recovery failed"
          />
          <Stat
            label="Address derefs"
            value={readability.addrDerefPer100Lines.toFixed(1)}
            hint="per 100 lines — symbol recovery failed (not score-penalized)"
          />
          <Stat
            label="Verbosity"
            value={`${readability.verbosity.toFixed(2)}×`}
            hint="emitted lines per reference-source line"
          />
        </div>
      </Panel>
    </div>
  );
}

function OutcomeTile({
  outcome,
  count,
  total,
  onClick,
}: {
  outcome: Outcome;
  count: number;
  total: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${OUTCOME_LABEL[outcome]} — ${OUTCOME_GLOSS[outcome]}. Click to open in the Function Explorer.`}
      className="text-left transition-opacity hover:opacity-80"
    >
      <Card className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-slate-400">
          <span className="inline-block h-2.5 w-2.5 rounded-xs" style={{ backgroundColor: OUTCOME_COLOR[outcome] }} />
          {OUTCOME_LABEL[outcome]}
        </span>
        <span className="text-3xl font-bold font-mono" style={{ color: OUTCOME_COLOR[outcome] }}>
          {count}
        </span>
        <span className="text-xs text-slate-500">
          {total === 0 ? 0 : Math.round((100 * count) / total)}% of functions
        </span>
      </Card>
    </button>
  );
}
