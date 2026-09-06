typedef unsigned char u8;typedef unsigned short u16;typedef unsigned int u32;typedef signed char s8;typedef short s16;typedef int s32;
extern u32 gReadBgs;
struct Off0 { u8 _pad0[22]; u16 m22; };
s32 erback(u32 a0, u32 a1) {
    u32 v0;
    s32 v1;
    v0 = 0;
    v1 = 0;
    if (v1 < a1) {
        do {
            ((s32 *)*(s32 *)((a0 << 3) + (u32)&gReadBgs))[v0] = v0 << 6;
            v1 = v1 + ((struct Off0 *)&gReadBgs)->m22;
            v0 = v0 + 1;
        } while (v0 < a1);
    }
    return v1;
}

