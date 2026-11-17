struct P { u32 x; u32 y; };
extern u32 gA, gB, gC, gD;
extern int gI;
extern u8 gMask;
void use(u32, int);
void rng(void);
void five(int, int, int, int, int);
void six(int, int, int, int, int, int);
void ix(int i) { u32 a[2]; int k; a[0] = gA; a[1] = gB; for (k = 0; k < 2; k++) if ((gMask >> k) & 1) use(a[k], k); rng(); }
void im1(int i) { u32 a[2]; a[0] = gA; a[1] = gB; five(1, 2, 3, a[i - 1], gC); }
void six1(int i, int j) { u32 a[3]; a[0] = gA; a[1] = gB; a[2] = gC; six(a[i], 2, 3, 4, gC, a[j]); }
void six2(int i, int j) { u32 a[3]; a[0] = gA; a[1] = gB; a[2] = gC; six(gI, 2, 3, 4, a[j], gC + a[i]); }
void six3(int i, int j) { u32 a[3]; a[0] = gA; a[1] = gB; a[2] = gC; six(gI, a[i + 1], 3, a[j - 1], gB, gA); }
void bytes(int i) { u8 b[8]; b[0] = gA; b[5] = gB; five(1, 2, 3, b[i], b[i + 2]); }
void members(int i) { struct P p[2]; p[0].x = gA; p[0].y = gB; p[1].x = gC; p[1].y = gD; five(1, 2, 3, p[i].y, gI); }
