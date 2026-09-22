// The decline classifier is FIRST-MATCH over an ordered list, and its ORDER is the whole product:
// it decides which missing capability the blocker Pareto tells the next round to build. Nothing
// tested it, and reordering one entry silently collapsed the largest MIPS family into the generic
// bucket — the classes still all existed, the counts just moved. These pin the orderings that
// actually overlap.
import type { FunctionResult } from '@asmlift/bench-schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { DECLINE_CLASSES, declineClassesOf } from '../src/pages/benchmark/lib/declines';

const ROOT = join(import.meta.dirname, '..', '..', '..');

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
  // spelling and nothing mwcc emits for a `float`. These seven markers were published as generic
  // opaque instructions in the committed artifact — five synthetic rows plus two real ac-decomp
  // functions — which is a floating-point gap reported as "we do not know what blocks these".
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
  // The frontend and the structurer word this differently, and a spelling nobody matched fell into
  // "other" — which reads as "we do not know what blocks these" when in fact we do.
  test.each([
    ["structure: unmodelled instruction 'mtc1'", 'float'],
    ["lift: unmodelled effect instruction 'mtc1' — no register destination to degrade", 'float'],
    ["lift: unmodelled store-class instruction 'swc1' — a memory write cannot be skipped", 'store-class'],
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
  // split: a transfer named by neither class stays in the `branch-form` residue.
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
    [
      "lift: cannot lift 'f': unmodelled control transfer 'bltzall' at 0x0 — not a modelled branch form",
      'branch-form',
    ],
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
      'ctr-loop',
    ],
    [
      "lift: cannot lift 'mem_clear': branch to 0x30 is not a block boundary (out-of-range / mid-instruction " +
        'target — tail branch or unrecovered control flow)',
      'block-boundary',
    ],
    [
      "lift: cannot lift 'f': unmodelled control transfer 'bltzall' at 0x0 — not a modelled branch form",
      'branch-form',
    ],
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
    // `switch-shapes` used to match the bare word `fall-through`. This is `frontend/ppc.ts`'s
    // generic conditional-branch refusal; there is no switch anywhere in it.
    [
      "lift: cannot lift 'f': conditional branch 'bge' at 0x20 has a target/fall-through that is not a block " +
        'boundary (tail branch or unrecovered control flow)',
      'block-boundary',
    ],
    // …and its recovered-dispatch refusal says BOTH "jump-table" and "not a block boundary", so
    // the two classes have to be told apart by phrase, not by which one is listed first.
    ["lift: cannot lift 'f': jump-table target is not a block boundary", 'switch-shapes'],
    // `branch-form` (then `control-flow`) used to match the bare words `indirect` and `computed`.
    // This is an address-taken-local refusal and a published marker of `sa3:ProcessOamBuffers`.
    [
      "lift: cannot lift 'ProcessOamBuffers': stack pointer used as data — the address of a stack local is " +
        'computed (`add r0, sp, #0x4`) — only a plain `mov rD, sp` capture is modelled',
      'address-taken-local',
    ],
  ])('%s -> %s', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });

  // These two are not misfiled any more; they are unnamed, which is the honest answer and the one
  // the residue list at the top of `declines.ts` records. A backend has no place in a lifting-gap
  // taxonomy at all, and a loop-naming refusal is not control flow.
  test.each([
    ['backend: pascal backend: switch fall-through has no faithful IDO Pascal case-of spelling'],
    [
      "structure: cannot structure 'f': a pre-update exit copy would rebuild a computed value inside a loop " +
        "nested in another loop's post-loop naming",
    ],
  ])('%s is unclassified rather than misfiled', (marker) => {
    expect(classOf(marker)).toBe('other');
  });
});

describe('a slot that is never written is not a frame the lifter cannot model', () => {
  // `stack-frames` and `uninit-local` are both about an sp slot and only their ORDER tells them
  // apart. The frontends spell the same refusal two ways, one per reading site.
  test.each([
    [
      "lift: cannot lift 'uninit_join': sp@4 is read on a path that never stores it, and lies outside this " +
        "function's frame partition (uninitialised local, or storage it does not own) — not modelled",
      'uninit-local',
    ],
    ["lift: cannot lift 'f': load from stack slot sp@8 that was never stored — not modelled", 'uninit-local'],
    ["lift: cannot lift 'f': reload of a stack local ('8(r1)') — local stack frames not supported", 'stack-frames'],
  ])('%s -> %s', (marker, want) => {
    expect(classOf(marker)).toBe(want);
  });
});

describe('a relocation refuses over the NAME or over the HALF, and they are different things to build', () => {
  // The largest gap the old taxonomy hid: 23 rows of compiler-generated names plus 12 of unpaired
  // address halves, all of them in "other". They are all relocation refusals and they are not one
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
    [
      "lift: cannot lift 'OamMalloc': literal-pool load of pool word 'gOamMallocBuffer+-0x8' is not a symbol, " +
        'symbol±offset, or number — not modelled',
      'pool-word-shape',
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
  // `sub-word data table` and `sub-word stack-frame` share a prefix and nothing else: one is table
  // data in `.rodata`, the other a frame slot. The loop pair is separated from `loop-shapes` on the
  // same reasoning — the loop IS recovered and its exit values are what refuse.
  test.each([
    [
      "lift: cannot lift 'UpdateShoalTideFlag': reads the sub-word data table 'tide.3' (.byte) — sub-word " +
        'table data is not modelled',
      'sub-word-table',
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
  // or nothing in the corpus reaches it (leave it, and say what it still guards). Both of these are
  // the third, measured on the committed artifact:
  //
  //   branch-likely  A RESIDUE. PR #226 modelled the capability — a likely branch nullifies its
  //                  delay slot, modelled by placement — and `mips.ts` :386, :642 and :647 are what
  //                  it left behind. 457 MIPS rows carry 192 likely branches across 88 functions,
  //                  and 15 of those rows also carry a computed `jr`. Not one is in a shape
  //                  `normaliseBranchLikely` refuses — a delay slot that is itself a control
  //                  transfer, a delay slot some branch targets, a likely branch inside another
  //                  transfer's slot — and not one collides with a recovered table. The population
  //                  is here; the hazard is not, and no compiler emits one.
  //   pic-globals    NOT REACHED, and reachable. 29 of 301 PPC rows read memory through a
  //                  literal-0 base over 110 sites and one of them MATCHES, so the relocated form
  //                  is lifted post-#221 and the PPC arm guards a base no relocation fills. The
  //                  MIPS arm has no row because every corpus toolchain compiles with no
  //                  small-data threshold: `-non_shared -G 0` for ido7.1,
  //                  `-mno-abicalls -fno-PIC -G 0` for gcc2.7.2kmc. That is a flag, not a limit —
  //                  a synthetic row may set its own `cflags` and three already do. With
  //                  `int gCounter; int tax_gprel(int n){ gCounter += n; return gCounter; }` and
  //                  ido7.1's canonical set at `-G 8` instead of `-G 0`, the global moves to
  //                  small data and the body becomes `lw v1,0(gp)` / `addu` / `jr ra` /
  //                  `sw v0,0(gp)`, both halves carrying `R_MIPS_GPREL16 gCounter`, which
  //                  declines with this class's message verbatim. `-KPIC -G 0` reaches the same
  //                  refusal the long way, through the GOT prologue; `-G 8` is the row to write,
  //                  because it is one token off canonical and has no second cause in it. The row
  //                  is owed; it is not impossible.
  //
  // Until it exists, the test that keeps both honest is that core still spells the refusal: a class
  // may not outlive the message it classifies.
  test.each([
    ['branch-likely', 'packages/core/src/frontend/mips.ts', "branch-likely '"],
    ['branch-likely', 'packages/core/src/frontend/mips.ts', 'cannot annul its delay slot'],
    ['branch-likely', 'packages/core/src/frontend/mips.ts', 'lands on its delay slot'],
    ['pic-globals', 'packages/core/src/frontend/mips.ts', 'gp used as data (PIC / small-data global access)'],
    ['pic-globals', 'packages/core/src/frontend/ppc.ts', 'SDA/global-relative access not supported'],
    ['pic-globals', 'packages/core/src/frontend/splat.ts', 'small-data / PIC data access'],
  ])('%s is still refused by %s', (_key, file, fragment) => {
    expect(readFileSync(join(ROOT, file), 'utf8')).toContain(fragment);
  });

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

  test('branch-likely says in its LABEL that it is a residue, because 0 rows reads as "cannot"', () => {
    // The Pareto renders the label and nothing else. A reader who finds "Branch-likely delay slots"
    // in a gap list concludes asmlift cannot lift one; it can, since #226.
    expect(DECLINE_CLASSES.find((c) => c.key === 'branch-likely')?.label).toMatch(/residual/);
  });

  test('PIC is matched as a word, so a symbol that merely contains it is not a small-data access', () => {
    expect(classOf("lift: cannot lift 'SetPICMode': unmodelled control transfer 'bltzall' at 0x0")).toBe(
      'branch-form',
    );
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
  // These three have no rows for reasons that are measured and written down beside them, not
  // because something shadowed them. If a fourth name appears here, a class has gone dark. If one
  // of these three disappears, a residue found an inhabitant or somebody wrote the `tax_gprel`
  // row — good news, and this list moves in the commit that earns it.
  const NO_ROWS = ['branch-form', 'branch-likely', 'pic-globals'];

  test('every other class is inhabited, and exactly these three are not', () => {
    const exhibited = new Set(artifact.results.flatMap((r) => declineClassesOf(r)));
    expect(
      DECLINE_CLASSES.map((c) => c.key)
        .filter((k) => !exhibited.has(k))
        .sort(),
    ).toEqual(NO_ROWS);
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
