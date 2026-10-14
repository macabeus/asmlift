// `compilerBehaviors.linkageLocalArea` (target.ts) says where a CodeWarrior build keeps its locals,
// and the PPC frontend draws the frame-object audit's partition from it — so it rests on committed
// objects (`corpus/probe-mwcc-frame.c`, `scripts/regen-mwcc-frame-probes.ts`), read here off the
// text: each probe takes its local's address, so the `addi rX,r1,K` that names it gives its offset,
// and every other word the function homes or spills in its frame is read off its `r1` accesses.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { __testing } from '../src/frontend/ppc';
import { PPC_MWCC } from '../src/target';

interface Frame {
  size: number;
  /** post-push offsets of the words the prologue saves a callee-saved register in */
  saves: number[];
  /** the post-push offset of the captured local, `addi rX,r1,K` */
  local: number;
  /** post-push offsets of every other access inside the frame: homes, spills, outgoing words */
  stores: number[];
  loads: number[];
  /** entry offsets of the loads past the frame (the caller's: link-register word, incoming words) */
  incoming: number[];
  lines: string[];
}

const fixtureText = (fixture: string) => readFileSync(join(import.meta.dirname, 'corpus', fixture), 'utf8');

const frames = (fixture: string): Map<string, Frame> => {
  const out = new Map<string, Frame>();
  for (const part of fixtureText(fixture)
    .split(/^[0-9a-f]+ </m)
    .slice(1)) {
    const name = part.slice(0, part.indexOf('>'));
    const lines = part
      .split('\n')
      .map((l) => /^\s*[0-9a-f]+:\t(\S+)\s*(.*)$/.exec(l))
      .filter((m) => m !== null)
      .map((m) => `${m[1]} ${m[2]}`.trim());
    const ins = lines.map((l) => {
      const [mn, rest = ''] = l.split(' ');
      return { mn, ops: rest.split(',') };
    });
    const r1Off = (op: string | undefined) => {
      const m = /^(-?\d+)\(r1\)$/.exec(op ?? '');
      return m ? Number(m[1]) : null;
    };
    const push = ins.find((i) => i.mn === 'stwu' && i.ops[0] === 'r1');
    const size = push ? -r1Off(push.ops[1])! : 0;
    const f: Frame = { size, saves: [], local: NaN, stores: [], loads: [], incoming: [], lines };
    // A SAVE is a store of a callee-saved register before anything writes it; its reload is the
    // restore. Offsets are post-push: an access before the push or after the pop is entry-relative.
    const written = new Set<string>();
    let depth = 0;
    for (const i of ins) {
      const raw = r1Off(i.ops[1]);
      if (i.mn === 'stwu' && i.ops[0] === 'r1') {
        depth = size;
        continue;
      }
      if (i.mn === 'addi' && i.ops[0] === 'r1') {
        depth = 0;
        continue;
      }
      if (i.mn === 'addi' && i.ops[1] === 'r1') {
        f.local = Number(i.ops[2]);
      }
      if (raw !== null) {
        const post = raw + size - depth;
        const reg = i.ops[0];
        const calleeSaved = /^r(1[3-9]|2\d|3[01])$/.test(reg);
        if (post >= size) {
          f.incoming.push(post - size);
        } else if (i.mn.startsWith('st') && calleeSaved && !written.has(reg)) {
          f.saves.push(post);
        } else if (i.mn.startsWith('st')) {
          f.stores.push(post);
        } else if (!f.saves.includes(post)) {
          f.loads.push(post);
        }
      }
      if (!i.mn.startsWith('st') && !i.mn.startsWith('b') && !i.mn.startsWith('cmp')) {
        written.add(i.ops[0]);
      }
    }
    out.set(name, f);
  }
  return out;
};

// The bytes of each probe's local, from the source, and the stack words its widest call takes.
const LOCAL_BYTES: Record<string, number> = {
  leafarr: 16,
  callarr: 16,
  out9arr: 12,
  out10arr: 12,
  mixout: 8,
  spillarr: 12,
};
const STACK_WORDS: Record<string, number> = {
  leafarr: 0,
  callarr: 0,
  out9arr: 1,
  out10arr: 2,
  mixout: 1,
  spillarr: 0,
  twice9: 1,
};

// The PPC frontend's own partition (`frontend/ppc.ts` `linkageLocalArea`), asked of each probe.
const rule = PPC_MWCC.compilerBehaviors.linkageLocalArea!;
const area = (f: Frame, stackWords: number) =>
  __testing.linkageLocalArea(rule, { frameSize: f.size, stackWords, saves: f.saves })!;

describe.each(['mwcc242-frame.txt', 'mwcc242mp4-frame.txt', 'mwcc247-frame.txt', 'mwcc233-frame.txt'])(
  '%s',
  (fixture) => {
    const fs = frames(fixture);

    test.each(Object.keys(LOCAL_BYTES))('%s: the local lies inside the area the target claims', (fn) => {
      const f = fs.get(fn)!;
      const a = area(f, STACK_WORDS[fn]);
      expect(f.local).toBeGreaterThanOrEqual(a.from);
      expect(f.local + LOCAL_BYTES[fn]).toBeLessThanOrEqual(a.to);
      // …and no saved register inside it
      expect(f.saves.filter((s) => s >= a.from && s < a.to)).toEqual([]);
    });

    // Every other word the function keeps in its frame — a home, a spill, a word of the local — is
    // in the area too, and only a call's outgoing words lie between the linkage and the area.
    test.each(Object.keys(STACK_WORDS))('%s: nothing but outgoing words lies outside the area', (fn) => {
      const f = fs.get(fn)!;
      const a = area(f, STACK_WORDS[fn]);
      const outside = [...f.stores, ...f.loads].filter((o) => o < a.from || o >= a.to);
      expect(outside.every((o) => o >= rule.linkageBytes && o < a.from)).toBe(true);
      expect(f.loads.filter((o) => o < a.from)).toEqual([]);
    });

    test('a function that makes no call still pushes a frame, and its area starts past the linkage', () => {
      const f = fs.get('leafarr')!;
      expect(f.size).toBeGreaterThan(0);
      expect(area(f, 0).from).toBe(rule.linkageBytes);
    });

    test('twice9: the ninth argument is stored to 8(r1) again between the two calls', () => {
      const lines = fs.get('twice9')!.lines;
      const bls = lines.flatMap((l, i) => (l.startsWith('bl ') ? [i] : []));
      expect(bls).toHaveLength(2);
      expect(lines.slice(bls[0] + 1, bls[1]).some((l) => /^stw r\d+,8\(r1\)$/.test(l))).toBe(true);
    });

    test('incoming integer argument word k >= 8 is read at entry r1 + 8 + 4(k - 8)', () => {
      // `in9` reads `i`, argument word 8; `in10` reads `i` and `j`, words 8 and 9
      expect(fs.get('in9')!.incoming).toContain(8);
      expect(fs.get('in10')!.incoming).toEqual(expect.arrayContaining([8, 12]));
    });
  },
);

test('no partition without a stated layout, or with nothing left between the outgoing words and the saves', () => {
  expect(__testing.linkageLocalArea(undefined, { frameSize: 32, stackWords: 0, saves: [28] })).toBeNull();
  expect(__testing.linkageLocalArea(rule, { frameSize: 16, stackWords: 1, saves: [12] })).toBeNull();
  expect(__testing.linkageLocalArea(rule, { frameSize: 64, stackWords: 0, saves: [52, 56, 60] })).toEqual({
    from: 8,
    to: 52,
  });
});
