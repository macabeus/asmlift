# The symbol-naming policy

A relocation hands the frontend a **linker's** name, and a linker's namespace is strictly larger
than C's. Recovering the address a relocation points at is only half of being able to use it: the
other half is deciding whether the name can be written into a candidate at all.

The failure this policy exists to prevent is the one m2c shipped as `unksp0` for years — a gap
rendered as an ordinary-looking identifier. `__vt__6System` is the sharpest case in this corpus:
`extern u32 __vt__6System;` **compiles**, so nothing downstream would ever object, and the candidate
would simply be wrong in a way that reads as right. A name that cannot be spelled must therefore be
refused _by the shape of the name_, before anything is recovered, and the refusal must say which
kind it saw.

The rules are `packages/core/src/frontend/reloc-symbol.ts` — one classifier, one sentence per
refusing kind. This page is the evidence behind them: the counts, the corpus they came from, and
the reasoning a rule is too short to carry.

## The kinds

Counted over the **230 distinct symbols** named by an `R_PPC_ADDR16_HA`, `R_PPC_ADDR16_LO` or
`R_PPC_EMB_SDA21` relocation across the benchmark's 126 GameCube rows (Animal Crossing, Mario
Party 4, Pikmin), classified by `classifyRelocSymbol` itself rather than by eye.

| kind                    | distinct | sites | example                                    | what happens                                     |
| ----------------------- | -------: | ----: | ------------------------------------------ | ------------------------------------------------ |
| plain external          |       79 |   212 | `minimumVcount`, `g_fdinfo`, `lbl_1_bss_8` | recovered; the declaration minter may declare it |
| anonymous constant pool |      129 |   362 | `@193`, `@1135`                            | **refused**                                      |
| C++ mangled class scope |        9 |    16 | `statbuff__9CmdStream`                     | **refused**                                      |
| function-scope static   |        7 |    22 | `sprHideTbl$797`                           | defined in the body, from the target's data      |
| C++ vtable              |        4 |     8 | `__vt__6System`                            | **refused**                                      |
| section-relative label  |        2 |     8 | `...bss.0`, `...data.0`                    | **refused**                                      |

- **Anonymous constant pool** `@N` — the compiler invented the name for a literal it has no
  declaration for. `@193` is not a C identifier, so minting `extern u32 @193;` would trade a clean
  decline for a syntax error. Emitting the pool's _bytes_ instead is the right long-term answer and
  is a different capability: 257 of the 362 sites take the pool's ADDRESS (`lis`/`addi`/`li`, which
  needs a `static const` object, not a literal) and the other 105 are float loads.

- **Section-relative label** `...bss.0` — denotes an offset into a section, not an object. There is
  nothing to declare.

- **Function-scope static** `name$N` (mwcc), `name.N` (agbcc) — the source DEFINED the object
  inside the function, so no declaration anywhere names it and minting an `extern` would name
  nothing. The lift defines it instead, in the function body under the source name `name`, from
  what the target carries (`frontend/local-object.ts`): the section gives the qualifier and whether
  there is an initializer (`.rodata` → `static const`, `.data` → `static` with one, bss → `static`
  without), the size gives the extent, the bytes give the initializer, and the element type comes
  from the definition's own data directives where the target is an assembler listing (agbcc's
  `.word`s are a word table), else from the function's accesses, whose loads also settle its
  signedness (`structure/local-statics.ts`). The ALIGNMENT is the target's too — agbcc's `.align`
  ahead of the label, and the record mwcc's `.comment` section keeps for every symbol (an `s64`
  records 8, an `aligned(32)` buffer 32; no section header or symbol value pins it) — and the
  definition states it in an attribute wherever it is wider than its declaration gets. What a
  declaration gets is the compiler's, declared per target in `compilerBehaviors.staticLayout`: the
  least alignment of an array, the alignment of a string-literal initializer (agbcc word-aligns
  one, so a byte array its listing wrote as `.ascii` at that alignment is initialized with a string
  literal rather than given an attribute), and whether a zero scalar keeps `.data` (agbcc) or moves
  to bss (mwcc, where one zero element in `.data` must be an array of one). A `const`
  static's address that reaches an argument, an assignment or a return is cast to the unqualified
  pointer, because mwcc does not drop the qualifier implicitly.

  Through the raising tower the IR keeps the LINKER name (`gaddr {sym="tide.3"}`): its `.` or `$`
  cannot equal a C identifier or a symbol-map name, so no pass can take a map's global `tide` for
  the static. `structure` renames the finished tree to the source name once, and refuses there
  when anything else the function names — another static, a global, a callee, a parameter or
  local — carries that name, which the block-scope static would hide. The counter's VALUE is left to
  the candidate's compiler: agbcc's assembler reduces the relocation to `.rodata`+offset, so the
  name never reaches the object, and objdiff at its defaults does not compare a local symbol's name
  (a candidate whose static is `t_seiyo_days_tbl$38` or `other_tbl$32` scores the same as `$32`).
  Its ORDER is not left to anyone: both compilers count declarations, so the counters of one
  function's statics record the order the source declared them in, which is the order the
  compiler lays them out by — and the lift declares them in that order. In bss mwcc puts the
  scalars it moved there for their `= 0` first, in that order, and lays the ones with no
  initializer out after them: reversed in `.sbss`, and in `.bss` (an object over the `-sdata`
  threshold: an array over 8 bytes, every scalar at `-sdata 0`) in the order its code first uses
  them. So the offsets also say which statics had the `= 0`, and the lift writes it — in `.bss` on
  every scalar of the leading run, since one used first with no initializer sits there too and only
  the `= 0` keeps it there in a candidate whose code uses another first. The same measurement means **no score checks the definition**: a wrong initializer, a wrong name, a wrong order and a
  wrong alignment all MATCH, and only the section and the local linkage are scored — so the
  matching suite compares the candidate's data sections with the target's byte for byte, with
  their alignment (`packages/cli/test/matching/local-statics.test.ts`).

  The definition is refused when the target does not carry it, when a relocation falls inside it
  (an initializer holding an address), when its extent or alignment cannot be read, and when
  another function names it too. The last is a static of an inlined same-unit function — agbcc
  puts `static inline counter`'s `n.3` ahead of its first caller, mwcc `-inline auto` has every
  caller address `n$4` — and re-declaring it in one of them would split one object in two. Only the functions the input
  shows can be checked: a single function's listing cannot show a second referrer, and a
  benchmark row's input ends at the row's function — the unit's earlier functions are in it (the
  mwcc side table keeps their relocations that name the row's statics), its later ones are not.

  **Block scope, not file scope**, and it is a decision rather than a measurement: both spellings
  compile to the same bytes and score 0 on both compilers. Block scope is what the source wrote and
  cannot collide with a file-scope name in a project's context; a file-scope `static` would claim
  only unit-local linkage, which is all the target shows, but collides with a same-named file-scope
  object in the unit. The block-scope claim that this function owns the object is exactly the claim
  the referrer check above tests.

- **Predefined identifier** `__FUNCTION__$2`, `__func__$1`, `__PRETTY_FUNCTION__$3` — mwcc names the
  object behind the name every function body predefines like a static of that function. A
  definition would redeclare it, so it is refused, in its own sentence. (agbcc puts the same string
  in `.LC0`, an anonymous label.)

- **Static of an inlined function** `name$localstaticN$fn` — mwcc's name for a static inside an
  inline function from a header (`_half$localstatic3$sqrtf`). It belongs to that function's
  definition, which a source reaches by calling it, so it is refused, in its own sentence.

- **C++ vtable** `__vt__X` — no C++ source spells its own vtable; the compiler emits it from the
  class definition. It is the kind whose declaration would compile, which is exactly why it needs an
  explicit rule rather than falling through to the minter.

- **C++ class scope** `statbuff__9CmdStream`, `__ct__Q26Action5ChildFv` — mwcc's mangling of
  `CmdStream::statbuff`. This one is refused for the **declaration**, not for the spelling, and the
  refusal says so.

  **Measured, not assumed:** without this rule `pikmin:initSoftReset__9StdSystemFv` lifts correctly
  to `statbuff__9CmdStream = 0;` and then fails to compile, because the row's context declares the
  class member and the symbol map's knowing the mangled name suppresses the declaration asmlift
  would otherwise mint.

  **And measured the other way,** because it is tempting to call the name itself unwritable:
  compiled in the shape the harness really uses — a C++ row's candidate inside
  the `extern "C"` block `apps/benchmark/src/compile/real.ts` wraps it in —
  `extern int statbuff__9CmdStream; int h(void){return statbuff__9CmdStream;}` emits
  `R_PPC_EMB_SDA21 statbuff__9CmdStream`: **exactly the target symbol**. So the spelling is right
  and only the declaration is missing. The route out is to decode the scope (`packages/core/src/mangle.ts`
  already demangles the function form) and mint the member declaration, or to stop the symbol map
  suppressing the mint — either is a capability with its own measurement, and until one exists the
  row is a loud decline rather than a `noncompile` about nothing.

  The marker is mwcc's scope encoding — `__` followed by a class-name LENGTH, or its `Q<depth>`
  nesting prefix — never a double underscore alone, which would refuse ordinary C globals
  (`g_my__table`, `__initialised`). No false positive among the 230 symbols.

  **Which way the rule cuts, said out loud.** The marker is the SCOPE, not the mangling. mwcc also
  mangles a FREE function's parameter list — `makeObjectBoss__Fv`, `ARAMFinish__FUl`,
  `__DspSync__FsP9OSContext` — and those are `plain`: **89** of the **24,236** distinct symbols
  named by a data relocation across the three checkouts carry a `__F…` suffix with no class scope in
  front of it. No source spells one of those either, so the "no source spells it" reading of this
  policy would refuse them. That reading is not the rule, and the measurement above is why: what the
  refusal is really about is the **declaration**, and a free function's has no class scope to be
  suppressed by. The distinction has **0 inhabitants in emitted output** — over 4,663 lifted
  functions in the same sweep, not one recovered `&NAME` carries a mangling marker — so it is
  written down rather than acted on. Two things would have to be measured before widening it: what
  the symbol map does with a name it already knows as a function, and whether a data relocation on a
  free function (its address taken into a table) wants a function POINTER rather than the object
  declaration `rank-declare` mints. Neither has been measured, and inventing an answer here is the
  failure this file exists to prevent.

- **Anything else that is not a C identifier** is refused too, so a spelling this corpus has not
  shown fails loud instead of reaching the minter.

## What is deliberately NOT refused

- **The decomp projects' generated labels** — `lbl_1_bss_2464`, `lbl_1_data_EC`, `fn_1_458`: 31
  distinct names over 96 sites, counted in the `plain` row above. They are ordinary identifiers, and
  the projects' own reference sources spell them
  (`temp_r31 = &lbl_1_bss_2468[lbl_1_bss_2464];`) — 14 of the rows carrying one do so in their own
  published reference source. The decomp project is the authority on its own names. Giving them a
  kind of their own would be a distinction with no behaviour behind it.

- **A relocation's addend.** `SLSerialNo` and `SLSerialNo+0x4` are different words of one object,
  not different names; the addend rides as the access offset.

- **`bl` call targets.** They reach the emitter by a different path and are not routed through this
  policy — and the measurement says they should not be. A callee is CALLED, never declared as an
  object, and inside the `extern "C"` block a C++ row's candidate is compiled in, the mangled name
  written verbatim is the symbol the relocation named:
  `void __ct__Q26Action5ChildFv(void); void g(void){__ct__Q26Action5ChildFv();}` emits
  `R_PPC_REL24 __ct__Q26Action5ChildFv`. (Without that block it would not: the C++ front end mangles
  the identifier a SECOND time, to `__ct__Q26Action5ChildFv__Fv`. The linkage block is what makes the
  call path correct, and `candidateLinkage` documents its own measurement of the same effect.)

## What the policy does NOT decide

**It is a NAME gate.** Two things it is not:

**Not the type.** A name this policy passes is still rendered at the width the asm implies, and
where the project's headers give it another type the candidate does not compile — mwcc's
`illegal implicit conversion from 'struct field_info_s *' to 'long'` on
`ac-decomp:mFI_BGDisplayListTop`, whose `g_fdinfo` is declared `mFM_fdinfo_c *`. That is the
rendered-type seam, and it is loud where it fails. It has a **stated cost**: two rows
(`ac-decomp:mFI_BGDisplayListTop`, `marioparty4:fn_1_12D74`) trade a decline for a `noncompile`,
taking the GameCube tier from 0 to 2. A decline and a `noncompile` are both honest; this one moves
the row to a later, more specific guard, and closing it is the rendered-type capability's job.

**Not the linkage.** `rank-declare` mints `extern u32 NAME;` for a recovered global, and 46% of the
sites the policy calls spellable name a symbol that is LOCAL in its own object (191,766 of 416,171
in Mario Party 4, 4,169 distinct). The minted `extern` asserts external linkage for an object that
has none — and asserts **nothing the reference did not already assert**, measured: compiled with
mwcc, `static int gFoo[4];` and `extern int gFoo[4];` in front of the same two functions produce the
same instructions and the same relocations, `R_PPC_ADDR16_HA gFoo` / `R_PPC_ADDR16_LO gFoo`, and the
small-data pair likewise emits `R_PPC_EMB_SDA21 gBar` either way. mwcc references a file-scope static
**by name**, so the object cannot tell the two spellings apart and neither can objdiff. The policy
therefore has nothing to decide here: what a relocation carries is a name, and the name is right.
(A file-scope static is also spelled in its own source exactly as the relocation spells it, which is
what separates it from `sprHideTbl$797`, where the `$797` is the compiler's and no source's.)

## Guards with no inhabitant

`docs/level-tower.md`'s **earn the level** governs REPRESENTATION — an opcode, a pass boundary, a
recovery — and it is why `ori`, `addic` and the `@l`-in-a-displacement form are not modelled here
although the wider corpus has thousands of sites: no benchmark row reaches them.

It does not govern REFUSALS, and the two must not be confused. A guard's job is to make a shape that
is not modelled fail loud; a guard with no inhabitant costs a branch and buys the guarantee that the
inhabitant, when it arrives, is not silently miscompiled. Nine of the refusals added with this
capability have zero inhabitants in a 29,804-function sweep of Pikmin and Mario Party 4 (`@ha`/`@l`
immediates that are not the 0 placeholder, an SDA operand that is not `0(0)`, a relocation outside
its instruction, two relocations on one instruction, a name of no known kind), and they stay.

## Adding a kind

A kind earns an entry when a row **measurably** fails because of it — a compile error, a wrong
address, a refusal that names the wrong thing — not because a name looks unusual. Add the rule to
`reloc-symbol.ts`, add its spelling to the corpus table in
`packages/core/test/reloc-symbol-policy.test.ts` (which is table-driven over spellings taken from
real listings, never invented ones), and record the measurement here.
