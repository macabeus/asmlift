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
| function-scope static   |        7 |    22 | `sprHideTbl$797`                           | **refused**                                      |
| C++ vtable              |        4 |     8 | `__vt__6System`                            | **refused**                                      |
| section-relative label  |        2 |     8 | `...bss.0`, `...data.0`                    | **refused**                                      |

- **Anonymous constant pool** `@N` — the compiler invented the name for a literal it has no
  declaration for. `@193` is not a C identifier, so minting `extern u32 @193;` would trade a clean
  decline for a syntax error. Emitting the pool's _bytes_ instead is the right long-term answer and
  is a different capability: 257 of the 362 sites take the pool's ADDRESS (`lis`/`addi`/`li`, which
  needs a `static const` object, not a literal) and the other 105 are float loads.

- **Section-relative label** `...bss.0` — denotes an offset into a section, not an object. There is
  nothing to declare.

- **Function-scope static** `name$N` — the honest spelling is to re-declare the static _inside_ the
  candidate and let mwcc re-mangle it, but `$N` is a translation-unit-wide counter the compiler
  assigned, so whether the re-mangled name lands on the same symbol is a **measurement** nobody has
  taken. Refused until someone takes it.

- **C++ vtable** `__vt__X` — no C++ source spells its own vtable; the compiler emits it from the
  class definition. It is the kind whose declaration would compile, which is exactly why it needs an
  explicit rule rather than falling through to the minter.

- **C++ mangled class scope** `statbuff__9CmdStream`, `__ct__Q26Action5ChildFv` — mwcc's mangling of
  `CmdStream::statbuff`. The C a candidate is written in cannot enter that scope to spell it.
  **Measured, not assumed:** before this rule existed, `pikmin:initSoftReset__9StdSystemFv` lifted
  correctly to `statbuff__9CmdStream = 0;` and then failed to compile, because the row's context
  declares the class member and the symbol map's knowing the mangled name suppresses the declaration
  asmlift would otherwise mint.

  The marker is mwcc's scope encoding — `__` followed by a class-name LENGTH, or its `Q<depth>`
  nesting prefix — never a double underscore alone, which would refuse ordinary C globals
  (`g_my__table`, `__initialised`). No false positive among the 230 symbols.

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
  policy. Whether a mangled callee has the same problem a mangled global does is a separate question
  with its own measurement.

## What the policy does NOT decide

A name this policy passes can still fail downstream, for a reason that is not about naming. The
recovered global is rendered at the width the asm implies, and where the project's headers give it
another type the candidate does not compile — mwcc's
`illegal implicit conversion from 'struct field_info_s *' to 'long'` on
`ac-decomp:mFI_BGDisplayListTop`, whose `g_fdinfo` is declared `mFM_fdinfo_c *`. That is the
rendered-type seam, and it is loud where it fails.

## Adding a kind

A kind earns an entry when a row **measurably** fails because of it — a compile error, a wrong
address, a refusal that names the wrong thing — not because a name looks unusual. Add the rule to
`reloc-symbol.ts`, add its spelling to the corpus table in
`packages/core/test/reloc-symbol-policy.test.ts` (which is table-driven over spellings taken from
real listings, never invented ones), and record the measurement here.
