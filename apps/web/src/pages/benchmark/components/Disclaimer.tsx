import summary from '../../../data/summary.json';
import { Panel } from './ui/Section';

export function Disclaimer() {
  return (
    <Panel title="Disclaimer">
      <p className="text-sm text-slate-300 leading-relaxed space-y-2">
        This benchmark aims to be a fair comparison of the two decompilers and to help on the development of asmlift.
      </p>

      <p className="text-sm text-slate-300 leading-relaxed space-y-2">
        m2c can be better or worse than asmlift on specific functions. See the Methodology for details on how the
        benchmark was built and what it measures.
      </p>

      <p className="text-sm text-slate-300 leading-relaxed space-y-2">
        Last but not least, the learnings from m2c were very helpful during the development of asmlift, and we are
        grateful for the hard work done by the m2c contributors.
      </p>

      <p className="text-sm text-slate-300 leading-relaxed space-y-2">
        Compared against m2c at commit{' '}
        <a
          href={`https://github.com/matt-kempster/m2c/commit/${summary.m2cCommit}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-teal-300 hover:underline"
        >
          {summary.m2cCommit.slice(0, 7)}
        </a>
        .
      </p>
    </Panel>
  );
}
