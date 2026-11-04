// scripts/heap-check.sh: a row's measured peak against the heap budget scripts/lane-setup.sh records.
// Incident: a crossed structure variation raised one real row's enumeration peak from 2.11 to
// 2.44 GB, past node's default heap, and its bench shard died twice with the row lost from the tier.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'heap-check.sh');
const scratch = mkdtempSync(join(tmpdir(), 'heap-check-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const LIMIT = '2348810240';
function run(arg: string, env: Record<string, string> = { ASMLIFT_LANE_HEAP_LIMIT_BYTES: LIMIT }) {
  const r = spawnSync('sh', [SCRIPT, arg], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe('heap-check', () => {
  it('reads the peak out of a `/usr/bin/time -v` log and says OVER past the recorded limit', () => {
    const log = join(scratch, 'over.log');
    writeFileSync(
      log,
      '\tCommand being timed: "pnpm bench fan x --enumerate"\n\tMaximum resident set size (kbytes): 2382812\n',
    );
    const { status, out } = run(log);
    expect(status).toBe(1);
    expect(out).toContain('heap-check: OVER peak 2.44 GB = 104% of the 2.35 GB heap limit');
  });

  it('says NEAR from 90% and OK under it, both exit 0', () => {
    expect(run('2200000000')).toMatchObject({ status: 0, out: expect.stringContaining('NEAR') });
    expect(run('1950000000')).toMatchObject({ status: 0, out: expect.stringContaining('OK') });
  });

  it('reads the limit from node when the lane recorded none', () => {
    const { status, out } = run('1000', {});
    expect(status).toBe(0);
    expect(out).toContain('from node on PATH, now');
  });

  it('refuses a log with no peak line, and a missing file', () => {
    const log = join(scratch, 'empty.log');
    writeFileSync(log, 'nothing here\n');
    expect(run(log).status).toBe(2);
    expect(run(join(scratch, 'absent')).status).toBe(2);
  });
});
