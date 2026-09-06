#include "gba.h"
struct BgInfo {
    /* 0x00 */ void *pTiles; // BG tiles
    /* 0x04 */ void *pTilemap; // BG tilemap
    /* 0x08 */ u16 hOfs; // BGXHOFS
    /* 0x0A */ u16 vOfs; // BGXVOFS
    /* 0x0C */ u16 tileCol; // BG left column
    /* 0x0E */ u16 tileRow; // BG top row
    /* 0x10 */ u16 hLength; // BG X length
    /* 0x12 */ u16 vLength; // BG Y length
    /* 0x14 */ u16 unk14;
    /* 0x16 */ u16 unk16; // BG tile length y?
    /* 0x18 */ u8 unk18;  // BG tile length x?
    /* 0x19 */ u8 pad19[0x1C - 0x19];
}; /* size = 0x1C */
extern struct BgInfo gBgInfo[4];

struct Unk_030034A0 {
    /* 0x00_0 */ u32 unk0_0:2;
    /* 0x00_2 */ u8 unk0_2:4; // TODO: verify
    /* 0x00_6 */ u32 unk0_6:2;
    /* 0x01_0 */ u32 unk1_0:1;
    /* 0x01_1 */ u8 unk1_1:5; // TODO: verify
    /* 0x01_6 */ u32 unk1_6:1;
    /* 0x01_6 */ u32 unk1_7:2;
    /* 0x02_1 */ u32 unk2_1:2;
    /* 0x03 */ u8 unk3[1]; // TODO: length?
    /* 0x02 */ u8 pad4[0x5 - 0x4];
    /* 0x05 */ u8 unk5;
    /* 0x06 */ u8 unk6;
    /* 0x07 */ u8 pad7[0x8 - 0x7];
    /* 0x08 */ s16 unk8[2][2];
    /* 0x10 */ s16 unk10[2][2];
    /* 0x18 */ s16 unk18;
    /* 0x1A */ s16 unkA;
    /* 0x1C_0 */ u8 unk1C_0:2;
    /* 0x1C_2 */ u8 unk1C_2:1;
    /* 0x1C_3 */ u8 unk1C_3:1;
    /* 0x1C_4 */ u8 unk1C_4:1;
    /* 0x1C_5 */ u8 unk1C_5:1;
    /* 0x1C_6 */ u8 unk1C_6:1;
}; /* size = ? */
extern struct Unk_030034A0 *gUnk_030034A0;

extern u8 gUnk_03004DB0[]; // BG2 tilemap data

extern const u8 gUnk_08057ACC[][2][2];
extern const u32 *gUnk_08189CCC[][2];

extern void thunk_HeapFree(void* heapPtr);
extern void *DecompressAlloc(void *src);

#define min(a, b) ((a) < (b) ? (a) : (b))
#define max(a, b) ((a) >= (b) ? (a) : (b))

void LoadBGTilemapData(s32 arg0, s32 arg1)
{
    s32 sp4;
    void *sp8;
    s32 spC;
    u32 sp10;
    u32 sp14;
    u32 sp18;
    u8 *temp_r8;
    s32 var_r3;
    s32 var_r7;
    u32 var_sl;
    u32 var_r8;
    u32 var_sb;

    var_r3 = arg1; // FAKE?
    var_sb = gUnk_08057ACC[arg0][arg1][1];
    var_r3 = gUnk_08057ACC[arg0][arg1][0]; // Can also use separate s32 temp_r3; variable for this
    spC = gUnk_030034A0->unk3[var_sb - 2];

    if ((gUnk_030034A0->unk1_0 != 0) && (var_sb == 2))
    {
        var_sl = 0x10 << spC;
        if (gBgInfo); // FAKE?
        temp_r8 = DecompressAlloc((void*)gUnk_08189CCC[var_r3][var_sb - 2]);
        temp_r8 += 4;

        for (var_r3 = 0; var_r3 < gBgInfo[2].vLength; var_r3++)
        {
            for (var_r7 = 0; var_r7 < gBgInfo[2].hLength; var_r7++)
            {
                gUnk_03004DB0[var_r7] = temp_r8[var_r7 + (var_r3 * gBgInfo[2].hLength)];
            }

            for (var_r7 = gBgInfo[2].hLength; var_r7 < var_sl; var_r7++)
            {
                gUnk_03004DB0[var_r7] = 0;
            }

            DmaCopy16Wait(3, gUnk_03004DB0, gBgInfo[2].pTilemap + (var_r3 * var_sl), var_sl);
        }

        for (var_r3 = gBgInfo[2].vLength; var_r3 < var_sl; var_r3++)
        {
            DmaFill16(3, 0, gBgInfo[2].pTilemap + (var_r3 * var_sl), var_sl);
        }

        thunk_HeapFree(temp_r8 - 4);
    }
    else
    {
        sp8 = DecompressAlloc((void*)gUnk_08189CCC[var_r3][var_sb - 2]);
        sp8 += 4;

        switch (spC)
        {
            case 3:
                sp4 = 4;
                break;

            default:
                sp4 = 2;
                break;

            case 0:
                sp4 = 1;
                break;
        }

        for (var_r7 = 0; var_r7 < sp4; var_r7++)
        {
            switch (spC)
            {
                case 0:
                    var_sl = min(gBgInfo[var_sb].hLength, 0x20);
                    var_r8 = min(0x20 - var_sl, 0x20);
                    sp10 = min(gBgInfo[var_sb].vLength, 0x20);
                    sp14 = 0;
                    sp18 = 0;
                    break;

                case 1:
                    if (var_r7 != 0)
                    {
                        var_sl = min(gBgInfo[var_sb].hLength, 0x20);
                    }
                    else
                    {
                        var_sl = 0x20;
                    }

                    if (var_r7 != 0)
                    {
                        var_r8 = min(0x20 - var_sl, 0x20);
                    }
                    else
                    {
                        var_r8 = 0;
                    }

                    sp10 = min(gBgInfo[var_sb].vLength, 0x20);
                    sp14 = var_r7 << 5;
                    sp18 = 0;
                    break;

                case 2:
                    var_sl = min(gBgInfo[var_sb].hLength, 0x20);
                    var_r8 = min(0x20 - var_sl, 0x20);

                    if (var_r7 != 0)
                    {
                        sp10 = min(gBgInfo[var_sb].vLength, 0x20);
                    }
                    else
                    {
                        sp10 = 0x20;
                    }

                    sp14 = 0;
                    sp18 = var_r7 * gBgInfo[var_sb].vLength;
                    break;

                case 3:
                    if (var_r7 != 0)
                    {
                        var_sl = min(gBgInfo[var_sb].hLength, 0x20);
                    }
                    else
                    {
                        var_sl = 0x20;
                    }

                    if (var_r7 != 0)
                    {
                        var_r8 = min(0x20 - var_sl, 0x20);
                    }
                    else
                    {
                        var_r8 = 0x20;
                    }

                    if (var_r7 != 0)
                    {
                        sp10 = min(gBgInfo[var_sb].vLength, 0x20);
                    }
                    else
                    {
                        sp10 = 0x20;
                    }

                    sp14 = (var_r7 & 2) ? 0x20 : 0;
                    sp18 = (var_r7 & 1) ? 0x20 : 0;
                    break;
            }

            for (var_r3 = 0; var_r3 < sp10; var_r3++)
            {
                if (var_r8 != 0)
                {
                    DmaFill16(3, 0, gBgInfo[var_sb].pTilemap + (var_r3 * 0x40) + (var_r7 * 0x800) + (var_sl * 2), var_r8 * 2);
                }

                DmaCopy16Wait(3, sp8 + ((var_r3 + sp18) * gBgInfo[var_sb].hLength) * 2 + (sp14 * 2), gBgInfo[var_sb].pTilemap + (var_r3 * 0x40) + (var_r7 * 0x800), var_sl * 2);
            }

            for (var_r3 = sp10; var_r3 < 0x20; var_r3++)
            {
                // Decreasing order of matching
                // gBgInfo[2].pTilemap += 0;
                // gBgInfo[2].vLength += 0;
                // vu8 tmp = 0;
                // gBgInfo[var_sb].pTilemap++,gBgInfo[var_sb].pTilemap--;

                // DmaFill16(3, 0, gBgInfo[var_sb].pTilemap + (var_r7 * 0x800) + (var_r3 * 0x40), 0x40);

                // This matches better than the above one normally, but when using fake matching, the above one works better
                DmaFill16(3, 0, gBgInfo[var_sb].pTilemap + (var_r3 * 0x40) + (var_r7 * 0x800), 0x40);
            }
        }

        thunk_HeapFree(sp8 - 4);
    }
}
