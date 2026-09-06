# 0 "captured-input.c"
# 0 "<built-in>"
# 0 "<command-line>"
# 1 "captured-input.c"
typedef unsigned char u8;typedef unsigned short u16;typedef unsigned int u32;typedef signed char s8;typedef short s16;typedef int s32;

extern u8 gBgInfo[];

extern u8 gUnk_03004DB0[];
struct Elem0 { s32 field_0; u8 _pad0[4]; };
struct Elem1 { s32 field_0; u8 _pad0[24]; };
struct Elem2 { s32 field_0; u8 _pad0[24]; };
struct Elem3 { s32 field_0; u8 _pad0[24]; };
void LoadBGTilemapData(u32 a0, u32 a1) {
    s32 v0;
    s32 v1;
    s32 v18;
    s32 v3;
    s32 v4;
    s32 v5;
    u32 v6;
    s32 v7;
    u32 v8;
    s32 v9;
    s32 v10;
    s32 v2;
    s32 v12;
    s32 v13;
    s32 v11;
    s32 v15;
    s32 v16;
    u32 v17;
    s32 v14;
    s32 v23;
    volatile u16 sp0;
    u16 * p0;
    s32 * p1;
    s32 * p2;
    v0 = *(u8 *)((a1 << 1) + (a0 << 2) + 134576845);
    v1 = *(u8 *)((a1 << 1) + (a0 << 2) + 134576844);
    v2 = ((u8 *)((*(u32 *)0x030034A0) + v0))[1];
    p0 = (u16 *)&gBgInfo;
    p1 = (s32 *)&(*(volatile u32 *)0x40000D4);
    p2 = (s32 *)&gBgInfo;
    if (((u8 *)(*(u32 *)0x030034A0))[1] << 31 != 0 && v0 == 2) {
        v3 = DecompressAlloc(((struct Elem0 *)135830732)[v1].field_0);
        v16 = 0;
        if (0 < p0[37]) {
            do {
                for (v5 = 0; v5 < p0[36]; v5 = v5 + 1) {
                    gUnk_03004DB0[v5] = *(u8 *)(v5 + p0[36] * v16 + (v3 + 4));
                }
                for (v6 = p0[36]; v6 < 16 << v2; v6 = v6 + 1) {
                    gUnk_03004DB0[v6] = 0;
                }
                *p1 = &gUnk_03004DB0;
                p1[1] = p2[15] + (16 << v2) * v16;
                p1[2] = (u32)(16 << v2) >> 1 | 128 << 24;
                while ((p1[2] & 128 << 24) != 0) {
                }
                v16 = v16 + 1;
            } while (v16 < p0[37]);
        }
        v8 = p0[37];
        v7 = (16 << v2) * p0[37] + p2[15];
        while (v8 < 16 << v2) {
            sp0 = 0;
            *p1 = &sp0;
            p1[1] = v7;
            p1[2] = (u32)(16 << v2) >> 1 | 129 << 24;
            v7 = v7 + (16 << v2);
            v8 = v8 + 1;
        }
        thunk_HeapFree(v3 + 4 - 4);
        return;
    } else {
        v4 = DecompressAlloc(*(s32 *)((v0 - 2 << 2) + (v1 << 3) + 135830732));
        if (v2 != 0) {
            v18 = 2;
            if (v2 == 3) v18 = 4;
        } else {
            v18 = 1;
        }
        v10 = 0;
        if (0 < v18) {
            do {
                switch (v2) {
                    case 0:
                        if (((u16 *)(v0 * 28 + (u32)&gBgInfo))[8] <= 31) {
                            v13 = ((u16 *)(v0 * 28 + (u32)&gBgInfo))[8];
                        } else {
                            v13 = 32;
                        }
                        if ((u32)(32 - v13) > 32) {
                            v12 = 32;
                        } else {
                            v12 = 32 - v13;
                        }
                        if (((u16 *)(v0 * 28 + (u32)&gBgInfo))[9] <= 31) {
                            v11 = ((u16 *)(v0 * 28 + (u32)&gBgInfo))[9];
                        } else {
                            v11 = 32;
                        }
                        v15 = 0;
                        v14 = 0;
                        break;
                    case 1:
                        if (v10 != 0) {
                            if (((u16 *)(v0 * 28 + (u32)&gBgInfo))[8] <= 31) {
                                v13 = ((u16 *)(v0 * 28 + (u32)&gBgInfo))[8];
                            } else {
                                v13 = 32;
                            }
                        } else {
                            v13 = 32;
                        }
                        v23 = v0 << 3;
                        if (v10 != 0) {
                            if ((u32)(32 - v13) > 32) {
                                v12 = 32;
                            } else {
                                v12 = 32 - v13;
                            }
                        } else {
                            v12 = 0;
                        }
                        if (((u16 *)((v23 - v0 << 2) + (u32)&gBgInfo))[9] <= 31) {
                            v11 = ((u16 *)((v23 - v0 << 2) + (u32)&gBgInfo))[9];
                        } else {
                            v11 = 32;
                        }
                        v15 = v10 << 5;
                        v14 = 0;
                        break;
                    case 2:
                        if (((u16 *)(v0 * 28 + (u32)&gBgInfo))[8] <= 31) {
                            v13 = ((u16 *)(v0 * 28 + (u32)&gBgInfo))[8];
                        } else {
                            v13 = 32;
                        }
                        if ((u32)(32 - v13) > 32) {
                            v12 = 32;
                        } else {
                            v12 = 32 - v13;
                        }
                        if (v10 != 0) {
                            if (((u16 *)(v0 * 28 + (u32)&gBgInfo))[9] <= 31) {
                                v11 = ((u16 *)(v0 * 28 + (u32)&gBgInfo))[9];
                            } else {
                                v11 = 32;
                            }
                        } else {
                            v11 = 32;
                        }
                        v15 = 0;
                        v14 = v10 * ((u16 *)(v0 * 28 + (u32)&gBgInfo))[9];
                        break;
                    case 3:
                        if (v10 != 0) {
                            if (((u16 *)(v0 * 28 + (u32)&gBgInfo))[8] <= 31) {
                                v13 = ((u16 *)(v0 * 28 + (u32)&gBgInfo))[8];
                            } else {
                                v13 = 32;
                            }
                        } else {
                            v13 = 32;
                        }
                        if (v10 != 0) {
                            if ((u32)(32 - v13) > 32) {
                                v12 = 32;
                            } else {
                                v12 = 32 - v13;
                            }
                        } else {
                            v12 = 32;
                        }
                        if (v10 != 0) {
                            if (((u16 *)(v0 * 28 + (u32)&gBgInfo))[9] <= 31) {
                                v11 = ((u16 *)(v0 * 28 + (u32)&gBgInfo))[9];
                            } else {
                                v11 = 32;
                            }
                        } else {
                            v11 = 32;
                        }
                        v15 = -(2 & v10) >> 31 & 32;
                        v14 = (-(1 & v10) | 1 & v10) >> 31 & 32;
                        break;
                }
                v17 = 0;
                if (v17 < v11) {
                    do {
                        if (v12 != 0) {
                            sp0 = 0;
                            *p1 = &sp0;
                            p1[1] = ((struct Elem1 *)((u32)&gBgInfo + 4))[v0].field_0 + (v17 << 6) + (v10 << 11) + (v13 << 1);
                            p1[2] = v12 | 129 << 24;
                        }
                        *p1 = v4 + 4 + (((u16 *)(v0 * 28 + (u32)&gBgInfo))[8] * (v17 + v14) << 1) + (v15 << 1);
                        p1[1] = ((struct Elem2 *)((u32)&gBgInfo + 4))[v0].field_0 + (v17 << 6) + (v10 << 11);
                        p1[2] = v13 | 128 << 24;
                        if ((p1[2] & 128 << 24) != 0) {
                            do {
                            } while ((p1[2] & 128 << 24) != 0);
                        }
                        v17 = v17 + 1;
                    } while (v17 < v11);
                }
                for (v9 = v11; v9 <= 31; v9 = v9 + 1) {
                    sp0 = 0;
                    *p1 = &sp0;
                    p1[1] = ((struct Elem3 *)((u32)&gBgInfo + 4))[v0].field_0 + (v10 << 11) + (v9 << 6);
                    p1[2] = 2164260896;
                }
                v10 = v10 + 1;
            } while (v10 < v18);
        }
        thunk_HeapFree(v4 + 4 - 4);
        return;
    }
}
