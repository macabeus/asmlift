/* Declaration-rank probe for `TargetDescription.compilerBehaviors.spillSlotOrder`.
 *
 * Sixteen `int` locals, each assigned `n + 17*(rank+1)` so its immediate NAMES it in the object,
 * all live across a call so the allocator must home the losers in the frame. Reading
 * `<imm> -> [sp,#off]` gives the compiler's direction: does the earlier-DECLARED local take the
 * lower slot or the higher one?
 *
 * THIS IS THE REVERSED HALF: the identical body with the DECLARATION LIST reversed. Both files
 * assign in the same textual order, so anything that follows USE order is unchanged between the
 * two and only a fact about declaration rank moves.
 *
 * Compiled by `scripts/regen-declrank-probes.ts` for ido7.1, gcc2.7.2kmc and gcc2.7.2 — flags and
 * objdump command are in each generated `*-declrank-rev.txt` header, taken from
 * `@asmlift/toolchains` rather than retyped. Read by
 * `packages/core/test/spill-slot-order.test.ts`. Regenerate with:
 *
 *   npx tsx scripts/regen-declrank-probes.ts
 */
int sink(int);
int probe(int n)
{
    int q, p, o, m, l, k, j, i, h, g, f, e, d, c, b, a;
    a = n + 0x11;
    b = n + 0x22;
    c = n + 0x33;
    d = n + 0x44;
    e = n + 0x55;
    f = n + 0x66;
    g = n + 0x77;
    h = n + 0x88;
    i = n + 0x99;
    j = n + 0xaa;
    k = n + 0xbb;
    l = n + 0xcc;
    m = n + 0xdd;
    o = n + 0xee;
    p = n + 0xff;
    q = n + 0x110;
    sink(n);
    return a * b + c * d + e * f + g * h + i * j + k * l + m * o + p * q;
}
