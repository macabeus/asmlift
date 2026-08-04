// The `features` vocabulary — what each tag means and, where possible, how it is CHECKED.
//
// Tags were authored per extraction session with no shared definition (`features: string[]` and
// nothing else), and a four-way audit found roughly a fifth of the real tier carrying at least one
// tag its function does not support: `bitfield` produced by a regex that matched ternaries,
// `soft-div` applied to `/` by a constant that compiles to a shift, `call` on leaf functions that
// emit no call instruction, `loop` on straight-line bodies, `arithmetic` on a function whose entire
// compiled form is `lui/jr/sb/nop`. A tag nobody can falsify drifts into a comment.
//
// So the vocabulary is split in two:
//
//   MACHINE-CHECKED — decidable from evidence the dataset already carries (the function's own
//   source, or the compiled `targetAsm`). `features.test.ts` asserts BOTH directions for these:
//   tagged ⇒ evidence exists, and evidence exists ⇒ tagged. They cannot rot.
//
//   JUDGEMENT — a human call (is this "bulk" memory movement? is this arithmetic "interesting"?).
//   Defined here so the call is at least made against a written standard, but not asserted.
//
// A tag outside both lists fails validation: the vocabulary is closed, so a typo (`fixedpoint` for
// `fixed-point`) is an error rather than a silently-new category that splits every aggregate.

/** Tags decided from the function's own C source. */
export const SOURCE_CHECKED = {
  switch: 'a `switch` statement appears in the body',
  goto: 'a `goto` appears in the body',
  /** A REAL do-while loop. `do { … } while (0)` is a macro idiom with no back edge — not a loop. */
  'do-while': 'a `do { … } while (cond)` loop, where cond is not the literal 0',
  loop: 'a `for`, `while`, or real do-while loop appears in the body',
  'nested-loop': 'a loop lexically inside another loop',
  ternary: 'a `?:` conditional expression appears in the body',
  sizeof: 'the `sizeof` operator appears in the body',
  shift: '`<<` or `>>` appears in the body',
  bitwise: '`&`, `|`, `^`, or `~` appears in the body (as an operator, not `&&`/`||`/address-of)',
} as const;

/** Tags decided from the compiled reference assembly (`targetAsm`). */
export const ASM_CHECKED = {
  /** The COMPILED code calls a soft-division helper. `/` by a constant that becomes a shift is not
   *  soft-div, and neither is a hardware `div` (MIPS) or a BIOS division syscall (GBA `svc #6`). */
  'soft-div': 'the compiled code calls __divsi3/__udivsi3/__modsi3/__umodsi3',
  /** ANY call instruction. The callee's NAME is deliberately not used: these are unlinked objects,
   *  so an external MIPS `jal` renders as `jal 0 <enclosing symbol>` — the callee lives in a
   *  relocation the harness's objdump flags do not emit. Filtering by name would discard every
   *  real call on MIPS and keep none. */
  call: 'the compiled code contains a call instruction',
  mmio: 'the compiled code references a hardware I/O register address (0x04000000-0x040003FF)',
  dma: 'the compiled code programs the DMA registers (0x040000B0-0x040000DF)',
} as const;

/** Tags that are a human call. Defined, not asserted. */
export const JUDGEMENT = {
  arithmetic: 'integer arithmetic is a POINT of the function, not merely an index computation',
  branch: 'conditional control flow is a point of the function',
  compare: 'the function is essentially a comparison',
  struct: 'a struct type is used',
  union: 'a union type is accessed (including through a project typedef)',
  bitfield: 'a declared C bitfield (`u32 x : 2`) is read or written',
  field: 'a named struct/union member is accessed',
  array: 'an array is indexed',
  nested: 'nested aggregate access (`a[i][j]`, or a struct within a struct)',
  pointer: 'pointer arithmetic or dereference beyond plain member access',
  cast: 'an explicit cast that changes the value or its width',
  memory: 'bulk memory movement (copy/clear/compress), not any single load or store',
  store: 'a store is the point of the function',
  global: 'a file-scope or extern variable is referenced',
  table: 'a constant lookup table is read with a computed index',
  float: 'floating-point types are used',
  'fixed-point': 'Q-format integer math',
  int64: '64-bit integer arithmetic',
  matrix: 'matrix math',
  fnptr: 'a call through a function pointer',
  recursion: 'the function calls itself',
  macro: 'a project macro is load-bearing for the shape',
  abs: 'absolute value is computed',
  baseline: 'a trivial function carrying no other feature',
} as const;

export const KNOWN_FEATURES = new Set<string>([
  ...Object.keys(SOURCE_CHECKED),
  ...Object.keys(ASM_CHECKED),
  ...Object.keys(JUDGEMENT),
]);

/** Strip comments and string/char literals so operator scans cannot match inside them. */
export function stripLiterals(c: string): string {
  return c
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(\\.|[^"\\])*"/g, '""')
    .replace(/'(\\.|[^'\\])*'/g, "''");
}

/** Blank out the `do` keyword of every `do { … } while (0)` — a macro idiom with no back edge, so
 *  it must not register as a loop for `do-while`, `loop`, or `nested-loop`. Done by brace-matching
 *  rather than regex because these nest. */
function neutralizeDoWhileZero(body: string): string {
  const out = body.split('');
  for (const m of [...body.matchAll(/\bdo\s*\{/g)]) {
    const open = body.indexOf('{', m.index);
    let depth = 0;
    let close = -1;
    for (let i = open; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}' && --depth === 0) {
        close = i;
        break;
      }
    }
    const tail = close === -1 ? null : /^(\s*)while(\s*\(\s*0\s*\))/.exec(body.slice(close + 1));
    if (tail) {
      out[m.index] = ' ';
      out[m.index + 1] = ' ';
      // blank the trailing `while` too, or the `loop` scan still sees a while-keyword
      for (let i = close + 1 + tail[1].length; i < close + 1 + tail[1].length + 5; i++) out[i] = ' ';
    }
  }
  return out.join('');
}

/** A real do-while loop — `do { … } while (0)` has already been neutralized by the caller. */
function hasRealDoWhile(body: string): boolean {
  return /\bdo\s*\{/.test(body);
}

function hasNestedLoop(body: string): boolean {
  // walk braces, tracking whether we are inside a loop header's block
  const loopAt: number[] = [];
  let depth = 0;
  let nested = false;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      const before = body.slice(Math.max(0, i - 400), i);
      // `[^{}]` not `[^;]`: a `for (a; b; c)` header is full of semicolons
      const isLoop = /\b(for|while)\s*\([^{}]*\)\s*$/.test(before) || /\bdo\s*$/.test(before);
      depth++;
      if (isLoop) {
        if (loopAt.length > 0) {
          nested = true;
        }
        loopAt.push(depth);
      }
    } else if (body[i] === '}') {
      if (loopAt.length && loopAt[loopAt.length - 1] === depth) {
        loopAt.pop();
      }
      depth--;
    }
  }
  return nested;
}

/** Which SOURCE_CHECKED tags the function's own C supports. */
export function sourceEvidence(funcC: string): Set<string> {
  const b = stripLiterals(funcC);
  const body = neutralizeDoWhileZero(b.slice(b.indexOf('{')));
  const out = new Set<string>();
  if (/\bswitch\s*\(/.test(body)) out.add('switch');
  if (/\bgoto\s+\w+\s*;/.test(body)) out.add('goto');
  if (hasRealDoWhile(body)) out.add('do-while');
  if (/\bfor\s*\(|\bwhile\s*\(/.test(body) || hasRealDoWhile(body)) out.add('loop');
  if (hasNestedLoop(body)) out.add('nested-loop');
  // `?:` but not `? :` inside a label or a bitfield declarator
  if (/\?[^;{}]*:/.test(body)) out.add('ternary');
  if (/\bsizeof\b/.test(body)) out.add('sizeof');
  if (/<<|>>/.test(body)) out.add('shift');
  // require a LEFT operand so `&x` (address-of) and `&&`/`||` do not count
  if (/[\w)\]]\s*&(?!&)/.test(body) || /[\w)\]]\s*\|(?!\|)/.test(body) || /\^|~/.test(body)) {
    out.add('bitwise');
  }
  return out;
}

const DIV_HELPERS = /__(u?divsi3|u?modsi3|divdi3|moddi3)/;

/** Which ASM_CHECKED tags the compiled reference supports. `sym` is the function's own name. */
export function asmEvidence(targetAsm: string, _sym: string): Set<string> {
  const out = new Set<string>();
  if (DIV_HELPERS.test(targetAsm)) out.add('soft-div');
  // direct (`bl`/`jal`) and indirect (`jalr`/`blx`, agbcc's `_call_via_rN` thunk) alike
  if (/^\s*\S*\s*\b(bl|jal|jalr|blx)\b|_call_via_r/m.test(targetAsm)) out.add('call');
  const addrs = [...targetAsm.matchAll(/0x0?4[0-9a-f]{6}\b/gi)].map((m) => parseInt(m[0], 16));
  if (addrs.some((a) => a >= 0x04000000 && a <= 0x040003ff)) out.add('mmio');
  if (addrs.some((a) => a >= 0x040000b0 && a <= 0x040000df)) out.add('dma');
  return out;
}
