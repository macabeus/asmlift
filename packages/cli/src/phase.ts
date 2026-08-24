// asmlift — the ranked run's phase clock. A ranked run is four phases with wildly different costs
// — enumerate the candidates, compile each one, score each object, order the results — and the
// `asmlift: [phase]` line is what a run says about each. A per-phase claim then comes from the log
// everyone already pastes, instead of from a rig outside the tree the next round has to rebuild.
//
// The clock is a VALUE the ranked path owns, not a module global: `main.ts` mints one per run and
// threads it through `rank.ts`. A caller that mints none takes no timing and keeps no state.
//
// `compile` is summed ACROSS workers and legitimately exceeds the wall clock; that ratio is the
// pool's average parallelism, and it is the number that says whether more `--jobs` would help.

/** A ranked run's phases. `rank` is the final ordering pass, separate from `score` because they
 *  are the two halves the pooled driver splits — and one of them is one call per candidate. */
export type Phase = 'enumerate' | 'compile' | 'score' | 'rank';

const PHASES: Phase[] = ['enumerate', 'compile', 'score', 'rank'];

export class PhaseClock {
  readonly #ms = new Map<Phase, number>();
  readonly #calls = new Map<Phase, number>();
  readonly #started = performance.now();
  // Inclusive time charged by the children of each OPEN synchronous frame, so a phase that
  // contains another one reports its own work: the serial driver compiles inside the call it
  // scores in, and a `score` that quietly counted the compile would be the whole profile wrong.
  readonly #children: number[] = [];
  /** How many concurrent producers charged `compile` — reported so a summed figure larger than
   *  the wall clock reads as parallelism rather than as a broken measurement. */
  workers = 1;

  #add(phase: Phase, ms: number): void {
    this.#ms.set(phase, (this.#ms.get(phase) ?? 0) + ms);
    this.#calls.set(phase, (this.#calls.get(phase) ?? 0) + 1);
  }

  /** Charge one SYNCHRONOUS phase, exclusive of any phase nested inside it. */
  time<T>(phase: Phase, fn: () => T): T {
    const t0 = performance.now();
    this.#children.push(0);
    try {
      return fn();
    } finally {
      const elapsed = performance.now() - t0;
      const nested = this.#children.pop() ?? 0;
      if (this.#children.length > 0) {
        this.#children[this.#children.length - 1] += elapsed;
      }
      this.#add(phase, elapsed - nested);
    }
  }

  /** Charge one AWAITED phase. Flat, and outside the nesting stack above: several of these are in
   *  flight at once in the pooled driver, so there is no one frame such a charge belongs to. */
  async timeAsync<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.#add(phase, performance.now() - t0);
    }
  }

  /** What this clock has charged one phase, in milliseconds and calls — the same numbers
   *  `report()` renders, for a caller that wants them rather than the line. */
  charged(phase: Phase): { ms: number; calls: number } {
    return { ms: this.#ms.get(phase) ?? 0, calls: this.#calls.get(phase) ?? 0 };
  }

  /** One `asmlift: [phase]` line. `main-thread idle+other` is the wall minus the phases that run
   *  ON the main thread — the pool's waiting, plus everything this clock does not name — so it is
   *  the honest size of what a reader may NOT conclude from the numbers beside it. */
  report(): string {
    const wall = (performance.now() - this.#started) / 1000;
    const s = (phase: Phase) => (this.#ms.get(phase) ?? 0) / 1000;
    const parts = PHASES.filter((p) => this.#calls.has(p)).map((p) => {
      const n = this.#calls.get(p) ?? 0;
      const pooled = p === 'compile' && this.workers > 1 ? ` over ${this.workers} workers` : '';
      return `${p} ${s(p).toFixed(1)}s${pooled} (${n} call${n === 1 ? '' : 's'})`;
    });
    const other = wall - s('enumerate') - s('score') - s('rank');
    return `asmlift: [phase] wall ${wall.toFixed(1)}s · ${parts.join(' · ')} · main-thread idle+other ${other.toFixed(1)}s\n`;
  }
}

/** `clock.time`, tolerating the absent clock every non-CLI caller has. */
export const timed = <T>(clock: PhaseClock | undefined, phase: Phase, fn: () => T): T =>
  clock ? clock.time(phase, fn) : fn();

/** `clock.timeAsync`, same. */
export const timedAsync = <T>(clock: PhaseClock | undefined, phase: Phase, fn: () => Promise<T>): Promise<T> =>
  clock ? clock.timeAsync(phase, fn) : fn();
