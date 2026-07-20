// @asmlift/toolchains — the PINNED compile implementations (agbcc, IDO 7.1, KMC GCC,
// CodeWarrior): candidate compiles, reference compiles, and the Docker machinery.
// Behavior changes here are benchmark-row changes.
//
// REGISTRATION RULE: each registerCandidateCompiler call sits at MODULE SCOPE next to the
// implementation it registers, so ANY import that can reach a registry-dependent path has
// already evaluated this module. (An index-only side effect would be bypassed by subpath
// imports, silently leaving @asmlift/cli's registry empty — and the benchmark's gcc/mwcc
// rows would record "noncompile" instead of failing loud.)
import { registerCandidateCompiler } from '@asmlift/cli/score';
import { C_TYPEDEFS } from '@asmlift/core/target';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { GCC_KMC_TOOLCHAIN, IDO_TOOLCHAIN, MWCC_PPC_TOOLCHAIN, TOOLCHAIN } from './toolchain';

const noPascal = (compiler: string): never => {
  throw new Error(`${compiler} target has no Pascal backend`);
};

/** A spawn-level failure (ENOENT etc.) means the BINARY couldn't run — a setup defect, not a
 *  compile error. Without this distinction, `spawnSync` reports `status: null`/`stderr: null`
 *  and callers' `status !== 0` checks surface it as "agbcc failed: null" — cryptic for anyone
 *  whose machine lacks the pinned toolchains. Name the binary and the remedy instead. */
export function spawnFailure(cmd: string, e: NodeJS.ErrnoException): string {
  if (e.code === 'ETIMEDOUT') {
    return `'${cmd}' timed out`;
  }
  return (
    `cannot run '${cmd}' (${e.code ?? e.message}) — not installed, or its pinned-toolchain ` +
    `default path doesn't exist on this machine. Toolchain binaries resolve from ASMLIFT_* env ` +
    `vars with sibling-checkout defaults; see packages/cli/CONTRIBUTION.md#the-pinned-toolchains.`
  );
}

/** Spawn helper shared by every toolchain invocation (asmdata.ts uses it too). Throws the
 *  named setup error above when the binary itself couldn't run; compile failures (nonzero
 *  status, real stderr) still return for the caller to diagnose. */
export function run(cmd: string, args: string[], env?: Record<string, string>) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  if (r.error) {
    throw new Error(spawnFailure(cmd, r.error));
  }
  return r;
}

// ── agbcc / ARM ───────────────────────────────────────────────────────────────────────────

/** Compile candidate C with agbcc + assemble; returns the object path. */
function compileCandAgbcc(cSource: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-score-'));
  const cPath = join(dir, 'cand.c');
  const ppPath = join(dir, 'cand.pp.c');
  const sPath = join(dir, 'cand.s');
  const oPath = join(dir, 'cand.o');
  writeFileSync(cPath, C_TYPEDEFS + cSource);

  run('sh', ['-c', `cpp -P -nostdinc ${cPath} > ${ppPath} 2>/dev/null`]);
  const cc = run(TOOLCHAIN.agbcc, [ppPath, '-o', sPath, ...TOOLCHAIN.agbccFlags]);
  if (cc.status !== 0) {
    throw new Error(`agbcc failed: ${cc.stderr}`);
  }
  const as = run(TOOLCHAIN.as, [...TOOLCHAIN.asFlags, sPath, '-o', oPath]);
  if (as.status !== 0) {
    throw new Error(`as failed: ${as.stderr}`);
  }
  return oPath;
}

registerCandidateCompiler('agbcc', (source, _symbol, backendId) =>
  backendId === 'pascal' ? noPascal('agbcc') : compileCandAgbcc(source),
);

export { compileCandAgbcc };

/** Compile reference C with agbcc and return its assembly text (the scoring target). */
export function compileTargetAsm(cSource: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-ref-'));
  const cPath = join(dir, 'ref.c');
  const ppPath = join(dir, 'ref.pp.c');
  const sPath = join(dir, 'ref.s');
  writeFileSync(cPath, C_TYPEDEFS + cSource);
  run('sh', ['-c', `cpp -P -nostdinc ${cPath} > ${ppPath} 2>/dev/null`]);
  const cc = run(TOOLCHAIN.agbcc, [ppPath, '-o', sPath, ...TOOLCHAIN.agbccFlags]);
  if (cc.status !== 0) {
    throw new Error(`agbcc failed: ${cc.stderr}`);
  }
  return readFileSync(sPath, 'utf8');
}

/** Assemble a target .s (the committed reference) into a .o for scoring against. */
export function assembleTarget(targetAsm: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-target-'));
  const sPath = join(dir, 'target.s');
  const oPath = join(dir, 'target.o');
  writeFileSync(sPath, targetAsm);
  const as = run(TOOLCHAIN.as, [...TOOLCHAIN.asFlags, sPath, '-o', oPath]);
  if (as.status !== 0) {
    throw new Error(`target as failed: ${as.stderr}`);
  }
  return oPath;
}

// ── MIPS / IDO path ───────────────────────────────────────────────────────────────────
// IDO emits no textual asm, so the reference flow is: compile C → object (the scoring
// target) AND disassemble that object → asm text (asmlift's frontend input). Scoring a
// candidate: compile its C → object, objdiff against the target. The objdiff engine is the
// same arch-agnostic scorer used for ARM — it reads the ELF's arch itself.

/** Compile reference C with IDO → {obj (scoring target), asm (disassembly, frontend input)}. */
export function compileMipsTarget(cSource: string, _symbol: string): { obj: string; asm: string } {
  const dir = contentShareableDir('asmlift-mips-ref-', cSource);
  const cPath = join(dir, 'ref.c');
  const oPath = join(dir, 'ref.o');
  writeFileSync(cPath, C_TYPEDEFS + cSource);
  const cc = run(IDO_TOOLCHAIN.cc, [...IDO_TOOLCHAIN.ccFlags, '-o', oPath, cPath]);
  if (cc.status !== 0) {
    throw new Error(`ido cc failed: ${cc.stderr || cc.stdout}`);
  }
  const dis = run(IDO_TOOLCHAIN.objdump, [...IDO_TOOLCHAIN.objdumpFlags, oPath]);
  if (dis.status !== 0) {
    throw new Error(`objdump failed: ${dis.stderr}`);
  }
  return { obj: oPath, asm: dis.stdout };
}

/** Compile candidate IDO Pascal (via `cc`→`upas`, routed by the `.p` extension); returns the
 *  object path. No C typedefs: Pascal source stands alone. */
export function compileCandIdoPascal(pascalSource: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-mips-pas-'));
  const pPath = join(dir, 'cand.p'); // `.p` makes IDO's cc select the Pascal frontend
  const oPath = join(dir, 'cand.o');
  writeFileSync(pPath, pascalSource);
  const cc = run(IDO_TOOLCHAIN.cc, [...IDO_TOOLCHAIN.ccFlags, '-o', oPath, pPath], {
    USR_LIB: dirname(IDO_TOOLCHAIN.cc),
  });
  if (cc.status !== 0) {
    throw new Error(`ido pascal (upas) failed: ${cc.stderr || cc.stdout}`);
  }
  return oPath;
}

/** Compile candidate C with IDO; returns the object path. */
export function compileCandIdoC(cSource: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-mips-score-'));
  const cPath = join(dir, 'cand.c');
  const oPath = join(dir, 'cand.o');
  writeFileSync(cPath, C_TYPEDEFS + cSource);
  const cc = run(IDO_TOOLCHAIN.cc, [...IDO_TOOLCHAIN.ccFlags, '-o', oPath, cPath]);
  if (cc.status !== 0) {
    throw new Error(`ido cc failed: ${cc.stderr || cc.stdout}`);
  }
  return oPath;
}

registerCandidateCompiler('ido', (source, _symbol, backendId) =>
  backendId === 'pascal' ? compileCandIdoPascal(source) : compileCandIdoC(source),
);

// ── MIPS / KMC GCC path (Docker) ────────────────────────────────────────────────────────
// Same ISA as IDO, different compiler (see MIPS_GCC in target.ts). The KMC GCC is a Linux/i386
// binary, so the C→object step runs inside a linux/386 container with the compiler dir mounted;
// the object is then disassembled + scored with the native host binutils/objdiff, exactly as the
// IDO path does. The scratch dir lives under /tmp (Docker-Desktop-shareable on macOS; os.tmpdir()
// returns /var/folders which is NOT bind-mountable by default).

/** Is a working Docker daemon reachable? Tests skip the GCC path cleanly when not. */
export function dockerAvailable(): boolean {
  const d = GCC_KMC_TOOLCHAIN.docker;
  return spawnSync(d, ['info'], { encoding: 'utf8' }).status === 0;
}

/** Is the pinned agbcc binary present? (PATH-resolved tools like `arm-none-eabi-as` can't be
 *  probed by existsSync — a missing one surfaces via run()'s named spawn failure instead.) */
export function agbccAvailable(): boolean {
  return existsSync(TOOLCHAIN.agbcc);
}

/** Is the pinned IDO 7.1 `cc` present? Same PATH caveat as agbccAvailable. */
export function idoAvailable(): boolean {
  return existsSync(IDO_TOOLCHAIN.cc);
}

export function mkShareableTmp(prefix: string): string {
  return mkdtempSync(join('/tmp', prefix));
}

/** A DETERMINISTIC shareable scratch dir, content-keyed: same inputs ⇒ same path on every
 *  machine. Reference builds must use this, not mkShareableTmp — compilers bake the build
 *  path into the object (IDO writes it into .mdebug section BYTES), so a random or
 *  machine-specific dir makes the object, its dump and every published artifact embedding
 *  them differ per host. Same-content concurrent rebuilds write identical bytes (benign). */
export function contentShareableDir(prefix: string, key: string): string {
  const dir = join('/tmp', `${prefix}${createHash('sha256').update(key).digest('hex').slice(0, 16)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── persistent container pool ───────────────────────────────────────────────────────────
// A `docker run --rm` costs ~1.2 s of pure launch overhead while the i386 compile inside is
// nearly free; a `docker exec` into a long-lived container costs ~50 ms. Each dockerized step
// below first tries one pooled container per (image, toolchain dir) and falls back to a
// single-shot `docker run` when the pool is unavailable.
//
// Pool mechanics: the container just runs `sleep 86400` (self-expires daily; a later run lazily
// restarts it) with the toolchain dir and /tmp mounted ONCE — /tmp at /host-tmp, so every
// per-call mkShareableTmp scratch dir is reachable without a per-call mount. The name encodes
// the mount config, so a changed image/dir simply pools under a new name. Concurrent shard
// processes race to create it; the loser's "name already in use" is success. Set
// ASMLIFT_DOCKER_POOL=0 to disable pooling entirely (the benchmark's A/B baseline switch).
//
// Pool state lives in THIS module only — poolExec/hostTmp/ppcPoolCfg are exported for
// asmdata.ts's dockerized PPC objdump, which must share the same pool.

const poolEnabled = () => process.env.ASMLIFT_DOCKER_POOL !== '0';
const poolReady = new Set<string>(); // container names this process has confirmed running

function poolName(kind: string, cfg: string): string {
  return `asmlift-pool-${kind}-${createHash('sha256').update(cfg).digest('hex').slice(0, 8)}`;
}

/** Map a host path under /tmp to its path under the pool's /host-tmp mount (null ⇒ not poolable). */
export function hostTmp(p: string): string | null {
  const abs = p.startsWith('/private/tmp/') ? p.slice('/private'.length) : p;
  return abs.startsWith('/tmp/') ? `/host-tmp${abs.slice(4)}` : null;
}

function ensurePooled(docker: string, image: string, name: string, mounts: string[]): boolean {
  if (!poolEnabled()) {
    return false;
  }
  if (poolReady.has(name)) {
    return true;
  }
  const ins = run(docker, ['container', 'inspect', '-f', '{{.State.Running}}', name]);
  if (ins.status === 0 && ins.stdout.trim() === 'true') {
    poolReady.add(name);
    return true;
  }
  if (ins.status === 0) {
    run(docker, ['rm', '-f', name]);
  } // exists but exited (expired sleep)
  const r = run(docker, ['run', '-d', '--name', name, '--platform', 'linux/386', ...mounts, image, 'sleep', '86400']);
  if (r.status === 0 || /already in use/i.test(r.stderr ?? '')) {
    poolReady.add(name);
    return true;
  }
  return false; // no docker daemon / image → caller cold-runs (surfacing the real error there)
}

/** `docker exec` in the pool. Returns null when the pool itself is unusable (caller cold-runs);
 *  otherwise the spawn result — whose exit code is then the COMMAND's own (a compile error must
 *  surface as the same throw the cold path produces, never silently retry). One retry through a
 *  container restart covers the sleep expiring mid-run. */
export function poolExec(docker: string, image: string, name: string, mounts: string[], execArgs: string[]) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!ensurePooled(docker, image, name, mounts)) {
      return null;
    }
    const r = run(docker, ['exec', ...execArgs]);
    if (r.status !== 0 && /No such container|is not running/i.test(r.stderr ?? '')) {
      poolReady.delete(name);
      run(docker, ['rm', '-f', name]);
      continue;
    }
    return r;
  }
  return null;
}

/** Compile `srcC` (a basename in `dir`) to the object `outObj` with KMC GCC inside the
 *  container — pooled `docker exec` when `dir` is under /tmp, single-shot `docker run` otherwise.
 *  Throws on failure. Exported for the benchmark's real-tier compile
 *  (apps/benchmark/src/compile/kmc.ts), so it pools through the same helper. */
export function kmcCompile(dir: string, srcC: string, outObj: string): void {
  const t = GCC_KMC_TOOLCHAIN;
  const w = hostTmp(dir);
  if (w) {
    const name = poolName('kmc', `${t.image}|${t.dir}`);
    const mounts = ['-v', `${t.dir}:/kmc:ro`, '-v', '/tmp:/host-tmp'];
    const cc = poolExec(t.docker, t.image, name, mounts, [
      '-w',
      w,
      '-e',
      'COMPILER_PATH=/kmc',
      name,
      '/kmc/gcc',
      ...t.ccFlags,
      '-c',
      '-o',
      `${w}/${outObj}`,
      `${w}/${srcC}`,
    ]);
    if (cc) {
      if (cc.status !== 0) {
        throw new Error(`kmc gcc (docker) failed: ${cc.stderr || cc.stdout}`);
      }
      return;
    }
  }
  const cc = run(t.docker, [
    'run',
    '--rm',
    '--platform',
    'linux/386',
    '-v',
    `${t.dir}:/kmc:ro`,
    '-v',
    `${dir}:/work`,
    '-w',
    '/work',
    '-e',
    'COMPILER_PATH=/kmc',
    t.image,
    '/kmc/gcc',
    ...t.ccFlags,
    '-c',
    '-o',
    `/work/${outObj}`,
    `/work/${srcC}`,
  ]);
  if (cc.status !== 0) {
    throw new Error(`kmc gcc (docker) failed: ${cc.stderr || cc.stdout}`);
  }
}

/** Compile reference C with KMC GCC → {obj (scoring target), asm (disassembly, frontend input)}. */
export function compileMipsGccTarget(cSource: string, _symbol: string): { obj: string; asm: string } {
  const t = GCC_KMC_TOOLCHAIN;
  const dir = contentShareableDir('asmlift-mgcc-ref-', cSource);
  writeFileSync(join(dir, 'ref.c'), C_TYPEDEFS + cSource);
  kmcCompile(dir, 'ref.c', 'ref.o');
  const oPath = join(dir, 'ref.o');
  const dis = run(t.objdump, [...t.objdumpFlags, oPath]);
  if (dis.status !== 0) {
    throw new Error(`objdump failed: ${dis.stderr}`);
  }
  return { obj: oPath, asm: dis.stdout };
}

/** Compile candidate C with KMC GCC (dockerized); returns the object path. */
export function compileCandKmc(cSource: string): string {
  const dir = mkShareableTmp('asmlift-mgcc-score-');
  writeFileSync(join(dir, 'cand.c'), C_TYPEDEFS + cSource);
  kmcCompile(dir, 'cand.c', 'cand.o');
  return join(dir, 'cand.o');
}

registerCandidateCompiler('gcc', (source, _symbol, backendId) =>
  backendId === 'pascal' ? noPascal('gcc') : compileCandKmc(source),
);

// ── PowerPC / CodeWarrior path (Docker) ─────────────────────────────────────────────────────
// The THIRD ISA, FOURTH compiler (PPC_MWCC in target.ts). CodeWarrior `mwcceppc.exe` is a 32-bit
// Win32 PE; it runs through a 32-bit `wibo` inside a linux/386 container (packages/toolchains/ppc-docker), which
// also disassembles the object with a PowerPC objdump. The object lands in the bind-mounted /tmp
// scratch dir (host-visible), so the arch-agnostic objdiff scorer runs on the HOST exactly as for
// every other target. Mirrors the KMC-GCC path; only the compiler/PE-runner differ. See the
// Dockerfile for why 32-bit-wibo-under-qemu-i386 is the working path on Apple Silicon.

// The PPC pool container's identity: its NAME encodes exactly the mount config it was created
// with, so the pairing must change together — kept in one place so a one-sided edit can't
// resolve the same pooled name with incompatible mount expectations.
export function ppcPoolCfg(t: typeof MWCC_PPC_TOOLCHAIN): { name: string; mounts: string[] } {
  return {
    name: poolName('ppc', `${t.image}|${t.dir}`),
    mounts: ['-v', `${t.dir}:/mwcc:ro`, '-v', '/tmp:/host-tmp'],
  };
}

/** Are ALL three PPC-path prerequisites present: the Docker daemon, the LOCALLY-BUILT image
 *  (a `docker build` product — unlike the KMC path's public base image it would NOT auto-pull),
 *  and the bind-mounted proprietary CodeWarrior dir? Fixtures gate on this so a fresh checkout
 *  with the image un-built (or the mwcc dir absent) SKIPS cleanly instead of hard-failing
 *  inside `docker run`. */
export function ppcDockerAvailable(): boolean {
  const t = MWCC_PPC_TOOLCHAIN;
  if (spawnSync(t.docker, ['info'], { encoding: 'utf8' }).status !== 0) {
    return false;
  }
  if (spawnSync(t.docker, ['image', 'inspect', t.image], { encoding: 'utf8' }).status !== 0) {
    return false;
  }
  return existsSync(join(t.dir, 'mwcceppc.exe'));
}

/** Run one linux/386 container that compiles `srcC` (a basename in `dir`) with mwcceppc-via-wibo
 *  to `outObj`, and — when `disasm` — pipes the object through the PowerPC objdump, returning its
 *  text. The proprietary CodeWarrior dir is mounted read-only at /mwcc; the scratch dir at /work. */
function ppcContainer(dir: string, srcC: string, outObj: string, disasm: boolean): string {
  const t = MWCC_PPC_TOOLCHAIN;
  // The script is parameterized by the container-side workdir: `/work` for the single-shot
  // container (per-call mount), the /host-tmp mapping for the pooled one.
  const script = (W: string) => {
    const compile = `${t.wibo} /mwcc/mwcceppc.exe ${t.ccFlags.map(shq).join(' ')} -o ${W}/${outObj} ${W}/${srcC}`;
    return disasm ? `${compile} && ${t.objdump} ${t.objdumpFlags.join(' ')} ${W}/${outObj}` : compile;
  };
  const w = hostTmp(dir);
  if (w) {
    const { name, mounts } = ppcPoolCfg(t);
    const r = poolExec(t.docker, t.image, name, mounts, [name, 'sh', '-c', script(w)]);
    if (r) {
      if (r.status !== 0) {
        throw new Error(`mwcceppc (docker) failed: ${r.stderr || r.stdout}`);
      }
      return r.stdout;
    }
  }
  const r = run(t.docker, [
    'run',
    '--rm',
    '--platform',
    'linux/386',
    '-v',
    `${t.dir}:/mwcc:ro`,
    '-v',
    `${dir}:/work`,
    '-w',
    '/work',
    t.image,
    'sh',
    '-c',
    script('/work'),
  ]);
  if (r.status !== 0) {
    throw new Error(`mwcceppc (docker) failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}
// CodeWarrior flags carry spaces (e.g. `msg_show_realref off`), so quote each token for the shell.
function shq(s: string): string {
  return /[^\w/.,=-]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

/** Compile reference C with CodeWarrior → {obj (scoring target), asm (disassembly, frontend input)}. */
export function compilePpcTarget(cSource: string, _symbol: string): { obj: string; asm: string } {
  const dir = contentShareableDir('asmlift-ppc-ref-', cSource);
  writeFileSync(join(dir, 'ref.c'), C_TYPEDEFS + cSource);
  const asm = ppcContainer(dir, 'ref.c', 'ref.o', true);
  return { obj: join(dir, 'ref.o'), asm };
}

/** Compile candidate C with CodeWarrior (dockerized wibo); returns the object path. */
export function compileCandPpc(cSource: string): string {
  const dir = mkShareableTmp('asmlift-ppc-score-');
  writeFileSync(join(dir, 'cand.c'), C_TYPEDEFS + cSource);
  ppcContainer(dir, 'cand.c', 'cand.o', false);
  return join(dir, 'cand.o');
}

registerCandidateCompiler('mwcc', (source, _symbol, backendId) =>
  backendId === 'pascal' ? noPascal('mwcc') : compileCandPpc(source),
);

// ── C++ path (mangled-symbol harness) ─────────────────────────────────────────────────────
// mwcceppc is a C AND C++ compiler: the `.cp` extension selects the C++ frontend. A C++ target's
// symbol is MANGLED (`Vec::dot(Vec*)` → `dot__3VecFP3Vec`), so the scoring symbol is the mangled
// string, and objdiff aligns the candidate to the target by exactly that name. Same container,
// same flags — only the source extension differs: the compiler is one binary, the language is a
// flag (a future `target.language` axis).

/** Compile reference C++ (`.cp`) with CodeWarrior → {obj (scoring target), disasm (frontend input)}. */
export function compilePpcCppTarget(cppSource: string, _symbol: string): { obj: string; asm: string } {
  const dir = contentShareableDir('asmlift-ppc-cpp-ref-', cppSource);
  writeFileSync(join(dir, 'ref.cp'), C_TYPEDEFS + cppSource);
  const asm = ppcContainer(dir, 'ref.cp', 'ref.o', true);
  return { obj: join(dir, 'ref.o'), asm };
}

/** Compile candidate C++ (`.cp`) with CodeWarrior; returns the object path. */
export function compileCandPpcCpp(cppSource: string): string {
  const dir = mkShareableTmp('asmlift-ppc-cpp-score-');
  writeFileSync(join(dir, 'cand.cp'), C_TYPEDEFS + cppSource);
  ppcContainer(dir, 'cand.cp', 'cand.o', false);
  return join(dir, 'cand.o');
}
