import type { DecompilerId, DecompilerResult, FunctionResult } from '@asmlift/bench-schema';
import { useEffect, useMemo, useState } from 'react';

import { CodeBlock, type CodeLanguage } from '../../../shared/components/CodeBlock';
import type { ShareState } from '../../../shared/utils/permalink';
import { formatC } from '../lib/format-c';
import { playgroundShare } from '../lib/playground';
import { DECOMPILER_COLOR, TOOLCHAIN_LABEL } from '../theme';
import { Chip, GapBadge, OutcomeBadge } from './ui/Badge';

// The Benchmark's code-block chrome (the shared CodeBlock only fixes scroll/whitespace/mono).
const CODE_PRE = 'max-h-[46vh] rounded-md bg-slate-950/70 p-3 text-[12px] leading-relaxed text-slate-200';

/** A syntax-highlighted scrollable code block (em-dash placeholder for empty text). */
function Code({ text, language }: { text: string; language: CodeLanguage }) {
  if (!text) {
    return <pre className={`scroll-slim overflow-auto whitespace-pre font-mono ${CODE_PRE}`}>—</pre>;
  }
  return <CodeBlock code={text} language={language} className={CODE_PRE} />;
}

function scoreLabel(r: DecompilerResult): string {
  if (r.score === null) {
    return '—';
  }
  const max = r.maxScore ? `/${r.maxScore}` : '';
  return `${r.score}${max}`;
}

/** The nonzero readability penalties, spelled out (nothing shown for clean output). */
function qualityFlags(q: DecompilerResult['quality']): string[] {
  const flags: string[] = [];
  if (q.unkGlue > 0) {
    flags.push(`${q.unkGlue} undecompiled glue token(s)`);
  }
  if (q.gotos > 0) {
    flags.push(`${q.gotos} goto(s)`);
  }
  if (q.casts > 2) {
    flags.push(`${q.casts} casts`);
  }
  return flags;
}

/** One decompiler column: source + outcome + score + quality flags. */
function DecompilerColumn({
  id,
  result,
  language,
}: {
  id: DecompilerId;
  result: DecompilerResult;
  language: CodeLanguage;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm font-semibold" style={{ color: DECOMPILER_COLOR[id] }}>
          {id}
        </span>
        <div className="flex items-center gap-2">
          <OutcomeBadge outcome={result.outcome} />
          <span className="font-mono text-xs text-slate-400">objdiff {scoreLabel(result)}</span>
        </div>
      </div>
      <Code text={result.source} language={language} />
      <div className="text-xs text-slate-400 space-y-1">
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono">
          {result.outcome === 'declined' || result.outcome === 'failed' ? (
            // Marker stubs and failure text have no meaningful readability — a number here
            // would mislead.
            <span>quality n/a ({result.outcome})</span>
          ) : (
            <>
              <span>quality {result.quality.score}</span>
              <span>lines {result.quality.lines}</span>
              <span>gotos {result.quality.gotos}</span>
              <span>casts {result.quality.casts}</span>
              <span title="undecompiled-glue markers (M2C_ERROR / ASMLIFT_ERROR / opaque expressions)">
                unk-glue {result.quality.unkGlue}
              </span>
            </>
          )}
          {result.compileErrors !== null && <span className="text-red-400">compile errors {result.compileErrors}</span>}
        </div>
        {result.breakdown && result.score !== null && result.score > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-slate-500">
            <span title="instructions only in the candidate">+{result.breakdown.insert} ins</span>
            <span title="instructions only in the target">−{result.breakdown.delete} del</span>
            <span title="instructions fully replaced">~{result.breakdown.replace} repl</span>
            <span title="same position, different opcode">{result.breakdown.opMismatch} op</span>
            <span title="same opcode, different operands">{result.breakdown.argMismatch} arg</span>
          </div>
        )}
        {result.outcome !== 'declined' && result.outcome !== 'failed' && qualityFlags(result.quality).length > 0 && (
          <ul className="list-disc pl-4 space-y-0.5">
            {qualityFlags(result.quality).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        {result.errorMarkers && result.errorMarkers.length > 0 && (
          <div className="text-red-400">markers: {result.errorMarkers.join(', ')}</div>
        )}
      </div>
    </div>
  );
}

// The reproduction scripts open with placeholder checkout paths (M2C_PATH='/path/to/m2c' …).
// A visitor types their real paths once — persisted per browser — and every script renders
// copy-paste runnable, both on screen and through the Copy button.
const PATH_STORAGE_KEYS = { m2c: 'bench:m2c-path', asmlift: 'bench:asmlift-path' } as const;

function usePersistedPath(key: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  });
  const set = (v: string) => {
    setValue(v);
    try {
      if (v) {
        localStorage.setItem(key, v);
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // storage unavailable (private mode) — the input still works for this visit
    }
  };
  return [value, set];
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Rewrite a script's placeholder path assignments with the visitor's checkouts. */
function fillScriptPaths(script: string, m2cPath: string, asmliftPath: string): string {
  let out = script;
  if (m2cPath.trim()) {
    out = out.replace(`M2C_PATH='/path/to/m2c'`, `M2C_PATH=${shellQuote(m2cPath.trim())}`);
  }
  if (asmliftPath.trim()) {
    out = out.replace(`ASMLIFT_PATH='/path/to/asmlift'`, `ASMLIFT_PATH=${shellQuote(asmliftPath.trim())}`);
  }
  return out;
}

function PathInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-400">
      <span className="font-mono">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="w-56 rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-teal-500 focus:outline-none"
      />
    </label>
  );
}

/** A collapsed-by-default code section; `copy` adds a copy-to-clipboard button when open. */
function CollapsibleCode({
  title,
  text,
  language,
  copy = false,
}: {
  title: string;
  text: string;
  language: CodeLanguage;
  copy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-sm font-semibold text-slate-300 hover:text-white"
        >
          <span className="text-slate-500">{open ? '▾' : '▸'}</span>
          {title}
        </button>
        {copy && open && (
          <button
            onClick={() => {
              navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="rounded border border-slate-600 px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2">
          <Code text={text} language={language} />
        </div>
      )}
    </div>
  );
}

/** Right-hand detail drawer for a selected function. */
export function FunctionDetail({
  fn,
  onClose,
  onOpenInPlayground,
}: {
  fn: FunctionResult;
  onClose: () => void;
  onOpenInPlayground: (s: ShareState) => void;
}) {
  const share = useMemo(() => playgroundShare(fn), [fn]);
  const [m2cPath, setM2cPath] = usePersistedPath(PATH_STORAGE_KEYS.m2c);
  const [asmliftPath, setAsmliftPath] = usePersistedPath(PATH_STORAGE_KEYS.asmlift);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="scroll-slim w-full max-w-6xl overflow-y-auto border-l border-slate-700 bg-slate-900 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-700 bg-slate-900/95 px-6 py-4 backdrop-blur-sm">
          <div>
            <h2 className="font-mono text-lg font-bold text-white">{fn.sym}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
              <span>{fn.project}</span>
              <span className="text-slate-600">·</span>
              <span>{TOOLCHAIN_LABEL[fn.toolchain]}</span>
              <span className="text-slate-600">·</span>
              <span className="uppercase">{fn.isa}</span>
              <span className="text-slate-600">·</span>
              <span>{fn.tier}</span>
              <span className="text-slate-600">·</span>
              <span>{fn.loc} loc</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {fn.features.map((f) => (
                <Chip key={f}>{f}</Chip>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {share && (
              <button
                onClick={() => {
                  onOpenInPlayground(share);
                  onClose();
                }}
                title={
                  fn.tier === 'real'
                    ? 'Reproduces context-free (the benchmark run had prototypes)'
                    : 'Reproduce this function live'
                }
                className="rounded-md border border-teal-700 bg-teal-900/40 px-3 py-1 text-sm font-medium text-teal-300 hover:bg-teal-900/70"
              >
                Open in playground ↗
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-md px-3 py-1 text-sm text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              Close ✕
            </button>
          </div>
        </div>

        <div className="space-y-5 p-6">
          {fn.note && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              {fn.note}
            </div>
          )}

          {/* Three columns: reference + both decompilers */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-semibold text-slate-300">
                reference source
                {fn.sourceUrl && (
                  <a
                    href={fn.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-2 font-normal text-teal-400 hover:text-teal-300"
                    title="the exact lines in the decomp project (commit-pinned)"
                  >
                    view on GitHub ↗
                  </a>
                )}
              </span>
              <Code text={formatC(fn.refSource)} language={fn.language} />
            </div>
            <DecompilerColumn id="asmlift" result={fn.asmlift} language={fn.language} />
            <DecompilerColumn id="m2c" result={fn.m2c} language={fn.language} />
          </div>

          {/* Measured gap size */}
          {fn.gapSize && (
            <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-3">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-100">
                Gap size
                <GapBadge gap={fn.gapSize} />
              </div>
              <p className="text-xs text-slate-400">
                Best compiling candidate: <span className="font-mono">{fn.gapSize.decompiler}</span> at{' '}
                <span className="font-mono">
                  {fn.gapSize.score}/{fn.gapSize.maxScore}
                </span>{' '}
                differing instructions ({(fn.gapSize.ratio * 100).toFixed(0)}%)
              </p>
            </div>
          )}

          {/* Collapsibles: the decompiler input + copyable reproduction scripts */}
          <CollapsibleCode title="Input disassembly" text={fn.targetAsm} language="asm" />
          {fn.scripts && (
            <>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2">
                <span className="text-xs text-slate-500">Your local folders:</span>
                <PathInput label="M2C_PATH" value={m2cPath} onChange={setM2cPath} placeholder="/path/to/m2c" />
                <PathInput
                  label="ASMLIFT_PATH"
                  value={asmliftPath}
                  onChange={setAsmliftPath}
                  placeholder="/path/to/asmlift"
                />
              </div>
              <CollapsibleCode
                title="m2c script"
                text={fillScriptPaths(fn.scripts.m2c, m2cPath, asmliftPath)}
                language="bash"
                copy
              />
              <CollapsibleCode
                title="asmlift script"
                text={fillScriptPaths(fn.scripts.asmlift, m2cPath, asmliftPath)}
                language="bash"
                copy
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
