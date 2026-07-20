// The script-fidelity gate: re-EXECUTE both reproduction scripts for EVERY function and hold
// their results against the measured rows, BEFORE the data is published to apps/web. The
// scripts are what users copy; this gate is what makes them trustworthy — any drift between
// generator, harness and published numbers fails the run loudly.
//
// Verdict semantics (per script):
//   fail — the script itself broke (bash/usage/timeout/pre-step), the m2c output diverged from
//          the row (its inputs are fully published, byte-equality is the contract), or an
//          asmlift SYNTHETIC run landed on a different outcome/source than the row.
//   warn — an asmlift divergence in a class the scripts themselves document as approximate:
//          real-tier scoring context, and prototype hints the CLI cannot carry. Warns are
//          listed one-per-row — visible, never silent — but do not block publish.
import type { FunctionResult } from '@asmlift/bench-schema';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { M2C_DIR, REPO_ROOT, RESULTS_DIR } from '../config';
import { asmliftScript, m2cScript } from '../report/repro-scripts';

interface Verdict {
  id: string;
  tool: 'm2c' | 'asmlift';
  status: 'ok' | 'warn' | 'fail';
  reason?: string;
}

const SCRIPT_TIMEOUT_MS = 300_000;

function loadRows(): FunctionResult[] {
  const load = (f: string): FunctionResult[] =>
    (JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8')) as { results: FunctionResult[] }).results;
  return [...load('synthetic.json'), ...load('real.json')];
}

function runScript(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'bench-fidelity-'));
  writeFileSync(join(dir, 'script.sh'), script);
  return new Promise((res) => {
    const child = spawn('bash', ['script.sh'], { cwd: dir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), SCRIPT_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      res({ code: code ?? (signal ? 124 : 0), stdout, stderr });
    });
  });
}

/** Fill the user placeholders with this machine's real paths — the ONLY edit a user makes. */
function materialize(script: string): string {
  return script
    .replace("M2C_PATH='/path/to/m2c'", `M2C_PATH='${M2C_DIR}'`)
    .replace("ASMLIFT_PATH='/path/to/asmlift'", `ASMLIFT_PATH='${REPO_ROOT}'`);
}

async function checkM2c(r: FunctionResult): Promise<Verdict> {
  const { code, stdout, stderr } = await runScript(materialize(m2cScript(r)));
  if (code >= 2) {
    return { id: r.id, tool: 'm2c', status: 'fail', reason: `script exited ${code}: ${stderr.slice(0, 200)}` };
  }
  // mirror runM2c's source capture: stdout, else stderr (m2c soft-fails at exit 0)
  const produced = (stdout.trim() ? stdout : stderr).trim();
  if (produced !== r.m2c.source.trim()) {
    return { id: r.id, tool: 'm2c', status: 'fail', reason: 'output diverged from the published source' };
  }
  return { id: r.id, tool: 'm2c', status: 'ok' };
}

async function checkAsmlift(r: FunctionResult): Promise<Verdict> {
  const { code, stdout, stderr } = await runScript(materialize(asmliftScript(r)));
  if (code >= 2) {
    return { id: r.id, tool: 'asmlift', status: 'fail', reason: `script exited ${code}: ${stderr.slice(0, 200)}` };
  }
  if (r.asmlift.outcome === 'declined') {
    // the benchmark's annotate mode stores a marker STUB as the source; the scoring-mode CLI
    // surfaces the same decline as a stderr `[declined] <reason>`. The DECLINE must reproduce;
    // the reason spelling may differ by mode (annotate collects per-stage messages, strict
    // throws at first unresolved value) — a mismatch there is a visible warn, never silent.
    const marker = r.asmlift.errorMarkers?.[0] ?? '';
    const reason = marker.slice(marker.indexOf(': ') + 2).slice(0, 60);
    if (code === 1 && stderr.includes('[declined]')) {
      return reason === '' || stderr.includes(reason)
        ? { id: r.id, tool: 'asmlift', status: 'ok' }
        : {
            id: r.id,
            tool: 'asmlift',
            status: 'warn',
            reason: 'declined either way; reason text differs (mode surface)',
          };
    }
    return {
      id: r.id,
      tool: 'asmlift',
      status: r.tier === 'real' ? 'warn' : 'fail',
      reason: `declined row: exit ${code}, stderr lacks [declined]`,
    };
  }
  const wantExit = r.asmlift.outcome === 'match' ? 0 : 1;
  const sameExit = code === wantExit;
  const sameSource = stdout.trim() === r.asmlift.source.trim();
  if (sameExit && sameSource) {
    return { id: r.id, tool: 'asmlift', status: 'ok' };
  }
  const reason = `${sameExit ? '' : `exit ${code} (row: ${r.asmlift.outcome})`}${sameExit || sameSource ? '' : '; '}${
    sameSource ? '' : 'source diverged'
  }`;
  // real tier scores outside the project context; prototype hints are not expressible via the
  // CLI — both documented in the scripts themselves. Divergence there is a WARN, not a fail.
  return { id: r.id, tool: 'asmlift', status: r.tier === 'real' ? 'warn' : 'fail', reason };
}

export async function fidelity(jobs: number): Promise<void> {
  const { assertM2cPinned } = await import('../eval/m2c');
  assertM2cPinned();
  const rows = loadRows();
  const work = rows.flatMap((r) => [() => checkM2c(r), () => checkAsmlift(r)]);
  const verdicts: Verdict[] = [];
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < work.length) {
      const v = await work[next++]();
      verdicts.push(v);
      done++;
      if (done % 100 === 0) {
        console.log(`[fidelity] ${done}/${work.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));

  const fails = verdicts.filter((v) => v.status === 'fail');
  const warns = verdicts.filter((v) => v.status === 'warn');
  for (const w of warns) {
    console.log(`  warn ${w.tool} ${w.id}: ${w.reason}`);
  }
  for (const f of fails) {
    console.log(`  FAIL ${f.tool} ${f.id}: ${f.reason}`);
  }
  console.log(
    `\nfidelity: ${verdicts.length} script runs — ${verdicts.length - fails.length - warns.length} ok, ${warns.length} warn, ${fails.length} fail`,
  );
  if (fails.length > 0) {
    throw new Error(`${fails.length} script(s) diverged from the published rows — publish blocked`);
  }
}
