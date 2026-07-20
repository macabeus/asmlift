// asmlift IR — the canonical textual printer.
//
// Determinism: value names are assigned HERE, at print time, by a fixed traversal
// (blocks in order; within a block, params then op-results). Two
// structurally-identical functions therefore print byte-identically regardless of the
// order their Value objects were created — there is no global counter to leak order.
import type { AttrVal, Block, Fn, Value } from './core';
import { typeToString } from './types';

export function print(fn: Fn): string {
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

  const lines: string[] = [`fn ${fn.name} {`];
  for (const b of fn.blocks) {
    const params = b.params.map((p) => `${ref(p)}: ${typeToString(p.type)}`).join(', ');
    lines.push(`^${blockLabel.get(b)}(${params}):`);
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
