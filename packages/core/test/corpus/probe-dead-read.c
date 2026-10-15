/* Dead reads that survive compilation, read by packages/core/test/dead-reads.test.ts through
 * scripts/regen-dead-read-probes.ts. Every compiler measured deletes a plain read whose value
 * nothing uses, so each read here is `volatile`, and its result is never consumed: overwritten by
 * the next statement's load, or never read at all. The address plays no part, so the same reads
 * go through a literal, an extern symbol and a pointer parameter. `pairhi` and the reads after it
 * are the exceptions: reads that are NOT volatile, which a gate must leave plain. */
typedef volatile unsigned int vu32;
extern volatile int gR;

void readback(int b, short *x) {
    *(volatile int *)0x040000D8 = b;
    *(volatile int *)0x040000D8;
    x[0] = x[1] + 3;
}

void dmaburst(const void *s, void *d, int n, short *x) {
    vu32 *dmaRegs = (vu32 *)0x040000D4;
    dmaRegs[0] = (unsigned int)s;
    dmaRegs[1] = (unsigned int)d;
    dmaRegs[2] = n | 0x84000000;
    dmaRegs[2];
    x[0] = x[1] + 3;
}

void lone(short *x) {
    *(volatile unsigned short *)0x04000004;
    x[0] = x[1] + 3;
}

void sym(short *x) {
    gR;
    x[0] = x[1] + 3;
}

void param(volatile int *p, short *x) {
    *p;
    x[0] = x[1] + 3;
}

/* Not volatile: the second word of a 64-bit return, which a lift that guesses a one-word return
 * leaves unused (frontend/dead-reads.ts `held-at-word-return`). */
long long pairhi(long long *p) {
    return *p;
}

/* Not volatile either: plain reads a compiler KEEPS with nothing using them, each refused by a gate
 * of frontend/dead-reads.ts. agbcc merges two identical arms after flow has deleted the dead insns,
 * so the read the branch tested survives (`samearms`, refused only where a declaration says the
 * object is plain: `declared-plain`). O32 compilers store a copied struct, or a long long, to the
 * frame, where the lift keeps the slot as a variable and drops the store (`spilled`); KMC keeps
 * the high word's `addu` of a long long sum it then truncates (`computed`). */
extern int gPlain;

int samearms(int *q) {
    if (gPlain) *q = 1; else *q = 1;
    return 0;
}

struct Pair { int a, b; };

int spill(struct Pair *p) {
    struct Pair s = *p;
    return s.a;
}

int widesum(long long *p, int c) {
    long long v = *p;
    if (c) v += 3;
    return (int)v;
}
