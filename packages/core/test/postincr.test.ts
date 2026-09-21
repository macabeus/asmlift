// UNIT tests for the `postincr` expression node (l3/ast.ts): how each backend spells it, and the
// places a node that both READS and WRITES has to be visible where a plain leaf would not be —
// the shared effect predicate, the mention walk a variation deletes declarations on, both sides of
// DCE (the keep list, and the liveness that pins the store reaching the `++` and the declaration
// with it), and the sequence-point contract.
//
// Hand-built AST, the way locals-written.test.ts pins its rule: the coverage is the property, not
// which pass produces the shape today. Its one producer is structure.ts's `emitDoWhile`
// (loop-preupdate-cond.test.ts).
import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { ContractError, assertPostIncrUnshared } from '../src/contracts';
import { T } from '../src/ir/types';
import { type Expr, type SFn, type Stmt, exprEquals, exprHasEffect } from '../src/l3/ast';
import { eliminateDeadStores } from '../src/l3/dce';
import { mentionedLocals } from '../src/l3/mentions';
import { c, v } from './helpers';

const inc = (name: string, by: 1 | -1 = 1): Expr => ({ k: 'postincr', name, by });

const fnWith = (body: Stmt[], locals: SFn['locals'] = [{ name: 'v1', type: T.int(32, true) }]): SFn => ({
  name: 'f',
  params: [],
  locals,
  retType: T.int(32, true),
  body,
});

// `while (v0 != 0 && v1++ <= 9)` — the shape the fold produces, and the one whose parenthesisation
// is load-bearing: a postfix operator over a bare identifier binds tighter than every parent, so it
// never takes parentheses of its own and never suppresses its parent's.
test('the C backend spells a post-increment postfix, at every precedence', () => {
  const src = cBackend.emit(
    fnWith(
      [
        {
          k: 'dowhile',
          cond: {
            k: 'bin',
            op: '&&',
            l: { k: 'bin', op: '!=', l: v('v0'), r: c(0) },
            r: { k: 'bin', op: '<=', l: inc('v1'), r: c(9) },
          },
          body: [],
        },
        { k: 'return', value: { k: 'bin', op: '&', l: { k: 'bin', op: '>>', l: v('v0'), r: inc('v2', -1) }, r: c(1) } },
      ],
      [
        { name: 'v0', type: T.int(32, true) },
        { name: 'v1', type: T.int(32, true) },
        { name: 'v2', type: T.int(32, true) },
      ],
    ),
  );
  expect(src).toContain('} while (v0 != 0 && v1++ <= 9);');
  expect(src).toContain('return v0 >> v2-- & 1;');
});

// IDO Pascal has no increment operator and no expression that may carry a side effect, so it
// declines rather than dropping the update — the `field`/`cast` discipline.
test('the Pascal backend declines a post-increment loud', () => {
  expect(() => pascalBackend.emit(fnWith([{ k: 'return', value: inc('v1') }]))).toThrow(/post-increment/);
});

test('a post-increment is an effect, and `by` is part of the spelling', () => {
  expect(exprHasEffect(inc('v1'))).toBe(true);
  expect(exprHasEffect({ k: 'bin', op: '<=', l: inc('v1'), r: c(9) })).toBe(true);
  expect(exprEquals(inc('v1'), inc('v1'))).toBe(true);
  expect(exprEquals(inc('v1'), inc('v1', -1))).toBe(false);
  expect(exprEquals(inc('v1'), v('v1'))).toBe(false);
});

// A variation that drops a declaration counts mentions with this walk. A name carried ONLY by a
// post-increment is still named by the tree, and dropping it would leave an undeclared identifier.
test('the mention walk sees a name only a post-increment carries', () => {
  expect([...mentionedLocals([{ k: 'exprstmt', value: inc('v1') }], new Set(['v1']))]).toEqual(['v1']);
});

// The write is the loop update; deleting the dead assignment around it would delete the update.
test('DCE keeps a dead assignment whose value holds a post-increment', () => {
  const body: Stmt[] = [
    { k: 'assign', name: 'v9', value: { k: 'bin', op: '+', l: inc('v1'), r: c(1) } },
    { k: 'return', value: c(0) },
  ];
  const kept = eliminateDeadStores(
    fnWith(body, [
      { name: 'v1', type: T.int(32, true) },
      { name: 'v9', type: T.int(32, true) },
    ]),
  );
  expect(kept.body.some((s) => s.k === 'assign' && s.name === 'v9')).toBe(true);
});

// The `++` is the local's ONLY reader: a walk that counted it as neither a read nor a mention
// would take the store that reaches it and the declaration with it, and the emitted function would
// not compile.
test('DCE keeps the store a post-increment reads, and the declaration', () => {
  const kept = eliminateDeadStores(
    fnWith([
      { k: 'assign', name: 'v1', value: c(0) },
      { k: 'dowhile', cond: { k: 'bin', op: '<=', l: inc('v1'), r: c(9) }, body: [] },
    ]),
  );
  expect(kept.body.some((s) => s.k === 'assign' && s.name === 'v1')).toBe(true);
  expect(kept.locals.map((l) => l.name)).toEqual(['v1']);
});

test('the sequence-point contract refuses a second mention in the same expression', () => {
  const shared = (e: Expr): Stmt[] => [{ k: 'dowhile', cond: e, body: [] }];
  expect(() =>
    assertPostIncrUnshared(
      fnWith(shared({ k: 'bin', op: '&&', l: v('v1'), r: { k: 'bin', op: '<=', l: inc('v1'), r: c(9) } })),
    ),
  ).toThrow(ContractError);
  // Two mentions SEPARATED by a statement boundary are well-defined, and the contract says so.
  expect(() =>
    assertPostIncrUnshared(
      fnWith([
        {
          k: 'dowhile',
          cond: { k: 'bin', op: '<=', l: inc('v1'), r: c(9) },
          body: [{ k: 'assign', name: 'v2', value: v('v1') }],
        },
      ]),
    ),
  ).not.toThrow();
});

test('a cast over a post-increment renders from the local declaration, not from the node', () => {
  const src = cBackend.emit(
    fnWith(
      [{ k: 'return', value: { k: 'bin', op: '>>', l: inc('v1'), r: c(3) } }],
      [{ name: 'v1', type: T.int(32, false) }],
    ),
  );
  expect(src).toContain('return (s32)v1++ >> 3;');
});

// The STRUCTURAL half, and the reason it is a source scan rather than another hand-built tree: TS
// exhaustiveness protects `exprChildren`/`mapExprChildren`, where a new `Expr` kind is a compile
// error, and protects nothing about a predicate that spells the leaf kinds out by hand. Every such
// predicate answers "which name does this node mention", `mentionedName` (l3/ast.ts) is the one
// place that answers it for the whole vocabulary, and the two lines below spell the pair for some
// other reason, each named. A collector that misses `postincr` reports the name UNTOUCHED, which is
// how `initfirst`'s deadness rule hoists an init onto the path its own guard skips.
const SEPARATE_THE_KINDS: ReadonlyMap<string, string> = new Map([
  ['contracts.ts', '`&v` is a write channel and a bare `v` is a read, and the walk records them on different sides'],
  ['l3/argbase.ts', 'asks what a memory BASE is — an address, a const, or a global — not which names a tree mentions'],
]);

test('every leaf-kind collector goes through mentionedName, or says why it does not', () => {
  const root = new URL('../src/', import.meta.url);
  const files: string[] = [];
  const walk = (dir: URL, prefix: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.isDirectory()) {
        walk(new URL(`${ent.name}/`, dir), `${prefix}${ent.name}/`);
      } else if (ent.name.endsWith('.ts')) {
        files.push(`${prefix}${ent.name}`);
      }
    }
  };
  walk(root, '');
  const offenders: string[] = [];
  for (const f of files) {
    readFileSync(new URL(f, root), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const pairs = line.includes(`k === 'var'`) && line.includes(`k === 'addr'`);
        if (pairs && !line.includes('postincr') && !SEPARATE_THE_KINDS.has(f)) {
          offenders.push(`${f}:${i + 1}`);
        }
      });
  }
  expect(offenders).toEqual([]);
  // The exemptions are named, so one whose file stops spelling the pair is a line to delete rather
  // than a licence that quietly outlives its reason.
  for (const f of SEPARATE_THE_KINDS.keys()) {
    expect(readFileSync(new URL(f, root), 'utf8')).toContain(`k === 'addr'`);
  }
});
