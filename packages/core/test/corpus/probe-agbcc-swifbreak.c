/* A CASE BODY THAT BREAKS ON ONE PATH AND FALLS INTO THE NEXT CASE ON ANOTHER — the switch-scoped
 * `break;` both switch regimes now spell (switch-recover.ts `ArmExit`, structure.ts
 * `switchFrames`).
 *
 * `inloop` is the shape inside a loop, as Klonoa writes it: the `break;` must leave the SWITCH and
 * run the loop's update, never leave the loop. `loopout` leaves the switch from inside a loop the
 * case body opened, which C can only write with a `goto`, and must keep declining. `elsearm` falls
 * through from the `else` of an `if` whose `then` breaks.
 *
 * Regenerate with: npx tsx scripts/regen-switch-spelling-probes.ts
 */
extern s32 gA, gB, gC;
extern s32 gK[8];
void f(s32 x);
void g(s32 x);
void h(s32 x);
s32 p(void);
void r(s32 x);

void inloop(void)
{
    s32 i;
    for (i = 0; i < 8; i++) {
        switch (gK[i]) {
        case 1: if (i != gA && i != gB) break;
        case 2: f(i); break;
        case 3: g(i); break;
        case 4: h(i); break;
        case 5: r(i); break;
        }
    }
}

void loopout(void)
{
    s32 i = gC;
    switch (i) {
    case 0: g(i); break;
    case 1:
        while (p()) {
            if (gA) goto out;
        }
        if (gB) break;
    case 2: f(i); break;
    case 3: h(i); break;
    case 4: r(1); break;
    }
out:
    r(0);
}

void elsearm(void)
{
    s32 i = gC;
    switch (i) {
    case 0: g(i); break;
    case 1:
        if (gA) {
            h(2);
            break;
        } else {
            g(3);
        }
    case 2: f(i); break;
    case 3: h(i); break;
    case 4: r(1); break;
    }
    r(0);
}
