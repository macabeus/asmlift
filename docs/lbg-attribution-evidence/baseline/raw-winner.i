# 0 "captured-input.c"
# 0 "<built-in>"
# 0 "<command-line>"
# 1 "captured-input.c"
typedef unsigned char u8;typedef unsigned short u16;typedef unsigned int u32;typedef signed char s8;typedef short s16;typedef int s32;
struct Elem0 { s32 field_0; u8 _pad0[4]; };
struct Elem1 { u8 _pad0[16]; u16 field_16; u8 _pad1[10]; };
struct Elem10 { u8 _pad0[16]; u16 field_16; u8 _pad1[10]; };
struct Elem11 { s32 field_0; u8 _pad0[24]; };
struct Elem12 { s32 field_0; u8 _pad0[24]; };
struct Elem2 { u8 _pad0[18]; u16 field_18; u8 _pad1[8]; };
struct Elem3 { u8 _pad0[16]; u16 field_16; u8 _pad1[10]; };
struct Elem4 { u8 _pad0[16]; u16 field_16; u8 _pad1[10]; };
struct Elem5 { u8 _pad0[18]; u16 field_18; u8 _pad1[8]; };
struct Elem6 { u8 _pad0[18]; u16 field_18; u8 _pad1[8]; };
struct Elem7 { u8 _pad0[16]; u16 field_16; u8 _pad1[10]; };
struct Elem8 { u8 _pad0[18]; u16 field_18; u8 _pad1[8]; };
struct Elem9 { s32 field_0; u8 _pad0[24]; };
void LoadBGTilemapData(u32 a0, u32 a1) {
    s32 v0;
    s32 v1;
    s32 v22;
    u32 v3;
    s32 v4;
    s32 v5;
    s32 v6;
    u16 * v7;
    s32 v8;
    s32 v9;
    u32 v10;
    s32 v11;
    u32 v12;
    s32 v13;
    s32 v14;
    s32 v2;
    s32 v16;
    s32 v17;
    s32 v15;
    s32 v19;
    u32 v21;
    s32 v18;
    s32 v27;
    volatile u16 sp0;
    volatile s32 * p0;
    p0 = (s32 *)67109076;
    v0 = *(u8 *)((a1 << 1) + (a0 << 2) + 134576845);
    v1 = *(u8 *)((a1 << 1) + (a0 << 2) + 134576844);
    v2 = ((u8 *)(*(s32 *)50345120 + v0))[1];
    if (((u8 *)*(s32 *)50345120)[1] << 31 != 0 && v0 == 2) {
        v3 = 16 << v2;
        v4 = DecompressAlloc(((struct Elem0 *)135830732)[v1].field_0) + 4;
        if (0 < *(u16 *)50345082) {
            v5 = 128 << 24;
            v14 = 0;
            do {
                for (v9 = 0; v9 < *(u16 *)50345080; v9 = v9 + 1) {
                    *(u8 *)(v9 + 50351536) = *(u8 *)(v9 + *(u16 *)50345080 * v14 + v4);
                }
                for (v10 = *(u16 *)50345080; v10 < v3; v10 = v10 + 1) {
                    *(u8 *)(v10 + 50351536) = 0;
                }
                *p0 = 50351536;
                p0[1] = ((s32 *)50345008)[15] + v3 * v14;
                p0[2] = v3 >> 1 | v5;
                while ((p0[2] & 128 << 24) != 0) {
                }
                v14 = v14 + 1;
            } while (v14 < *(u16 *)50345082);
        }
        v12 = *(u16 *)50345082;
        v11 = v3 * *(u16 *)50345082 + ((s32 *)50345008)[15];
        while (v12 < v3) {
            sp0 = 0;
            *p0 = &sp0;
            p0[1] = v11;
            p0[2] = v3 >> 1 | 129 << 24;
            v11 = v11 + v3;
            v12 = v12 + 1;
        }
        thunk_HeapFree(v4 - 4);
        return;
    } else {
        v6 = DecompressAlloc(*(s32 *)((v0 - 2 << 2) + (v1 << 3) + 135830732)) + 4;
        if (v2 != 0) {
            v22 = 2;
            if (v2 == 3) v22 = 4;
        } else {
            v22 = 1;
        }
        v14 = 0;
        if (v14 < v22) {
            do {
                switch (v2) {
                    case 0:
                        if (((struct Elem1 *)50345008)[v0].field_16 <= 31) {
                            v17 = ((struct Elem1 *)50345008)[v0].field_16;
                        } else {
                            v17 = 32;
                        }
                        if ((u32)(32 - v17) > 32) {
                            v16 = 32;
                        } else {
                            v16 = 32 - v17;
                        }
                        if (((struct Elem2 *)50345008)[v0].field_18 <= 31) {
                            v15 = ((struct Elem2 *)50345008)[v0].field_18;
                        } else {
                            v15 = 32;
                        }
                        v19 = 0;
                        v18 = 0;
                        break;
                    case 1:
                        if (v14 != 0) {
                            if (((struct Elem3 *)50345008)[v0].field_16 <= 31) {
                                v17 = ((struct Elem3 *)50345008)[v0].field_16;
                            } else {
                                v17 = 32;
                            }
                        } else {
                            v17 = 32;
                        }
                        v27 = v0 << 3;
                        if (v14 != 0) {
                            if ((u32)(32 - v17) > 32) {
                                v16 = 32;
                            } else {
                                v16 = 32 - v17;
                            }
                        } else {
                            v16 = 0;
                        }
                        v7 = (u16 *)((v27 - v0 << 2) + 50345008);
                        if (v7[9] <= 31) {
                            v15 = v7[9];
                        } else {
                            v15 = 32;
                        }
                        v19 = v14 << 5;
                        v18 = 0;
                        break;
                    case 2:
                        if (((struct Elem4 *)50345008)[v0].field_16 <= 31) {
                            v17 = ((struct Elem4 *)50345008)[v0].field_16;
                        } else {
                            v17 = 32;
                        }
                        if ((u32)(32 - v17) > 32) {
                            v16 = 32;
                        } else {
                            v16 = 32 - v17;
                        }
                        if (v14 != 0) {
                            if (((struct Elem5 *)50345008)[v0].field_18 <= 31) {
                                v15 = ((struct Elem5 *)50345008)[v0].field_18;
                            } else {
                                v15 = 32;
                            }
                        } else {
                            v15 = 32;
                        }
                        v19 = 0;
                        v18 = v14 * ((struct Elem6 *)50345008)[v0].field_18;
                        break;
                    case 3:
                        if (v14 != 0) {
                            if (((struct Elem7 *)50345008)[v0].field_16 <= 31) {
                                v17 = ((struct Elem7 *)50345008)[v0].field_16;
                            } else {
                                v17 = 32;
                            }
                        } else {
                            v17 = 32;
                        }
                        if (v14 != 0) {
                            if ((u32)(32 - v17) > 32) {
                                v16 = 32;
                            } else {
                                v16 = 32 - v17;
                            }
                        } else {
                            v16 = 32;
                        }
                        if (v14 != 0) {
                            if (((struct Elem8 *)50345008)[v0].field_18 <= 31) {
                                v15 = ((struct Elem8 *)50345008)[v0].field_18;
                            } else {
                                v15 = 32;
                            }
                        } else {
                            v15 = 32;
                        }
                        v19 = -(2 & v14) >> 31 & 32;
                        v18 = (-(1 & v14) | 1 & v14) >> 31 & 32;
                        break;
                }
                v21 = 0;
                if (v21 < v15) {
                    do {
                        if (v16 != 0) {
                            sp0 = 0;
                            *p0 = &sp0;
                            p0[1] = ((struct Elem9 *)50345012)[v0].field_0 + (v21 << 6) + (v14 << 11) + (v17 << 1);
                            p0[2] = v16 | 129 << 24;
                        }
                        *p0 = v6 + (((struct Elem10 *)50345008)[v0].field_16 * (v21 + v18) << 1) + (v19 << 1);
                        p0[1] = ((struct Elem11 *)50345012)[v0].field_0 + (v21 << 6) + (v14 << 11);
                        v8 = 128 << 24;
                        p0[2] = v17 | v8;
                        if ((p0[2] & v8) != 0) {
                            do {
                            } while ((p0[2] & v8) != 0);
                        }
                        v21 = v21 + 1;
                    } while (v21 < v15);
                }
                for (v13 = v15; v13 <= 31; v13 = v13 + 1) {
                    sp0 = 0;
                    *p0 = &sp0;
                    p0[1] = ((struct Elem12 *)50345012)[v0].field_0 + (v14 << 11) + (v13 << 6);
                    p0[2] = 2164260896;
                }
                v14 = v14 + 1;
            } while (v14 < v22);
        }
        thunk_HeapFree(v6 - 4);
        return;
    }
}
