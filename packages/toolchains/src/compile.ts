// @asmlift/toolchains — the PINNED compile implementations (agbcc, IDO 7.1, KMC GCC,
// CodeWarrior): candidate compiles, reference compiles, and the Docker machinery.
// Behavior changes here are benchmark-row changes.
//
// REGISTRATION RULE: each registerCandidateCompiler call sits at MODULE SCOPE next to the
// implementation it registers, so ANY import that can reach a registry-dependent path has
// already evaluated this module. (An index-only side effect would be bypassed by subpath
// imports, silently leaving @asmlift/cli's registry empty — and the benchmark's gcc/mwcc
// rows would record "noncompile" instead of failing loud.)
import { scopedObjectPath } from '@asmlift/cli/elf-section';
import { type CandidateCompiler, registerCandidateCompiler } from '@asmlift/cli/score';
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';
import { C_TYPEDEFS, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  GCC272_TOOLCHAIN,
  GCC_KMC_TOOLCHAIN,
  IDO_TOOLCHAIN,
  MWCC_PPC_TOOLCHAIN,
  type MwccToolchainId,
  TOOLCHAIN,
  mwccDir,
} from './toolchain';

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
  if (e.code === 'ENOBUFS') {
    return `'${cmd}' wrote more output than the ${SPAWN_BUFFER / (1024 * 1024)} MiB this harness reads`;
  }
  return (
    `cannot run '${cmd}' (${e.code ?? e.message}) — not installed, or its pinned-toolchain ` +
    `default path doesn't exist on this machine. Toolchain binaries resolve from ASMLIFT_* env ` +
    `vars with sibling-checkout defaults; see packages/cli/CONTRIBUTION.md#the-pinned-toolchains.`
  );
}

/** A candidate compile step that exited nonzero, as the ranking driver must see it: core's
 *  `CompilerRejection` when the tool ran to completion and said no, a plain `Error` when a signal
 *  killed it — the half-printed diagnostics of a killed compiler have the shape of a rejection and
 *  are not one (core stillborn.ts reads rejections only). */
function refused(what: string, r: { status: number | null; stderr: string; stdout: string }): Error {
  const output = r.stderr || r.stdout;
  return r.status === null
    ? new Error(`${what} did not run to completion — transient, not a rejection:\n${output}`)
    : new CompilerRejection(`${what} failed: ${output}`, output);
}

/** How much output one spawn may write. Node's default is a mebibyte, and an object carrying a big
 *  data table dumps past it: Pikmin's `system.cpp` includes `bigFont.h`, whose target's
 *  `objdump -s -r -t` is over 1 MiB of hex. */
const SPAWN_BUFFER = 256 * 1024 * 1024;

/** Spawn helper shared by every toolchain invocation (asmdata.ts uses it too). Throws the
 *  named setup error above when the binary itself couldn't run; compile failures (nonzero
 *  status, real stderr) still return for the caller to diagnose. */
export function run(cmd: string, args: string[], env?: Record<string, string>) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: SPAWN_BUFFER,
  });
  if (r.error) {
    throw new Error(spawnFailure(cmd, r.error));
  }
  return r;
}

// ── agbcc / ARM ───────────────────────────────────────────────────────────────────────────
// agbcc is `cc1`: it takes PREPROCESSED C, and its lexer cannot even skip a comment (a `/*` is
// `syntax error before '/'`). So the preprocessor is not optional here — but it is only WORK
// where the text has something for it to do, and a CANDIDATE spelling almost never does: of the
// 7272 distinct sources the benchmark corpus enumerates, 7252 skip it and `cpp -P -nostdinc`
// hands back every one of those byte for byte. The 20 that do not all name a libgcc callee like
// `__ashrdi3`; the other text this compiler is handed, the annotate-mode stub, is all comment and
// could never take the fast path.
//
// A REFERENCE source is a real translation unit and never plain here — 265 of the 311 only for
// want of a final newline, which `cpp` would add. Appending it here instead would buy those back;
// the flat "the preprocessor is the identity or it runs" rule is worth more than one target build
// per row.

/** Every construct the preprocessor acts on. A directive or operator (`#`), either comment, a
 *  backslash-newline splice, a trigraph, a CR — plus, below, any token `cpp` would expand as a
 *  predefined macro, which needs no `#` anywhere to fire. */
const PREPROCESSOR_SYNTAX = /#|\/\*|\/\/|\\\n|\?\?|\r/;
/** Whitespace the preprocessor REWRITES with nothing to expand: it deletes a blank line and a
 *  trailing run, collapses an interior run to one space, and turns a tab, form feed or vertical
 *  tab into one. What survives verbatim is a leading indent of spaces and single spaces between
 *  tokens — all the C backend prints, so this rejects nothing it emits. Without the clause the
 *  identity below is not the preprocessor's behaviour, only this corpus's. */
const NORMALIZED_WHITESPACE = /[\t\f\v]|[ ]\n|(^|\n)[ ]*\n|\S {2}/;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;
/** The namespace C reserves for the implementation, which is where a preprocessor built-in has
 *  to live (see `needsPreprocessing`). */
const RESERVED_IDENTIFIER = /^_[_A-Z]/;

/** The macros the preprocessor DECLARES with no input — its own `-dM` answer rather than a list
 *  in this file, because the set is the host toolchain's and a hardcoded copy would rot silently.
 *  Read once per process; an unreadable answer sends every source through the preprocessor, which
 *  is the behaviour without any of this. */
let predefines: ReadonlySet<string> | undefined;
let predefinesRead = false;
function predefinedMacros(): ReadonlySet<string> | undefined {
  if (!predefinesRead) {
    predefinesRead = true;
    const r = spawnSync('cpp', ['-dM', '-E', '-nostdinc', '/dev/null'], { encoding: 'utf8' });
    const names = r.status === 0 ? [...String(r.stdout).matchAll(/^#define (\w+)/gm)].map((m) => m[1]) : [];
    predefines = names.length > 0 ? new Set(names) : undefined;
  }
  return predefines;
}

/** Would `cpp -P -nostdinc` change these bytes? Over-answering `true` only costs the old path.
 *
 *  A macro expands with no `#` anywhere, and `-dM` is not the whole list: the BUILT-INs the
 *  preprocessor implements rather than defines — `__LINE__`, `__FILE__`, `__COUNTER__`,
 *  `__TIMESTAMP__`, `_Pragma`, `__has_include` — are absent from that answer and expand anyway
 *  (`__FILE__` bakes in the scratch path, so one spelling would not compile to the same bytes
 *  twice). A built-in has to live in the namespace C reserves for the implementation or it would
 *  break conforming programs, so RESERVED_IDENTIFIER covers them without enumerating them, and
 *  the `-dM` set is there for whatever a host declares outside that namespace. Struct padding
 *  (`_pad0`) is why the rule cannot simply be "starts with an underscore". */
export function needsPreprocessing(text: string): boolean {
  if (PREPROCESSOR_SYNTAX.test(text) || NORMALIZED_WHITESPACE.test(text) || !text.endsWith('\n')) {
    return true;
  }
  const macros = predefinedMacros();
  return (
    macros === undefined || (text.match(IDENTIFIER) ?? []).some((id) => RESERVED_IDENTIFIER.test(id) || macros.has(id))
  );
}

/** Write `text` as `<name>.c`, and the PREPROCESSED C the compiler reads as `<name>.pp.c`.
 *  Returns the latter — the same path, holding the same bytes, whichever way it got there. */
function writePreprocessed(dir: string, name: string, text: string): string {
  const cPath = join(dir, `${name}.c`);
  const ppPath = join(dir, `${name}.pp.c`);
  writeFileSync(cPath, text);
  if (needsPreprocessing(text)) {
    run('sh', ['-c', `cpp -P -nostdinc ${cPath} > ${ppPath} 2>/dev/null`]);
  } else {
    writeFileSync(ppPath, text);
  }
  return ppPath;
}

/** Compile candidate C with agbcc at `flags` + assemble; returns the object path. */
export function compileCandAgbcc(cSource: string, flags: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-score-'));
  const sPath = join(dir, 'cand.s');
  const oPath = join(dir, 'cand.o');
  const ppPath = writePreprocessed(dir, 'cand', C_TYPEDEFS + cSource);
  const cc = run(TOOLCHAIN.agbcc, [ppPath, '-o', sPath, ...TOOLCHAIN.harnessFlags, ...flags]);
  if (cc.status !== 0) {
    throw refused('agbcc', cc);
  }
  const as = run(TOOLCHAIN.as, [...TOOLCHAIN.asFlags, sPath, '-o', oPath]);
  if (as.status !== 0) {
    throw refused('as', as);
  }
  return oPath;
}

/** agbcc's candidate compiler at `flags`. The registry holds it at agbcc's canonical flags. */
export const agbccCandidateCompiler =
  (flags: readonly string[]): CandidateCompiler =>
  (source, _symbol, backendId) =>
    backendId === 'pascal' ? noPascal('agbcc') : compileCandAgbcc(source, flags);

registerCandidateCompiler('agbcc', agbccCandidateCompiler(TOOLCHAIN_TARGETS.agbcc.canonicalFlags));

/** Compile reference C with agbcc at `flags` and return its assembly text (the scoring target). */
export function compileTargetAsm(cSource: string, flags: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-ref-'));
  const sPath = join(dir, 'ref.s');
  const ppPath = writePreprocessed(dir, 'ref', C_TYPEDEFS + cSource);
  const cc = run(TOOLCHAIN.agbcc, [ppPath, '-o', sPath, ...TOOLCHAIN.harnessFlags, ...flags]);
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

/** A DUMP THAT SUCCEEDED AND SAID NOTHING IS A FAILURE THAT DID NOT SAY SO. Every objdump this
 *  package runs prints at least a `file format` header, so empty stdout on exit 0 is a step that
 *  died quietly — a container that never ran the binary, a truncated pipe — and nothing downstream
 *  notices: an empty disassembly parses as a function with no instructions, an empty
 *  `objdump -s -r -t` as a well-formed EMPTY AsmData. Guards the STEP, naming the invocation and
 *  the object it ran on; the benchmark states the same invariant over the `BuiltTarget` CONTRACT,
 *  for the producers this package does not own (apps/benchmark/src/toolchains.ts `checkedTarget`). */
export function nonEmptyDump(text: string, what: string): string {
  if (text.trim() === '') {
    throw new Error(`${what} exited 0 but produced NO output — refusing an empty dump`);
  }
  return text;
}

/** Compile reference C with IDO at `flags` → {obj (scoring target), asm (disassembly, frontend input)}. */
export function compileMipsTarget(
  cSource: string,
  symbol: string,
  flags: readonly string[],
): { obj: string; asm: string } {
  const dir = contentShareableDir('asmlift-mips-ref-', flags, cSource);
  const cPath = join(dir, 'ref.c');
  const oPath = join(dir, 'ref.o');
  writeFileSync(cPath, C_TYPEDEFS + cSource);
  const cc = run(IDO_TOOLCHAIN.cc, [...IDO_TOOLCHAIN.harnessFlags, ...flags, '-o', oPath, cPath]);
  if (cc.status !== 0) {
    throw new Error(`ido cc failed: ${cc.stderr || cc.stdout}`);
  }
  const dis = run(IDO_TOOLCHAIN.objdump, [...IDO_TOOLCHAIN.objdumpFlags, scopedObjectPath(oPath, symbol, dir)]);
  if (dis.status !== 0) {
    throw new Error(`objdump failed: ${dis.stderr}`);
  }
  return { obj: oPath, asm: nonEmptyDump(dis.stdout, `ido objdump on ${oPath}`) };
}

/** Compile one C/`.i` file at `flags` → object with Mario Party 3's GCC 2.7.2 inside its linux/386
 *  container (pooled, with a one-shot `docker run` fallback) — the same shape as kmcCompile. `-B` +
 *  COMPILER_PATH point the old driver at its bundled `cc1` and binutils under the mounted dir. */
export function gcc272Compile(dir: string, srcC: string, outObj: string, flags: readonly string[]): void {
  const t = GCC272_TOOLCHAIN;
  const w = hostTmp(dir);
  if (w) {
    const name = poolName('gcc272', `${t.image}|${t.dir}`);
    const mounts = ['-v', `${t.dir}:/gcc272:ro`, '-v', '/tmp:/host-tmp'];
    const cc = poolExec(t.docker, t.image, name, mounts, [
      '-w',
      w,
      '-e',
      'COMPILER_PATH=/gcc272',
      name,
      '/gcc272/gcc',
      '-B',
      '/gcc272/',
      ...t.harnessFlags,
      ...flags,
      '-c',
      '-o',
      `${w}/${outObj}`,
      `${w}/${srcC}`,
    ]);
    if (cc) {
      if (cc.status !== 0) {
        throw new Error(`gcc 2.7.2 (docker) failed: ${cc.stderr || cc.stdout}`);
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
    `${t.dir}:/gcc272:ro`,
    '-v',
    `${dir}:/work`,
    '-w',
    '/work',
    '-e',
    'COMPILER_PATH=/gcc272',
    t.image,
    '/gcc272/gcc',
    '-B',
    '/gcc272/',
    ...t.harnessFlags,
    ...flags,
    '-c',
    '-o',
    `/work/${outObj}`,
    `/work/${srcC}`,
  ]);
  if (cc.status !== 0) {
    throw new Error(`gcc 2.7.2 (docker) failed: ${cc.stderr || cc.stdout}`);
  }
}

/** GCC 2.7.2 / MIPS — synthetic-tier target build at `flags`. The C→object step runs in the
 *  linux/386 container (gcc272Compile); the object is disassembled + scored on the host, mirroring
 *  the KMC path. */
export function compileMipsGcc272Target(
  cSource: string,
  symbol: string,
  flags: readonly string[],
): { obj: string; asm: string } {
  const { objdump, objdumpFlags } = GCC272_TOOLCHAIN;
  const dir = contentShareableDir('asmlift-mgcc272-ref-', flags, cSource);
  writeFileSync(join(dir, 'ref.c'), C_TYPEDEFS + cSource);
  gcc272Compile(dir, 'ref.c', 'ref.o', flags);
  const oPath = join(dir, 'ref.o');
  const dis = run(objdump, [...objdumpFlags, scopedObjectPath(oPath, symbol, dir)]);
  if (dis.status !== 0) {
    throw new Error(`objdump failed: ${dis.stderr}`);
  }
  return { obj: oPath, asm: nonEmptyDump(dis.stdout, `gcc 2.7.2 objdump on ${oPath}`) };
}

/** Compile candidate IDO Pascal (via `cc`→`upas`, routed by the `.p` extension) at `flags`; returns
 *  the object path. No C typedefs: Pascal source stands alone. */
export function compileCandIdoPascal(pascalSource: string, flags: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-mips-pas-'));
  const pPath = join(dir, 'cand.p'); // `.p` makes IDO's cc select the Pascal frontend
  const oPath = join(dir, 'cand.o');
  writeFileSync(pPath, pascalSource);
  const cc = run(IDO_TOOLCHAIN.cc, [...IDO_TOOLCHAIN.harnessFlags, ...flags, '-o', oPath, pPath], {
    USR_LIB: dirname(IDO_TOOLCHAIN.cc),
  });
  if (cc.status !== 0) {
    throw refused('ido pascal (upas)', cc);
  }
  return oPath;
}

/** Compile candidate C with IDO at `flags`; returns the object path. */
export function compileCandIdoC(cSource: string, flags: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-mips-score-'));
  const cPath = join(dir, 'cand.c');
  const oPath = join(dir, 'cand.o');
  writeFileSync(cPath, C_TYPEDEFS + cSource);
  const cc = run(IDO_TOOLCHAIN.cc, [...IDO_TOOLCHAIN.harnessFlags, ...flags, '-o', oPath, cPath]);
  if (cc.status !== 0) {
    throw refused('ido cc', cc);
  }
  return oPath;
}

/** IDO's candidate compiler at `flags`. The registry holds it at ido7.1's canonical flags. */
export const idoCandidateCompiler =
  (flags: readonly string[]): CandidateCompiler =>
  (source, _symbol, backendId) =>
    backendId === 'pascal' ? compileCandIdoPascal(source, flags) : compileCandIdoC(source, flags);

registerCandidateCompiler('ido', idoCandidateCompiler(TOOLCHAIN_TARGETS['ido7.1'].canonicalFlags));

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

export function gcc272Available(): boolean {
  return dockerAvailable() && existsSync(join(GCC272_TOOLCHAIN.dir, 'gcc'));
}

export function mkShareableTmp(prefix: string): string {
  return mkdtempSync(join('/tmp', prefix));
}

/** A DETERMINISTIC shareable scratch dir, keyed by the compile's flags and source: same inputs ⇒
 *  same path on every machine. Reference builds must use this, not mkShareableTmp — compilers bake
 *  the build path into the object (IDO writes it into .mdebug section BYTES), so a random or
 *  machine-specific dir makes the object, its dump and every published artifact embedding them
 *  differ per host. Same-input concurrent rebuilds write identical bytes (benign); one source at two
 *  flag sets gets two directories, so neither overwrites the other's object. */
export function contentShareableDir(prefix: string, flags: readonly string[], source: string): string {
  const key = JSON.stringify([flags, source]);
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

/** Compile `srcC` (a basename in `dir`) at `flags` to the object `outObj` with KMC GCC inside the
 *  container — pooled `docker exec` when `dir` is under /tmp, single-shot `docker run` otherwise.
 *  Throws on failure. Exported for the benchmark's real-tier compile
 *  (apps/benchmark/src/compile/kmc.ts), so it pools through the same helper. */
export function kmcCompile(dir: string, srcC: string, outObj: string, flags: readonly string[]): void {
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
      ...t.harnessFlags,
      ...flags,
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
    ...t.harnessFlags,
    ...flags,
    '-c',
    '-o',
    `/work/${outObj}`,
    `/work/${srcC}`,
  ]);
  if (cc.status !== 0) {
    throw new Error(`kmc gcc (docker) failed: ${cc.stderr || cc.stdout}`);
  }
}

/** Compile reference C with KMC GCC at `flags` → {obj (scoring target), asm (disassembly, frontend
 *  input)}. */
export function compileMipsGccTarget(
  cSource: string,
  symbol: string,
  flags: readonly string[],
): { obj: string; asm: string } {
  const t = GCC_KMC_TOOLCHAIN;
  const dir = contentShareableDir('asmlift-mgcc-ref-', flags, cSource);
  writeFileSync(join(dir, 'ref.c'), C_TYPEDEFS + cSource);
  kmcCompile(dir, 'ref.c', 'ref.o', flags);
  const oPath = join(dir, 'ref.o');
  const dis = run(t.objdump, [...t.objdumpFlags, scopedObjectPath(oPath, symbol, dir)]);
  if (dis.status !== 0) {
    throw new Error(`objdump failed: ${dis.stderr}`);
  }
  return { obj: oPath, asm: nonEmptyDump(dis.stdout, `kmc objdump on ${oPath}`) };
}

/** Compile candidate C with KMC GCC (dockerized) at `flags`; returns the object path. */
export function compileCandKmc(cSource: string, flags: readonly string[]): string {
  const dir = mkShareableTmp('asmlift-mgcc-score-');
  writeFileSync(join(dir, 'cand.c'), C_TYPEDEFS + cSource);
  kmcCompile(dir, 'cand.c', 'cand.o', flags);
  return join(dir, 'cand.o');
}

/** KMC GCC's candidate compiler at `flags`. The registry holds it at gcc2.7.2kmc's canonical flags. */
export const kmcCandidateCompiler =
  (flags: readonly string[]): CandidateCompiler =>
  (source, _symbol, backendId) =>
    backendId === 'pascal' ? noPascal('gcc') : compileCandKmc(source, flags);

registerCandidateCompiler('gcc', kmcCandidateCompiler(TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags));

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
export function ppcPoolCfg(mwcc: MwccToolchainId): { name: string; mounts: string[] } {
  const dir = mwccDir(mwcc);
  return {
    name: poolName('ppc', `${MWCC_PPC_TOOLCHAIN.image}|${dir}`),
    mounts: ['-v', `${dir}:/mwcc:ro`, '-v', '/tmp:/host-tmp'],
  };
}

/** The pooled container that runs the image's OWN tools with no CodeWarrior build mounted. The
 *  PowerPC objdump belongs to the image, not to any of the three compiler directories, so a dump
 *  that picked one of their pools would name a build it does not depend on — and would start that
 *  build's container to read an object it never compiled. */
export function ppcDumpPoolCfg(): { name: string; mounts: string[] } {
  return { name: poolName('ppc-dump', MWCC_PPC_TOOLCHAIN.image), mounts: ['-v', '/tmp:/host-tmp'] };
}

/** Are ALL three PPC-path prerequisites present: the Docker daemon, the LOCALLY-BUILT image
 *  (a `docker build` product — unlike the KMC path's public base image it would NOT auto-pull),
 *  and the bind-mounted proprietary CodeWarrior dir? Fixtures gate on this so a fresh checkout
 *  with the image un-built (or the mwcc dir absent) SKIPS cleanly instead of hard-failing
 *  inside `docker run`. */
export function ppcDockerAvailable(mwcc: MwccToolchainId): boolean {
  const t = MWCC_PPC_TOOLCHAIN;
  if (spawnSync(t.docker, ['info'], { encoding: 'utf8' }).status !== 0) {
    return false;
  }
  if (spawnSync(t.docker, ['image', 'inspect', t.image], { encoding: 'utf8' }).status !== 0) {
    return false;
  }
  return existsSync(join(mwccDir(mwcc), 'mwcceppc.exe'));
}

/** Run one shell command in a linux/386 container over `dir`: through the pool when `dir` is under
 *  the shared /tmp mount, else in a single-shot container that mounts it at /work. The proprietary
 *  CodeWarrior dir is mounted read-only at /mwcc. `script` is parameterized by the container-side
 *  path of `dir`, which differs between the two routes; `via` names the route that answered, so an
 *  empty result can be blamed on the right one. */
function ppcExec(mwcc: MwccToolchainId, dir: string, script: (W: string) => string): { out: string; via: string } {
  const t = MWCC_PPC_TOOLCHAIN;
  const w = hostTmp(dir);
  if (w) {
    const { name, mounts } = ppcPoolCfg(mwcc);
    const r = poolExec(t.docker, t.image, name, mounts, [name, 'sh', '-c', script(w)]);
    if (r) {
      if (r.status !== 0) {
        throw new Error(`mwcceppc (docker) failed: ${r.stderr || r.stdout}`);
      }
      return { out: r.stdout, via: 'pooled' };
    }
  }
  const r = run(t.docker, [
    'run',
    '--rm',
    '--platform',
    'linux/386',
    '-v',
    `${mwccDir(mwcc)}:/mwcc:ro`,
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
  return { out: r.stdout, via: 'one-shot' };
}

/** Compile `srcC` (a basename in `dir`) with mwcceppc-via-wibo at `flags` to `outObj`, and — when
 *  `disasm` — pipe the object through the PowerPC objdump in the same container, returning its text.
 *
 *  Exported for the benchmark's real-tier compile (apps/benchmark/src/compile/mwcc.ts), which owns
 *  its own scratch-directory policy and must not get the synthetic tier's typedef prelude: it
 *  compiles a PREPROCESSED project translation unit, whose types the project's own headers already
 *  declared. One container round trip for compile + dump, through the same pool. */
export function ppcCompile(
  mwcc: MwccToolchainId,
  dir: string,
  srcC: string,
  outObj: string,
  flags: readonly string[],
  disasm = false,
): string {
  const t = MWCC_PPC_TOOLCHAIN;
  const { out, via } = ppcExec(mwcc, dir, (W) => {
    const argv = [...t.harnessFlags, ...flags];
    const compile = `${t.wibo} /mwcc/mwcceppc.exe ${argv.map(shq).join(' ')} -o ${W}/${outObj} ${W}/${srcC}`;
    return disasm ? `${compile} && ${t.objdump} ${t.objdumpFlags.join(' ')} ${W}/${outObj}` : compile;
  });
  // a compile-only run legitimately prints nothing; only the piped objdump owes output
  return disasm ? nonEmptyDump(out, `ppc objdump (${via}) on ${dir}/${outObj}`) : out;
}

/** `objdump -d -r` on an object ALREADY in `dir` — the PowerPC objdump ships only inside the image,
 *  so re-reading an object (a section-scoped copy of one this path just built) needs the container
 *  too. */
export function ppcDisasmText(mwcc: MwccToolchainId, dir: string, objName: string): string {
  const t = MWCC_PPC_TOOLCHAIN;
  const { out, via } = ppcExec(mwcc, dir, (W) => `${t.objdump} ${t.objdumpFlags.join(' ')} ${W}/${objName}`);
  return nonEmptyDump(out, `ppc objdump (${via}) on ${dir}/${objName}`);
}
/** `objdump -t` on an object already in `dir`: its symbol table, sizes included. */
export function ppcSymbolTableText(mwcc: MwccToolchainId, dir: string, objName: string): string {
  const t = MWCC_PPC_TOOLCHAIN;
  const { out, via } = ppcExec(mwcc, dir, (W) => `${t.objdump} -t ${W}/${objName}`);
  return nonEmptyDump(out, `ppc objdump -t (${via}) on ${dir}/${objName}`);
}
// CodeWarrior flags carry spaces (e.g. `msg_show_realref off`), so quote each token for the shell.
function shq(s: string): string {
  return /[^\w/.,=-]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

/** The disassembly a read of `symbol` may legitimately see. `asm` is the whole-object dump the
 *  compile already produced in the same container; when the object holds several code sections —
 *  mwcc gives a translation unit one `.text` per part, all starting at address 0 — it is replaced by
 *  a dump of a copy holding only the section that defines `symbol`. A single-section object, which
 *  is every target the synthetic tier builds, keeps the dump it already has.
 *
 *  Exported beside `ppcCompile` for the same reason: the real tier compiles project units, and a
 *  project unit is exactly where several `.text` sections show up. */
export function ppcSectionScoped(
  mwcc: MwccToolchainId,
  dir: string,
  objName: string,
  symbol: string,
  asm: string,
): string {
  const obj = join(dir, objName);
  const scoped = scopedObjectPath(obj, symbol, dir);
  return scoped === obj ? asm : ppcDisasmText(mwcc, dir, basename(scoped));
}

/** Compile reference C with CodeWarrior at `flags` → {obj (scoring target), asm (disassembly,
 *  frontend input)}. */
export function compilePpcTarget(
  mwcc: MwccToolchainId,
  cSource: string,
  symbol: string,
  flags: readonly string[],
): { obj: string; asm: string } {
  const dir = contentShareableDir('asmlift-ppc-ref-', [mwcc, ...flags], cSource);
  writeFileSync(join(dir, 'ref.c'), C_TYPEDEFS + cSource);
  const asm = ppcCompile(mwcc, dir, 'ref.c', 'ref.o', flags, true);
  return { obj: join(dir, 'ref.o'), asm: ppcSectionScoped(mwcc, dir, 'ref.o', symbol, asm) };
}

/** Compile candidate C with CodeWarrior (dockerized wibo) at `flags`; returns the object path. */
export function compileCandPpc(mwcc: MwccToolchainId, cSource: string, flags: readonly string[]): string {
  const dir = mkShareableTmp('asmlift-ppc-score-');
  writeFileSync(join(dir, 'cand.c'), C_TYPEDEFS + cSource);
  ppcCompile(mwcc, dir, 'cand.c', 'cand.o', flags, false);
  return join(dir, 'cand.o');
}

/** CodeWarrior's candidate compiler at `flags`. The registry holds it at mwcc_242_81's canonical flags. */
export const mwccCandidateCompiler =
  (mwcc: MwccToolchainId) =>
  (flags: readonly string[]): CandidateCompiler =>
  (source, _symbol, backendId) =>
    backendId === 'pascal' ? noPascal('mwcc') : compileCandPpc(mwcc, source, flags);

// The registry is keyed by `TargetDescription.compiler`, which all three CodeWarrior builds spell
// `mwcc`, so it holds exactly one of them: the build with canonical flags to hold it at. The other
// two are real-tier-only — every path that compiles for them binds its build explicitly — and a
// registry entry naming a build they are not is why this one says which it is out loud.
registerCandidateCompiler('mwcc', mwccCandidateCompiler('mwcc_242_81')(TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags));

// ── C++ path (mangled-symbol harness) ─────────────────────────────────────────────────────
// mwcceppc is a C AND C++ compiler: the `.cp` extension selects the C++ frontend. A C++ target's
// symbol is MANGLED (`Vec::dot(Vec*)` → `dot__3VecFP3Vec`), so the scoring symbol is the mangled
// string, and objdiff aligns the candidate to the target by exactly that name. Same container,
// same flags — only the source extension differs: the compiler is one binary, the language is a
// flag (a future `target.language` field).

/** Compile reference C++ (`.cp`) with CodeWarrior at `flags` → {obj (scoring target), disasm
 *  (frontend input)}. */
export function compilePpcCppTarget(
  mwcc: MwccToolchainId,
  cppSource: string,
  symbol: string,
  flags: readonly string[],
): { obj: string; asm: string } {
  const dir = contentShareableDir('asmlift-ppc-cpp-ref-', [mwcc, ...flags], cppSource);
  writeFileSync(join(dir, 'ref.cp'), C_TYPEDEFS + cppSource);
  const asm = ppcCompile(mwcc, dir, 'ref.cp', 'ref.o', flags, true);
  return { obj: join(dir, 'ref.o'), asm: ppcSectionScoped(mwcc, dir, 'ref.o', symbol, asm) };
}

/** Compile candidate C++ (`.cp`) with CodeWarrior at `flags`; returns the object path. */
export function compileCandPpcCpp(mwcc: MwccToolchainId, cppSource: string, flags: readonly string[]): string {
  const dir = mkShareableTmp('asmlift-ppc-cpp-score-');
  writeFileSync(join(dir, 'cand.cp'), C_TYPEDEFS + cppSource);
  ppcCompile(mwcc, dir, 'cand.cp', 'cand.o', flags, false);
  return join(dir, 'cand.o');
}

// ── the project include tree, in CodeWarrior's dialect ─────────────────────────────────────
// The real tier vendors each row's PREPROCESSED translation unit, and a GameCube project's headers
// are written for mwcceppc: they branch on `__MWERKS__`, `__PPCGEKKO__` and the other macros only
// that front end declares, and they use CodeWarrior spellings a host `cpp` rejects outright. So the
// preprocessor that reads them has to be mwcceppc itself, which lives in the same container as the
// compiler — with the checkout mounted, because the unit's `-i` paths are relative to it.

export interface PpcPreprocessOptions {
  /** the CodeWarrior build whose front end reads the tree — the headers branch on its own macros */
  mwcc: MwccToolchainId;
  /** the project checkout: the directory the unit's `-i` paths resolve against */
  root: string;
  /** the translation unit to preprocess. Must live under /tmp, which is where the container reads
   *  and writes host-visible files. */
  srcPath: string;
  /** where the preprocessed text is written, beside `srcPath` under /tmp */
  outPath: string;
  /** the unit's preprocessor words: its `-i`/`-I` include paths and `-D`/`-d` macros, as the
   *  project's own build passes them */
  argv: readonly string[];
  /** the words the unit's build rule runs the compiler UNDER, relative to `root`. dtk projects put
   *  `build/tools/sjiswrap.exe` here, which converts the UTF-8 the repository stores to the
   *  Shift-JIS the compiler expects as the file is read. */
  wrapper?: readonly string[];
}

// ── #pragma, which mwcceppc's preprocessor consumes ─────────────────────────────────────────
// No preprocessing mode of mwcceppc writes a `#pragma` back out: `-E`, `-EP`, `-P` and
// `-preprocess` all execute the directive and drop it, and GC/1.3.2 has no option that keeps it.
// A vendored translation unit is then NOT the unit the project compiled, and the difference is not
// cosmetic. Measured on Animal Crossing's own headers: `include/types.h` declares the section every
// `__declspec(section "forcestrip")` names, so without it the blob does not compile at all
// (`unknown section name 'forcestrip'`), and `include/libc/math.h` wraps `floor`, `sqrtf` and the
// rest in `#pragma cplusplus on … reset`, so without it a C unit's calls to them lose their C++
// linkage — `floor__Fd` becomes `floor` — silently.
//
// So every directive is carried through as a MARKER: an identifier no program spells, on a line of
// its own directly below the directive, which the preprocessor passes through verbatim wherever the
// directive was live and drops with it wherever an `#if` made it dead. The directive itself stays,
// so what it does to preprocessing (`#pragma once`) still happens. The project's files cannot be
// edited, so each one holding a directive is shadowed, inside the container only, by a marked copy.
//
// THE COST, stated: a marked file is one line longer below each directive, so `__LINE__` expanded
// INSIDE that file after a directive reads one higher per directive above it. A row's own function
// is never in such a file (its unit is written fresh), so what this could move is a header's inline
// body, and the ROM gate is what would refuse the row if it did. `__FILE__` does NOT move: mwcceppc
// expands it to the basename, and the marked copy the unit is preprocessed from keeps the unit's
// own — which the ROM gate could not have caught, a string literal's address being a relocation.

const PRAGMA_MARKER = /^[ \t]*__asmlift_pragma_(\d+)__[ \t]*$/gm;
const PRAGMA_DIRECTIVE = /^[ \t]*#[ \t]*pragma\b/;

/** `text` with a marker line below every `#pragma` directive, each directive appended to
 *  `pragmas` so its marker's number indexes it. A directive continued over several lines with a
 *  backslash is one directive, marked after its last line. */
export function markPragmas(text: string, pragmas: string[]): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const continued = i > 0 && lines[i - 1].endsWith('\\');
    if (continued || !PRAGMA_DIRECTIVE.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    let end = i;
    while (end < lines.length - 1 && lines[end].endsWith('\\')) {
      end++;
    }
    const directive = lines.slice(i, end + 1);
    out.push(...directive, `__asmlift_pragma_${pragmas.length}__`);
    pragmas.push(directive.join('\n'));
    i = end;
  }
  return out.join('\n');
}

/** Preprocessed `text` with every marker line replaced by the directive it stands for. Throws when
 *  a marker survives anywhere else: the preprocessor joined it into a line, and the directive's
 *  place in the unit can no longer be told. */
export function restorePragmas(text: string, pragmas: readonly string[]): string {
  const restored = text.replace(PRAGMA_MARKER, (_, i: string) => pragmas[Number(i)]);
  const stray = /__asmlift_pragma_\d+__/.exec(restored);
  if (stray !== null) {
    throw new Error(`mwcceppc -EP moved the #pragma marker ${stray[0]} into a line of code`);
  }
  return restored;
}

/** The files under `root` holding a `#pragma` directive, relative to it: the ones a preprocess
 *  that reads the checkout has to see marked. */
function filesWithPragmas(root: string): string[] {
  const r = spawnSync('grep', ['-rlIE', '^[[:space:]]*#[[:space:]]*pragma', '--exclude-dir=.git', '.'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    throw new Error(`cannot search ${root} for #pragma directives: ${r.error?.message ?? r.stderr}`);
  }
  return r.stdout
    .split('\n')
    .filter((f) => f !== '')
    .map((f) => f.replace(/^\.\//, ''));
}

/** A preprocessed unit's BYTES as ASCII text, with every non-ASCII byte inside a narrow string literal
 *  written as the three-digit octal escape the compiler reads back as that same byte.
 *
 *  A vendored unit is carried as a string, and a dtk project's wrapper hands the compiler bytes that
 *  are not UTF-8: `sjiswrap` rewrites the repository's UTF-8 literals into Shift-JIS as the compiler
 *  reads them, so a Pikmin header's `"カーソル抜き"` reaches the preprocessor's output as bytes no
 *  string decoding round-trips. As escapes the same literal is plain text, and it compiles to the
 *  same object: measured on the whole of Pikmin's `piki.cpp`, 1,165 such characters, the escaped unit
 *  and the raw bytes build byte-identical objects under GC/1.2.5n.
 *
 *  The unit is read a byte at a time, the way the compiler reads it: `sjiswrap` already doubles a
 *  Shift-JIS trail byte that is a backslash, so no lead byte may swallow the byte after it here. A
 *  non-ASCII byte anywhere else — outside a literal, in a character constant or a wide literal, or
 *  right after a backslash — has no escape that means the same thing, and is refused. */
export function asciiLiterals(bytes: Uint8Array): string {
  const QUOTE = 0x22;
  const APOSTROPHE = 0x27;
  const BACKSLASH = 0x5c;
  const WIDE = 0x4c; // the `L` of `L"…"`
  let text = '';
  let literal: 'string' | 'wide string' | 'character constant' | undefined;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const at = `+0x${i.toString(16)}`;
    if (literal === undefined) {
      if (b >= 0x80) {
        throw new Error(`a non-ASCII byte outside any literal at ${at}, which no escape can spell`);
      }
      if (b === QUOTE) {
        literal = bytes[i - 1] === WIDE ? 'wide string' : 'string';
      } else if (b === APOSTROPHE) {
        literal = 'character constant';
      }
      text += String.fromCharCode(b);
    } else if (b === BACKSLASH) {
      if (bytes[i + 1] >= 0x80) {
        throw new Error(`a backslash before a non-ASCII byte at ${at}, which no escape can spell`);
      }
      text += String.fromCharCode(b, bytes[++i]);
    } else if (b >= 0x80) {
      if (literal !== 'string') {
        throw new Error(`a non-ASCII byte in a ${literal} at ${at}, which no escape can spell`);
      }
      text += `\\${b.toString(8).padStart(3, '0')}`;
    } else {
      if (b === (literal === 'character constant' ? APOSTROPHE : QUOTE)) {
        literal = undefined;
      }
      text += String.fromCharCode(b);
    }
  }
  return text;
}

/** Preprocess one translation unit with mwcceppc's own front end (`-EP`: expand, and strip the
 *  `#line` comments it would otherwise emit), returning the text — with every live `#pragma`
 *  directive of the unit and of the project files it reads still in place (see above).
 *
 *  A ONE-SHOT container, never the pool: the pool's mounts are fixed at `/mwcc` and `/tmp`, and this
 *  needs the checkout as well. It is also not in the measured loop — a unit is preprocessed once, at
 *  `bench vendor` time, and the runner then reads the frozen result. */
export function ppcPreprocess(opts: PpcPreprocessOptions): string {
  const t = MWCC_PPC_TOOLCHAIN;
  const out = hostTmp(opts.outPath);
  if (hostTmp(opts.srcPath) === null || out === null) {
    throw new Error(`mwcceppc preprocessing reads and writes under /tmp, not ${opts.srcPath} → ${opts.outPath}`);
  }
  const pragmas: string[] = [];
  const marked = mkdtempSync(join('/tmp', 'asmlift-ppc-pragmas-'));
  const unit = join(marked, basename(opts.srcPath));
  let r;
  try {
    // BYTE FOR BYTE, via latin1: a marked copy stands in for the project's own file, and what the
    // compiler reads from it must be what it would have read from the original. A unit or header a
    // dtk wrapper hands over in Shift-JIS is not UTF-8, and decoding it as UTF-8 turns every
    // multibyte character into U+FFFD before mwcceppc ever sees it. latin1 is the one encoding that
    // round-trips all 256 byte values, and a `#pragma` directive is ASCII either way.
    writeFileSync(unit, markPragmas(readFileSync(opts.srcPath).toString('latin1'), pragmas), 'latin1');
    const shadowMounts = filesWithPragmas(opts.root).flatMap((rel, i) => {
      const copy = join(marked, `${i}-${basename(rel)}`);
      writeFileSync(copy, markPragmas(readFileSync(join(opts.root, rel)).toString('latin1'), pragmas), 'latin1');
      return ['-v', `${copy}:/proj/${rel}:ro`];
    });
    const argv = [...t.harnessFlags, ...opts.argv, '-EP', `/unit/${basename(unit)}`, '-o', out];
    const wrapper = (opts.wrapper ?? []).map((w) => `/proj/${w}`);
    r = run(t.docker, [
      'run',
      '--rm',
      '--platform',
      'linux/386',
      '-v',
      `${mwccDir(opts.mwcc)}:/mwcc:ro`,
      '-v',
      `${opts.root}:/proj:ro`,
      '-v',
      `${marked}:/unit:ro`,
      ...shadowMounts,
      '-v',
      '/tmp:/host-tmp',
      '-w',
      '/proj',
      t.image,
      'sh',
      '-c',
      [t.wibo, ...wrapper, '/mwcc/mwcceppc.exe', ...argv].map(shq).join(' '),
    ]);
  } finally {
    rmSync(marked, { recursive: true, force: true });
  }
  if (r.status !== 0 || !existsSync(opts.outPath)) {
    throw new Error(`mwcceppc -EP failed: ${r.stderr || r.stdout}`);
  }
  let text;
  try {
    text = asciiLiterals(readFileSync(opts.outPath));
  } catch (e) {
    throw new Error(`mwcceppc -EP of ${opts.srcPath} cannot be vendored as text: ${(e as Error).message}`);
  }
  return restorePragmas(text, pragmas);
}
