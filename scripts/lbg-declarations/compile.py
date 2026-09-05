from pathlib import Path
import subprocess,os
root=Path(os.environ['LBG_STUDY_DIR'])
for p in sorted(root.glob('*.c')):
 subprocess.run(['arm-none-eabi-cpp','-nostdinc','-I','tools/agbcc/include','-iquote','include',str(p),'-o',str(p.with_suffix('.i'))],check=True)
 with p.with_suffix('.trace').open('w') as err:
  subprocess.run([os.environ['LBG_TRACE_COMPILER'],str(p.with_suffix('.i')),'-o',str(p.with_suffix('.s')),'-mthumb-interwork','-Wimplicit','-Wparentheses','-O2','-fhex-asm','-fprologue-bugfix'],env={**os.environ,'LBG_ALLOC_TRACE':'1'},stderr=err,check=True)
 with p.with_suffix('.s').open('a') as out:out.write('\n.text\n\t.align\t2, 0\n')
 subprocess.run(['arm-none-eabi-as','-mcpu=arm7tdmi','-mthumb-interwork',str(p.with_suffix('.s')),'-o',str(p.with_suffix('.o'))],check=True)
print('compiled',len(list(root.glob('*.c'))))
