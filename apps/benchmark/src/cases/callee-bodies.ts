// The bodies of a real row's callees that its translation unit does not hold, read off the project's
// linked ELF at vendor time and committed, so a row's lift is handed what the CLI hands it.
//
// WHY THE HARNESS NEEDS THEM. The CLI reads a guessed callee's body off `tools.asmlift.elf` and the
// core bounds the callee's arity by it (cli elf-bodies.ts). A row's published repro script runs the
// CLI in the project checkout, so it reads those bodies; the harness runs from the vendored dataset
// with no checkout, so it reads them from this file. Without them, a row whose lift asks such a body
// would publish different source from its repro for one input: kleod's WorldMapScreenUnlockNewWorld
// would spell a guessed argument for thunk_GetRandomValue, an ARM veneer whose body reads none.
//
// WHAT IS FROZEN: for every row outside a REL module, every direct callee its target does not
// define (cli `elfBodyCandidates`), and of each, the body the ELF gives (`calleeBodiesFromElf`) or
// its name under `unread` where it gives none. That is a superset of what any one lift reads
// (`elfBodyCallees`: the callees its declarations leave guessed), so the frozen set does not depend
// on today's prototypes, and a row's lift selects from it with the CLI's own rule
// (`selectCalleeBodies`). A callee the rule selects that the file names in neither list is a
// vendoring older than the rule, and REFUSES: handing the lift nothing there would publish the
// divergence this file exists to remove.
//
// ONE FILE PER PROJECT (`callee-bodies.json.gz` beside `symbols.json.gz`), a callee's body being the
// ELF's and not the row's. WHAT IS STABLE ACROSS MACHINES IS THE CONTENT, not the gzip bytes: the
// JSON is canonical (keys sorted at every depth, `unread` sorted), so the same bodies are the same
// text everywhere; the deflate stream is whatever the zlib build writes (Node's and a system zlib
// 1.3 differ at the same level), as for symbols.json.gz. So the writer leaves a file whose content
// is unchanged alone (`writeVendoredCalleeBodies`), and the drift check compares content
// (run/symbol-drift.ts `checkCalleeBodiesDrift`): a re-vendor on another host rewrites only what
// changed. A listing body is objdump text, and objdump's release decides it: `objdump` records the
// `--version` line of the one that read the listings without its package label
// (callee-bodies-elf.ts `objdumpVersion`: the distribution's, not the release's), null where none
// did (an agbcc project's bodies are ARM words out of the image), and the ELF's path in the
// listing's header line is written as decomp.yaml names it, never as this machine's.
//
// A REL module's row is handed none, as the CLI hands it none (`elfBodyCallees`).
import { elfBodyCallees } from '@asmlift/cli/elf-bodies';
import type { Reloc } from '@asmlift/core/frontend/asmdata';
import type { CalleeBodies, CalleeBody } from '@asmlift/core/frontend/callee-body';
import type { Prototypes } from '@asmlift/core/proto';
import type { SymbolMap } from '@asmlift/core/symbols';
import type { TargetDescription } from '@asmlift/core/target';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const CALLEE_BODIES_FILE = 'callee-bodies.json.gz';

/** A vendoring the harness cannot hand a lift what the CLI hands it from: older than the selection
 *  rule, or missing beside a vendored map. A HARNESS refusal, not a decompiler gap, and its own class
 *  so a driver that counts a row it cannot lift as a decompiler gap (run/gate-census.ts) can tell it
 *  apart and stay loud on it, as fan, sweep and the runner do. */
export class StaleCalleeBodies extends Error {}

/** A project's frozen callee bodies (see the header). */
export interface VendoredCalleeBodies {
  /** the `--version` line of the objdump that disassembled the listing bodies; null where none did */
  objdump: string | null;
  bodies: CalleeBodies;
  /** every callee a row asked whose range in the ELF gave no body */
  unread: readonly string[];
}

/** `v` with the keys of every object sorted, so one value has one spelling. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(canonical);
  }
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** The file's bytes for `v`: canonical JSON, gzipped with the header's OS byte (RFC 1952 §2.3, byte
 *  9) fixed at 3 (Unix), which zlib otherwise sets to the platform it was built for. */
export function calleeBodiesBytes(v: VendoredCalleeBodies): Buffer {
  const gz = gzipSync(Buffer.from(calleeBodiesJson(v)), { level: 9 });
  gz[9] = 3;
  return gz;
}

/** The canonical JSON text of `v`: the file's content, which is what holds across machines (see
 *  the header). */
export function calleeBodiesJson(v: VendoredCalleeBodies): string {
  return `${JSON.stringify(canonical({ objdump: v.objdump, bodies: v.bodies, unread: [...v.unread].sort() }))}\n`;
}

/** Write the project's frozen bodies into its vendored dir, or remove the file where the project
 *  has none to freeze (`undefined`: no linked ELF), so no file outlives what wrote it. A file that
 *  already holds `v` is left as it is, whatever zlib wrote it (see the header). */
export function writeVendoredCalleeBodies(dir: string, v: VendoredCalleeBodies | undefined): void {
  const path = join(dir, CALLEE_BODIES_FILE);
  if (v === undefined) {
    rmSync(path, { force: true });
    return;
  }
  if (existsSync(path) && gunzipSync(readFileSync(path)).toString('utf8') === calleeBodiesJson(v)) {
    return;
  }
  writeFileSync(path, calleeBodiesBytes(v));
}

/** The project's frozen bodies, out of its vendored dir.
 *
 *  Undefined for a project that vendors no symbol map, which is a project with no linked ELF: the
 *  CLI reads no bodies there either. A project that vendors a map and no bodies THROWS, because its
 *  rows would be lifted with none while `bench repro` reads them off the ELF. */
export function readVendoredCalleeBodies(
  project: string,
  dir: string,
  hasSymbolMap: boolean,
): VendoredCalleeBodies | undefined {
  const path = join(dir, CALLEE_BODIES_FILE);
  if (existsSync(path)) {
    const v = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as VendoredCalleeBodies;
    return { objdump: v.objdump, bodies: v.bodies, unread: v.unread };
  }
  if (!hasSymbolMap) {
    return undefined;
  }
  throw new StaleCalleeBodies(
    `${project}: a linked ELF is vendored (symbols.json.gz) but no callee bodies from it — ` +
      `run \`pnpm bench vendor --project ${project} --callee-bodies-only\``,
  );
}

/** The bodies a lift of `sym` is handed: of `vendored`, those of the callees the CLI's rule selects
 *  (cli `elfBodyCallees`, at the prototypes, map and relocations the lift reads), or undefined where
 *  none is. THROWS for a selected callee the vendoring names in neither list (see the header). */
export function selectCalleeBodies(
  asm: string,
  sym: string,
  target: TargetDescription,
  prototypes: Prototypes | undefined,
  symbols: SymbolMap | undefined,
  relocs: readonly Reloc[] | undefined,
  vendored: VendoredCalleeBodies,
): CalleeBodies | undefined {
  const out: Record<string, CalleeBody> = {};
  const unread = new Set(vendored.unread);
  for (const callee of elfBodyCallees(asm, sym, target, prototypes, symbols, relocs, undefined)) {
    const body = Object.hasOwn(vendored.bodies, callee) ? vendored.bodies[callee] : undefined;
    if (body !== undefined) {
      out[callee] = body;
    } else if (!unread.has(callee)) {
      throw new StaleCalleeBodies(
        `${sym}: its lift reads the body of ${callee} out of the linked ELF, and the vendored callee bodies ` +
          'name no such callee — re-run `pnpm bench vendor --callee-bodies-only` for its project',
      );
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
