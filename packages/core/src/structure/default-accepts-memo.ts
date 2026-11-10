// asmlift structurer — the memo of the default structuring's outcome that `assertDefaultAccepts`
// (structure.ts) asks before re-running it: `DefaultAcceptsMemo`, one outcome per reset of one fn,
// refusing to answer for a graph rewritten under it (`DefaultAcceptsMemoMisuse`, `graphShape`).
import { Fn } from '../ir/core';
import type { StructureHooks, StructureOptions } from './structure-options';

/** A {@link DefaultAcceptsMemo} asked a question it cannot answer. */
export class DefaultAcceptsMemoMisuse extends Error {
  constructor(message: string) {
    super(`DefaultAcceptsMemo: ${message}`);
    this.name = 'DefaultAcceptsMemoMisuse';
  }
}

/** Every block, block parameter, op, opcode, operand, result, successor and edge argument of `fn`,
 *  in order and by identity, each list after its length. A pass that rewrites the graph in place
 *  changes it; attributes and side tables are not in it. */
function graphShape(fn: Fn): unknown[] {
  const shape: unknown[] = [fn.blocks.length];
  for (const b of fn.blocks) {
    shape.push(b, b.params.length, ...b.params, b.ops.length);
    for (const op of b.ops) {
      shape.push(op, op.opcode, op.operands.length, ...op.operands, op.results.length, ...op.results);
      shape.push(op.successors.length);
      for (const s of op.successors) {
        shape.push(s.block, s.args.length, ...s.args);
      }
    }
  }
  return shape;
}

/** A set or array of at most this many primitives is keyed by its members. Keying costs a pass over
 *  the members on every structuring, and the maps and sets a project hands every function (`symbols`,
 *  `pointerGlobals`) are as large as the project, so a bigger one is keyed by identity. */
const MEMO_CONTENT_KEY_LIMIT = 64;

/** What `assertDefaultAccepts` learned about ONE fn: for each reset it structured, whether
 *  `structure()` accepted it or the error it threw. Settings that differ only in the flags the
 *  guard resets share one reset, so an enumeration that structures a fn under many settings asks
 *  the same question of it many times.
 *
 *  VALID WHILE THE FN AND THE OPTIONS' CONTAINERS ARE UNCHANGED. A fn rewritten in place
 *  (`sinkStoreTails`) needs a new memo, and a `Map`, an object, or a set or array over
 *  `MEMO_CONTENT_KEY_LIMIT` members is keyed by identity, so one mutated between two calls would
 *  share a key with its old contents. The `declared` stamps are not a change: `structure()`
 *  re-derives them from the options' map before it reaches the guard, so the reset run finds them as
 *  the first run of the same key did.
 *
 *  Asked about another fn, or about its own fn once a block, op or value of it was added, removed,
 *  replaced or reordered (`graphShape`), it throws {@link DefaultAcceptsMemoMisuse} rather than
 *  answer. That is a wiring defect, not a decline, so `rank.ts` lets it end the enumeration.
 *
 *  Only a call with no hooks is answered: a hook can change the outcome, or must observe the run.
 *  An option holding a function or a symbol has no key, and its reset always runs. */
export class DefaultAcceptsMemo {
  readonly #outcomes = new Map<string, { error: unknown } | 'accepted'>();
  readonly #ids = new WeakMap<object, number>();
  readonly #shape: readonly unknown[];
  #nextId = 0;

  constructor(readonly fn: Fn) {
    this.#shape = graphShape(fn);
  }

  /** Returns or throws what `run` did for this reset, running it only when the memo has no
   *  outcome for it yet. */
  check(fn: Fn, hooks: StructureHooks, reset: StructureOptions, run: () => void): void {
    if (fn !== this.fn) {
      throw new DefaultAcceptsMemoMisuse('asked about a fn it was not made for');
    }
    const shape = graphShape(fn);
    if (shape.length !== this.#shape.length || shape.some((x, i) => !Object.is(x, this.#shape[i]))) {
      throw new DefaultAcceptsMemoMisuse(`asked about ${fn.name} after its graph was rewritten`);
    }
    const key = Object.values(hooks).every((h) => h === undefined) ? this.#keyOf(reset) : undefined;
    if (key === undefined) {
      run();
      return;
    }
    const known = this.#outcomes.get(key);
    if (known === 'accepted') {
      return;
    }
    if (known !== undefined) {
      throw known.error;
    }
    try {
      run();
    } catch (error) {
      this.#outcomes.set(key, { error });
      throw error;
    }
    this.#outcomes.set(key, 'accepted');
  }

  /** Every option that is set, by name and value; `undefined` when one has no key. */
  #keyOf(opts: StructureOptions): string | undefined {
    const parts: string[] = [];
    for (const name of Object.keys(opts).sort()) {
      const value: unknown = (opts as Record<string, unknown>)[name];
      if (value === undefined) {
        continue;
      }
      const part = this.#valueKey(value);
      if (part === undefined) {
        return undefined;
      }
      parts.push(`${name}=${part}`);
    }
    return parts.join(';');
  }

  /** A prefix-free spelling of one value, so two option sets share a key only when every value
   *  agrees. */
  #valueKey(value: unknown): string | undefined {
    switch (typeof value) {
      case 'undefined':
        return 'u';
      case 'boolean':
        return value ? 't' : 'f';
      case 'number':
        return Object.is(value, -0) ? 'n-0' : `n${value}`;
      case 'bigint':
        return `b${value}`;
      case 'string':
        return JSON.stringify(value);
      case 'function':
      case 'symbol':
        return undefined;
    }
    if (value === null) {
      return 'null';
    }
    const members = value instanceof Set ? [...value] : Array.isArray(value) ? value : undefined;
    if (
      members !== undefined &&
      members.length <= MEMO_CONTENT_KEY_LIMIT &&
      members.every((m) => m === null || typeof m !== 'object')
    ) {
      const keys = members.map((m) => this.#valueKey(m));
      return keys.every((k) => k !== undefined) ? `${value instanceof Set ? 'S' : 'A'}[${keys.join(',')}]` : undefined;
    }
    const container = value as object;
    let id = this.#ids.get(container);
    if (id === undefined) {
      id = this.#nextId++;
      this.#ids.set(container, id);
    }
    return `#${id}`;
  }
}
