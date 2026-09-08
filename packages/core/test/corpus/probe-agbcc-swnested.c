/* WHAT PRE5's DECLINE PRODUCES ON A NESTED TREE — the shape behind switch-recover.ts PRE5's
 * "WHAT THE DECLINE PRODUCES" paragraph.
 *
 * `recognizeSwitch` runs on the whole comparison tree and then again on the sub-trees a decline
 * leaves behind. Here the OUTER tree interleaves (the `x == 98` arm's body sits between the tests),
 * so PRE5 declines it; recovery then runs again on the `switch`'s own sub-tree, which does NOT
 * interleave, and part of it comes back as a `switch`. The emitted C is therefore an `if` nest
 * around a `switch` over a STRICT SUBSET of the source's case labels, not a clean ladder.
 * Behaviourally identical either way; the point of the fixture is that the fragment is what a
 * reader should expect.
 *
 * Regenerate with: npx tsx scripts/regen-switch-spelling-probes.ts
 */
void f(s32 x, s32 *p)
{
    if (x == 99) {
        p[0] = 1;
        p[1] = 2;
        p[2] = 3;
        p[3] = 4;
    } else if (x == 98) {
        p[5] = 9;
    } else {
        switch (x) {
        case 6:
            p[0] = 1;
            p[1] = 2;
            p[2] = 3;
            p[3] = 4;
            break;
        case 7:
            p[1] = 5;
            break;
        case 8:
            p[1] = 6;
            break;
        case 9:
            p[1] = 7;
            break;
        }
    }
}
