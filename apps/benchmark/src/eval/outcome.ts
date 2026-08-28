// The symmetric outcome classifier: ONE rule set, applied identically to BOTH decompilers.
//
//   match / nonmatch — compiled, objdiff-scored
//   declined         — output bears explicit incompleteness markers; never compiled or scored
//                      (marker CALLS compile under C89 implicit declarations — scoring that
//                      object would grade meaningless code)
//   noncompile       — marker-FREE output that claims completeness but fails to compile; the row
//                      keeps the decompiled source AND the real compiler error
//   failed           — no usable output at all (crash, "Function not found", empty)
//
// The LABEL is symmetric; the CAUSE is not, and the shape of m2c's half CHANGED. It used to be
// context starvation: most real rows carried no `--context` at all, so m2c declined on `?`
// placeholders for types the project had written down. Every real row now carries one — 246 the
// project's vendored context, six a hand-written list of callees the headers omit (see
// cases/manifests.ts for the provisioning policy and its residuals) — and what survives is mostly
// a callee the CONTEXT does not declare either: `? func_80038388_38F88(?)`, 10 of the real tier's
// 15 m2c declines. The SYNTHETIC tier is unchanged and deliberately starved on both sides:
// neither tool gets project data there.
//
// Note the PRECEDENCE, because it moves rows between labels without anything getting better or
// worse: classification runs before any compile, so a decline marker outranks a compile failure.
// Output that both bears a `?` and would not compile reads as `declined`; remove the `?` by
// supplying the type and the SAME uncompilable construct then reads as `noncompile`. Neither
// label scores, so that flip is a reclassification, not a regression.
// Explicit incompleteness markers a decompiler emits where it KNOWS it has a gap
// (classification runs BEFORE any compile — see the header).
import { pickDiagnostics } from '../compile/util';

const DECLINE_MARKERS: { name: string; re: RegExp }[] = [
  { name: 'ASMLIFT_ERROR', re: /ASMLIFT_ERROR/ }, // asmlift annotate-mode gap marker
  { name: 'M2C_ERROR', re: /M2C_ERROR/ }, // m2c undecodable instruction / unhandled construct
  { name: 'M2C_UNK', re: /M2C_UNK/ }, // m2c unknown value
  { name: 'M2C_CARRY', re: /M2C_CARRY/ }, // m2c carry flag it cannot model in C
  // m2c's `(bitwise T)` pseudo-cast — deliberately-invalid syntax for a reinterpret it cannot
  // express in C (soft-float helper returns); the same cannot-express signal as M2C_CARRY
  { name: 'M2C bitwise cast', re: /\(bitwise / },
  // m2c's unknown-TYPE placeholder `?` — its explicit needs-context signal. Anchored to m2c's
  // declaration shapes (`extern ?`, line-start decls, right after `(`/`{`/`,`); a single-line
  // ternary cannot match these anchors, and m2c's formatter never wraps a ternary to line start.
  { name: '? placeholder', re: /extern \?/ },
  { name: '? placeholder', re: /^\? /m },
  { name: '? placeholder', re: /\b(?:static|extern|const) \? / },
  { name: '? placeholder', re: /\(\? *\*/ },
  { name: '? placeholder', re: /[({,] *\? [A-Za-z_*]/ },
];

/** Names of the decline markers present in `source` (deduped), or [] when marker-free. */
export function declineMarkersIn(source: string): string[] {
  const names: string[] = [];
  for (const { name, re } of DECLINE_MARKERS) {
    if (re.test(source) && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/** m2c produced no usable output at all: its own crash block or a missing-function report.
 *  (An empty stdout / nonzero exit is handled by the runner, which sees the process.) */
export function isHardFailure(source: string): boolean {
  return /Decompilation failure/.test(source) || /Function \S+ not found/.test(source);
}

/** The compiler diagnostics inside a captured error string (pickDiagnostics selection, capped;
 *  falls back to the first non-empty line so the marker is never empty). Scratch-dir paths
 *  collapse to `<tmp>/`: an unchanged row must re-run to the IDENTICAL marker, or committed
 *  artifacts churn on temp-dir names. */
export function compilerErrorLines(msg: string): string[] {
  const lines = msg
    .split('\n')
    .map((l) => l.trim().replace(/\S*\/(?:asmlift|bench)-[A-Za-z0-9-]+\//g, '<tmp>/'))
    .filter(Boolean);
  const diags = pickDiagnostics(lines);
  const picked = (diags.length > 0 ? diags : lines.slice(0, 1)).slice(0, 5).map((l) => l.slice(0, 240));
  return picked.length > 0 ? picked : ['unknown error'];
}
