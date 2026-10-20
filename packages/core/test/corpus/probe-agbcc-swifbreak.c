/* A CASE BODY THAT BREAKS ON ONE PATH AND FALLS INTO THE NEXT CASE ON ANOTHER — the switch-scoped
 * `break;` both switch regimes now spell (switch-recover.ts `ArmExit`, structure.ts
 * `switchFrames`).
 *
 * `inloop` is the shape inside a loop, as Klonoa writes it: the `break;` must leave the SWITCH and
 * run the loop's update, never leave the loop. `loopout` leaves the switch from inside a loop the
 * case body opened, which C can only write with a `goto`, and must keep declining. `elsearm` falls
 * through from the `else` of an `if` whose `then` breaks. `exitloop` leaves its loop from an arm
 * whose `break;` reaches that exit, the switch's own merge. `twoguards` breaks twice before it
 * falls, and `intodefault` breaks or falls into the `default:` arm. `loopleave` and `subret` are
 * loops whose dispatch reaches code past the loop or past the loop bottom: their falling arms
 * cannot take a switch `break;`, so the tree goes to if-recovery, never to a loud refusal.
 * `codebreak` and `retfall` leave a falling arm through a block of their own (code before the
 * `break;`, a `return` through the shared epilogue), and `closedbreak` is a closed arm with a
 * `break;` in its middle: each joins inside the arm rather than copying its tail.
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
void m(s32 x);

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

void exitloop(s32 *q)
{
    s32 x;
    for (;;) {
        if (gC) h(0);
        x = *q;
        switch (x) {
        case 1: if (gA) goto out;
        case 2: f(x); break;
        case 3: f(3); break;
        case 4: g(4); break;
        case 5: f(5); break;
        default: goto out;
        }
        q++;
    }
out:
    r(9);
}

void twoguards(s32 i)
{
    switch (i) {
    case 1:
        if (i == gA) break;
        h(i);
        if (i == gB) break;
        m(i);
    case 2: f(i); break;
    case 3: g(i); break;
    case 4: g(4); break;
    case 5: h(5); break;
    }
    r(0);
}

void intodefault(s32 i, s32 k)
{
    switch (k) {
    case 3: g(i); break;
    case 1: if (i == gA) break;
    default: f(i); break;
    }
    r(0);
}

s32 loopleave(s32 i, s32 a, s32 b)
{
    s32 k, t, u;
    t = b + 1; u = a;
    k = 0;
    while (k < 4) {
        k = k + 1;
        switch (i + k) {
        case 1: if (a > gB) { t = p() + u; goto out; } if (t != gC) break;
        case 3: return u;
        default: t = u * 2; break;
        }
    }
out:
    r(t);
    return t + u * 3;
}

s32 subret(s32 i, s32 a, s32 b)
{
    s32 k, t, u;
    t = b + 1; u = a;
    k = 0;
    while (k < 4) {
        k = k + 1;
        switch (i + k) {
        case 17: if (a > gB) return t;
        case 3: if (t > 3) t = u * 2; else { t = p() + u; break; }
        case 999: t = u * 2; if (a == gA && b != gC) break; t = 99;
        case 100: t = p() + u;
        case 250: if (a == gA && b != gC) u = a + 85; break;
        }
    }
    r(t);
    return t + u * 3;
}

s32 codebreak(s32 i, s32 a, s32 b)
{
    switch (i) {
    case 0: g(i); break;
    case 1: if (a) { if (b) { g(7); break; } g(1); } h(2);
    case 2: f(i); break;
    case 3: h(i); break;
    case 4: r(1); break;
    }
    r(0);
    return 0;
}

s32 retfall(s32 i, s32 a, s32 b)
{
    switch (i) {
    case 0: g(i); break;
    case 1: if (a) { if (b) return 3; g(1); } if (gA) break; h(2);
    case 2: f(i); break;
    case 3: h(i); break;
    case 4: r(1); break;
    }
    r(0);
    return 0;
}

s32 closedbreak(s32 i, s32 a, s32 b)
{
    switch (i) {
    case 0: g(i); break;
    case 1: if (a) { if (b) break; g(1); } h(2); break;
    case 2: f(i); break;
    case 3: h(i); break;
    case 4: r(1); break;
    }
    r(0);
    return 0;
}
