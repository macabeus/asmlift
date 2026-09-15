import type { FunctionResult } from '@asmlift/bench-schema';
import { useMemo, useState } from 'react';

import { type FlagGroup, type ProjectProfile, rowFlags } from '../lib/flags';

/** Changes in the build's words, each kept on one line (`-O2 → -O1` never breaks inside itself). */
function Changes({ changes }: { changes: readonly string[] }) {
  return (
    <span className="font-mono">
      {changes.map((c, i) => (
        <span key={c}>
          {i > 0 && ' · '}
          <span className="whitespace-nowrap">{c}</span>
        </span>
      ))}
    </span>
  );
}

function Words({ groups }: { groups: FlagGroup[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-slate-200">
      {groups.map((g, i) => (
        <span key={i} className="whitespace-nowrap">
          {g.map((w, j) => (
            <span key={j}>
              {j > 0 && ' '}
              {w.overridden ? (
                <s className="text-slate-500" title="overridden by a later flag">
                  {w.text}
                </s>
              ) : (
                w.text
              )}
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}

/** The always-visible compiler-flags strip of a function's detail: the flags the target and every
 *  candidate compiled with, where they came from, and how they compare with the project's. */
export function CompilerFlags({
  fn,
  peer,
  initialView = 'effective',
}: {
  fn: FunctionResult;
  /** the profile most of the project's rows of this toolchain share (`peerProfile`) */
  peer: ProjectProfile | null;
  initialView?: 'effective' | 'raw';
}) {
  const [view, setView] = useState(initialView);
  const [derivationOpen, setDerivationOpen] = useState(false);
  const f = useMemo(() => rowFlags(fn, peer), [fn, peer]);
  const { source } = f;
  const peers = f.peer && `${f.peer.rows} of ${fn.project}'s ${f.peer.of} ${fn.toolchain} rows`;

  return (
    <section aria-label="compiler flags" className="rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-slate-100">Compiler flags</span>
        {f.level && <span className="rounded bg-slate-700 px-1.5 py-0.5 font-mono text-slate-200">{f.level}</span>}
        {f.hasOverrides && (
          <span role="radiogroup" aria-label="flag view" className="flex gap-2 text-slate-400">
            {(['effective', 'raw'] as const).map((v) => (
              <button
                key={v}
                role="radio"
                aria-checked={view === v}
                onClick={() => setView(v)}
                className={view === v ? 'text-teal-300' : 'hover:text-slate-200'}
              >
                {view === v ? '◉' : '○'} {v}
              </button>
            ))}
          </span>
        )}
        <span className="text-slate-500 sm:ml-auto">
          from {source.label}
          {source.kind === 'build' && (
            <>
              {' '}
              <button
                onClick={() => setDerivationOpen((o) => !o)}
                aria-expanded={derivationOpen}
                title="how the flags were read off the build"
                className="rounded px-1 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
              >
                {derivationOpen ? '▾' : '▸'}
              </button>{' '}
              · <span className="font-mono">{source.unit}</span>
            </>
          )}
        </span>
      </div>
      {source.kind === 'build' && derivationOpen && (
        <pre className="scroll-slim mb-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-slate-950/70 p-2 font-mono text-[11px] text-slate-400">
          {source.derivation}
        </pre>
      )}
      <Words groups={view === 'effective' ? f.effective : f.raw} />
      {f.peer &&
        (f.peer.same ? (
          <p className="mt-2 text-slate-400">same profile as {peers}</p>
        ) : (
          <p className="mt-2 text-amber-300">
            ◆ differs from the profile of {peers}: <Changes changes={f.peer.changes} />
          </p>
        ))}
      {f.unclassified.length > 0 && (
        <p className="mt-1 text-slate-500">
          not in asmlift&apos;s flag table (the compiler still receives them):{' '}
          <span className="font-mono">{f.unclassified.join(' ')}</span>
        </p>
      )}
      <p className="mt-1 text-slate-500">
        The target and every candidate compile with these flags, and asmlift decompiles against {fn.toolchain}
        &apos;s compiler behaviors at every flag set. m2c takes no flags.
      </p>
    </section>
  );
}
