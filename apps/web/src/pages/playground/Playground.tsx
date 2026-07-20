import { cBackend } from '@asmlift/core/backend/c';
import { cppBackend } from '@asmlift/core/backend/cpp';
import { pascalBackend } from '@asmlift/core/backend/pascal';
import { detectName } from '@asmlift/core/detect';
import type { LanguageBackend } from '@asmlift/core/l3/ast';
import { type DecompileResult, decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC, type TargetDescription } from '@asmlift/core/target';
import { decompileTraced } from '@asmlift/core/trace';
import { StreamLanguage } from '@codemirror/language';
import { gas } from '@codemirror/legacy-modes/mode/gas';
import CodeMirror from '@uiw/react-codemirror';
import { useQueryState } from 'nuqs';
import { useEffect, useMemo, useRef, useState } from 'react';

import { CodeBlock } from '../../shared/components/CodeBlock';
import { type ShareState, encodeShare } from '../../shared/utils/permalink';
import { parseAsShareState } from '../../shared/utils/url-state';
import { Pipeline } from './Pipeline';
import { RankBadge } from './RankPanel';
import { deriveSpec, parseSpec } from './cpp-spec';
import { EXAMPLES } from './examples';
import { useRanking } from './useRanking';

const TARGETS: Record<string, { desc: TargetDescription; label: string; format: string }> = {
  'agbcc-arm': { desc: ARMV4T_AGBCC, label: 'GBA — agbcc / ARMv4T', format: 'agbcc textual .s' },
  'ido-mips': { desc: MIPS_IDO, label: 'N64 — IDO / MIPS', format: 'mips objdump -d --no-show-raw-insn' },
  'gcc-mips': { desc: MIPS_GCC, label: 'N64 — KMC GCC / MIPS', format: 'mips objdump -d --no-show-raw-insn' },
  'mwcc-ppc': { desc: PPC_MWCC, label: 'GC/Wii — mwcc / PPC', format: 'ppc objdump -d -r --no-show-raw-insn' },
};

// cpp has no static backend: cppBackend(spec) is built per run from the user/derived spec.
const BACKENDS: Record<string, { backend?: LanguageBackend; label: string; highlight: 'c' | 'c++' | 'plain' }> = {
  c: { backend: cBackend, label: 'C', highlight: 'c' },
  cpp: { label: 'C++ (CodeWarrior)', highlight: 'c++' },
  pascal: { backend: pascalBackend, label: 'Pascal (IDO dialect)', highlight: 'plain' },
};

const SPEC_PLACEHOLDER = `optional — auto-derived from the mangled symbol when empty. Full form:
{"method":"dot","cls":"Vec","retType":{"base":"int","ptr":0},
 "params":[{"name":"o","type":{"base":"Vec","ptr":1}}],
 "classes":{"Vec":{"fields":[{"name":"x","type":{"base":"int","ptr":0}},{"name":"y","type":{"base":"int","ptr":0}}]}}}`;

type Tab = 'source' | 'pipeline';
const TABS: { id: Tab; label: string }[] = [
  { id: 'source', label: 'Source' },
  { id: 'pipeline', label: 'Pipeline' },
];

const asmExtensions = [StreamLanguage.define(gas)];

// A share is applied ATOMICALLY or not at all: mixing a fallback target with the share's asm
// would silently decompile under the wrong ISA.
function sanitize(s: ShareState | null): ShareState | null {
  return s && TARGETS[s.target] && BACKENDS[s.backend] ? s : null;
}

// The emitted source embeds the function name verbatim — a non-identifier would be silently
// invalid C, so it is rejected before it reaches the pipeline.
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$.]*$/;

export function Playground({
  active,
}: {
  /** whether the Playground view is the one on screen — gates the ?s= permalink writes so a
   *  hidden Playground never rewrites the Benchmark view's URL */
  active: boolean;
}) {
  const [urlShare, setUrlShare] = useQueryState('s', parseAsShareState.withOptions({ history: 'replace' }));
  const [initial] = useState(() => sanitize(urlShare));
  const [targetId, setTargetId] = useState(initial?.target ?? EXAMPLES[0].target);
  const [backendId, setBackendId] = useState(initial?.backend ?? 'c');
  const [asm, setAsm] = useState(initial?.asm ?? EXAMPLES[0].asm);
  const [nameOverride, setNameOverride] = useState(initial?.name ?? '');
  const [specText, setSpecText] = useState(initial?.spec ?? '');
  const [debounced, setDebounced] = useState({ asm, targetId, backendId, nameOverride, specText });
  const [tab, setTab] = useState<Tab>('source');
  const [copied, setCopied] = useState<'idle' | 'copied' | 'huge' | 'failed'>('idle');
  // The last ?s= WE wrote, encoded — tells external changes apart from our own writes echoing back.
  const lastWritten = useRef<string | null>(initial ? encodeShare(initial) : null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced({ asm, targetId, backendId, nameOverride, specText }), 250);
    return () => clearTimeout(t);
  }, [asm, targetId, backendId, nameOverride, specText]);

  // An EXTERNAL ?s= change (Back/Forward, the Benchmark's "Open in playground") loads into the
  // editor. Own writes are skipped via lastWritten, so a debounced (250ms-old) echo can never
  // clobber newer keystrokes.
  useEffect(() => {
    const s = sanitize(urlShare);
    if (!s) {
      return;
    }
    const enc = encodeShare(s);
    if (enc === lastWritten.current) {
      return;
    }
    lastWritten.current = enc;
    setTargetId(s.target);
    setBackendId(s.backend);
    setAsm(s.asm);
    setNameOverride(s.name ?? '');
    setSpecText(s.spec ?? '');
    setTab('source');
    // Seed the debounced snapshot too, so an incoming share decompiles at once — no transient
    // where the write effect re-encodes the previous content over the new share.
    setDebounced({
      asm: s.asm,
      targetId: s.target,
      backendId: s.backend,
      nameOverride: s.name ?? '',
      specText: s.spec ?? '',
    });
  }, [urlShare]);

  // The permalink IS the state: keep ?s= in sync with the debounced editor state (nuqs rate-limits
  // the writes, Safari-aware). Gated on `active`: a hidden Playground must not rewrite the
  // Benchmark view's URL.
  useEffect(() => {
    if (!active) {
      return;
    }
    const state: ShareState = {
      target: debounced.targetId,
      backend: debounced.backendId,
      asm: debounced.asm,
      ...(debounced.nameOverride.trim() ? { name: debounced.nameOverride.trim() } : {}),
      ...(debounced.backendId === 'cpp' && debounced.specText.trim() ? { spec: debounced.specText } : {}),
    };
    lastWritten.current = encodeShare(state);
    void setUrlShare(state);
  }, [debounced, active, setUrlShare]);

  const detected = useMemo(() => detectName(debounced.asm), [debounced.asm]);
  const override = debounced.nameOverride.trim();
  const fnName = override || detected;
  const nameInvalid = fnName !== undefined && !IDENT.test(fnName);

  // Resolve the language backend first (cpp needs a spec: user JSON, or derived from a first
  // C-backend pass), so the Source decompile and the Pipeline trace share the exact same one.
  const langBackend: { backend: LanguageBackend } | { error: string } | null = useMemo(() => {
    if (!debounced.asm.trim() || !fnName || nameInvalid) {
      return null;
    }
    if (debounced.backendId !== 'cpp') {
      return { backend: BACKENDS[debounced.backendId].backend! };
    }
    try {
      const target = TARGETS[debounced.targetId].desc;
      const spec = debounced.specText.trim()
        ? parseSpec(debounced.specText)
        : deriveSpec(fnName, decompile(fnName, debounced.asm, target, { onGap: 'annotate' }).sfn);
      return { backend: cppBackend(spec) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [debounced, fnName]);

  const result: DecompileResult | { error: string } | null = useMemo(() => {
    if (!debounced.asm.trim()) {
      return null;
    }
    if (!fnName) {
      return { error: 'Could not detect the function name from the asm — set it in the “function” field.' };
    }
    if (nameInvalid) {
      return { error: `"${fnName}" is not a valid identifier — the emitted source would not compile.` };
    }
    if (langBackend === null) {
      return null;
    }
    if ('error' in langBackend) {
      return { error: langBackend.error };
    }
    try {
      return decompile(fnName, debounced.asm, TARGETS[debounced.targetId].desc, {
        backend: langBackend.backend,
        onGap: 'annotate',
      });
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [debounced, fnName, nameInvalid, langBackend]);

  // The Pipeline tab's trace — computed only while that tab is open (a second tower run).
  // A thrown trace is an ERROR result (rendered as such), never a silently blank panel.
  const pipelineReport = useMemo(() => {
    if (
      tab !== 'pipeline' ||
      !debounced.asm.trim() ||
      !fnName ||
      nameInvalid ||
      langBackend === null ||
      'error' in langBackend
    ) {
      return null;
    }
    try {
      return {
        report: decompileTraced(fnName, debounced.asm, TARGETS[debounced.targetId].desc, {
          backend: langBackend.backend,
          onGap: 'annotate',
        }).report,
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [debounced, fnName, nameInvalid, langBackend, tab]);

  const ok = result !== null && !('error' in result);
  const diagnostics = ok ? result.diagnostics : [];

  // In-browser ranking — agbcc/ARMv4T + C backend only (the one target whose textual `.s` can be
  // reassembled and whose compiler exists as wasm). Async, worker-driven, stale-guarded (H1). For
  // every other target/backend it stays "off" and the view keeps the plain decompile.
  const rankTarget = TARGETS[debounced.targetId].desc;
  const rankEligible =
    active && // don't run WASM scoring while this view is hidden (e.g. a benchmark deep-link)
    rankTarget.compiler === 'agbcc' &&
    debounced.backendId === 'c' &&
    !!fnName &&
    !nameInvalid &&
    !!debounced.asm.trim();
  const ranking = useRanking({
    eligible: rankEligible,
    asm: debounced.asm,
    name: fnName,
    targetId: debounced.targetId,
    target: rankTarget,
  });
  // The Source view shows the RANKED-BEST C when scoring has resolved for the current input;
  // otherwise the deterministic decompile (instant, and the fallback if ranking is off/loading/
  // errored). Because ranking resets to "loading" on every input change, `best.source` can never
  // be shown against a different asm than the one it was scored for.
  const shownSource = ok ? (ranking.status === 'ok' ? ranking.result.best.source : result.source) : '';

  const share = () => {
    const url = window.location.href;
    navigator.clipboard
      .writeText(url)
      .then(
        () => setCopied(url.length > 20_000 ? 'huge' : 'copied'), // a 20k+ URL breaks in many contexts
        () => setCopied('failed'), // insecure context / permission denied
      )
      .finally(() => setTimeout(() => setCopied('idle'), 2000));
  };

  const loadExample = (i: number) => {
    const ex = EXAMPLES[i];
    if (!ex) {
      return;
    }
    setTargetId(ex.target);
    setBackendId(ex.backend ?? 'c');
    setSpecText(ex.spec ?? '');
    setAsm(ex.asm);
    setNameOverride('');
    setTab('source');
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-slate-500">Toolchain</span>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5"
          >
            {Object.entries(TARGETS).map(([id, t]) => (
              <option key={id} value={id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-slate-500">Output</span>
          <select
            value={backendId}
            onChange={(e) => setBackendId(e.target.value)}
            className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5"
          >
            {Object.entries(BACKENDS).map(([id, b]) => (
              <option key={id} value={id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-slate-500">Function</span>
          <input
            value={nameOverride}
            onChange={(e) => setNameOverride(e.target.value)}
            placeholder={detected ?? 'function name'}
            spellCheck={false}
            className="w-36 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono placeholder:text-slate-600"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-slate-500">Examples</span>
          <select
            defaultValue=""
            onChange={(e) => {
              loadExample(Number(e.target.value));
              e.target.value = '';
            }}
            className="max-w-72 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5"
          >
            <option value="" disabled>
              load an example…
            </option>
            {EXAMPLES.map((ex, i) => (
              <option key={ex.label} value={i}>
                {ex.label}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={share}
          className="ml-auto rounded-md border border-teal-700 bg-teal-900/40 px-3 py-1.5 font-medium text-teal-300 hover:bg-teal-900/70"
        >
          {copied === 'copied'
            ? 'copied!'
            : copied === 'huge'
              ? 'copied (huge URL!)'
              : copied === 'failed'
                ? 'copy failed'
                : 'share link'}
        </button>
      </div>

      {backendId === 'cpp' && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">
            C++ signature{' '}
            <span className="normal-case">
              — class, method, params, field names (a decomp project reads these from headers)
            </span>
          </span>
          <textarea
            value={specText}
            onChange={(e) => setSpecText(e.target.value)}
            rows={3}
            placeholder={SPEC_PLACEHOLDER}
            spellCheck={false}
            className="scroll-slim rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs placeholder:text-slate-600"
          />
        </label>
      )}

      <main className="grid flex-1 gap-4 lg:grid-cols-2">
        <section className="flex min-h-[420px] flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-slate-300">Assembly</h2>
            <span className="font-mono text-[11px] text-slate-500">{TARGETS[targetId].format}</span>
          </div>
          <div className="flex-1 overflow-hidden rounded-lg border border-slate-800">
            <CodeMirror
              value={asm}
              onChange={setAsm}
              theme="dark"
              height="100%"
              style={{ height: '100%' }}
              extensions={asmExtensions}
              basicSetup={{ foldGutter: false }}
            />
          </div>
        </section>

        <section className="flex min-h-[420px] flex-col gap-1.5">
          <div className="flex items-center gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${tab === t.id ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-800'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-hidden">
            {result === null ? (
              <div className="grid h-full place-items-center rounded-lg border border-dashed border-slate-800 text-sm text-slate-500">
                paste assembly on the left, or load an example
              </div>
            ) : 'error' in result ? (
              <div className="h-full rounded-lg border border-rose-900 bg-rose-950/40 p-4 font-mono text-sm text-rose-300">
                {result.error}
              </div>
            ) : tab === 'source' ? (
              <div className="flex h-full flex-col gap-1.5">
                <RankBadge ranking={ranking} />
                <div className="min-h-0 flex-1">
                  <CodeBlock
                    code={shownSource}
                    language={BACKENDS[debounced.backendId].highlight}
                    className="h-full rounded-lg border border-slate-800 bg-slate-900/80 p-4 text-[13px] leading-relaxed"
                  />
                </div>
              </div>
            ) : pipelineReport === null ? null : 'error' in pipelineReport ? (
              <div className="h-full rounded-lg border border-rose-900 bg-rose-950/40 p-4 font-mono text-sm text-rose-300">
                the trace failed: {pipelineReport.error}
              </div>
            ) : (
              <Pipeline report={pipelineReport.report} ranking={ranking} />
            )}
          </div>
          {diagnostics.length > 0 && (
            <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs leading-relaxed">
              <p className="mb-1.5 font-semibold text-amber-300">
                {diagnostics.length} decline{diagnostics.length > 1 ? 's' : ''} — annotated loudly (ASMLIFT_ERROR
                markers in the output), never guessed silently:
              </p>
              <ul className="space-y-1">
                {diagnostics.map((d, i) => (
                  <li key={i} className="font-mono text-amber-200/90">
                    <span className="mr-1.5 rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] uppercase">
                      {d.stage}
                    </span>
                    {d.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-slate-800 pt-3 text-xs leading-relaxed text-slate-500">
        Decompiles a function on the browser, context-free. For the GBA, we also{' '}
        <span className="text-slate-300">verifies the match</span> using agbcc and objdiff compiled to WebAssembly
      </footer>
    </div>
  );
}
