import { scoreObjects } from '../../packages/cli/src/objdiff.ts';

for (const path of process.argv.slice(3))
  console.log(JSON.stringify({ path, ...scoreObjects(process.argv[2], path, 'LoadBGTilemapData') }));
