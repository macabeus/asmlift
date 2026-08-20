// Feature-tag DETECTORS. The vocabulary itself lives in @asmlift/bench-schema, because apps/web
// renders it too and cannot import this app; here we only decide, per row, which tags the evidence
// supports.
//
// Three evidence kinds, and only the third is authored:
//
//   source    — from the function's own C. Derived into every row by eval/evaluate.ts, so a dataset
//               cannot disagree with its own source.
//   codegen   — from the row's compiled `targetAsm`. Also per row: what a compiler does with a
//               constant divide or a switch is a property of (function × toolchain), and one
//               synthetic spec runs on four.
//   judgement — a human call. Authored in the dataset, and held to the floor below.
import { type FeatureDef, KNOWN_FEATURES, featuresByEvidence } from '@asmlift/bench-schema';

const idsOf = (kind: Parameters<typeof featuresByEvidence>[0]): Set<string> =>
  new Set(featuresByEvidence(kind).map((f: FeatureDef) => f.id));

/** Tags decided from the function's own C source. */
export const SOURCE_CHECKED = idsOf('source');
/** Tags decided from the row's compiled reference assembly. */
export const CODEGEN_DERIVED = idsOf('codegen');
/** Tags that are a human call: defined in the vocabulary, held to a floor here, never asserted. */
export const JUDGEMENT = idsOf('judgement');

export { KNOWN_FEATURES };

/** A NECESSARY condition for a JUDGEMENT tag: failing it makes the tag indefensible.
 *
 *  "Is this *bulk* memory movement?" cannot be decided by a regex, so the sufficient condition
 *  stays with the reviewer — but most tags have a floor that can be, and checking it catches
 *  fabrications without pretending the judgement is mechanical.
 *
 *  `global`, `memory`, `union`, `bitfield`, `pointer` and the type-ish tags have NO reliable floor
 *  and are absent on purpose: kleod spells several globals as address macros
 *  (`#define gStreamPtr (*(u8**)0x03004D84)`), which emit a raw `.word` rather than a symbol, and
 *  `union`/`bitfield` need the project's headers to resolve. */
export const JUDGEMENT_FLOOR: Record<string, (body: string, asm: string, whole: string) => boolean> = {
  arithmetic: (b) => /[+%]|(?<!-)-(?!>)|(?<!\/)\/(?![/*])|\*/.test(b),
  array: (b) => /\[/.test(b),
  table: (b) => /\w+\s*\[\s*[^\]\d\s]/.test(b), // indexed by something that is not a literal
  'variable-index': (b) => /\w+\s*\[\s*[^\]\d\s]/.test(b),
  cast: (b) =>
    /\(\s*\w+\s*\*+\s*\)/.test(b) ||
    /\(\s*(?:struct|union|enum|const|unsigned|signed|void|int|char|short|long|float|double|[us]\d+|f\d+|\w+_t|[A-Z]\w*)[\w\s]*\**\s*\)/.test(
      b,
    ),
  struct: (b) => /\bstruct\b|\bunion\b|->|\.\s*[A-Za-z_]/.test(b),
  field: (b) => /->|\.\s*[A-Za-z_]/.test(b),
  fnptr: (_b, asm) => /\bjalr\b|\bblx\b|_call_via_r/.test(asm),
  // `&&`/`||` count: a short-circuit is conditional control flow, and the compiler branches on it
  branch: (b, asm) =>
    /\bif\b|\bswitch\b|\?|\bfor\b|\bwhile\b|&&|\|\|/.test(b) ||
    /\bb(eq|ne|ge|gt|le|lt|hi|ls|cs|cc)\b|beqz|bnez|blez|bgtz|bltz|bgez/.test(asm),
  break: (b) => /\bbreak\b/.test(b),
  // The necessary condition is a declaration statement with NO initialiser — `int r;`, `int w,x;`.
  // Anchored at a statement boundary so it cannot match a type name mid-expression, and the tail
  // class excludes `=`, so a declarator list where ANYTHING is initialised (`int a,b,s=0;`) is not
  // evidence. Which local goes uninitialised, and on which path, stays a human call.
  'uninit-local': (b) =>
    /(?:^|[;{}])\s*(?:(?:unsigned|signed|const|struct|union)\s+)*(?:void|int|char|short|long|float|double|[us]\d+|f\d+|\w+_t|[A-Z]\w*)\s+\**\s*[A-Za-z_][\w\s,*]*;/.test(
      b,
    ),
  continue: (b) => /\bcontinue\b/.test(b),
  // A merged value chain needs a branching construct AND more than one local for the arms to
  // decide — a declaration statement with at least two declarators, which is how the source spells
  // them. Whether the arms all decide the SAME ones, and whether those values are computed rather
  // than already named, stays a human call.
  'merge-chain': (b) =>
    /\bif\b|\bswitch\b|\?/.test(b) &&
    /(?:^|[;{}])\s*(?:(?:unsigned|signed|const|struct|union)\s+)*(?:void|int|char|short|long|float|double|[us]\d+|f\d+|\w+_t|[A-Z]\w*)\s+[^;{}()]*,[^;{}()]*;/.test(
      b,
    ),
  // a TYPE tag: the evidence is in the signature, not the body
  double: (_b, _asm, whole) => /\bdouble\b/.test(whole),
  dense: (b) => /\bswitch\s*\(/.test(b),
  sparse: (b) => /\bswitch\s*\(/.test(b),
  fallthrough: (b) => /\bswitch\s*\(/.test(b),
  // C has no rotate operator; it is spelled as a shift pair
  rotate: (b) => /<<|>>/.test(b),
  mask: (b) => /&/.test(b),
  'div-const': (b) => /\//.test(b),
  'div-pow2': (b) => /\//.test(b),
  'div-reg': (b) => /\//.test(b),
  'mod-const': (b) => /%/.test(b),
  'mod-pow2': (b) => /%/.test(b),
  'mod-reg': (b) => /%/.test(b),
};

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

/** Which `source` tags the function's own C supports. */
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

/** The `codegen` tags decidable from the assembly ALONE (no source needed). */
function asmEvidence(targetAsm: string): Set<string> {
  const out = new Set<string>();
  if (DIV_HELPERS.test(targetAsm)) out.add('soft-div');
  // direct (`bl`/`jal`) and indirect (`jalr`/`blx`, agbcc's `_call_via_rN` thunk) alike
  if (/^\s*\S*\s*\b(bl|jal|jalr|blx)\b|_call_via_r/m.test(targetAsm)) out.add('call');
  const addrs = [...targetAsm.matchAll(/0x0?4[0-9a-f]{6}\b/gi)].map((m) => parseInt(m[0], 16));
  if (addrs.some((a) => a >= 0x04000000 && a <= 0x040003ff)) out.add('mmio');
  if (addrs.some((a) => a >= 0x040000b0 && a <= 0x040000df)) out.add('dma');
  return out;
}

const MUL_HIGH = /\b(mulhw|mulhwu|mulhi)\b|\b(mult|multu)\b[\s\S]{0,120}?\bmf(hi|lo)\b/;
const HW_DIV = /\b(div|divu|divw|divwu)\b\s+[^\n]*,/;
const ANY_MUL = /\b(mul|muls|mult|multu|mullw|mulli|mulhw|mulhwu|smull|umull)\b/;
/** A conditional branch on any of the four ISAs. `b`/`j`/`jr ra`/`bx lr`/`blr` are unconditional. */
const COND_BRANCH =
  /\b(b(eq|ne|lt|le|gt|ge|hi|ls|cc|cs|lo|hs|mi|pl|vs|vc)|b(eq|ne)z l?|beqz|bnez|blez|bgtz|bltz|bgez|bc1[tf]|b(dnz|so|ns))\w*\b/;

/** Computed jump: ARM `mov pc, rN`, MIPS `jr` on a register other than `ra`, PPC `bctr`. */
function hasComputedJump(asm: string): boolean {
  return /\bmov\s+pc\s*,\s*r\d/.test(asm) || /\bjr\s+(?!ra\b)\w+/.test(asm) || /\bbctr\b/.test(asm);
}

/** Codegen tags for one row. `funcC` is the source the row was built from — three of these tags are
 *  claims about a TRANSFORMATION ("the multiply became shifts"), so they need to know there was a
 *  multiply. */
export function codegenEvidence(funcC: string, targetAsm: string): Set<string> {
  const out = asmEvidence(targetAsm);
  const body = neutralizeDoWhileZero(stripLiterals(funcC));
  const src = body.slice(body.indexOf('{'));

  const soft = out.has('soft-div');
  const hw = HW_DIV.test(targetAsm);
  if (hw) out.add('hw-div');
  // a magic reciprocal is a multiply-high stapled to a shift, in code that does NOT divide
  if (!soft && !hw && MUL_HIGH.test(targetAsm) && /[/%]/.test(src)) out.add('magic-div');

  const computed = hasComputedJump(targetAsm);
  if (computed) out.add('jump-table');
  else if (/\bswitch\s*\(/.test(src)) out.add('comparison-tree');

  // A relational operator counts without an `if`: `(a>0) - (a<0)` is a conditional the compiler
  // may or may not branch on, which is the point of the tag. `->` and the shifts must go first or
  // every struct access reads as a comparison.
  const rel = src.replace(/->/g, ' ').replace(/<<|>>/g, ' ');
  const conditional = /\bif\s*\(|\?[^;{}]*:|\bswitch\s*\(|\bfor\s*\(|\bwhile\s*\(|[<>]=?|[=!]=/.test(rel);
  // a computed jump is not branchless: the conditional became an indirect jump, not straight-line
  if (conditional && !computed && !COND_BRANCH.test(targetAsm)) out.add('branchless');

  // `a * 10` with no multiply instruction anywhere ⇒ the compiler reduced it
  if (/\*\s*\d/.test(src) && !ANY_MUL.test(targetAsm)) out.add('strength-reduce');
  return out;
}

/** Every tag one row publishes: the judgement tags its dataset authored, plus whatever its own
 *  source and assembly support. Authored data therefore carries judgement tags ONLY. */
export function rowFeatures(authored: readonly string[], funcC: string, targetAsm: string): string[] {
  return [...new Set([...authored, ...sourceEvidence(funcC), ...codegenEvidence(funcC, targetAsm)])];
}
