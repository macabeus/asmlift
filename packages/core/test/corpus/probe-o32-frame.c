/* O32 frame-layout probe for `TargetDescription.compilerBehaviors.o32LocalArea`: where a MIPS
 * compiler keeps an address-taken local in the one frame `addiu sp,sp,-N` reserves, beside the
 * outgoing area (the 16-byte home of a0..a3, then the stack words a call takes), the saved
 * registers and the spill temps. Each function takes its local's address, so the `addiu aX,sp,K`
 * (or `addu rD,sp,rX`) that names it reads the local's offset straight off the object.
 *
 * `in9` is the incoming half: argument word k >= 4 sits at entry sp + 4k, so a function that
 * pushed N bytes reads its ninth argument at N + 32.
 *
 * `twice` and `owns` are `compilerBehaviors.localsAboveOutgoingArea`: the caller never reads its
 * outgoing area back after a call — it stages an unchanged argument again before the second call —
 * because the callee owns those words (`owns` assigns to its own fifth parameter in place on IDO).
 *
 * Compiled by `scripts/regen-o32-frame-probes.ts` for ido7.1, gcc2.7.2kmc and gcc2.7.2 — flags
 * and objdump command are in each generated `*-o32frame.txt` header. Read by
 * `packages/core/test/o32-frame-probes.test.ts`. Regenerate with:
 *
 *   npx tsx scripts/regen-o32-frame-probes.ts
 */
void fill(int *p);
int g1(int);
int h5(int, int, int, int, int);

/* no call, so no outgoing area */
int leafarr(int i) { int a[4]; a[0] = 1; a[1] = 2; a[2] = 3; a[3] = 4; return a[i]; }

/* a call that takes no stack word: the outgoing area is the home of a0..a3, [0,16) */
int callarr(void) { int a[4]; fill(a); return a[0] + a[3]; }

/* a call that takes one stack word: the outgoing area is [0,20) */
int out5arr(int x) { int a[3]; fill(a); return h5(1, 2, 3, 4, x) + a[0]; }

/* a value live across a call beside the local: where the compiler puts the spill temp */
int spillarr(int x, int y) { int a[3]; int r = g1(x); fill(a); return a[0] + r + g1(y) + y; }

/* the same fifth argument staged for two calls */
int twice(int x) { return h5(1, 2, 3, 4, x) + h5(1, 2, 3, 4, x); }

/* a callee assigning to its own stack parameter */
int owns(int a, int b, int c, int d, int e) { e = e + a; g1(e); return e + b; }

/* incoming stack arguments, read after the frame is pushed */
int in9(int a, int b, int c, int d, int e, int f, int g, int h, int i) { if (a) return g1(i) + e; return b; }
