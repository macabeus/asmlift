// asmlift IR — the canonical textual printer.
//
// Determinism: value names are assigned HERE, at print time, by a fixed traversal
// (blocks in order; within a block, params then op-results). Two
// structurally-identical functions therefore print byte-identically regardless of the
// order their Value objects were created — there is no global counter to leak order.
import type { AttrVal, Block, Fn, Value } from './core';
import { typeToString } from './types';

/** WRITE-ORDER ANNOTATION (`ir/core.ts` WriteOrder) — OFF by default and deliberately not part of
 *  the round-trip artifact. The record is a measurement `parse` cannot reconstruct, and a parsed fn
 *  that came back MEASURED would structure differently from every other parsed fn, so the text form
 *  never carries it back in. It is printed for the per-stage DUMPS, where its absence was the gap:
 *  two functions with identical `stage:lift` output emit different C, and attributing that took a
 *  temporary printf where a dump diff should have shown it. */
export interface PrintOptions {
  writeOrder?: boolean;
}

export function print(fn: Fn, opts: PrintOptions = {}): string {
  const blockLabel = new Map<Block, string>();
  fn.blocks.forEach((b, i) => blockLabel.set(b, `bb${i}`));

  const name = new Map<Value, string>();
  let counter = 0;
  const assign = (v: Value) => {
    if (!name.has(v)) {
      name.set(v, `%${counter++}`);
    }
    return name.get(v)!;
  };
  for (const b of fn.blocks) {
    for (const p of b.params) {
      assign(p);
    }
    for (const op of b.ops) {
      for (const r of op.results) {
        assign(r);
      }
    }
  }
  const ref = (v: Value) => name.get(v) ?? '%<undef>';

  // Present only when asked for AND measured — an unmeasured fn prints exactly as before, which is
  // the distinction a reader of the dump most needs to see.
  const order = opts.writeOrder ? fn.writeOrder : undefined;
  const lines: string[] = [`fn ${fn.name} {`];
  for (const b of fn.blocks) {
    const params = b.params.map((p) => `${ref(p)}: ${typeToString(p.type)}`).join(', ');
    const writes = order?.writes.get(b);
    lines.push(`^${blockLabel.get(b)}(${params}):` + (writes === undefined ? '' : `  ; writes=${writes}`));
    for (const op of b.ops) {
      let s = '  ';
      if (op.results.length) {
        s += op.results.map((r) => `${ref(r)}: ${typeToString(r.type)}`).join(', ') + ' = ';
      }
      s += op.opcode;
      const args: string[] = [];
      for (const o of op.operands) {
        args.push(ref(o));
      }
      for (const su of op.successors) {
        args.push(`^${blockLabel.get(su.block)}(${su.args.map(ref).join(', ')})`);
      }
      if (args.length) {
        s += ' ' + args.join(', ');
      }
      s += fmtAttrs(op.attrs);
      // Per SUCCESSOR, the ordinal of this block's last write to each destination param's key —
      // the exact numbers `structure.ts`'s edge-copy sort reads, in successor-arg order, with `-`
      // for a destination this block never wrote.
      if (order?.writes.has(b) && op.successors.length) {
        const rec = order.lastWrite.get(b);
        s +=
          '  ; order ' +
          op.successors
            .map((su) => `^${blockLabel.get(su.block)}(${su.block.params.map((p) => rec?.get(p) ?? '-').join(', ')})`)
            .join(' ');
      }
      lines.push(s);
    }
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function fmtAttrs(a: Record<string, AttrVal>): string {
  const keys = Object.keys(a).sort();
  if (keys.length === 0) {
    return '';
  }
  return ' {' + keys.map((k) => `${k}=${fmtAttr(a[k])}`).join(', ') + '}';
}

function fmtAttr(v: AttrVal): string {
  // A list attr (switch_br `cases`) prints bracketed so `parseAttrs`' top-level comma split (which
  // tracks `[`/`(`/`{` depth) keeps it as one token and round-trips it back to a number[].
  if (Array.isArray(v)) {
    return `[${v.join(';')}]`;
  }
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}
