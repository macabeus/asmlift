// asmlift — the traced tower: decompile() plus a per-stage PROCESS record (the reasoning
// trail), browser-pure. Runs the SAME stage sequence as pipeline.ts and captures a TraceReport:
// per-stage IR dumps (each post-verify) and per-pattern before/after events. Scoring lives on
// the other side of the seam: @asmlift/cli/report enriches this into the full DecompileReport
// (objdiff score, per-pattern score deltas via the `probeScore` hook, ranked candidates) when a
// target object is available; the web playground renders the TraceReport as-is.
import { cBackend } from './backend/c';
import type { AsmData } from './frontend/asmdata';
import { frontendFor } from './frontend/registry';
import type { Fn } from './ir/core';
import { print } from './ir/print';
import { verify } from './ir/verify';
import type { LanguageBackend } from './l3/ast';
import { DEFAULT_IDIOM_PATTERNS, RewritePattern, applyPattern, dce, patternApplies } from './pattern/engine';
import { type OnGap, raiseRecovered, structureChecked, stubResult } from './pipeline';
import { type Prototypes, prototypesFromSymbols } from './proto';
import { assumedShapes, inferGlobalArrays } from './raise/globalshape';
import { type SymbolInfo, type SymbolMap, symbolsByName } from './symbols';
import { type TargetDescription, structureOptionsFor } from './target';

export interface StageTrace {
  id: string; // stable localization anchor: "stage:lift", "stage:recover", …
  title: string; // human label = the transform this stage performs
  irDump?: string; // textual IR (or emitted source for the backend stage)
  verified: boolean; // verifier passed after this stage
  note?: string;
}
export interface PatternEvent {
  id: string; // "pattern:sdiv-pow2/2"
  patternId: string;
  hits: number;
  beforeIr: string;
  afterIr: string;
  scoreBefore?: number; // filled only when a probeScore hook is supplied (cli report)
  scoreAfter?: number;
  scoreDelta?: number; // negative = improved toward match
}

export interface TraceReport {
  version: 1;
  type: 'decompile';
  symbol: string;
  target: {
    isa: string;
    compiler: string;
    capabilities: TargetDescription['capabilities'];
    compilerBehaviors: TargetDescription['compilerBehaviors'];
  };
  asm: string; // the original input assembly the run decompiled
  trace: StageTrace[];
  patternEvents: PatternEvent[];
  source: string;
  /** Set ONLY on the annotate-mode stub path (empty trace): the failure reason, machine-readable —
   *  so a consumer of the reasoning trail is not reduced to parsing the stub's source comments. */
  declineReason?: string;
  /** The shapes the emitted source's spelling ASSUMES, derived from the assembly rather than read
   *  from a map — pipeline.ts `DecompileResult.assumedSymbols`, and the same obligation: a
   *  consumer showing the source must show these, because a bare `gSym[i]` means what the
   *  declaration of `gSym` says it means.
   *
   *  NARROWER THAN THE `stage:globalshape` ENTRY ABOVE, on purpose. That entry reports what the
   *  stage DERIVED, so a spelling decision downstream is attributable to a stage; this reports
   *  what the SOURCE rests on, and a shape the structurer refused or a name the caller's own map
   *  described is not an obligation the reader has (raise/globalshape.ts `assumedShapes`). */
  assumedSymbols: SymbolInfo[];
}

/** `; dims [_][2]` for a derived rank, or '' for rank 1 — the trace note's tail. */
function dimsNote(i: SymbolInfo): string {
  const inner = i.shape === 'array' ? (i.dims ?? []).slice(1) : [];
  return inner.length === 0 ? '' : `, dims [_]${inner.map((d) => `[${d ?? '?'}]`).join('')}`;
}

// Every knob decompile() takes must exist here with the SAME default — a surface that disagrees
// with pipeline.ts makes the report's headline source diverge from decompile()'s.
export interface TraceOptions {
  patterns?: RewritePattern[]; // DEFAULTS to DEFAULT_IDIOM_PATTERNS, exactly like decompile()
  backend?: LanguageBackend;
  prototypes?: Prototypes; // header facts (callee arities + void-ness), keyed by symbol
  asmData?: AsmData; // data-section side table (Regime-B jump tables), as in decompile()
  symbols?: SymbolMap; // address→symbol map (symbols.ts), as in decompile(); absent ⇒ inert
  onGap?: OnGap; // "strict" (default) | "annotate", as in decompile()
  /** Score probe at pattern boundaries (cli report's objdiff hook). One call per boundary:
   *  pattern N's after-score is pattern N+1's before-score. Absent ⇒ score fields stay unset.
   *
   *  THE DERIVED ARRAY SHAPES TRAVEL WITH THE CLONE: they are read once off the lift
   *  (`stage:globalshape`) and change the default spelling of every indexed global, so a probe
   *  that structures without them attributes its per-pattern delta to a source the main path does
   *  not emit. */
  probeScore?: (fn: Fn, inferredSymbols: Map<string, SymbolInfo>) => number | undefined;
}

// The report's per-pass trace stage id + title, keyed by the shared PreRecoveryPass.id. Kept HERE
// (not in pre-recovery.ts) because these strings are a trace concern — the driver itself is
// trace-agnostic. `title` is a function so `arrays` can fold its scaled-access count in.
const PRE_RECOVERY_TRACE: Record<string, { stage: string; title: (result: number | boolean) => string }> = {
  addrnum: {
    stage: 'stage:addrnum',
    title: (r) => `Address numbering (${r} duplicate address def(s) / trivial phi(s) collapsed)`,
  },
  const: { stage: 'stage:const', title: () => 'Const materialize (lui;ori → one 32-bit const)' },
  magicdiv: { stage: 'stage:magicdiv', title: () => 'Magic-number division recovery (mulh/mulhu → sdiv/udiv)' },
  softdiv: { stage: 'stage:softdiv', title: () => 'Soft-division lower (bl __divsi3 → division op)' },
  arrays: { stage: 'stage:legalize', title: (r) => `Array legalize (${r} scaled access(es) → aload/astore)` },
  structs: { stage: 'stage:structs', title: () => 'Struct-pointer recovery (access-pattern evidence)' },
  shortcircuit: { stage: 'stage:shortcircuit', title: () => 'Short-circuit recovery (boolean && / ||)' },
  'branch-shortcircuit': {
    stage: 'stage:branch-shortcircuit',
    title: () => 'Short-circuit recovery (control-flow && / ||)',
  },
  'struct-arrays': { stage: 'stage:struct-arrays', title: () => 'Struct-array recovery (element stride evidence)' },
};

/** Run the tower while recording a TraceReport. Strict mode throws on any gap (like decompile);
 *  annotate mode never throws — a non-localizable failure degrades to the same stub. */
export function decompileTraced(
  name: string,
  asm: string,
  target: TargetDescription,
  opts: TraceOptions = {},
): { source: string; report: TraceReport } {
  if ((opts.onGap ?? 'strict') === 'strict') {
    return traceTower(name, asm, target, opts);
  }
  try {
    return traceTower(name, asm, target, opts);
  } catch (e) {
    // Annotate-mode parity with decompile(): a NON-localizable failure degrades to the SAME
    // stub (reason + original asm as comments) instead of a throw.
    const stub = stubResult(name, asm, opts.backend ?? cBackend, e);
    return {
      source: stub.source,
      report: {
        version: 1,
        type: 'decompile',
        symbol: name,
        target: {
          isa: target.id,
          compiler: target.compiler,
          capabilities: target.capabilities,
          compilerBehaviors: target.compilerBehaviors,
        },
        asm,
        trace: [],
        patternEvents: [],
        assumedSymbols: [],
        source: stub.source,
        declineReason: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

function traceTower(
  name: string,
  asm: string,
  target: TargetDescription,
  opts: TraceOptions,
): { source: string; report: TraceReport } {
  const backend = opts.backend ?? cBackend;
  // Merged exactly as pipeline.ts does: the project's own DWARF signatures fill in what the caller
  // did not state. A trace that lifted from a different table would explain a run that never
  // happened.
  const prototypes = prototypesFromSymbols(opts.symbols, opts.prototypes ?? {});
  const returnsVoid = prototypes[name]?.returnsVoid ?? false;
  const trace: StageTrace[] = [];
  const patternEvents: PatternEvent[] = [];

  // (1) lift → typed-SSA IR
  const fn = frontendFor(target).lift(name, asm, target, prototypes, opts.asmData, opts.symbols);
  verify(fn);
  trace.push({ id: 'stage:lift', title: 'Lift (ISA frontend → typed-SSA IR)', irDump: print(fn), verified: true });
  // The array shapes the assembly evidences, off the LIFTED fn — same reading, same reason, as
  // pipeline.ts's runTower: the fold and the tower below destroy the order the licence reads.
  //
  // IT GETS ITS OWN TRACE ENTRY because it is the one stage whose product is not the IR: it
  // changes the DEFAULT spelling of every indexed global and leaves no mark in any `irDump`, so
  // without a line here a reader following the trail from `stage:lift` to `stage:structure` sees
  // `gTbl[i]` appear with nothing that produced it, and a wrong shape is attributable to no stage.
  const inferredSymbols = inferGlobalArrays(fn, target);
  trace.push({
    id: 'stage:globalshape',
    title: 'Array shape from stride evidence (globals no symbol map describes)',
    verified: true,
    note:
      inferredSymbols.size === 0
        ? 'nothing evidenced — every indexed global keeps `((T *)&gSym)[i]`, valid under any declaration'
        : [...inferredSymbols.values()]
            .map((i) => `${i.name}: elem ${i.elemSize} ${i.elemSigned ? 'signed' : 'unsigned'}${dimsNote(i)}`)
            .join('; '),
  });

  // (2) idiom fold (capability-gated), with an optional probed score per pattern boundary —
  // the SAME default set as decompile()/decompileRanked
  const active = (opts.patterns ?? DEFAULT_IDIOM_PATTERNS).filter((p) => patternApplies(p, target));
  // Probe economy: ONE probe per pattern boundary — pattern N's after-score IS pattern N+1's
  // before-score (the state is identical), and each probe costs a full clone + tower + external
  // compile + objdiff. Zero-hit patterns emit NO event (the IR is unchanged).
  let scoreBefore = opts.probeScore?.(fn, inferredSymbols);
  for (const p of active) {
    const beforeIr = print(fn);
    const hits = applyPattern(fn, p);
    dce(fn);
    verify(fn);
    if (hits === 0) {
      continue;
    }
    const afterIr = print(fn);
    const scoreAfter = opts.probeScore?.(fn, inferredSymbols);
    patternEvents.push({
      id: `pattern:${p.id}`,
      patternId: p.id,
      hits,
      beforeIr,
      afterIr,
      scoreBefore,
      scoreAfter,
      scoreDelta: scoreBefore !== undefined && scoreAfter !== undefined ? scoreAfter - scoreBefore : undefined,
    });
    scoreBefore = scoreAfter;
  }
  if (active.length) {
    trace.push({
      id: 'stage:idiom',
      title: `Idiom fold (${active.length} pattern(s), capability-gated)`,
      irDump: print(fn),
      verified: true,
    });
  }

  // (2.35–3.5) the SHARED tower spine (pipeline.ts raiseRecovered) — pre-recovery recognizers →
  // type recovery → return-sinking, byte-identical to decompile()/decompileRanked by
  // construction. The trace's only additions are the entries, injected via the hooks
  // (each fires post-verify).
  raiseRecovered(
    fn,
    target,
    {
      afterPass: (pass, result) => {
        // A pass with no registered strings still traces under a generic title: the traced tower
        // must never crash (and so diverge from decompile()) just because a NEW pre-recovery pass
        // landed before its trace entry did.
        const t = PRE_RECOVERY_TRACE[pass.id] ?? {
          stage: `stage:${pass.id}`,
          title: () => `${pass.id} (pre-recovery pass)`,
        };
        trace.push({ id: t.stage, title: t.title(result), irDump: print(fn), verified: true });
      },
      afterRecover: () =>
        trace.push({ id: 'stage:recover', title: 'Type recovery (in-place on IR)', irDump: print(fn), verified: true }),
      afterRetsink: () =>
        trace.push({
          id: 'stage:retsink',
          title: 'Return-sinking (tail-duplicate return-only merge)',
          irDump: print(fn),
          verified: true,
        }),
      afterLatchFold: () =>
        trace.push({
          id: 'stage:latchfold',
          title: 'Empty-latch folding (splice out an SSA-emptied back-edge block)',
          irDump: print(fn),
          verified: true,
        }),
    },
    prototypes[name],
  );

  // (4) structure → neutral AST; boundary contract: no unresolved value leaked (strict) or
  // spelled as a loud ASMLIFT_ERROR marker (annotate) — same onGap lever as decompile()
  const mapSymbols = opts.symbols ? symbolsByName(opts.symbols) : undefined;
  const sfn = structureChecked(fn, {
    ...structureOptionsFor(target, returnsVoid),
    onGap: opts.onGap ?? 'strict',
    ...(mapSymbols ? { symbols: mapSymbols } : {}),
    ...(inferredSymbols.size ? { inferredSymbols } : {}),
  });
  trace.push({
    id: 'stage:structure',
    title: 'Structuring (IR → neutral AST)',
    verified: true,
    note: `${sfn.body.length} top-level statement(s)`,
  });

  // (5) lower + print → source text
  const source = backend.emit(sfn);
  trace.push({ id: 'stage:emit', title: `Backend emit (neutral AST → ${backend.id})`, irDump: source, verified: true });

  return {
    source,
    report: {
      version: 1,
      type: 'decompile',
      symbol: name,
      target: {
        isa: target.id,
        compiler: target.compiler,
        capabilities: target.capabilities,
        compilerBehaviors: target.compilerBehaviors,
      },
      asm,
      trace,
      patternEvents,
      source,
      // The same narrowing pipeline.ts's `DecompileResult` makes, and for the same reason: the
      // `stage:globalshape` entry above reports what the STAGE derived, this reports what the
      // SOURCE rests on, and they differ wherever a consumer refused the shape or the caller's
      // own map already declared the name (raise/globalshape.ts `assumedShapes`).
      assumedSymbols: assumedShapes(inferredSymbols, sfn, mapSymbols),
    },
  };
}
