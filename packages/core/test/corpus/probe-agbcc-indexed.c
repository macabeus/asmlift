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
int kr();
int below1(int i) { u32 a[3]; u32 *p = a - 1; a[0] = gA; a[1] = gB; a[2] = gC; return kr(1, 2, 3, 4, p[i]); }
int below2(int i) { u32 a[3]; u32 *p = &a[-1]; a[0] = gA; a[1] = gB; a[2] = gC; gI = p[i]; return kr(1, 2, 3, 4, gC); }
int below3(int i) { u32 a[3]; u32 *p = a - 1; a[0] = gA; a[1] = gB; a[2] = gC; return kr(1, 2, 3, p[i], gI); }
int below4(int i, int c) { u32 a[3]; u32 *p = a - 1; a[0] = gA; a[1] = gB; a[2] = gC; return kr(1, 2, 3, c ? p[i] : 7, gI); }
int below5(int i) { u32 a[3]; u32 *p = a - 2; a[0] = gA; a[1] = gB; a[2] = gC; return kr(1, 2, 3, 4, gI, p[i]); }
int below6(int i) { u32 a[3]; u32 *p = a - 1; a[0] = gA; a[1] = gB; a[2] = gC; kr(1, 2, 3, 4, gI); return p[i]; }
struct S12 { u32 a; u32 b; u32 c; };
int blk1(int i) { u32 w[6]; struct S12 *p = (struct S12 *)(w - 1); w[0] = gA; w[1] = gB; w[2] = gC; w[3] = gD; w[4] = gA; w[5] = gB; return kr(p[i], 3, gI); }
int blk2(int i) { u32 w[6]; struct S12 *p = (struct S12 *)(w - 2); w[0] = gA; w[1] = gB; w[2] = gC; w[3] = gD; w[4] = gA; w[5] = gB; return kr(p[i], 3, 4, gI); }
int blk3(int i) { u32 w[6]; struct S12 *p = (struct S12 *)(w - 1); w[0] = gA; w[1] = gB; w[2] = gC; w[3] = gD; w[4] = gA; w[5] = gB; return kr(1, 2, p[i], gI); }
extern u32 gE, gF, gT[64]; extern int gK; extern int (*gFp)();
int fpspill(int i, int j, int k, int l) { int x0 = gB * l, x1 = gA - l, x2 = gT[i & 63], x3 = gT[i & 63], x4 = gT[l & 63] * k, x5 = gT[l & 63] * k, x6 = gT[l & 63] * k, x7 = gA - l, x8 = gK ^ i; u32 w[8]; struct S12 *p = (struct S12 *)(w - 4); w[0] = gA; w[1] = gE; w[2] = gE; w[3] = gC; w[4] = gF; w[5] = gF; w[6] = gD; w[7] = gC; return gFp(gT[k & 63], gT[k & 63], p[i], j ? gI : gK, gT[j & 63]) + x0 + x1 + x2 + x3 + x4 + x5 + x6 + x7 + x8; }
void walk4(void) { u32 a[4]; int i; a[0] = gA; a[1] = gB; a[2] = gC; a[3] = gD; for (i = 0; i < gI; i++) use(a[i], 0); }
void walkcall(void) { u32 a[2]; int i; a[0] = gA; a[1] = gB; for (i = 0; i < gI; i++) use(a[i], i); rng(); }
void walkkr(void) { u32 a[2]; int i; a[0] = gA; a[1] = gB; for (i = 0; i < gI; i++) use(a[i], i); kr(1, 2, 3, 4, 5); }
void walkdn(void) { u32 a[2]; int i; a[0] = gA; a[1] = gB; for (i = gI; i >= 0; i--) use(a[i], i); }
void walkbelow(void) { u32 a[3]; u32 *p = a - 1; int i; a[0] = gA; a[1] = gB; a[2] = gC; for (i = 0; i < gI; i++) use(*++p, i); five(1, 2, 3, 4, gC); }
void walkbefore(void) { u32 a[2]; int i; a[0] = gA; a[1] = gB; kr(1, 2, 3, 4, gC); for (i = 0; i < gI; i++) use(a[i], i); }
