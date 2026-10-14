/* mwcc frame-layout probe for `TargetDescription.compilerBehaviors.linkageLocalArea`: where a
 * CodeWarrior build keeps an address-taken local in the one frame `stwu r1,-N(r1)` reserves, beside
 * the linkage (the back chain at 0 and the callee's link-register save word at 4), the outgoing
 * stack words a call takes from 8, and the saved registers at the top. Each function takes its
 * local's address, so the `addi rX,r1,K` that names it reads the local's offset straight off the
 * object.
 *
 * `in9` and `in10` are the incoming half: integer argument word k >= 8 sits at entry r1 + 8 + 4(k-8),
 * so a function that pushed N bytes reads its ninth argument at N + 8.
 *
 * `twice9` stages one ninth argument for two calls: the caller writes it again before the second.
 *
 * Compiled by `scripts/regen-mwcc-frame-probes.ts` for mwcc_242_81 (at its canonical flags and at
 * Mario Party 4's), mwcc_233_163n (Pikmin's, in C) and mwcc_247_107 (Mario Party 4's) — flags and
 * objdump command are in each generated `*-frame.txt` header. Read by
 * `packages/core/test/mwcc-frame-probes.test.ts`. Regenerate with:
 *
 *   npx tsx scripts/regen-mwcc-frame-probes.ts
 */
void fill(int *p);
int g1(int);
int h9(int, int, int, int, int, int, int, int, int);
int h10(int, int, int, int, int, int, int, int, int, int);

/* no call, but a frame all the same */
int leafarr(int i) { int a[4]; a[0] = 1; a[1] = 2; a[2] = 3; a[3] = 4; return a[i]; }

/* a call that takes no stack word */
int callarr(void) { int a[4]; fill(a); return a[0] + a[3]; }

/* a call that takes one stack word, [8,12) */
int out9arr(int x) { int a[3]; fill(a); return h9(1, 2, 3, 4, 5, 6, 7, 8, x) + a[0]; }

/* a call that takes two stack words, [8,16) */
int out10arr(int x) { int a[3]; fill(a); return h10(1, 2, 3, 4, 5, 6, 7, 8, x, x) + a[0]; }

/* calls of different widths: the widest one sizes the outgoing area */
int mixout(int x) { int a[2]; fill(a); g1(a[1]); return h9(1, 2, 3, 4, 5, 6, 7, 8, x) + a[0]; }

/* values live across calls beside the local, so the prologue saves registers */
int spillarr(int x, int y) { int a[3]; int r = g1(x); fill(a); return a[0] + r + g1(y) + y; }

/* the same ninth argument staged for two calls */
int twice9(int x) { return h9(1, 2, 3, 4, 5, 6, 7, 8, x) + h9(1, 2, 3, 4, 5, 6, 7, 8, x); }

/* incoming stack arguments */
int in9(int a, int b, int c, int d, int e, int f, int g, int h, int i) { if (a) return g1(i) + e; return b; }
int in10(int a, int b, int c, int d, int e, int f, int g, int h, int i, int j) { return i - j; }
