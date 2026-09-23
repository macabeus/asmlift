// The decline classifier is FIRST-MATCH over an ordered list, and its ORDER is the whole product:
// it decides which missing capability the blocker Pareto tells the next round to build. Reordering
// one entry collapses the largest MIPS family into the generic bucket with every class still
// present and only the counts moved, which no other gate can see. These pin the orderings that
// actually overlap.
import type { FunctionResult } from '@asmlift/bench-schema';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { DECLINE_CLASSES, OTHER_CLASS, declineClassesOf } from '../src/pages/benchmark/lib/declines';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const CORE_SRC = join(ROOT, 'packages/core/src');

/** A source file with its COMMENT LINES removed — a line whose first non-space character opens or
 *  continues one. Every phrase check below runs against this rather than the raw text, because a
 *  phrase that survives only in prose pins nothing: `frontend/opaque.ts` says "unmodelled
 *  instruction" six times, all of them in comments, and `frontend/thumb.ts` says "local stack
 *  frames not supported" once, in a comment saying it does not emit that phrase. Against the raw
 *  text a pin on either file is green while the phrase has no producer left. */
const codeOf = (file: string): string =>
  readFileSync(join(ROOT, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

/** Every decline message `packages/core/src` can throw, as a template.
 *
 *  A DECLINE is what the benchmark publishes as a marker: the pipeline catches these four
 *  constructors and annotates. Each site's balanced-paren argument is taken, its string-literal
 *  pieces kept and every `${…}` replaced by a placeholder — so an interpolated MNEMONIC or SYMBOL
 *  becomes `X` here, which is why a class keyed on a mnemonic alternation cannot be exercised from
 *  this corpus and is pinned by hand instead (see `NOT_IN_TEMPLATES`). */
const DECLINE_CTORS = new Set([
  'FrontendUnsupportedError',
  'PpcUnsupportedError',
  'RaiseUnsupportedError',
  'StructureError',
]);

const coreDeclineTemplates = (): { file: string; line: number; text: string }[] => {
  const files: string[] = [];
  (function walk(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (p.endsWith('.ts')) {
        files.push(p);
      }
    }
  })(CORE_SRC);
  const out: { file: string; line: number; text: string }[] = [];
  for (const f of files.sort()) {
    const src = readFileSync(f, 'utf8');
    const re = /throw new (\w+)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (!DECLINE_CTORS.has(m[1])) {
        continue;
      }
      let i = m.index + m[0].length;
      let depth = 1;
      const start = i;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') {
          depth++;
        } else if (src[i] === ')') {
          depth--;
        }
        i++;
      }
      const arg = src.slice(start, i - 1);
      const pieces: string[] = [];
      const lit = /`((?:[^`\\]|\\.)*)`|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
      let l: RegExpExecArray | null;
      while ((l = lit.exec(arg))) {
        pieces.push(l[1] ?? l[2] ?? l[3] ?? '');
      }
      const text = pieces
        .join('')
        .replace(/\$\{[^}]*\}/g, 'X')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        out.push({ file: f.slice(CORE_SRC.length + 1), line: src.slice(0, m.index).split('\n').length, text });
      }
    }
  }
  return out;
};

const CORE_TEMPLATES = coreDeclineTemplates();
const classOfText = (t: string) => DECLINE_CLASSES.find((c) => c.pattern.test(t))?.key ?? OTHER_CLASS.key;

/** a declined row carrying exactly these markers */
const row = (...errorMarkers: string[]) =>
  ({ asmlift: { outcome: 'declined', errorMarkers } }) as unknown as FunctionResult;

const classOf = (marker: string) => declineClassesOf(row(marker))[0];

describe('specific instruction families beat the generic opaque bucket', () => {
  // `opaque-ops` is `unmodelled instruction` with NO mnemonic filter, so it subsumes every class
  // that matches a named instruction. It must sit below all of them.
  test.each([
    ['mtc1', 'float'],
    ['mfc1', 'float'],
    ['cvt.s.w', 'float'],
    ['add.s', 'float'],
    ['lwc1', 'float'],
    ['fmr', 'float'],
    ['stfd', 'float'],
  ])("unmodelled instruction '%s' classifies as %s, not opaque-ops", (mnemonic, want) => {
    expect(classOf(`structure: unmodelled instruction '${mnemonic}'`)).toBe(want);
  });

  // PPC spells single precision with a trailing `s` and a record form with a trailing `.`, so a
  // list written against `fadd|fsub|fmul|fdiv` and a closing quote matches the double-precision
  // spelling and nothing mwcc emits for a `float`. Seven of these eleven are published markers of
  // the committed artifact — `fadds`, `fsubs`, `fmuls` (twice), `fdivs` on five synthetic rows,
  // `fneg` and `fabs` on two real ac-decomp functions — so that alternation reports a
  // floating-point gap as "we do not know what blocks these".
  test.each(['fadds', 'fsubs', 'fmuls', 'fdivs', 'fneg', 'fabs', 'fadd.', 'fmadds', 'fsel', 'psq_l', 'ps_madds0'])(
    "the PPC FPU mnemonic '%s' is floating point",
    (mnemonic) => {
      expect(classOf(`structure: unmodelled instruction '${mnemonic}'`)).toBe('float');
    },
  );

  // The other half: the PPC arm must not become "anything mwcc emits". Every one of these is a
  // real opaque-ops inhabitant of the committed artifact.
  test.each(['clz', 'rlwimi', 'rlwinm', 'xoris', 'subfe', 'addc', 'adde'])(
    "a mnemonic in no family still lands in opaque-ops: '%s'",
    (mnemonic) => {
      expect(classOf(`structure: unmodelled instruction '${mnemonic}'`)).toBe('opaque-ops');
    },
  );

  // A STORE IS SPELT AT A DIFFERENT SITE, and for four mnemonics it is the ONLY site. `opaque.ts`
  // tests `policy.storeClass` before anything becomes an opaque, so nothing can ever print
  // "unmodelled instruction 'swc1'": without the store-class prefix these four alternatives of
  // `float` are inert, and all 13 markers core spells that way are floating-point stores.
  test.each(['swc1', 'sdc1', 'stfs', 'stfd'])("the store-class spelling of '%s' is floating point", (mnemonic) => {
    expect(
      classOf(
        `lift: cannot lift 'f @0x4': unmodelled store-class instruction '${mnemonic}' — a memory write cannot ` +
          'be skipped or degraded to a register opaque',
      ),
    ).toBe('float');
  });

  // …and the half that stops the widened prefix becoming the next catch-all. The ISA store
  // policies are `sb|sh|sw|swl|swr|sc|sd|sdl|sdr` (mips.ts), `^(str|stm)` (thumb.ts) and `^st`
  // (ppc.ts), so `store-class` is uninhabited today rather than dead, and these are what would
  // inhabit it.
  test.each(['stwbrx', 'swl', 'sb', 'stmia'])("a non-FPU store stays in store-class: '%s'", (mnemonic) => {
    expect(
      classOf(
        `lift: cannot lift 'f @0x4': unmodelled store-class instruction '${mnemonic}' — a memory write cannot ` +
          'be skipped or degraded to a register opaque',
      ),
    ).toBe('store-class');
  });
});

describe('the instruction cause beats the shape symptom', () => {
  // An `opaque` makes its block impure, so a shape recognizer refuses and the decline reads as a
  // loop/switch problem. pipeline.ts `attributeOpaques` appends the instruction; these pin that the
  // appended half is the one that wins, or the attribution would be cosmetic.
  test('a loop-shape decline naming an unmodelled instruction is opaque-ops', () => {
    expect(
      classOf(
        "structure: cannot structure 'f': unrecovered back-edge into block #1 (loop-recovery declined " +
          'this shape: multi-latch, irreducible/overlapping loops, a conditional continue, or an unsafe ' +
          "break) — and the function carries unmodelled instruction 'clz', which is the more likely cause",
      ),
    ).toBe('opaque-ops');
  });

  test('…and the FLOAT family still wins over both', () => {
    expect(
      classOf(
        "structure: cannot structure 'f': unrecovered back-edge into block #1 (loop-recovery declined " +
          "this shape) — and the function carries unmodelled instruction 'mtc1', which is the more likely cause",
      ),
    ).toBe('float');
  });

  test('a loop-shape decline with NO unmodelled instruction is still loop-shapes', () => {
    // Without this, "always classify as opaque-ops" would pass the two tests above.
    expect(classOf("structure: cannot structure 'f': unrecovered back-edge into block #1")).toBe('loop-shapes');
  });
});

describe('all three "unmodelled …" message spellings are classified', () => {
  // The frontend and the structurer word this differently, and a spelling no class reads falls into
  // "other" — which reads as "we do not know what blocks these" when in fact we do.
  test.each([
    ["structure: unmodelled instruction 'mtc1'", 'float'],
    ["lift: unmodelled effect instruction 'mtc1' — no register destination to degrade", 'float'],
    ["lift: unmodelled store-class instruction 'swc1' — a memory write cannot be skipped", 'float'],
    ["lift: unmodelled store-class instruction 'stwbrx' — a memory write cannot be skipped", 'store-class'],
    ["structure: unmodelled instruction 'clz'", 'opaque-ops'],
    ["lift: unmodelled effect instruction 'teq' — no register destination to degrade", 'opaque-ops'],
  ])('%s -> %s', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });
});

describe('the two MIPS delay-slot gaps are told apart', () => {
  // `bc1fl` is a branch-likely AND an FP condition-code branch, and the FP condition code blocks it
  // either way — so the two must not share a class, or the blocker Pareto would report the FP rows
  // as work the branch-likely round left undone. The `bltzall` row holds the other half of the
  // split: a transfer named by neither class stays in `branch-form`.
  test.each([
    [
      "lift: cannot lift 'absi': branch-likely 'bltzl' at 0x4 — the delay slot is itself a control transfer",
      'branch-likely',
    ],
    ["lift: cannot lift 'f': branch-likely at 0x24 — a recovered switch arm lands on its delay slot", 'branch-likely'],
    [
      "lift: cannot lift 'fcmp': floating-point condition-code branch 'bc1f' at 0x8 — the FP condition code is not modelled",
      'fp-cond-branch',
    ],
    ["lift: cannot lift 'f': unmodelled control transfer 'bltzall' at 0x0 — not a modelled branch form", 'branch-form'],
  ])('%s -> %s', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });
});

describe('a control transfer is named by what it is, not by the catch-all', () => {
  // `branch-form` matches `unmodelled control transfer` with no further filter, so every class
  // that names one of those transfers must sit above it — the same first-match hazard `opaque-ops`
  // has with `float`. Three transfers in the corpus are separately buildable capabilities, so one
  // bucket reporting them together reads as one gap where there are three.
  test.each([
    [
      "lift: cannot lift 'aBALL_actor_move': unmodelled control transfer 'bctrl' at 0x9c (an indirect call — a " +
        'virtual dispatch or a call through a pointer — is not yet supported)',
      'indirect-call',
    ],
    [
      "lift: cannot lift 'calcDataSize__6TexImgFiii': unmodelled control transfer 'bctr' at 0x20 (CTR-counted " +
        'loop or indirect branch — mwcc -O4 loop unrolling is not yet supported)',
      'ctr-transfer',
    ],
    [
      "lift: cannot lift 'mem_clear': branch to 0x30 is not a block boundary (out-of-range / mid-instruction " +
        'target — tail branch or unrecovered control flow)',
      'block-boundary',
    ],
    ["lift: cannot lift 'f': unmodelled control transfer 'bltzall' at 0x0 — not a modelled branch form", 'branch-form'],
  ])('%s -> %s', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });
});

describe('a pattern keyed on an English word claims sentences that are not about it', () => {
  // Both of these are the same defect and both were live: a class whose pattern is a bare word
  // rather than a phrase its producer guarantees. They are pinned as NEGATIVE cases, because the
  // failure is silent — the count moves to a class that names the wrong capability and nothing
  // grows "other", so the anchor at the bottom of this file cannot see it. Every marker here is a
  // core message copied from its throw site.
  test.each([
    // `switch-shapes` must not reach the bare word `fall-through`. This is `frontend/ppc.ts`'s
    // generic conditional-branch refusal; there is no switch anywhere in it.
    [
      "lift: cannot lift 'f': conditional branch 'bge' at 0x20 has a target/fall-through that is not a block " +
        'boundary (tail branch or unrecovered control flow)',
      'block-boundary',
    ],
    // …and its recovered-dispatch refusal says BOTH "jump-table" and "not a block boundary", so
    // the two classes have to be told apart by phrase, not by which one is listed first.
    ["lift: cannot lift 'f': jump-table target is not a block boundary", 'switch-shapes'],
    // `branch-form` must not reach the bare words `indirect` and `computed`. This is an
    // address-taken-local refusal and a published marker of `sa3:ProcessOamBuffers`.
    [
      "lift: cannot lift 'ProcessOamBuffers': stack pointer used as data — the address of a stack local is " +
        'computed (`add r0, sp, #0x4`) — only a plain `mov rD, sp` capture is modelled',
      'address-taken-local',
    ],
    // `cross-block-flags-arm` must not reach the bare headline `no reaching compare: `. Thumb
    // throws that headline for THREE subjects, and only one of them is an edge: the shapes its
    // inheritance model left over; flags written by arithmetic, by `tst`/`cmn` or by a call, which
    // no edge model would move; and a block with no predecessor, where there is no edge to carry
    // anything. The arithmetic one has 97 sites in kleod's and sa3's hand-written asm and 2 in
    // their built `.s`, so filing it under a label that reads "across an edge" would send a roadmap
    // reader to build the wrong thing — the same over-claim the `stack-frames` class was narrowed
    // for.
    [
      "lift: cannot lift 'MultiBootWaitSendDone': conditional branch 'bgt' has no reaching compare: the flags " +
        "it tests were written by 'sub' in '.LWait', and only a compare's are modelled",
      'other',
    ],
    [
      "lift: cannot lift 'f': conditional branch 'bge' has no reaching compare: the flags it tests were " +
        "written by a call in 'f', over the compare that reached it, and only a compare's are modelled",
      'other',
    ],
    // …INCLUDING when the writer is a block away, which is the shape that used to be filed as an
    // edge problem. The sentence the predecessor wrote is what crosses, so one gap reads the same
    // however the labels fall, and it classifies the same too.
    [
      "lift: cannot lift 'f': conditional branch 'bge' has no reaching compare: the flags it tests were " +
        "written by 'add' in '.L2', over the compare that reached it, and only a compare's are modelled",
      'other',
    ],
    // …and a branch whose block nothing reaches is not an edge shape either.
    [
      "lift: cannot lift 'f': conditional branch 'bge' has no reaching compare: no compare reaches 'f', and " +
        'it has no predecessor to inherit any from',
      'other',
    ],
    // …while the four shapes the model really does leave at an edge land in the class.
    [
      "lift: cannot lift 'f': conditional branch 'bge' has no reaching compare: no compare crosses the edges " +
        "into '.L2': 2 meet there, and the flags need not agree on all of them",
      'cross-block-flags-arm',
    ],
    [
      "lift: cannot lift 'f': conditional branch 'bge' has no reaching compare: no compare crosses the edge " +
        "into '.L1': its only predecessor '.L2' is lifted after it",
      'cross-block-flags-arm',
    ],
    [
      "lift: cannot lift 'f': conditional branch 'bge' has no reaching compare: no compare crosses the edge " +
        "into '.L2': it leaves 'f' through a conditional branch",
      'cross-block-flags-arm',
    ],
    [
      "lift: cannot lift 'f': conditional branch 'bge' has no reaching compare: no compare crosses the edge " +
        "into '.Lc0': it leaves the jump-table dispatch in 'f'",
      'cross-block-flags-arm',
    ],
  ])('%s -> %s', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });

  // A loop-naming refusal is not control flow, so being unnamed is the honest answer here and the
  // residue list in `declines.ts` records it.
  //
  // THE OTHER TEMPTING NEGATIVE CASE CANNOT BE PUBLISHED AT ALL: `pascal backend: switch
  // fall-through has no faithful IDO Pascal case-of spelling` is a real text
  // (`packages/core/src/backend/pascal.ts`) and not a real marker — it is thrown as a plain
  // `Error`, `Diagnostic.stage` in `pipeline.ts` is `lift | raise | structure | contract | verify |
  // internal` with no `backend`, and `apps/benchmark/src/eval/asmlift.ts` builds every marker as
  // `${d.stage}: …`. Measured over the artifact, every marker on a declined row opens `lift:`
  // (253), `structure:` (49) or `raise:` (18). A negative test against a string the channel cannot
  // carry asserts a hazard that does not exist; `ppc.ts`'s tail-branch refusal, a real published
  // marker, is the whole of the case for not keying on the word `fall-through`.
  test('a loop-naming refusal is unclassified rather than misfiled as control flow', () => {
    expect(
      classOf(
        "structure: cannot structure 'f': a pre-update exit copy would rebuild a computed value inside a loop " +
          "nested in another loop's post-loop naming",
      ),
    ).toBe('other');
  });
});

describe('a slot that is never written is not a frame the lifter cannot model', () => {
  // `stack-frames` and `unstored-slot` are both about an sp slot and only their ORDER tells them
  // apart. The frontends spell the same refusal two ways, one per reading site.
  test.each([
    [
      "lift: cannot lift 'uninit_join': sp@4 is read on a path that never stores it, and lies outside this " +
        "function's frame partition (uninitialised local, or storage it does not own) — not modelled",
      'unstored-slot',
    ],
    // Verbatim from `frontend/mips.ts` — and it is why `stack-frames` carries no `stack-passed`
    // alternative. That site is its only producer, `unstored-slot` claims it on "was never stored"
    // first, so no string core emits could reach one.
    [
      "lift: cannot lift 'f': load from stack slot sp@8 that was never stored (stack-passed argument beyond " +
        'the 4 register args, or an address-taken/uninitialised local) — not modelled',
      'unstored-slot',
    ],
    ["lift: cannot lift 'f': reload of a stack local ('8(r1)') — local stack frames not supported", 'stack-frames'],
  ])('%s -> %s', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });

  // ONE GUARD, THREE FRONTENDS. `frontend/ppc.ts` and `frontend/mips.ts` read r1/sp as a data
  // operand exactly as `frontend/thumb.ts` does — their comments say so — and refuse WITHOUT
  // resolving the cause, so their message is a disjunction where Thumb's is a decision. All three
  // spellings name an address-taken local first, and the first two are published markers of
  // `ac-decomp`, `marioparty4`, `pikmin` and two synthetic rows — 17 of the 20 rows of
  // `address-taken-local`, against 3 that arrive by Thumb's decided spelling.
  test.each([
    [
      "lift: cannot lift 'step0_make_dl': stack pointer r1 used as data (address-taken local / frame " +
        'arithmetic) — not supported',
      'address-taken-local',
    ],
    [
      "lift: cannot lift 'f': stack pointer used as data (address-taken local / frame arithmetic) — local " +
        'stack frames not supported',
      'address-taken-local',
    ],
    // thumb.ts's own fallback `why`, reached when the slot model is on and no blocker named itself.
    [
      "lift: cannot lift 'f': stack pointer used as data — not a modelled slot (address-taken local / frame " +
        'arithmetic / above the local area)',
      'address-taken-local',
    ],
  ])('%s -> %s', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });

  // …and the negative half, which is the one that would go silently wrong: `unstored-slot`'s own
  // message names "an address-taken/uninitialised local" with a SLASH, and `address-taken-local`
  // sits above it. A pattern spelling the bare words `address-taken` and `local` would take it.
  test('the slash-joined disjunction in the unstored-slot message is not an address-taken claim', () => {
    expect(
      classOf(
        "lift: cannot lift 'f': load from stack slot sp@8 that was never stored (stack-passed argument beyond " +
          'the 4 register args, or an address-taken/uninitialised local) — not modelled',
      ),
    ).toBe('unstored-slot');
  });

  // `frontend/thumb.ts` has ONE sp-as-data throw and appends ten different `why`s to it. Two name a
  // capability of their own and are claimed above by first-match; these eight are what the class
  // called "other sp uses" actually is, and all eight are verbatim from `slotModelBlocker`. Keyed
  // on a single `why`, the first corpus row on any of them arrives unclassified.
  test.each([
    'a register-offset sp access can alias any slot',
    'a sub-word sp access aliases the word-slot model',
    'sp moves in a block that neither returns nor is the entry',
    'a non-entry block establishes its own frame depth',
    'sp unwinds mid-function and execution continues',
    'the frame moves between two accesses that keyed slots against it',
    'a pop reads the frame while the local area is still reserved',
  ])('the slot-model blocker "%s" is a stack-frames gap', (why) => {
    expect(classOf(`lift: cannot lift 'f': stack pointer used as data — ${why}`)).toBe('stack-frames');
  });
});

describe('a relocation refuses over the NAME or over the HALF, and they are different things to build', () => {
  // The largest single gap in the corpus after floating point: 23 rows of compiler-generated names
  // plus 12 of unpaired address halves. They are all relocation refusals and they are not one
  // capability — a pooled literal is a value the object already carries, a function-scope static is
  // spellable once the counter suffix goes, a C++ entity needs a declaration seam that does not
  // exist, a section-relative label denotes an offset nothing declares, and an unpaired half is not
  // a naming question at all. Each example is a published marker from the committed artifact.
  test.each([
    [
      "lift: cannot lift 'cKF_KeyCalc': 'lis' at 0x18 names an anonymous constant pool entry ('@61') — the " +
        'compiler generated that name for a literal it has no declaration for, so no C source can refer to it',
      'pooled-literal',
    ],
    [
      "lift: cannot lift 'aPMAN_set_move_idx': 'lis' at 0x4 names a function-scope static ('move_idx$345') — " +
        'the suffix is a translation-unit-wide counter the compiler assigned, which no source can spell',
      'tu-scoped-name',
    ],
    [
      "lift: cannot lift '__dt__6SystemFv': 'lis' at 0x18 names a C++ virtual table ('__vt__6System') — the " +
        'compiler emits it from a class definition, so no source spells it',
      'cxx-symbol',
    ],
    [
      "lift: cannot lift 'fullfillPiki__6AIPerfFR4Menu': 'lis' at 0xc names a C++ class-scoped symbol " +
        "('containerPikis__8GameStat') — a reference spelled this way reaches exactly that symbol",
      'cxx-symbol',
    ],
    [
      "lift: cannot lift 'DoMount__FlPv': 'lis' at 0x8c names a section-relative label ('...bss.0') — it " +
        'denotes an offset into a section, not an object, so there is nothing to declare',
      'section-label',
    ],
    [
      "lift: cannot lift 'lbRk_SeirekiDays': v0 holds the high half of 't_seiyo_days_tbl' (the 'lui' at 0x24) " +
        "and is read as a value — only its matching '%lo' half may consume it",
      'reloc-halves',
    ],
  ])('%s -> %s', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });

  // `pool-word-shape` used to have its published marker here, `sa3:OamMalloc`'s
  // `pool word 'gOamMallocBuffer+-0x8' is not a symbol, symbol±offset, or number`. It is gone
  // rather than reworded: `gOamMallocBuffer+-0x8` LIFTS now, so no input produces that sentence
  // and a fixture holding it would pass forever while testing a string the tool cannot say. The
  // class is covered instead by the seven `why`s below, every one of them a shape that still
  // refuses.

  test.each([
    // All seven `why`s that reach `frontend/thumb.ts`'s one literal-pool throw. Keyed on the `why`
    // the corpus happened to print, only the ones saying `pool word` classified, and the rest —
    // the same capability at the same site — would have arrived as unclassified.
    [
      "lift: cannot lift 'f': literal-pool load of pool word 'gFoo+gBar' is not a symbol, symbol±offset, " +
        'or number — not modelled',
    ],
    ["lift: cannot lift 'f': literal-pool load of offset 3 is not a whole word in pool '_pool_1' — not modelled"],
    [
      "lift: cannot lift 'f': literal-pool load of offset '+-0x4' into pool '_pool_1' is not a '+N' byte " +
        'offset — not modelled',
    ],
    ["lift: cannot lift 'f': literal-pool load of word '0x100000000' is not a 32-bit value — not modelled"],
    [
      "lift: cannot lift 'f': literal-pool load of pool word 'gFoo+0x100000000' carries an addend that is " +
        'not a 32-bit value — not modelled',
    ],
    [
      "lift: cannot lift 'f': literal-pool load of pool word '010' has a leading-zero magnitude, which is " +
        'octal to the assembler — not modelled',
    ],
    // The same rule one position out, in the pool's OPERAND rather than in one of its words.
    [
      "lift: cannot lift 'f': literal-pool load of offset '+010' into pool '_pool_1' has a leading-zero " +
        'magnitude, which is octal to the assembler — not modelled',
    ],
  ])('%s -> pool-word-shape', (marker) => {
    expect(classOf(marker)).toBe('pool-word-shape');
  });

  // THE SIBLINGS A TIGHTER CLASS WOULD MISS. Ten core messages, every one a member of a family
  // that has a class here and none of them the spelling the corpus happened to print. Each is the
  // throw-site text with its interpolations filled in.
  test.each([
    // `structure/structure.ts` refuses a jump table five ways; `case arms do not linearize` was the
    // only one the class read, and it had one row.
    ["structure: cannot structure 'f': jump-table cases share a target block with differing phi args", 'switch-shapes'],
    [
      "structure: cannot structure 'f': a jump-table case runs on into the next case, and the target " +
        'language has no fall-through in its case statement',
      'switch-shapes',
    ],
    [
      "structure: cannot structure 'f': case 3/4 falls through into an arm that is not the next one " +
        'emitted — C fall-through only reaches the arm below',
      'switch-shapes',
    ],
    // …and the same message under a 90-character C++ name, which pushes its LAST clause past the
    // 200-character cap this file opens with. Keyed on "C fall-through only reaches the arm below"
    // the long name answers "other" and the short name classifies — the exact failure the cap rule
    // exists to prevent, and the reason the pattern reads the opening clause.
    [
      `structure: cannot structure '${'A'.repeat(90)}': case 3/4 falls through into an arm that is not ` +
        'the next one emitted — C fall-through only reaches the arm below',
      'switch-shapes',
    ],
    [
      "structure: cannot structure 'f': the case fallen into takes a value from the switch edge, which " +
        'the fall-through path would re-run',
      'switch-shapes',
    ],
    // PR #222's placeholder law in the MIPS frontend: a relocation that never arrived is not the
    // address zero. It is reachable with an ordinary lift of a `-G 0` object whose side table was
    // not supplied.
    [
      "lift: cannot lift 'f': 'lui' at 0x0 loads the high half 0x0 with no relocation on it — that is an " +
        'unrelocated placeholder, not the value',
      'reloc-halves',
    ],
    // …and its PPC twin, which ends in the same clause as the alternative this class already had.
    [
      "lift: cannot lift 'f': 'addi' at 0x4 carries a data relocation ('gFoo') — the printed immediate " +
        'is a link-time placeholder, not the value',
      'reloc-halves',
    ],
    [
      "lift: cannot lift 'f': 'addi' at 0x4 carries the '@l' half of 'gFoo' but its immediate is '8', not " +
        'the expected 0 placeholder',
      'reloc-halves',
    ],
    [
      "lift: cannot lift 'f': 'lis' at 0x0 carries the '@ha' half of 'gFoo' but its immediate is '2', not " +
        'the expected 0 placeholder',
      'reloc-halves',
    ],
    // The two small-data siblings. The file spent a paragraph explaining that `pic-globals` had no
    // inhabitant anywhere while these sat unnamed in the residue.
    [
      "lift: cannot lift 'f': 'lwz' at 0x8 carries a small-data relocation ('gFoo') but its memory " +
        "operand is '4(r13)', not the expected '0(0)' placeholder",
      'pic-globals',
    ],
    [
      "lift: cannot lift 'f': 'addi' at 0xc carries a small-data relocation ('gFoo') but its immediate " +
        "is '4', not the expected 0 placeholder",
      'pic-globals',
    ],
  ])('%s -> %s', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });

  test('an unpaired half carried by an FPU load is about the half, not about the FPU', () => {
    // `reloc-halves` sits BELOW `float`, and this marker names `lwc1`. It classifies as the half
    // because `float` matches only `unmodelled instruction '<mnemonic>'` — loosen that alternation
    // to a bare mnemonic and this row silently becomes a floating-point gap.
    expect(
      classOf(
        "lift: cannot lift 'chase_angle': 'lwc1' at 0x28 carries 'R_MIPS_LO16' against 'game_GameFrame_2F' " +
          'but is not a modelled consumer of it — the printed immediate is a link-time placeholder, not the value',
      ),
    ).toBe('reloc-halves');
  });
});

describe('the remaining families each name what a round would build', () => {
  // An unread data directive and a `sub-word stack-frame` access share nothing: one is table data
  // in `.rodata`, the other a frame slot. Both directive spellings are pinned, and one of them is
  // `.quad` on purpose — the class is about a directive whose bytes the reader did not parse into
  // words, not about a width, and a pattern that had gone back to reading widths would still match
  // the `.short` line alone. The loop pair is separated from `loop-shapes` on the same reasoning —
  // the loop IS recovered and its exit values are what refuse.
  test.each([
    [
      "lift: cannot lift 'f': literal-pool load of data label 'sTab', which carries a '.short' directive this " +
        'reader does not read as words — not modelled',
      'unread-data-directive',
    ],
    [
      "lift: cannot lift 'f': literal-pool load of data label 'sTab', which carries a '.quad' directive this " +
        'reader does not read as words — not modelled',
      'unread-data-directive',
    ],
    [
      "lift: cannot lift 'f': data label 'sTab', which carries a '.short' directive this reader does not read " +
        'as words, is used as a register — not modelled',
      'unread-data-directive',
    ],
    ["lift: cannot lift 'f': sub-word stack-frame access ('2(r1)') — local stack frames not supported", 'stack-frames'],
    [
      "lift: cannot lift 'evw_anime_colreg_manual': the call at 0x3c has no prototype, r5 holds a value and " +
        'r4 holds none — an argument register left at its incoming value and one the call does not pass look ' +
        'the same',
      'no-prototype-args',
    ],
    [
      "structure: cannot structure 'dma_wait': a post-loop read reaches a temp the guarded body may never assign",
      'loop-exit-values',
    ],
    [
      "structure: cannot structure 'ucmp': the fused guard's exit edge carries a value the post-loop copies " +
        'do not reproduce on a zero-trip run',
      'loop-exit-values',
    ],
    ["structure: cannot structure 'f': unrecovered back-edge into block #1", 'loop-shapes'],
  ])('%s -> %s', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });
});

describe('a class is decided inside the PUBLISHED marker, not inside the full reason', () => {
  // `apps/benchmark/src/eval/asmlift.ts` publishes `<stage>: ` + `firstLine(reason)`, and
  // `firstLine` is `split('\n')[0].slice(0, 200)`. A pattern keyed past that cap tests a string no
  // artifact carries, and the classifier then answers `other` on a gap it knows by name.
  const REASON =
    "cannot lift '__ct__7ActFreeFP4Piki': reload of '8(r1)' into r4, a slot r3 was saved into — " +
    'a load that does not restore the register the slot holds is a value read back through the ' +
    'stack, which is a local stack frame this frontend does not model';

  test('the phrase naming the frame does not survive the cap', () => {
    expect(REASON).toContain('local stack frame');
    expect(REASON.slice(0, 200)).not.toContain('local stack frame');
  });

  test('…and the truncated marker is classified all the same', () => {
    expect(classOf(`lift: ${REASON.slice(0, 200)}`)).toBe('stack-frames');
  });

  test('the untruncated reason agrees, so the cap changes nothing about the answer', () => {
    expect(classOf(`lift: ${REASON}`)).toBe('stack-frames');
  });
});

describe('the classes with no corpus row are alive, not dead entries', () => {
  // A class with zero rows is three different findings with three different fixes: its refusal is
  // gone from core (delete the class), its refusal is still emitted but reworded (fix the pattern),
  // or nothing in the corpus reaches it (leave it, and say what it still guards). All of these are
  // the third, measured on the committed artifact:
  //
  //   branch-likely  LEFTOVER SHAPES. PR #226 modelled the capability — a likely branch nullifies its
  //                  delay slot, modelled by placement — and `mips.ts` :386, :642 and :647 are what
  //                  it left behind. The population is enormous and the hazard is absent: over the
  //                  three MIPS Splat asm trees in `apps/benchmark/checkouts` (`af`,
  //                  `marioparty3`, `snowboardkids2-decomp` — 24,651 `.s` files), 18,785
  //                  instructions are likely branches — `bnel` 7,607, `beql` 6,623, `bc1fl` 1,909,
  //                  `bc1tl` 1,461, then the zero-compare forms — and each of the three shapes
  //                  `normaliseBranchLikely` SCANS FOR reads ZERO: a delay slot that is itself a
  //                  control transfer, a likely branch sitting in another transfer's slot, a delay
  //                  slot some branch targets. Scan with every mnemonic FULLMATCHED: a prefix
  //                  match counts `break` — a trap, not a branch — as a transfer and reports a
  //                  hazard that is not there.
  //                  THE THROW HAS SEVEN ARMS, NOT THREE, and the scan covers three of them. The
  //                  other four refuse a disassembly the reader cannot account for: an unresolved
  //                  branch target, and no instruction at the delay slot, at the not-taken edge, or
  //                  before the branch. `mips.ts:396` says `parseDisasm` guarantees those by
  //                  refusing a listing it cannot account for, which would make them unreachable by
  //                  construction — but nothing here measures that, and a coverage claim owes its
  //                  whole gate list rather than the arms it happened to scan.
  //   store-class    ALL 13 of its rows were floating-point stores and `float` now takes them, so
  //                  it emptied in the commit that admitted the store-class prefix there. Not
  //                  dead: the ISA store policies reach `stwbrx`, `swl`, `sb` and `stmia`, pinned
  //                  above.
  //
  // `pic-globals` is the fourth case, and the one that leaves this list: it was reachable and NOT
  // REACHED, because every corpus toolchain compiles with no small-data threshold — `-non_shared
  // -G 0` for ido7.1, `-mno-abicalls -fno-PIC -G 0` for gcc2.7.2kmc — which is a flag and not a
  // shape the toolchain cannot emit. `synthetic:tax_gprel` sets `-G 8` on ido7.1's canonical set,
  // the global moves to `.sbss`, and the row declines with this class's message verbatim. The flag
  // was audited in both directions: the same source at `-G 0` emits `lui`/`addiu` under
  // `R_MIPS_HI16`/`LO16` and does not reach the refusal at all.
  //
  // For a class that stays here, the test that keeps it honest is that core still spells its
  // refusal: a class may not outlive the message it classifies. That check lives in `SPELT_BY`,
  // for every class rather than for these.
  test.each([
    [
      "lift: cannot lift 'absi': branch-likely 'bnezl' at 0x0 — the delay slot is itself a control transfer ('b')",
      'branch-likely',
    ],
    ["lift: cannot lift 'f': gp used as data (PIC / small-data global access) — not supported", 'pic-globals'],
    [
      "lift: cannot lift 'f': non-register memory base ('0(0)') — SDA/global-relative access not supported",
      'pic-globals',
    ],
    ["lift: cannot lift 'f': relocation operand '%got' (small-data / PIC data access) — not modelled", 'pic-globals'],
  ])('%s -> %s', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });

  test('branch-likely says in its LABEL that it is leftover, because 0 rows reads as "cannot"', () => {
    // A zero-row class never reaches the Pareto at all — `declinePareto` accumulates only from
    // markers it saw, so `GapAnalysis.tsx`, the panel that calls itself the roadmap view, does not
    // render one. `DeclinePicker` in `components/FeaturePicker.tsx` does: one option per class with
    // the zero-count ones `disabled`, so the label is the whole of what a reader finds, on a filter
    // dropdown rather than on the roadmap. "Branch-likely delay slots" alone reads as "asmlift
    // cannot lift one"; it can, since #226.
    expect(DECLINE_CLASSES.find((c) => c.key === 'branch-likely')?.label).toMatch(/residual/);
  });

  // `PIC` and `SDA` are three upper-case letters, and a marker opens with the function's own name,
  // so an unanchored alternative classifies by what the SYMBOL is called. Both of these carry a
  // refusal about something else entirely.
  test.each([
    ["lift: cannot lift 'SetPICMode': unmodelled control transfer 'bltzall' at 0x0", 'branch-form'],
    [
      "lift: cannot lift 'draw__3SDAFv': unmodelled effect instruction 'stfd' — no register destination to degrade",
      'float',
    ],
  ])('%s is classified by its refusal, not by its symbol', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });

  test.each([
    // `frontend/ppc.ts` refuses a CTR loop at three sites. Keyed on the one spelling the artifact
    // carried, the two that say the trip count is unrecoverable arrived unclassified.
    ["lift: cannot lift 'f': 'bdnz' at 0x10 without a reaching 'mtctr' (CTR loop count not recoverable)"],
    [
      "lift: cannot lift 'f': CTR loop body contains 'mtctr' at 0x20 which clobbers CTR (loop trip count not recoverable)",
    ],
  ])('%s -> ctr-transfer', (marker) => {
    expect(classOf(marker)).toBe('ctr-transfer');
  });
});

describe('THE ANCHOR — the committed artifact leaves nothing unclassified', () => {
  // Every other test here is written against a string this file chose, so all of them pass on a
  // taxonomy that has drifted away from the messages core emits. This one is written against the
  // data the app renders: if a refusal is reworded, or a gap nobody has named appears, "other"
  // grows and this names the markers instead of the count quietly moving.
  const artifact = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'src/pages/benchmark/data/results.json'), 'utf8'),
  ) as { results: FunctionResult[] };

  test('no published decline marker falls into "other"', () => {
    const unclassified = artifact.results
      .filter((r) => r.asmlift.outcome === 'declined')
      .flatMap((r) => (r.asmlift.errorMarkers ?? []).filter((m) => !DECLINE_CLASSES.some((c) => c.pattern.test(m))));
    expect(unclassified).toEqual([]);
  });

  // The other half. "other" staying empty catches a marker nobody classifies; this catches the
  // opposite failure — a class whose rows have been swallowed by one ordered above it, which moves
  // counts WITHOUT growing "other". That is the hazard this file exists for: reordering one entry
  // collapsed the largest MIPS family into the generic bucket and every class still existed.
  //
  // These have no rows for reasons that are measured and written down beside them, not because
  // something shadowed them. If a further name appears here, a class has gone dark. If one of
  // these disappears, an unnamed gap found an inhabitant — good news, and this list moves in the
  // commit that earns it, as it did when `synthetic:tax_gprel` gave `pic-globals` one.
  //
  // `cross-block-flags-arm` arrived empty on purpose: the corpus's one ARM inhabitant of that
  // subject is `kleod:LoadObjects_World2Select:agbcc`, which the same commit taught asmlift to
  // lift, so the class names what the model left over rather than what it refuses today.
  //
  // `unread-data-directive` joins it for a THIRD reason, and the two sitting side by side is why
  // this note exists. `cross-block-flags-arm` is a MODEL GAP left over — a subject asmlift still
  // cannot reach, whose one inhabitant happened to be lifted. `unread-data-directive` is empty
  // because of what the benchmark SELECTS: its two refusals fire on a whole-word pool load of a
  // label the `.word` pass recorded no words for, and on that label used as a register base, and
  // no COMPILER emits either — agbcc's pools are `.word` and it reaches a halfword table through
  // its ADDRESS, which lifts. Hand-written asm does emit it, four times over two `.ascii` labels
  // in `pokeemerald/src/libgcnmultiboot.s`, and every benchmark row is a compiled function. So
  // this class can be inhabited without the ISA changing, and saying otherwise would invite the
  // refusals to be treated as dead code.
  //
  // `pool-word-shape` is a FOURTH reason and the only one of the four that is an achievement. It
  // is the catch-all tail of the pool-word reader, it held exactly one row —
  // `pokeemerald:UpdateShoalTideFlag:agbcc`, on a pool word spelled `tide.3` — and the message it
  // held that row with was false about its own input: `tide.3` IS a symbol, a function-scope
  // static, rejected only because a C identifier carries no dot. Naming that shape sent the row to
  // `tu-scoped-name`, where the five mwcc rows spelling the same thing `sprHideTbl$797` already
  // live, and emptied the catch-all. Its emptiness is the weak kind: an agbcc pool word that is a
  // `.L` code label or an unreadable expression would inhabit it tomorrow.
  //
  // The count in the test's name is DERIVED from this list. A literal there is prose wearing a
  // test's clothing: it is checked by nothing, so a list of five under a name saying four stays
  // green. Two branches edited this line from opposite directions in one night; do not write a
  // number here again.

  const NO_ROWS = [
    'branch-form',
    'branch-likely',
    'cross-block-flags-arm',
    'pool-word-shape',
    'store-class',
    'unread-data-directive',
  ];

  test(`every other class is inhabited, and exactly these ${NO_ROWS.length} are not`, () => {
    const exhibited = new Set(artifact.results.flatMap((r) => declineClassesOf(r)));
    expect(
      DECLINE_CLASSES.map((c) => c.key)
        .filter((k) => !exhibited.has(k))
        .sort(),
    ).toEqual(NO_ROWS);
  });

  // The two tests above catch TOTAL shadowing — a class emptied, or a marker nobody claims. They
  // do not catch a PARTIAL swallow, where both classes keep rows and only the counts move, which
  // is the more likely regression and the one with no symptom. Every published marker matched by
  // more than one class is listed here with the key that wins, so a new overlap is a review
  // question rather than a silent re-attribution. Read `a > b` as "a is listed above b, and a is
  // the answer".
  //
  // `float > opaque-ops` is the big one and is the reason the file is ordered at all: `opaque-ops`
  // has no mnemonic filter, so it subsumes every named instruction family. The two transfer pairs
  // are the three control-transfer capabilities sitting above `branch-form`.
  //
  // `tu-scoped-name > pool-word-shape` is the same shape one level down: `pool-word-shape` is the
  // pool reader's catch-all and its pattern is that reader's own SENTENCE PREFIX, so every named
  // pool gap overlaps it by construction and is answered by sitting above it. Splitting a message
  // out of that catch-all therefore always adds a line here, and that is the intended signal.
  const OVERLAPS: [chain: string, markers: number][] = [
    ['float > opaque-ops', 56],
    ['float > store-class', 13],
    ['indirect-call > branch-form', 10],
    ['ctr-transfer > branch-form', 3],
    ['outgoing-stack-args > stack-frames', 2],
    ['tu-scoped-name > pool-word-shape', 1],
    ['address-taken-local > stack-frames', 1],
  ];

  test('every marker that more than one class matches is attributed by a listed ordering', () => {
    const seen = new Map<string, number>();
    for (const r of artifact.results) {
      if (r.asmlift.outcome !== 'declined') {
        continue;
      }
      for (const m of r.asmlift.errorMarkers ?? []) {
        const all = DECLINE_CLASSES.filter((c) => c.pattern.test(m)).map((c) => c.key);
        if (all.length > 1) {
          const chain = all.join(' > ');
          seen.set(chain, (seen.get(chain) ?? 0) + 1);
        }
      }
    }
    expect([...seen.entries()].sort((a, b) => b[1] - a[1])).toEqual(OVERLAPS);
  });
});

describe('the list is well-formed', () => {
  test('keys are unique', () => {
    const keys = DECLINE_CLASSES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('no pattern carries the global flag', () => {
    // A `/g` RegExp reused across `.test()` calls advances `lastIndex` and returns alternating
    // answers — the classifier calls each pattern once per marker, so this would be nondeterministic.
    expect(DECLINE_CLASSES.filter((c) => c.pattern.global)).toEqual([]);
  });

  test('an unrecognised reason is preserved as "other", never dropped', () => {
    expect(classOf('structure: something nobody has classified yet')).toBe('other');
  });
});

describe('a class may not outlive the message it classifies', () => {
  // Every class here is a prose dependency on a message core emits, and the repo's wide
  // citation-anchor gate covers `packages/core`, `packages/cli`, `docs` and `apps/benchmark/src` —
  // not `apps/web`. So a reworded refusal reaches "other" and the artifact anchor fires, but only
  // once the artifact is regenerated; this fires on the next test run.
  //
  // One entry per class, naming the phrase the classifier keys on and the file that emits it. It
  // is deliberately not the whole pattern: an alternative is here when it is the only thing
  // standing between its class and "other", or when a reviewer would want to know it moved.
  //
  // THE CHECK RUNS AGAINST CODE, NOT AGAINST PROSE (`codeOf`), and the file each entry names is
  // the one that THROWS the phrase: `float` keys on `l3/ast.ts`'s `gapReasonFor`, not on the
  // `frontend/opaque.ts` comments that quote it. Pinned to a file that only talks about it, a
  // reworded `gapReasonFor` sends `float` and `opaque-ops` — 82 of 307 declines — into "other"
  // with this list green.
  //
  // FREEZING 65 PHRASES ACROSS 12 FILES HAS A RELEASE VALVE, and it is the same one `NO_ROWS`
  // carries: a red line here is an instruction, not a veto. If core reworded the message on
  // purpose, reword the pattern and the entry in that commit; the point is that the two move
  // together and that the second app hears about it.
  const SPELT_BY: [key: string, phrase: string, file: string][] = [
    ['address-taken-local', 'address-taken stack local', 'packages/core/src/frontend/thumb.ts'],
    ['address-taken-local', 'address of a stack local is', 'packages/core/src/frontend/thumb.ts'],
    ['outgoing-stack-args', 'outgoing stack-argument', 'packages/core/src/frontend/stackargs.ts'],
    ['unstored-slot', 'never stores it', 'packages/core/src/frontend/ssa.ts'],
    ['unstored-slot', 'was never stored', 'packages/core/src/frontend/mips.ts'],
    ['stack-frames', 'local stack frames not supported', 'packages/core/src/frontend/mips.ts'],
    ['stack-frames', 'stack pointer used as data', 'packages/core/src/frontend/thumb.ts'],
    ['address-taken-local', 'address-taken local / frame arithmetic', 'packages/core/src/frontend/ppc.ts'],
    ['address-taken-local', 'address-taken local / frame arithmetic', 'packages/core/src/frontend/mips.ts'],
    ['stack-frames', 'reload of a stack local', 'packages/core/src/frontend/ppc.ts'],
    ['stack-frames', 'sub-word stack-frame', 'packages/core/src/frontend/ppc.ts'],
    ['stack-frames', 'spill of a live value', 'packages/core/src/frontend/ppc.ts'],
    ['cross-block-cr', 'no reaching compare (', 'packages/core/src/frontend/ppc.ts'],
    ['cross-block-flags-arm', 'no reaching compare: ', 'packages/core/src/frontend/thumb.ts'],
    ['cross-block-flags-arm', 'no compare crosses the edge into ', 'packages/core/src/frontend/thumb.ts'],
    ['cross-block-flags-arm', 'no compare crosses the edges into ', 'packages/core/src/frontend/thumb.ts'],
    ['branch-likely', "branch-likely '", 'packages/core/src/frontend/mips.ts'],
    ['branch-likely', 'cannot annul its delay slot', 'packages/core/src/frontend/mips.ts'],
    ['branch-likely', 'lands on its delay slot', 'packages/core/src/frontend/mips.ts'],
    ['fp-cond-branch', 'floating-point condition-code branch', 'packages/core/src/frontend/mips.ts'],
    ['mips-calls', 'MIPS calls not yet modelled', 'packages/core/src/frontend/mips.ts'],
    ['pic-globals', 'gp used as data (PIC / small-data global access)', 'packages/core/src/frontend/mips.ts'],
    ['pic-globals', 'small-data / PIC data access', 'packages/core/src/frontend/splat.ts'],
    ['pic-globals', 'non-register memory base', 'packages/core/src/frontend/ppc.ts'],
    ['pic-globals', 'SDA/global-relative access not supported', 'packages/core/src/frontend/ppc.ts'],
    ['pic-globals', 'carries a small-data relocation', 'packages/core/src/frontend/ppc.ts'],
    ['store-class', 'unmodelled store-class', 'packages/core/src/frontend/opaque.ts'],
    ['float', 'unmodelled instruction', 'packages/core/src/l3/ast.ts'],
    ['runtime-helper', 'no model for the runtime helper', 'packages/core/src/l3/ast.ts'],
    ['wide-call-arg', 'half of a 64-bit value', 'packages/core/src/frontend/thumb.ts'],
    ['opaque-ops', 'unmodelled effect instruction', 'packages/core/src/frontend/opaque.ts'],
    ['opaque-ops', 'no lowering for op', 'packages/core/src/structure/structure.ts'],
    ['loop-shapes', 'unrecovered back-edge', 'packages/core/src/structure/structure.ts'],
    ['loop-shapes', 'loop-recovery declined', 'packages/core/src/structure/structure.ts'],
    ['loop-shapes', 'pre-update loop variable', 'packages/core/src/structure/structure.ts'],
    ['loop-exit-values', 'post-loop read reaches a temp', 'packages/core/src/structure/structure.ts'],
    ['loop-exit-values', 'do not reproduce on a zero-trip run', 'packages/core/src/structure/structure.ts'],
    ['switch-shapes', 'case arms do not linearize', 'packages/core/src/structure/structure.ts'],
    ['switch-shapes', 'jump-table target is not a block boundary', 'packages/core/src/frontend/ppc.ts'],
    ['switch-shapes', 'a case body reaches', 'packages/core/src/structure/switch-recover.ts'],
    ['switch-shapes', 'jump-table cases share a target block', 'packages/core/src/structure/structure.ts'],
    ['switch-shapes', 'a jump-table case runs on into the next case', 'packages/core/src/structure/structure.ts'],
    [
      'switch-shapes',
      'through into an arm that is not the next one emitted',
      'packages/core/src/structure/structure.ts',
    ],
    ['switch-shapes', 'takes a value from the switch edge', 'packages/core/src/structure/structure.ts'],
    ['structs', 'cannot recover struct', 'packages/core/src/raise/structs.ts'],
    ['structs', 'naturally aligned', 'packages/core/src/raise/structs.ts'],
    ['structs', 'overlapping fields', 'packages/core/src/raise/structs.ts'],
    ['unread-data-directive', 'does not read as words', 'packages/core/src/frontend/thumb.ts'],
    ['pooled-literal', 'anonymous constant pool entry', 'packages/core/src/frontend/reloc-symbol.ts'],
    ['tu-scoped-name', 'function-scope static', 'packages/core/src/frontend/reloc-symbol.ts'],
    ['cxx-symbol', 'C++ class-scoped symbol', 'packages/core/src/frontend/reloc-symbol.ts'],
    ['cxx-symbol', 'C++ virtual table', 'packages/core/src/frontend/reloc-symbol.ts'],
    ['section-label', 'section-relative label', 'packages/core/src/frontend/reloc-symbol.ts'],
    ['pool-word-shape', 'literal-pool load of', 'packages/core/src/frontend/thumb.ts'],
    ['reloc-halves', 'high half of', 'packages/core/src/frontend/high-half.ts'],
    ['reloc-halves', 'not a modelled consumer of it', 'packages/core/src/frontend/mips.ts'],
    ['reloc-halves', 'loads the high half', 'packages/core/src/frontend/mips.ts'],
    ['reloc-halves', 'carries a data relocation', 'packages/core/src/frontend/ppc.ts'],
    ['reloc-halves', "carries the '@l' half", 'packages/core/src/frontend/ppc.ts'],
    ['reloc-halves', "carries the '@ha' half", 'packages/core/src/frontend/ppc.ts'],
    ['no-prototype-args', 'has no prototype', 'packages/core/src/frontend/ppc.ts'],
    ['clobbered-value', 'is read on a path where a call has destroyed it', 'packages/core/src/frontend/ssa.ts'],
    ['indirect-call', 'an indirect call', 'packages/core/src/frontend/ppc.ts'],
    ['ctr-transfer', 'CTR-counted loop', 'packages/core/src/frontend/ppc.ts'],
    ['ctr-transfer', "without a reaching 'mtctr'", 'packages/core/src/frontend/ppc.ts'],
    ['ctr-transfer', 'clobbers CTR', 'packages/core/src/frontend/ppc.ts'],
    ['block-boundary', 'not a block boundary', 'packages/core/src/frontend/mips.ts'],
    ['branch-form', 'unmodelled control transfer', 'packages/core/src/frontend/mips.ts'],
    ['branch-form', 'not a modelled branch form', 'packages/core/src/frontend/mips.ts'],
  ];

  test.each(SPELT_BY)('%s keys on "%s", which %s still emits', (_key, phrase, file) => {
    expect(codeOf(file)).toContain(phrase);
  });

  test('every class is pinned — a new class arrives with its producer named', () => {
    const pinned = new Set(SPELT_BY.map(([key]) => key));
    expect(DECLINE_CLASSES.map((c) => c.key).filter((k) => !pinned.has(k))).toEqual([]);
  });

  test('…and every pin names a class that exists', () => {
    const keys = new Set(DECLINE_CLASSES.map((c) => c.key));
    expect([...new Set(SPELT_BY.map(([key]) => key))].filter((k) => !keys.has(k))).toEqual([]);
  });
});

describe('the classifier is measured against the messages core can throw, not only against the corpus', () => {
  // THE ANCHOR ABOVE IS BOUNDED BY THE CORPUS. It proves the artifact leaves nothing unclassified,
  // which is a claim about 307 declined rows — not about asmlift. These three gates are the other
  // denominator: every decline message `packages/core/src` CAN throw, harvested from the throw
  // sites themselves. The residue they measure is the honest one, and the file's header paragraph
  // names it by file — a paragraph of figures about 123 distinct messages across 11 files, which
  // nothing but this can hold to them.

  test('the harvest finds the decline sites, so a null result here would be the probe failing', () => {
    // Without this, deleting the walk would make every gate below vacuously pass.
    expect(CORE_TEMPLATES.length).toBeGreaterThan(100);
    expect(new Set(CORE_TEMPLATES.map((t) => t.file)).size).toBeGreaterThan(8);
  });

  // The count the header paragraph publishes. It is a RESIDUE and not a defect — some of these are
  // input errors rather than capability gaps (`disasm.ts` "symbol not found", `format.ts`'s
  // frontend mismatch), and the rest are gaps nothing in the corpus has reached, which is why they
  // are named in prose rather than given classes with no inhabitant. What this gate buys is that
  // the paragraph cannot drift: move a family into a class and this goes red with the new number.
  const RESIDUE_BY_FILE: [file: string, count: number][] = [
    ['frontend/thumb.ts', 27],
    ['structure/structure.ts', 16],
    ['frontend/mips.ts', 9],
    ['frontend/splat.ts', 8],
    ['frontend/disasm.ts', 7],
    ['frontend/ppc.ts', 3],
    ['frontend/format.ts', 1],
    ['pipeline.ts', 1],
  ];
  const RESIDUE_TOTAL = 72;

  test('the residue the header paragraph names is the residue that is there', () => {
    const unclassified = [...new Set(CORE_TEMPLATES.map((t) => t.text))].filter((t) => classOfText(t) === 'other');
    const byFile = new Map<string, number>();
    for (const t of unclassified) {
      const file = CORE_TEMPLATES.find((x) => x.text === t)!.file;
      byFile.set(file, (byFile.get(file) ?? 0) + 1);
    }
    expect({
      total: unclassified.length,
      byFile: [...byFile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    }).toEqual({ total: RESIDUE_TOTAL, byFile: RESIDUE_BY_FILE });
  });

  // AN ALTERNATIVE NOTHING CAN REACH IS INERT, and the file refuses those by name — but it refused
  // them by reading, and reading is how four of `float`'s alternatives survived a commit that was
  // about `float`. This is the mechanical version: a class earns its place by matching a message
  // core actually throws.
  //
  // `float` cannot be checked this way and is the only one that cannot: every alternative in it is
  // a MNEMONIC, which is an interpolation, and the harvest replaces an interpolation with a
  // placeholder. Its alternatives are pinned by hand at the top of this file, one test per
  // mnemonic family, which is what caught the four inert ones.
  const NOT_IN_TEMPLATES: Record<string, string> = {
    float: 'every alternative is a mnemonic, which the harvest replaces with a placeholder',
    // These five are BUILT by a helper and RETURNED, then interpolated into a throw elsewhere, so
    // the throw site carries a placeholder where the phrase is. `reloc-symbol.ts`'s
    // `unspellableReason` returns four of them and `thumb.ts`'s `analyzeOutgoingArgs` the fifth.
    // Each is pinned above against a published marker instead.
    'outgoing-stack-args': "thumb.ts's outgoing-argument analysis returns the reason; the throw interpolates it",
    'pooled-literal': "reloc-symbol.ts's unspellableReason returns the reason; the throw interpolates it",
    'tu-scoped-name': "reloc-symbol.ts's unspellableReason returns the reason; the throw interpolates it",
    'cxx-symbol': "reloc-symbol.ts's unspellableReason returns the reason; the throw interpolates it",
    'section-label': "reloc-symbol.ts's unspellableReason returns the reason; the throw interpolates it",
    // Same shape one level in: thumb.ts's reaching-compare throw interpolates its REASON, and the
    // class keys on one reason rather than on the headline — deliberately, because the headline
    // is shared with a different capability (flags written by arithmetic or a call). Both halves
    // are pinned above, and the shapes themselves are pinned in `thumb-frontend.test.ts`.
    'cross-block-flags-arm': 'thumb.ts interpolates the reason, and the class keys on the reason',
    // Same shape, one layer down: `l3/ast.ts`'s `gapReasonFor` builds this one and `structure.ts`
    // writes it into a marker, which `pipeline.ts` then interpolates into its throw. Pinned by hand
    // in `SPELT_BY` against the file that spells it, as `opaque-ops`'s sibling phrase is.
    'runtime-helper': "l3/ast.ts's gapReasonFor builds the reason; the throw interpolates it",
  };

  test('every class matches a message core can throw', () => {
    const unreachable = DECLINE_CLASSES.filter(
      (c) => !(c.key in NOT_IN_TEMPLATES) && !CORE_TEMPLATES.some((t) => c.pattern.test(t.text)),
    ).map((c) => c.key);
    expect(unreachable).toEqual([]);
  });

  test('…and every listed exception is a class that exists', () => {
    const keys = new Set(DECLINE_CLASSES.map((c) => c.key));
    expect(Object.keys(NOT_IN_TEMPLATES).filter((k) => !keys.has(k))).toEqual([]);
  });

  // THE OVERLAP TABLE ABOVE IS ALSO BOUNDED BY THE CORPUS, and its blind spot is stated wrongly in
  // `declines.ts` today: `switch-shapes` and `block-boundary` DO overlap — "jump-table target is
  // not a block boundary" is a strict superstring of "not a block boundary" — and the artifact
  // cannot see it, because its one `switch-shapes` row declines on a different spelling. This is
  // the same table taken over core's messages instead, so an ordering dependency exists here
  // whether or not a row has ever printed it. Read `a > b` as "a is listed above b, and a wins".
  const TEMPLATE_OVERLAPS: string[] = [
    // thumb.ts's one sp-as-data throw: the `why` naming an address-taken local also carries the
    // phrase `stack-frames` keys on, and first-match is what decides it.
    'address-taken-local > stack-frames',
    // ppc.ts's branch denylist is one throw with two arms, so the harvested template holds BOTH
    // arms' prose and matches all three transfer classes at once. No published marker does — a row
    // prints one arm — which is why the artifact table lists the two pairs separately.
    'indirect-call > ctr-transfer > branch-form',
    // The one no published marker can show. `jump-table target is not a block boundary` is a
    // strict superstring of `not a block boundary`, so ppc.ts's recovered-dispatch refusal matches
    // both, and `switch-shapes` wins only because it is listed first. The artifact cannot show it:
    // its single `switch-shapes` row declines on `the jump table's case arms do not linearize`.
    'switch-shapes > block-boundary',
  ];

  test('every core message more than one class matches is attributed by a listed ordering', () => {
    const chains = new Set<string>();
    for (const t of CORE_TEMPLATES) {
      const all = DECLINE_CLASSES.filter((c) => c.pattern.test(t.text)).map((c) => c.key);
      if (all.length > 1) {
        chains.add(all.join(' > '));
      }
    }
    expect([...chains].sort()).toEqual(TEMPLATE_OVERLAPS);
  });
});
