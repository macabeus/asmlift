// asmlift IR — the textual parser (the inverse of print.ts).
//
// The parser exists so that `parse(print(fn))` round-trips: the same textual artifact is
// both the debug dump and the test oracle. The parser builds the graph but enforces NO
// semantics — that is the verifier's job — so malformed-but-well-formed-syntax IR can be
// constructed and then rejected by verify().
// ROUND-TRIP DOMAIN: parse(print(fn)) holds for L1/scalar types only — `unkN`/`sN`/`uN` and
// `*`-pointers to them. STRUCT/ARRAY/VOID types print (typeToString) but do NOT parse back; a
// post-type-recovery dump is a one-way debugging artifact, not a test oracle.
import { Block, Fn, Op, Successor, Value, mkOp, mkValue } from './core';
import type { Opcode } from './opcodes';
import { IrType, parseType } from './types';

export function parse(text: string): Fn {
  const raw = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let i = 0;
  while (i < raw.length && raw[i].trim() === '') {
    i++;
  }
  const fnM = raw[i]?.match(/^fn (\w+) \{$/);
  if (!fnM) {
    throw new Error(`expected 'fn NAME {', got '${raw[i] ?? '<eof>'}'`);
  }
  const name = fnM[1];
  i++;

  const body: string[] = [];
  for (; i < raw.length; i++) {
    if (raw[i] === '}') {
      break;
    }
    if (raw[i].trim() === '') {
      continue;
    }
    body.push(raw[i].trim());
  }

  // PASS A — create all blocks and pre-declare every value by its textual name, so
  // operands can resolve regardless of definition order (incl. loop back-edges).
  const valueByName = new Map<string, Value>();
  const declValue = (nm: string, ty: IrType): Value => {
    let v = valueByName.get(nm);
    if (!v) {
      v = mkValue(ty);
      valueByName.set(nm, v);
    } else {
      v.type = ty;
    }
    return v;
  };

  interface RawBlock {
    block: Block;
    opLines: string[];
  }
  const rawBlocks: RawBlock[] = [];
  const blockByLabel = new Map<string, Block>();
  let cur: RawBlock | null = null;

  for (const line of body) {
    const bh = line.match(/^\^(\w+)\((.*)\):$/);
    if (bh) {
      const block: Block = { params: [], ops: [] };
      cur = { block, opLines: [] };
      rawBlocks.push(cur);
      if (blockByLabel.has(bh[1])) {
        throw new Error(`duplicate block label '${bh[1]}'`);
      }
      blockByLabel.set(bh[1], block);
      for (const p of splitTop(bh[2])) {
        const pm = p.match(/^(%\w+):\s*(.+)$/);
        if (!pm) {
          throw new Error(`bad block param '${p}'`);
        }
        block.params.push(declValue(pm[1], parseType(pm[2])));
      }
      continue;
    }
    if (!cur) {
      throw new Error(`op outside any block: '${line}'`);
    }
    cur.opLines.push(line);
    const eq = splitEquals(line);
    if (eq) {
      for (const r of splitTop(eq.results)) {
        const rm = r.match(/^(%\w+):\s*(.+)$/);
        if (!rm) {
          throw new Error(`bad result decl '${r}'`);
        }
        declValue(rm[1], parseType(rm[2]));
      }
    }
  }

  // PASS B — wire operands / successor args / results.
  const refValue = (nm: string): Value => {
    const v = valueByName.get(nm);
    if (!v) {
      throw new Error(`reference to undefined value '${nm}'`);
    }
    return v;
  };
  const refBlock = (label: string): Block => {
    const b = blockByLabel.get(label);
    if (!b) {
      throw new Error(`reference to undefined block '^${label}'`);
    }
    return b;
  };
  for (const rb of rawBlocks) {
    for (const line of rb.opLines) {
      rb.block.ops.push(parseOp(line, refValue, refBlock));
    }
  }

  return { name, blocks: rawBlocks.map((r) => r.block) };
}

function parseOp(line: string, refValue: (nm: string) => Value, refBlock: (label: string) => Block): Op {
  const eq = splitEquals(line);
  const results: Value[] = eq ? splitTop(eq.results).map((r) => refValue(r.match(/^(%\w+):/)![1])) : [];
  let rest = eq ? eq.rest : line;

  let attrs: Record<string, number | boolean | string | number[]> = {};
  const am = rest.match(/\s*\{([^}]*)\}\s*$/);
  if (am) {
    attrs = parseAttrs(am[1]);
    rest = rest.slice(0, am.index).trim();
  }

  const sp = rest.indexOf(' ');
  const opcode = sp < 0 ? rest : rest.slice(0, sp);
  const argStr = sp < 0 ? '' : rest.slice(sp + 1);

  const operands: Value[] = [];
  const successors: Successor[] = [];
  for (const arg of splitTop(argStr)) {
    if (arg.startsWith('^')) {
      const sm = arg.match(/^\^(\w+)\((.*)\)$/);
      if (!sm) {
        throw new Error(`bad successor '${arg}'`);
      }
      successors.push({ block: refBlock(sm[1]), args: splitTop(sm[2]).map(refValue) });
    } else if (arg.startsWith('%')) {
      operands.push(refValue(arg));
    } else {
      throw new Error(`unexpected operand '${arg}'`);
    }
  }
  return mkOp(opcode as Opcode, { operands, results, attrs, successors }); // data boundary: verify() rejects unknowns
}

// --- small text helpers ---

/** Split on top-level commas only (ignore commas inside (...), {...} or [...] — print.ts's
 *  list attrs are bracketed and rely on this tracking). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0,
    cur = '';
  for (const c of s) {
    if (c === '(' || c === '{' || c === '[') {
      depth++;
    } else if (c === ')' || c === '}' || c === ']') {
      depth--;
    }
    if (c === ',' && depth === 0) {
      if (cur.trim()) {
        out.push(cur.trim());
      }
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) {
    out.push(cur.trim());
  }
  return out;
}

/** Split at the first top-level " = " (not inside attrs braces). */
function splitEquals(t: string): { results: string; rest: string } | null {
  let depth = 0;
  for (let k = 0; k + 3 <= t.length; k++) {
    const c = t[k];
    if (c === '(' || c === '{') {
      depth++;
    } else if (c === ')' || c === '}') {
      depth--;
    } else if (depth === 0 && t.startsWith(' = ', k)) {
      return { results: t.slice(0, k).trim(), rest: t.slice(k + 3).trim() };
    }
  }
  return null;
}

function parseAttrs(s: string): Record<string, number | boolean | string | number[]> {
  const a: Record<string, number | boolean | string | number[]> = {};
  for (const pair of splitTop(s)) {
    const eqi = pair.indexOf('=');
    if (eqi < 0) {
      throw new Error(`bad attr '${pair}'`);
    }
    const k = pair.slice(0, eqi).trim();
    const raw = pair.slice(eqi + 1).trim();
    if (raw.startsWith('"')) {
      a[k] = JSON.parse(raw);
    } else if (raw === 'true') {
      a[k] = true;
    } else if (raw === 'false') {
      a[k] = false;
    } else if (raw.startsWith('[')) {
      a[k] = raw.slice(1, -1).split(';').filter(Boolean).map(Number);
    } // switch_br cases
    else {
      a[k] = Number(raw);
    }
  }
  return a;
}
