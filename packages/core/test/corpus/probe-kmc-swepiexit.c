/* A SWITCH WHOSE MERGE IS ITS LOOP'S EXIT ONLY BY WAY OF AN EARLY RETURN. On gcc2.7.2kmc the loop's
 * early `return w` and the code after the loop meet in a shared epilogue, which is then both the
 * dispatch's post-dominator and the loop's exit, while the switch's own `break;`s go to the loop's
 * bottom test (`w++; w < 4`). An arm structured against that merge would cross the bottom test,
 * so the tree goes to if-recovery (switch-recover.ts `exitMergeSpells`) rather than failing the
 * whole function loud.
 *
 * The globals and calls of the shape it was found in are loads and stores through `q` here, so the
 * disassembly needs no relocation side table.
 *
 * Compiled by `scripts/regen-switch-spelling-probes.ts` for gcc2.7.2kmc (-O2); flags and objdump
 * command are in the generated fixture's header. Read by `packages/core/test/switch-arms.test.ts`.
 */
int epiexit(int i, int a, int b, int *q)
{
    int t, u, w;
    t = b; u = a;
    for (w = 0; w < 4; w++) {
        if (a == q[0] && b != q[2]) return w;
        switch (i + w) {
        case 17:
            q[5] = u; u = a + 55;
            if (a == q[0]) { if (i & 1) { q[5] = 41; continue; } } else { q[4] = u; }
            break;
        case 250:
            if (i & 1) { q[5] = t; } else { if (q[6]) { t = u; return t; } }
            if (t > 3) { q[5] = t; }
        case 3:
            if (a == q[0]) { q[5] = 25; } else { if (a == q[0]) { if (q[6]) break; q[1] = t; } }
            if (b != 0) { if (a > q[1]) break; q[4] = t; }
            u = a + 47;
            continue;
        default:
            if (q[6]) { q[5] = t; } else { if (u == a) { u = a + 74; break; } }
            q[1] = t;
            break;
        }
    }
    q[7] = t;
    return t + u * 3;
}
