import type { FunctionResult } from '@asmlift/bench-schema';

import { featureStats, headToHead, headToHeadBy, headline, matchRate, matchRateBy } from '../lib/stats';
import { LOC_BUCKETS, locBucketOf, readabilityStats } from '../lib/stats';
import { H2H_COLOR, ISA_LABEL, ISA_ORDER, TOOLCHAIN_LABEL, TOOLCHAIN_ORDER } from '../theme';
import type { ExplorerPreset } from './Explorer';
import { HeadToHead } from './charts/HeadToHead';
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
  const h2h = headToHead(rows);
  const h2hByIsa = headToHeadBy(rows, (r) => r.isa, ISA_ORDER);
  const h2hByTier = headToHeadBy(rows, (r) => r.tier, ['synthetic', 'real']);
  const topFeatures = featureStats(rows).slice(0, 15);
  const byLoc = matchRateBy(rows, locBucketOf, [...LOC_BUCKETS]);
  const readability = { asmlift: readabilityStats(rows, 'asmlift'), m2c: readabilityStats(rows, 'm2c') };

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
        <div className="mt-3 grid grid-cols-2 gap-4 text-xs text-slate-400">
          <MatchLine label="asmlift match rate" rate={matchRate(rows, 'asmlift')} color="#2dd4bf" />
          <MatchLine label="m2c match rate" rate={matchRate(rows, 'm2c')} color="#a855f7" />
        </div>
      </Panel>

      {/* Head-to-head: the competitive view */}
      <Panel
        title="Head-to-head — who matches byte-exact"
        subtitle="Beyond each decompiler's own rate: where each WINS exclusively. Cyan = only asmlift matched; purple = only m2c matched; green = both; slate = neither."
      >
        <div className="mb-3 flex flex-wrap gap-3">
          <Verdict
            label="asmlift exclusive wins"
            value={h2h.asmliftOnly}
            color={H2H_COLOR.asmliftOnly}
            onClick={() => onExplore({ verdict: 'asmlift-only' })}
          />
          <Verdict
            label="m2c exclusive wins"
            value={h2h.m2cOnly}
            color={H2H_COLOR.m2cOnly}
            onClick={() => onExplore({ verdict: 'm2c-only' })}
          />
          <Verdict
            label="both match"
            value={h2h.both}
            color={H2H_COLOR.both}
            onClick={() => onExplore({ verdict: 'both' })}
          />
          <Verdict
            label="neither"
            value={h2h.neither}
            color={H2H_COLOR.neither}
            onClick={() => onExplore({ verdict: 'neither' })}
          />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <p className="mb-1 text-xs font-medium text-slate-400">by assembly (ISA)</p>
            <HeadToHead data={h2hByIsa} labelOf={(k) => ISA_LABEL[k] ?? k} height={200} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-slate-400">synthetic vs real</p>
            <HeadToHead data={h2hByTier} labelOf={(k) => (k === 'synthetic' ? 'Synthetic' : 'Real')} height={200} />
          </div>
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
          subtitle="Both decompilers do far better on authored probes than real game code."
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
        subtitle="Top 15 feature tags by frequency. A function counts toward every tag it carries."
      >
        <MatchRateBars
          data={topFeatures.map((f) => ({
            key: f.feature,
            total: f.count,
            asmlift: f.asmlift,
            m2c: f.m2c,
          }))}
          labelOf={(k) => k}
          horizontal
          showCount
          height={Math.max(360, topFeatures.length * 26)}
          onBarClick={(k) => onExplore({ feature: k })}
        />
      </Panel>

      <Panel
        title="Readability of compiling output"
        subtitle={`When both emit code, whose is cleaner? Over each decompiler's compiling outputs (asmlift ${readability.asmlift.n}, m2c ${readability.m2c.n}) — lower is better. Gotos = structured control flow lost; casts = type noise; raw memory casts = type recovery failed; address derefs = symbol recovery failed (not score-penalized); verbosity = emitted lines per reference line.`}
      >
        <ReadabilityBars asmlift={readability.asmlift} m2c={readability.m2c} />
      </Panel>
    </div>
  );
}

function Verdict({
  label,
  value,
  color,
  onClick,
}: {
  label: string;
  value: number;
  color: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Open in the Function Explorer"
      className="flex items-center gap-2 rounded-md bg-slate-800/50 px-3 py-1.5 transition-colors hover:bg-slate-700/60"
    >
      <span className="inline-block h-2.5 w-2.5 rounded-xs" style={{ backgroundColor: color }} />
      <span className="text-xs text-slate-300">{label}</span>
      <span className="font-mono text-sm font-semibold text-white">{value}</span>
    </button>
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
