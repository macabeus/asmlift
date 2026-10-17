import { FEATURE_BY_ID, type FunctionResult } from '@asmlift/bench-schema';

import { featureStats, headline, matchRate, matchRateBy } from '../lib/stats';
import { LOC_BUCKETS, locBucketOf, readabilityStats } from '../lib/stats';
import { ISA_LABEL, ISA_ORDER, TOOLCHAIN_LABEL, TOOLCHAIN_ORDER } from '../theme';
import type { ExplorerPreset } from './Explorer';
import { MatchRateBars } from './charts/MatchRateBars';
import { OutcomeDistribution } from './charts/OutcomeDistribution';
import { ReadabilityBars } from './charts/ReadabilityBars';
import { Panel } from './ui/Section';
import { Stat } from './ui/Stat';

export function Overview({
  rows,
  onExplore,
}: {
  rows: FunctionResult[];
  /** deep-link into the Function Explorer with a filter preset (charts + tiles are clickable) */
  onExplore: (preset: ExplorerPreset) => void;
}) {
  const h = headline(rows);
  const byToolchain = matchRateBy(rows, (r) => r.toolchain, TOOLCHAIN_ORDER);
  const byIsa = matchRateBy(rows, (r) => r.isa, ISA_ORDER);
  const byTier = matchRateBy(rows, (r) => r.tier, ['synthetic', 'real']);
  const topFeatures = featureStats(rows).slice(0, 15);
  const byLoc = matchRateBy(rows, locBucketOf, [...LOC_BUCKETS]);
  const readability = readabilityStats(rows, 'asmlift');

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

      {/* Headline: outcome distribution */}
      <Panel
        title="Outcome distribution"
        subtitle="The headline: every function lands in one of five outcomes. Hover a legend label for its definition."
      >
        <OutcomeDistribution rows={rows} />
        <div className="mt-3 text-xs text-slate-400">
          <MatchLine label="asmlift match rate" rate={matchRate(rows, 'asmlift')} color="#2dd4bf" />
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel
          title="Match rate by assembly (ISA)"
          subtitle="Byte-exact share per instruction set — ARM (GBA), MIPS (N64), PowerPC (GC)."
        >
          <MatchRateBars
            data={byIsa}
            labelOf={(k) => ISA_LABEL[k] ?? k}
            showCount
            onBarClick={(k) => onExplore({ isa: k })}
          />
        </Panel>

        <Panel
          title="Match rate by toolchain"
          subtitle="Byte-exact share across the five (ISA × compiler) targets — the precise per-compiler view."
        >
          <MatchRateBars
            data={byToolchain}
            labelOf={(k) => TOOLCHAIN_LABEL[k]}
            showCount
            onBarClick={(k) => onExplore({ toolchain: k })}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel
          title="Match rate: synthetic vs real"
          subtitle="asmlift does far better on authored probes than on real game code."
        >
          <MatchRateBars
            data={byTier}
            labelOf={(k) => (k === 'synthetic' ? 'Synthetic' : 'Real')}
            showCount
            onBarClick={(k) => onExplore({ tier: k })}
          />
        </Panel>

        <Panel
          title="Match rate by function size"
          subtitle="Reference-source size buckets — separates wins on trivia from real capability."
        >
          <MatchRateBars data={byLoc} labelOf={(k) => k} showCount />
        </Panel>
      </div>

      <Panel
        title="Match rate by feature"
        subtitle="Top 15 feature tags by frequency. A function counts toward every tag it carries; hover a bar for what the tag means."
      >
        <MatchRateBars
          data={topFeatures.map((f) => ({
            key: f.feature,
            total: f.count,
            rate: f.rate,
          }))}
          labelOf={(k) => FEATURE_BY_ID.get(k)?.label ?? k}
          horizontal
          showCount
          height={Math.max(360, topFeatures.length * 26)}
          onBarClick={(k) => onExplore({ feature: [k] })}
        />
      </Panel>

      <Panel
        title="Readability of compiling output"
        subtitle={`How clean is the code asmlift emits? Over its ${readability.n} compiling outputs — lower is better. Gotos = structured control flow lost; casts = type noise; raw memory casts = type recovery failed; address derefs = symbol recovery failed (not score-penalized); verbosity = emitted lines per reference line.`}
      >
        <ReadabilityBars stats={readability} />
      </Panel>
    </div>
  );
}

function MatchLine({ label, rate, color }: { label: string; rate: number; color: string }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-slate-800/40 px-3 py-2">
      <span>{label}</span>
      <span className="font-mono font-semibold" style={{ color }}>
        {Math.round(rate * 100)}%
      </span>
    </div>
  );
}
