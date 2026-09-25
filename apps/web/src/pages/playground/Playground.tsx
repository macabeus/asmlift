import { cBackend } from '@asmlift/core/backend/c';
import { cppBackend } from '@asmlift/core/backend/cpp';
import { pascalBackend } from '@asmlift/core/backend/pascal';
import { renderDeclarations } from '@asmlift/core/declare';
import { detectName } from '@asmlift/core/detect';
import type { LanguageBackend } from '@asmlift/core/l3/ast';
import { type DecompileResult, decompile } from '@asmlift/core/pipeline';
import { type CanonicalToolchainId, TOOLCHAIN_TARGETS, type ToolchainId } from '@asmlift/core/target';
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
import { RankBadge, RankDeclarations } from './RankPanel';
import { deriveSpec, parseSpec } from './cpp-spec';
import { EXAMPLES } from './examples';
import { canonicalFlagsText, readFlags } from './flags-field';
import { parseSymbolsJson } from './symbols-json';
import { useRanking } from './useRanking';

const TARGETS: Record<string, { id: CanonicalToolchainId; label: string; format: string }> = {
  agbcc: { id: 'agbcc', label: 'GBA — agbcc / ARMv4T', format: 'agbcc textual .s' },
  'ido7.1': { id: 'ido7.1', label: 'N64 — IDO / MIPS', format: 'mips objdump -d --no-show-raw-insn' },
  'gcc2.7.2kmc': { id: 'gcc2.7.2kmc', label: 'N64 — KMC GCC / MIPS', format: 'mips objdump -d --no-show-raw-insn' },
  // `-M gekko` is load-bearing, not decoration: the generic dialect prints the GameCube's
  // paired-single opcodes as POWER VSX, at the wrong register file and offset.
  mwcc_242_81: {
    id: 'mwcc_242_81',
    label: 'GC/Wii — mwcc / PPC',
    format: 'ppc objdump -d -r -M gekko --no-show-raw-insn',
  },
};

/** Each toolchain's name in the Toolchain select. */
const TARGET_LABELS: Partial<Record<ToolchainId, string>> = Object.fromEntries(
  Object.values(TARGETS).map((t) => [t.id, t.label]),
);

/** The flags a target starts at: its toolchain's canonical flags. */
const canonicalFor = (targetId: string) => canonicalFlagsText(TARGETS[targetId].id);

/** Ranking's flags while the field does not parse; ranking is off then, and a stable identity keeps
 *  the ranking question from changing under it. */
const NO_FLAGS: readonly string[] = [];

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

const SYMBOLS_PLACEHOLDER = `optional — the project's address→symbol map (hex address → SymbolInfo[]), e.g.
{"0x03001234": [{"name": "gCounter", "kind": "data"}],
 "0x08012344": [{"name": "DoThing", "kind": "code"}]}`;

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
  /** whether the Playground view is the one on screen — gates the #s= permalink writes so a
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
  const [symbolsText, setSymbolsText] = useState(initial?.symbols ?? '');
  const [flagsText, setFlagsText] = useState(initial?.cflags ?? canonicalFor(initial?.target ?? EXAMPLES[0].target));
  // The Symbols pane is collapsed by default when empty; a share/preset that carries a map opens it.
  const [symbolsOpen, setSymbolsOpen] = useState(!!initial?.symbols);
  const [debounced, setDebounced] = useState({
    asm,
    targetId,
    backendId,
    nameOverride,
    specText,
    symbolsText,
    flagsText,
  });
  const [tab, setTab] = useState<Tab>('source');
  const [copied, setCopied] = useState<'idle' | 'copied' | 'huge' | 'failed'>('idle');
  // The last #s= WE wrote, encoded — tells external changes apart from our own writes echoing back.
  const lastWritten = useRef<string | null>(initial ? encodeShare(initial) : null);

  useEffect(() => {
    const t = setTimeout(
      () => setDebounced({ asm, targetId, backendId, nameOverride, specText, symbolsText, flagsText }),
      250,
    );
    return () => clearTimeout(t);
  }, [asm, targetId, backendId, nameOverride, specText, symbolsText, flagsText]);

  // An EXTERNAL #s= change (Back/Forward, the Benchmark's "Open in playground") loads into the
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
    const sharedFlags = s.cflags ?? canonicalFor(s.target);
    setTargetId(s.target);
    setFlagsText(sharedFlags);
    setBackendId(s.backend);
    setAsm(s.asm);
    setNameOverride(s.name ?? '');
    setSpecText(s.spec ?? '');
    setSymbolsText(s.symbols ?? '');
    setSymbolsOpen(!!s.symbols);
    setTab('source');
    // Seed the debounced snapshot too, so an incoming share decompiles at once — no transient
    // where the write effect re-encodes the previous content over the new share.
    setDebounced({
      asm: s.asm,
      targetId: s.target,
      backendId: s.backend,
      nameOverride: s.name ?? '',
      specText: s.spec ?? '',
      symbolsText: s.symbols ?? '',
      flagsText: sharedFlags,
    });
  }, [urlShare]);

  // The permalink IS the state: keep #s= in sync with the debounced editor state (nuqs rate-limits
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
      ...(debounced.symbolsText.trim() ? { symbols: debounced.symbolsText } : {}),
      cflags: debounced.flagsText,
    };
    lastWritten.current = encodeShare(state);
    void setUrlShare(state);
  }, [debounced, active, setUrlShare]);

  // The Symbols pane's map, parsed on the same debounce as the decompile. A parse error is loud
  // in the pane but INERT to the run: the decompile proceeds WITHOUT the map — degrade, never
  // block (core's own optionality contract for `symbols`).
  const symbolsParse = useMemo(() => parseSymbolsJson(debounced.symbolsText), [debounced.symbolsText]);
  const symbolMap = symbolsParse && 'map' in symbolsParse ? symbolsParse.map : undefined;
  const symbolsError = symbolsParse && 'error' in symbolsParse ? symbolsParse.error : null;

  // The Flags field: the profile the decompile resolves and the words every ranked candidate compiles
  // with. The live reading echoes the level as it is typed; the debounced one is what runs.
  const liveFlags = useMemo(() => readFlags(TARGETS[targetId].id, flagsText, TARGET_LABELS), [targetId, flagsText]);
  const flags = useMemo(
    () => readFlags(TARGETS[debounced.targetId].id, debounced.flagsText, TARGET_LABELS),
    [debounced.targetId, debounced.flagsText],
  );
  const canonicalFlags = canonicalFor(targetId);

  const detected = useMemo(() => detectName(debounced.asm), [debounced.asm]);
  const override = debounced.nameOverride.trim();
  const fnName = override || detected;
  const nameInvalid = fnName !== undefined && !IDENT.test(fnName);

  // Resolve the language backend first (cpp needs a spec: user JSON, or derived from a first
  // C-backend pass), so the Source decompile and the Pipeline trace share the exact same one.
  const langBackend: { backend: LanguageBackend } | { error: string } | null = useMemo(() => {
    if (!debounced.asm.trim() || !fnName || nameInvalid || 'error' in flags) {
      return null;
    }
    if (debounced.backendId !== 'cpp') {
      return { backend: BACKENDS[debounced.backendId].backend! };
    }
    try {
      const { target } = flags.resolved;
      const spec = debounced.specText.trim()
        ? parseSpec(debounced.specText)
        : deriveSpec(
            fnName,
            decompile(fnName, debounced.asm, target, {
              onGap: 'annotate',
              ...(symbolMap ? { symbols: symbolMap } : {}),
            }).sfn,
            target.fpu?.slots,
          );
      return { backend: cppBackend(spec, target.fpu?.slots) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [debounced, fnName, nameInvalid, flags, symbolMap]);

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
    if ('error' in flags) {
      return { error: `flags: ${flags.error}` };
    }
    if (langBackend === null) {
      return null;
    }
    if ('error' in langBackend) {
      return { error: langBackend.error };
    }
    try {
      return decompile(fnName, debounced.asm, flags.resolved.target, {
        backend: langBackend.backend,
        onGap: 'annotate',
        ...(symbolMap ? { symbols: symbolMap } : {}),
      });
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [debounced, fnName, nameInvalid, flags, langBackend, symbolMap]);

  // The Pipeline tab's trace — computed only while that tab is open (a second tower run).
  // A thrown trace is an ERROR result (rendered as such), never a silently blank panel.
  const pipelineReport = useMemo(() => {
    if (
      tab !== 'pipeline' ||
      !debounced.asm.trim() ||
      !fnName ||
      nameInvalid ||
      'error' in flags ||
      langBackend === null ||
      'error' in langBackend
    ) {
      return null;
    }
    try {
      return {
        report: decompileTraced(fnName, debounced.asm, flags.resolved, {
          backend: langBackend.backend,
          onGap: 'annotate',
          ...(symbolMap ? { symbols: symbolMap } : {}),
        }).report,
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [debounced, fnName, nameInvalid, flags, langBackend, tab, symbolMap]);

  const ok = result !== null && !('error' in result);
  const diagnostics = ok ? result.diagnostics : [];
  // The array shapes this source's spelling ASSUMES (raise/globalshape.ts). Shown beside the
  // source because a bare `gTbl[i]` means what the declaration of `gTbl` says it means, and this
  // pane prints no declarations — every other spelling asmlift emits for a global reproduces the
  // bytes under any declaration, so this is the one place the source alone is not the whole answer.
  const assumed = ok ? result.assumedSymbols : [];

  // In-browser ranking — agbcc/ARMv4T + C backend only (the one target whose textual `.s` can be
  // reassembled and whose compiler exists as wasm). Async, worker-driven, stale-guarded (H1). For
  // every other target/backend it stays "off" and the view keeps the plain decompile.
  const rankTarget = TOOLCHAIN_TARGETS[TARGETS[debounced.targetId].id].description;
  const rankEligible =
    active && // don't run WASM scoring while this view is hidden (e.g. a benchmark deep-link)
    rankTarget.compiler === 'agbcc' &&
    !('error' in flags) &&
    debounced.backendId === 'c' &&
    !!fnName &&
    !nameInvalid &&
    !!debounced.asm.trim();
  // Symbol-mapped runs rank too: the worker enumerates the named spellings alongside
  // '/raw-globals' and compiles each self-declared — core's declaration synthesis
  // (@asmlift/core/declare, the same renderer the cli scorer prepends), so a map-named
  // candidate scores instead of silently losing to its raw sibling. A parse-errored Symbols
  // pane leaves symbolMap undefined — ranked raw, matching the decompile it sits beside.
  const ranking = useRanking({
    eligible: rankEligible,
    asm: debounced.asm,
    name: fnName,
    targetId: debounced.targetId,
    target: rankTarget,
    flags: 'error' in flags ? NO_FLAGS : flags.argv,
    ...(symbolMap ? { symbols: symbolMap } : {}),
  });
  // The Source view shows the RANKED-BEST C when scoring has resolved for the current input;
  // otherwise the deterministic decompile (instant, and the fallback if ranking is off/loading/
  // errored). Because ranking resets to "loading" on every input change, `winner.source` can never
  // be shown against a different asm than the one it was scored for.
  const shownSource = ok ? (ranking.status === 'ok' ? ranking.result.winner.source : result.source) : '';

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
    setFlagsText(canonicalFor(ex.target));
    setBackendId(ex.backend ?? 'c');
    setSpecText(ex.spec ?? '');
    setSymbolsText(ex.symbols ?? '');
    setSymbolsOpen(!!ex.symbols);
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
            onChange={(e) => {
              setTargetId(e.target.value);
              setFlagsText(canonicalFor(e.target.value));
            }}
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
        <div className="order-last flex min-w-0 basis-full flex-col gap-1">
          <label htmlFor="playground-flags" className="text-xs uppercase tracking-wide text-slate-500">
            Flags
          </label>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <input
              id="playground-flags"
              value={flagsText}
              onChange={(e) => setFlagsText(e.target.value)}
              spellCheck={false}
              aria-invalid={'error' in liveFlags}
              title="the flags the decompile reads, and every ranked candidate compiles with"
              className={`w-full min-w-0 rounded-md border sm:w-auto sm:flex-1 bg-slate-900 px-2 py-1.5 font-mono text-xs ${
                'error' in liveFlags ? 'border-rose-700' : 'border-slate-700'
              }`}
            />
            <button
              type="button"
              onClick={() => setFlagsText(canonicalFlags)}
              disabled={flagsText === canonicalFlags}
              title={`restore ${targetId}'s canonical flags: ${canonicalFlags}`}
              className="rounded-md px-1.5 py-1 text-xs text-teal-400 hover:bg-slate-800 disabled:cursor-default disabled:text-slate-600 disabled:hover:bg-transparent"
            >
              ⟲ canonical
            </button>
            {!('error' in liveFlags) && (
              <span className="font-mono text-xs text-slate-400">level {liveFlags.level ?? 'not named'}</span>
            )}
            {!('error' in liveFlags) && liveFlags.notes.length > 0 && (
              <span className="basis-full text-xs text-slate-500">{liveFlags.notes.join(' · ')}</span>
            )}
          </div>
        </div>
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

      {'error' in liveFlags && <p className="-mt-2 text-xs text-rose-300">flags: {liveFlags.error}</p>}

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
          <div className="rounded-lg border border-slate-800">
            <button
              type="button"
              onClick={() => setSymbolsOpen((o) => !o)}
              className="flex w-full items-center gap-2 px-3 py-2 text-xs"
            >
              <span className="text-slate-500">{symbolsOpen ? '▾' : '▸'}</span>
              <span className="font-semibold text-slate-300">Symbols (optional)</span>
              <span className={`ml-auto font-mono text-[11px] ${symbolsError ? 'text-amber-400' : 'text-slate-500'}`}>
                {symbolsError
                  ? 'invalid — decompiling without the map'
                  : symbolMap
                    ? 'map active'
                    : 'address → name/shape JSON'}
              </span>
            </button>
            {symbolsOpen && (
              <div className="flex flex-col gap-1.5 border-t border-slate-800 p-2">
                <textarea
                  value={symbolsText}
                  onChange={(e) => setSymbolsText(e.target.value)}
                  rows={8}
                  placeholder={SYMBOLS_PLACEHOLDER}
                  spellCheck={false}
                  className="scroll-slim rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs placeholder:text-slate-600"
                />
                {symbolsError && (
                  <p className="rounded-md border border-amber-900/60 bg-amber-950/30 p-2 text-xs leading-relaxed text-amber-300">
                    symbol map ignored — {symbolsError}. The decompile above ran without it.
                  </p>
                )}
              </div>
            )}
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
                {/* The block the winner was COMPILED WITH. The verdict is a fact about
                    declarations + source, and a synthesized declaration is fitted to the pasted
                    asm — showing only the source would publish half of it. */}
                <RankDeclarations ranking={ranking} />
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
          {assumed.length > 0 && (
            <div className="rounded-lg border border-sky-900/60 bg-sky-950/30 p-3 text-xs leading-relaxed">
              <p className="mb-1.5 font-semibold text-sky-300">
                {assumed.length} array shape{assumed.length > 1 ? 's' : ''} derived from this assembly — the source
                spells {assumed.length > 1 ? 'them' : 'it'} BARE, so it means what these declarations mean:
              </p>
              <pre className="font-mono text-sky-200/90">
                {renderDeclarations(assumed.map((info) => ({ name: info.name, info }))).trimEnd()}
              </pre>
            </div>
          )}
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
