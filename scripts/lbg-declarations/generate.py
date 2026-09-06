from pathlib import Path
import os
root=Path(os.environ['LBG_STUDY_DIR']); root.mkdir(parents=True,exist_ok=True); p=(Path(__file__).parent/'reference.c').read_text()
variants={'baseline':p,'add-unused':p.replace('    s32 sp4;','    s32 unused;\n    s32 sp4;'),'split-var-r3':p.replace('    s32 sp4;','    s32 temp_r3;\n    s32 sp4;').replace('var_r3 = gUnk_08057ACC','temp_r3 = gUnk_08057ACC').replace('gUnk_08189CCC[var_r3]','gUnk_08189CCC[temp_r3]'),'merge-pointers':p.replace('    u8 *temp_r8;\n','').replace('    void *sp8;','    u8 *sp8;').replace('temp_r8','sp8'),'move-pointer-block':p.replace('    u8 *temp_r8;\n','').replace('        var_sl = 0x10 << spC;','        u8 *temp_r8;\n        var_sl = 0x10 << spC;'),'address-sp4':p.replace('    s32 sp4;','    s32 sp4;\n    s32 * volatile address_sp4;').replace('    var_r3 = arg1;','    address_sp4 = &sp4;\n    var_r3 = arg1;'),'reverse-stack':p.replace('    s32 sp4;\n    void *sp8;\n    s32 spC;\n    u32 sp10;\n    u32 sp14;\n    u32 sp18;','    u32 sp18;\n    u32 sp14;\n    u32 sp10;\n    s32 spC;\n    void *sp8;\n    s32 sp4;')}
raw={'extern struct BgInfo gBgInfo[4];':'#define gBgInfo ((struct BgInfo *)0x03003430)','extern struct Unk_030034A0 *gUnk_030034A0;':'#define gUnk_030034A0 (*(struct Unk_030034A0 **)0x030034A0)','extern u8 gUnk_03004DB0[];':'#define gUnk_03004DB0 ((u8 *)0x03004DB0)','extern const u8 gUnk_08057ACC[][2][2];':'#define gUnk_08057ACC ((const u8 (*)[2][2])0x08057ACC)','extern const u32 *gUnk_08189CCC[][2];':'#define gUnk_08189CCC ((const u32 *(*)[2])0x08189CCC)'}
for name,src in variants.items():
 for basin in ['sym','raw']:
  for fake in ['plus','minus']:
   v=src
   if basin=='raw':
    for a,b in raw.items():v=v.replace(a,b)
   if fake=='minus':v='\n'.join(l for l in v.splitlines() if '// FAKE?' not in l)+'\n'
   (root/f'{name}-{basin}-{fake}.c').write_text(v)

(root/'swap-n2.c').write_text(p.replace('                DmaFill16(3, 0, gBgInfo[var_sb].pTilemap + (var_r3 * 0x40) + (var_r7 * 0x800), 0x40);', '                gBgInfo[2].vLength += 0;\n                DmaFill16(3, 0, gBgInfo[var_sb].pTilemap + (var_r7 * 0x800) + (var_r3 * 0x40), 0x40);'))
