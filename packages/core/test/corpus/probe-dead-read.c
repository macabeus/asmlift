/* Dead reads that survive compilation, read by packages/core/test/dead-reads.test.ts through
 * scripts/regen-dead-read-probes.ts. Every compiler measured deletes a plain read whose value
 * nothing uses, so each read here is `volatile`, and its result is never consumed: overwritten by
 * the next statement's load, or never read at all. The address plays no part, so the same reads
 * go through a literal, an extern symbol and a pointer parameter. `pairhi` is the exception, a
 * read that is NOT volatile and that the lift alone leaves unused. */
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
