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

/** A `struct`/`union` DEFINITION's members are not locals. The body a floor is handed starts at
 *  the first `{` in `src`, which for a row opening with an aggregate definition is the
 *  aggregate's brace — so the members would otherwise be counted as declaration statements. */
const withoutAggregates = (b: string): string => b.replace(/\b(?:struct|union)\b[^{;]*\{[^{}]*\}/g, ' ');

/** A preprocessor directive, blanked to spaces so the text keeps its length and its line breaks.
 *  A function-like macro's replacement list is a `)` followed by a brace, which is a function
 *  definition to anything reading punctuation; a `#define` continued with a backslash keeps going
 *  onto the next line. */
const withoutDirectives = (s: string): string =>
  s.replace(/^[ \t]*#(?:[^\n\\]|\\[\s\S])*/gm, (d) => d.replace(/[^\n]/g, ' '));

/** An indirect call, on every ISA the benchmark runs: PowerPC through the count or link register,
 *  MIPS `jalr`, ARM `blx`, and agbcc's `_call_via_rN` thunk. */
const INDIRECT_CALL = /\bbctrl\b|\bblrl\b|\bjalr\b|\bblx\b|_call_via_r/;

/** A floating-point literal with no `f` suffix, which has type `double` whatever surrounds it.
 *  The lookahead refuses `1.0f`, `1.0F`, `1.0l` and a version-like `1.0.3`; the leading class
 *  refuses the fraction of a hex constant. */
const UNSUFFIXED_FLOAT = /(?<![\w.])(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?(?![\w.])/;

/** Anything that takes a parenthesis and a brace without being a declarator. */
const NOT_A_DECLARATOR = /\b(?:if|else|while|for|switch|do|catch|return|sizeof)\s*$/;

/** The function's own definition: the declarator that names it, and the body that declarator opens.
 *
 *  A row's source is not a declarator followed by a body. A spec opens with the typedefs, macros
 *  and aggregate definitions its signature needs, so the first `{` in the text is routinely not the
 *  function's — which leaves "everything before it" a preamble rather than a signature, and
 *  "everything after it" wider than the one function. So: the body opens at the first top-level `{`
 *  that closes a parameter list, the signature is what stands between the preceding top-level `;`
 *  or `}` and that brace, and the body ends at the brace's match — a file-scope declaration after
 *  it is not part of this function and neither is one before it. */
export function definitionOf(whole: string): { signature: string; body: string } {
  const scan = withoutDirectives(whole);
  let depth = 0;
  let start = 0;
  for (let i = 0; i < scan.length; i++) {
    const ch = scan[i];
    if (ch === '{') {
      const head = scan.slice(start, i);
      if (
        depth === 0 &&
        /\)\s*(?:const\s+|volatile\s+)*$/.test(head) &&
        !NOT_A_DECLARATOR.test(head.slice(0, head.lastIndexOf('(')))
      ) {
        let d = 0;
        for (let j = i; j < scan.length; j++) {
          if (scan[j] === '{') d++;
          else if (scan[j] === '}' && --d === 0)
            return { signature: whole.slice(start, i), body: whole.slice(i, j + 1) };
        }
        return { signature: whole.slice(start, i), body: whole.slice(i) };
      }
      depth++;
    } else if (ch === '}') {
      if (--depth === 0) start = i + 1;
    } else if (ch === ';' && depth === 0) {
      start = i + 1;
    }
  }
  // No declarator: a vocabulary `example.c` is often a fragment. Read it whole.
  const at = whole.indexOf('{');
  return { signature: at < 0 ? whole : whole.slice(0, at), body: at < 0 ? whole : whole.slice(at) };
}

/** A NECESSARY condition for a JUDGEMENT tag: failing it makes the tag indefensible.
 *
 *  "Is this *bulk* memory movement?" cannot be decided by a regex, so the sufficient condition
 *  stays with the reviewer — but a tag with a floor that can be checked is checked, which catches
 *  fabrications without pretending the judgement is mechanical.
 *
 *  A judgement tag is listed here only when a floor would REFUSE something; the rest are absent on
 *  purpose, and which those are is `JUDGEMENT` minus `Object.keys(JUDGEMENT_FLOOR)` rather than a
 *  list restated in prose. Two of the reasons, so the shape of the absence is on the record:
 *  kleod spells several globals as address macros (`#define gStreamPtr (*(u8**)0x03004D84)`),
 *  which emit a raw `.word` rather than a symbol, and `union`/`bitfield` need the project's
 *  headers to resolve. */
export const JUDGEMENT_FLOOR: Record<string, (body: string, asm: string, whole: string) => boolean> = {
  arithmetic: (b) => /[+%]|(?<!-)-(?!>)|(?<!\/)\/(?![/*])|\*/.test(b),
  array: (b) => /\[/.test(b),
  table: (b) => /\w+\s*\[\s*[^\]\d\s]/.test(b), // indexed by something that is not a literal
  // ANY subscript in the chain, not only the first: `x[0][k]` is a variable index, and the `k`
  // there follows a `]` rather than a name. `table` deliberately keeps the tighter form — it is a
  // claim about the OBJECT being a constant lookup table, which its own first subscript shows.
  'variable-index': (b) => /[\w\]]\s*\[\s*[^\]\d\s]/.test(b),
  cast: (b) =>
    /\(\s*\w+\s*\*+\s*\)/.test(b) ||
    /\(\s*(?:struct|union|enum|const|unsigned|signed|void|int|char|short|long|float|double|[us]\d+|f\d+|\w+_t|[A-Z]\w*)[\w\s]*\**\s*\)/.test(
      b,
    ),
  struct: (b) => /\bstruct\b|\bunion\b|->|\.\s*[A-Za-z_]/.test(b),
  field: (b) => /->|\.\s*[A-Za-z_]/.test(b),
  fnptr: (_b, asm) => INDIRECT_CALL.test(asm),
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
      withoutAggregates(b),
    ),
  continue: (b) => /\bcontinue\b/.test(b),
  // The necessary condition is a UNARY `&` on an identifier — `use(&w)`, `*p = &tmp`. `&&` and a
  // binary `&` are excluded by requiring the nearest NON-SPACE character before it to be neither
  // an identifier character, nor a closing `)`/`]`, nor another `&` — the whitespace has to be
  // skipped, or a spaced binary `a & b` passes. Whether the address-taken object is the one the
  // diff turns on stays a human call.
  'stack-addr': (b) => /(?:^|[^\w)\]&\s])\s*&(?!&)\s*[A-Za-z_]/.test(b),

  // The necessary condition is a counted loop whose induction variable is DECLARED narrow —
  // `s16 i; … for (i = 0; …)`. BOTH halves are required, because either alone is a different tag:
  // a narrow local that is not a counter is `narrow`, and a wide counter is nothing at all. Which
  // codegen consequence the row turns on — the re-materialised sign extension, or the index that
  // survives because the narrowed write-back is not recognised as an induction variable — stays a
  // human call.
  'narrow-counter': (b) => {
    const ctrs = [...b.matchAll(/\bfor\s*\(\s*(\w+)\s*=/g), ...b.matchAll(/(\w+)\s*=\s*0\s*;\s*do\b/g)].map(
      (m) => m[1],
    );
    return ctrs.some((v) =>
      new RegExp(
        `(?:^|[;{}(,])\\s*(?:unsigned\\s+|signed\\s+)?(?:s8|u8|s16|u16|char|short)\\s+[\\w\\s,*]*\\b${v}\\b\\s*[,;=)]`,
      ).test(b),
    );
  },

  // The necessary condition is a counted loop whose own init clause zeroes the counter —
  // `for (i = 0; …)`. That is the only spelling whose zero-trip guard the compiler can emit
  // init-first, so a row claiming the tag must contain one. WHICH of the two guard spellings the
  // original used, and whether that is what the diff turns on, is the judgement.
  'guard-init': (b) => /\bfor\s*\(\s*\w+\s*=\s*0\s*;/.test(b),

  // A pre-update value needs a loop for the update to be hoisted above. WHICH of the three shapes
  // the row turns on — condition, exiting edge, or a value read after the loop — is the judgement.
  'loop-preupdate': (b) => /\bfor\s*\(|\bwhile\s*\(|\bdo\b/.test(b),

  // A device access is a `volatile` one. Whether that access is what the diff turns on stays the
  // judgement.
  'device-access': (b) => /\bvolatile\b/.test(b),

  // A merged value chain needs a branching construct AND more than one local for the arms to
  // decide. COUNTED ACROSS DECLARATION STATEMENTS, not within one: `void *a; void *b;` and
  // `void *a, *b;` declare the same two locals, and an earlier version of this rule required the
  // comma — which rejected kleod's ConfigureEntityBehavior, a ten-arm switch whose every arm
  // decides the same four locals, for spelling them one per line. Split into statements rather
  // than swept with a /g/ regex, because a match that CONSUMES the `;` leaves the next declaration
  // without the separator it would have anchored on, and consecutive declarations then count once.
  // An aggregate DEFINITION's members are stripped first — they are not locals for arms to decide.
  // Whether the arms all decide the SAME ones, and whether those values are computed rather than
  // already named, stays a human call.
  'merge-chain': (b) => {
    if (!/\bif\b|\bswitch\b|\?/.test(b)) {
      return false;
    }
    const DECL =
      /^\s*(?:(?:unsigned|signed|const|struct|union)\s+)*(?:void|int|char|short|long|float|double|[us]\d+|f\d+|\w+_t|[A-Z]\w*)\s+[^;{}()]*$/;
    return (
      withoutAggregates(b)
        .split(/[;{}]/)
        .filter((stmt) => DECL.test(stmt))
        .reduce((n, stmt) => n + stmt.split(',').length, 0) >= 2
    );
  },
  // a TYPE tag: the evidence is in the whole function, not just its body. `f64` is the spelling
  // three of the seven projects use for the type, and a row that never writes the keyword is
  // still using it — Animal Crossing's `Matrix_MtxtoMtxF` scales by `1 / (f64)0x10000` sixteen
  // times. `f32` is deliberately absent: it is the OTHER type. An UNSUFFIXED floating literal is
  // the third spelling: `calc + 0.5` is a double addition however the operands were declared,
  // which is why the suffix has to be absent — `1.0f / 30.0f` in the same function is not.
  double: (_b, _asm, whole) => /\bdouble\b|\bf64\b/.test(whole) || UNSUFFIXED_FLOAT.test(whole),

  // The floor of `fnptr` above and of this one is the same instruction, because the necessary
  // condition of both tags is the same: the call is INDIRECT. Which of the two the row claims —
  // a vtable slot or a function-pointer value — is the judgement, and it is not in the encoding.
  'virtual-call': (_b, asm) => INDIRECT_CALL.test(asm),

  // A constructor's declarator repeats the class name — `Thing::Thing(`. The SIGNATURE carries it
  // and the body never does, so like `double` this reads the whole function.
  ctor: (_b, _asm, whole) => /\b(\w+)\s*::\s*\1\s*\(/.test(definitionOf(whole).signature),
  // …and a destructor's is the same name behind a `~`.
  dtor: (_b, _asm, whole) => /~\s*\w+\s*\(/.test(definitionOf(whole).signature),

  // A reference PARAMETER: an `&` between a type and a name, in the parameter list. Read from the
  // signature and not the body, where a binary `a & b` is the same three tokens. A reference local
  // is the same construct and cannot pass this floor — the same narrowing `double` accepts.
  reference: (_b, _asm, whole) => /[\w>\]]\s*&\s*\**\s*\w+\s*[,)=]/.test(definitionOf(whole).signature),

  // A hardware float ABI needs a floating-point type in the SIGNATURE — a float that only ever
  // exists inside the body is never passed or returned. Which projects spell it `f32`/`f64`
  // rather than `float`/`double` is why all four are accepted.
  'hw-float-abi': (_b, _asm, whole) => /\b(?:float|double|f32|f64)\b/.test(definitionOf(whole).signature),

  // A by-value struct assignment is an assignment whose right-hand side is a WHOLE OBJECT — `*a =
  // *b;`, `p->pos = q->pos;`, `v = w;` — and not an expression, which would be a scalar store. It
  // has to be a PLAIN assignment: `a += b` reads and writes, and `a == b` does neither, so the `=`
  // is required to stand alone. That the object is an aggregate is what no scan can decide — the
  // types are the project's — so `v = w` between two scalars passes, and must.
  'struct-copy': (b) =>
    /(?<![-+*/%&|^!<>=])=(?!=)\s*\*?\s*[A-Za-z_]\w*(?:\s*(?:->|\.)\s*\w+|\s*\[[^\]]*\])*\s*;/.test(b),

  // For a callee to have been inlined, the body has to spell a call. The keywords that take a
  // parenthesis are excluded, or every `if (` would pass — and the lookahead closes on a word
  // boundary, or `forward(x)` is refused for beginning with one of them.
  'inlined-callee': (b) => /\b(?!(?:if|while|for|switch|return|sizeof|do|catch)\b)[A-Za-z_]\w*\s*\(/.test(b),
  'switch-arms': (b) => /\bswitch\s*\(/.test(b),
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

/** The floors NOTHING in the C can meet: an indirect call exists only in the object, so these two
 *  read the assembly and ignore the source entirely. A row the last `bench run` has not published
 *  yet carries no assembly, so it cannot be held to these until it does — and to every OTHER floor
 *  it is held on the spot, because every other floor reads the source. Declared here rather than
 *  inferred from which tags some published row needs its assembly for: `branch` passes on either
 *  evidence, and inferring swept it in and stopped checking the half the source decides. */
export const ASSEMBLY_ONLY_FLOOR = new Set(['fnptr', 'virtual-call']);

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

/** A local aggregate declaration with a brace initialiser, its storage class captured rather than
 *  skipped: `static u8 t[] = { … }` and `u8 t[] = { … }` are different shapes, and only the second
 *  costs a copy into the frame. Qualifiers before the type are optional and any number, the
 *  declarator may carry several extents (`s16 m[2][2]`) or NONE — a struct is an aggregate and
 *  takes the same copy, which is what the tag is about — and the whole thing is anchored at a
 *  statement boundary so an initialiser inside an expression cannot pass. */
const LOCAL_AGGREGATE_INIT =
  /(?:^|[;{}])\s*(?<storage>static\s+)?(?:(?:const|volatile|unsigned|signed|struct|union|enum)\s+)*[A-Za-z_]\w*\s+\**\s*[A-Za-z_]\w*\s*(?:\[[^\];]*\]\s*)*=\s*\{/g;

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

const CONNECTIVE = /&&|\|\|/;

/** Is a `&&`/`||` in `cond` the thing that DECIDES the branch, rather than an operand inside it?
 *
 *  Two ways it can be an operand, and the difference is not depth — it is what the parenthesis IS.
 *  A CALL's parentheses hide their contents (`f(a && b)` computes a boolean and passes it), while a
 *  GROUPING parenthesis is transparent (`!(a && b)` and `((a && b))` still decide the branch). So
 *  call arguments are stripped, innermost-first and repeatedly, and everything else stays. A single
 *  non-recursive strip of `\([^()]*\)` gets both halves wrong: it deletes a redundant group around
 *  the whole condition, and it leaves the connective standing in `f(g(), a && b)`.
 *
 *  The other way is a ternary. `a && b ? x : y` computes the connective and the `if` tests the
 *  ternary — the merged-boolean diamond, a different recovery. A `?` at depth 0 with a connective
 *  anywhere to its left says so; `(c ? x : y) && z` keeps its `?` inside a group and is unaffected.
 *
 *  (A cast reads as a call here — `(u8)(a)` loses its `(a)`. Harmless: a cast's operand is not a
 *  connective, and the direction is the safe one.) */
const decidesTheBranch = (cond: string): boolean => {
  let depth = 0;
  for (let i = 0; i < cond.length; i++) {
    if (cond[i] === '(') {
      depth++;
    } else if (cond[i] === ')') {
      depth--;
    } else if (cond[i] === '?' && depth === 0 && CONNECTIVE.test(cond.slice(0, i))) {
      return false;
    }
  }
  let stripped = cond;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(/([\w\])]\s*)\([^()]*\)/g, '$1');
  } while (stripped !== prev);
  return CONNECTIVE.test(stripped);
};

/** Does a `&&`/`||` decide a BRANCH here — i.e. sit in a CONTROLLING expression?
 *
 *  Balanced by hand rather than by regex: a controlling expression routinely contains its own
 *  parenthesised calls and casts, and `if\s*\([^)]*&&` stops at the first inner `)` and misses
 *  every one of them. Two more things the scan has to get right, beyond what `decidesTheBranch`
 *  owns:
 *
 *   - a `for` header holds three clauses and only the MIDDLE one controls anything; a connective in
 *     the init or the step is an ordinary value expression.
 *   - `#if (A && B)` is a preprocessor directive, and real-tier sources are unpreprocessed.
 *
 *  Not decidable here, and deliberately: a connective hidden inside a project macro
 *  (`#define IS_OK(a) ((a) == 1 || (a) == 2)`). Real-tier `funcC` is the decomp's verbatim C, so
 *  that direction only ever under-reports — the same limit every other `source` tag carries. */
const hasControllingConnective = (body: string): boolean => {
  for (const m of body.matchAll(/\b(if|while|for)\s*\(/g)) {
    if (/#\s*$/.test(body.slice(0, m.index))) {
      continue; // #if / #elif
    }
    let depth = 1;
    let i = m.index + m[0].length;
    const clauses: string[] = [];
    let from = i;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === '(') {
        depth++;
      } else if (body[i] === ')') {
        depth--;
      } else if (body[i] === ';' && depth === 1) {
        clauses.push(body.slice(from, i));
        from = i + 1;
      }
    }
    if (depth !== 0) {
      continue; // truncated body — no controlling expression to read
    }
    clauses.push(body.slice(from, i - 1));
    // `for (init; cond; step)` → the condition; everything else is one clause and IS the condition
    const cond = m[1] === 'for' ? (clauses.length === 3 ? clauses[1] : '') : clauses.join(';');
    if (decidesTheBranch(cond)) {
      return true;
    }
  }
  return false;
};

/** Which `source` tags the function's own C supports. */
export function sourceEvidence(funcC: string): Set<string> {
  const def = definitionOf(stripLiterals(funcC));
  const body = neutralizeDoWhileZero(def.body);
  // Some tags are facts about the SIGNATURE and leave no trace in the body at all — the same
  // reason the `double` floor is handed the whole function rather than the body.
  const signature = def.signature;
  const out = new Set<string>();
  if (/\bswitch\s*\(/.test(body)) out.add('switch');
  if (/\bgoto\s+\w+\s*;/.test(body)) out.add('goto');
  if (hasRealDoWhile(body)) out.add('do-while');
  if (/\bfor\s*\(|\bwhile\s*\(/.test(body) || hasRealDoWhile(body)) out.add('loop');
  if (hasNestedLoop(body)) out.add('nested-loop');
  // `?:` but not `? :` inside a label or a bitfield declarator
  if (/\?[^;{}]*:/.test(body)) out.add('ternary');
  if (hasControllingConnective(body)) out.add('short-circuit');
  if (/\bsizeof\b/.test(body)) out.add('sizeof');
  // A declaration statement whose storage class is `static` — anchored at a statement boundary, so
  // a `static` in a comment or mid-expression cannot pass, and read from the body alone, so the
  // `static` that makes the FUNCTION file-scope is not one of these.
  if (/(?:^|[;{}])\s*static\b/.test(body)) out.add('static-local');
  // `...` can only be the ellipsis of a parameter list here: the signature holds no expressions.
  if (/\.\.\.\s*\)/.test(signature)) out.add('varargs-def');
  // A `new`/`delete` EXPRESSION, which needs an operand after the keyword. Written so that an
  // identifier merely spelled `new` (`s->new`, `new_value`) cannot pass: `\bnew\b` already refuses
  // the second, and a leading `.`/`->` is excluded for the first.
  if (/(?<![.\w]|->)\bnew\b\s*[\w([]|(?<![.\w]|->)\bdelete\b\s*(?:\[\s*\]\s*)?[\w(*]/.test(body)) {
    out.add('new-delete');
  }
  // A local aggregate with a brace initialiser — a declaration statement carrying `= {`.
  // Only an AUTOMATIC one counts, so the storage class is CAPTURED rather than skipped: a `static`
  // aggregate lives in .rodata and is merely referenced, where an automatic one is copied into the
  // frame on every call, and that copy is the shape the tag is about. The static case is
  // `static-local`, so a body holding both declarations gets both tags and neither takes the other's.
  if ([...body.matchAll(LOCAL_AGGREGATE_INIT)].some((m) => m.groups?.storage === undefined)) {
    out.add('local-aggregate-init');
  }
  if (/<<|>>/.test(body)) out.add('shift');
  // require a LEFT operand so `&x` (address-of) and `&&`/`||` do not count. A cast's closing
  // paren is NOT a left operand — `(u32)&tmp` is address-of — so casts come out first. (A
  // parenthesised MACRO operand would be blanked too; no such row exists in the corpus today.)
  const noCasts = body.replace(
    /\(\s*(?:struct|union|enum|const|unsigned|signed|volatile|void|int|char|short|long|float|double|[us]\d+|f\d+|\w+_t|[A-Z]\w*)[\w\s]*\**\s*\)/g,
    ' ',
  );
  if (/[\w)\]]\s*&(?!&)/.test(noCasts) || /[\w)\]]\s*\|(?!\|)/.test(noCasts) || /\^|~/.test(noCasts)) {
    out.add('bitwise');
  }
  return out;
}

const DIV_HELPERS = /__(u?divsi3|u?modsi3|divdi3|moddi3)/;

/** Every symbol the compiled code CALLS BY NAME.
 *
 *  Two spellings, because objdump renders a call differently depending on where the callee is. One
 *  inside the object is printed on the branch itself (`bl __divsi3`); an external one leaves the
 *  branch pointing at its own address and names the callee on the relocation line under it
 *  (`10: R_PPC_REL24 _savegpr_25`). Only BRANCH relocations are read — `R_PPC_ADDR16_HA` names a
 *  datum, not a callee.
 *
 *  MIPS has neither spelling: the harness's objdump flags emit no MIPS relocation and an external
 *  `jal` renders against the enclosing symbol, so this returns nothing there. That is the same
 *  limit `call` documents, and it is why every tag below is a claim about the calls it CAN see.
 *
 *  Two things are deliberately unreadable. `bctrl` and `blrl` take no operand, so anything after
 *  them is the next line rather than a callee. And an unresolved branch prints its own ADDRESS
 *  followed by the enclosing symbol in angle brackets (`jal 0 <atans_table>`, `bl c <call1+0xc>`);
 *  the address can be all hex letters and read as a name, and the bracketed symbol is the caller,
 *  not the callee — so an operand followed by `<` names nothing and is skipped. */
const CALL_TARGET =
  /(?:\b(?:bl|bla|jal|jalx)\s+|\bR_(?:PPC_(?:REL24|PLTREL24)|ARM_(?:CALL|PC24|THM_CALL|THM_XPC22)|MIPS_26)\s+)([A-Za-z_][\w$.]*)(?![\w$.])(?!\s*<)/g;

const calledSymbols = (asm: string): Set<string> => new Set([...asm.matchAll(CALL_TARGET)].map((m) => m[1]));

/** The four helpers `soft-div` already names. */
const SOFT_DIV_HELPER = /^__(?:u?divsi3|u?modsi3|divdi3|moddi3)$/;

/** A helper the COMPILER generated, for an operation the target has no instruction for. Two runtime
 *  families appear in this corpus: libgcc's `__<op><mode>` names (agbcc, ido, kmc — soft float,
 *  64-bit shifts and multiplies, conversions) and the Metrowerks runtime's `__cvt_*`, `__va_arg`
 *  and `__<op>2<sign>`. Matched as WHOLE symbol names, so a project function that merely starts
 *  with two underscores is not one. */
const RUNTIME_HELPER =
  /^__(?:u?(?:div|mod)(?:si|di)3|(?:ash[lr]|lshr|mul|neg)di3|(?:add|sub|mul|div)[sd]f3|neg[sd]f2|float(?:un)?si[sd]f|fix(?:uns)?[sd]fsi|extendsfdf2|truncdfsf2|(?:eq|ne|lt|le|gt|ge|cmp|unord)[sd]f2|(?:div|mod|shl|shr)2[iu]?|cvt_\w+|va_arg|aeabi_\w+)$/;

/** The soft-float comparison helpers — a float compare on a target with no FPU. */
const SOFT_FLOAT_COMPARE = /^__(?:eq|ne|lt|le|gt|ge|cmp|unord)[sd]f2$/;

/** The C standard maths library, with its `f` and `l` spellings. */
const LIBM =
  /^(?:sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|log|log10|pow|sqrt|fmod|ceil|floor|fabs|ldexp|frexp|modf|hypot)[fl]?$/;

/** The PowerPC EABI's out-of-line prologue helpers. */
const SAVE_GPR_HELPER = /^_(?:save|rest)(?:gpr|fpr)_\d+$/;

/** A floating-point comparison in hardware: PowerPC into a condition register, MIPS into the FP
 *  condition flag the `bc1` branches read (`bc1tl`/`bc1fl` are the likely forms). */
const FLOAT_COMPARE =
  /\bfcmp[ou]\b|\bc\.(?:f|un|eq|ueq|olt|ult|ole|ule|sf|ngle|seq|ngl|lt|nge|le|ngt)\.[sd]\b|\bbc1[tf]l?\b/;

/** A callee-saved floating-point register written to the frame: PowerPC f14–f31 (`psq_st` is
 *  Gekko's paired-single store), MIPS $f20–$f31. The store must be `(r1)`/`(sp)` — the same
 *  register used as a scratch elsewhere is not a save. */
const FLOAT_CALLEE_SAVE =
  /\b(?:stfd|psq_st)\s+f(?:1[4-9]|2\d|3[01]),\s*-?\d+\(r1\)|\b(?:sdc1|swc1)\s+\$f(?:2\d|3[01]),\s*-?\d+\(sp\)/;

/** The PowerPC EABI's variadic-call marker: CR bit 6 says whether any float was passed in an FP
 *  register, and the caller sets or clears it at EVERY variadic call, including one passing none. */
const VARARG_CALL = /\bcr(?:clr|set)\s+4\*cr1\+eq\b/;

/** The `codegen` tags decidable from the assembly ALONE (no source needed). */
function asmEvidence(targetAsm: string): Set<string> {
  const out = new Set<string>();
  if (DIV_HELPERS.test(targetAsm)) out.add('soft-div');
  const called = calledSymbols(targetAsm);
  // `soft-div` says more about the same call, so the division helpers are its own and not counted
  // here — the two tags partition the runtime rather than doubling up on it.
  if ([...called].some((s) => RUNTIME_HELPER.test(s) && !SOFT_DIV_HELPER.test(s))) out.add('runtime-helper-call');
  if ([...called].some((s) => LIBM.test(s))) out.add('libm-call');
  if ([...called].some((s) => SAVE_GPR_HELPER.test(s))) out.add('savegpr-helper');
  if (FLOAT_COMPARE.test(targetAsm) || [...called].some((s) => SOFT_FLOAT_COMPARE.test(s))) out.add('float-compare');
  if (FLOAT_CALLEE_SAVE.test(targetAsm)) out.add('float-callee-save');
  if (VARARG_CALL.test(targetAsm)) out.add('vararg-call');
  if (/\bR_PPC_EMB_SDA21\b/.test(targetAsm)) out.add('sda-global');
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
