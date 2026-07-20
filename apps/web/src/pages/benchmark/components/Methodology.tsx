import type { FunctionResult } from '@asmlift/bench-schema';

import { TOOLCHAIN_LABEL } from '../theme';

// Toolchains/projects below are derived from the loaded rows — the dataset is the source of
// truth. Only this asm-format label is a static map.
const ASM_FORMAT: Record<string, string> = { arm: 'textual agbcc .s', mips: 'objdump -d', ppc: 'objdump -d' };

function toolchainsOf(rows: FunctionResult[]) {
  const seen = new Map<string, { id: string; isa: string; compiler: string; cases: number }>();
  for (const r of rows) {
    const t = seen.get(r.toolchain) ?? { id: r.toolchain, isa: r.isa, compiler: r.compiler, cases: 0 };
    t.cases++;
    seen.set(r.toolchain, t);
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function projectsOf(rows: FunctionResult[]) {
  const seen = new Map<string, { name: string; cases: number; repo?: string }>();
  for (const r of rows) {
    if (r.tier !== 'real') {
      continue;
    }
    const p: { name: string; cases: number; repo?: string } = seen.get(r.project) ?? { name: r.project, cases: 0 };
    p.cases++;
    p.repo ??= r.sourceUrl?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+/)?.[0];
    seen.set(r.project, p);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function H({ children }: { children: React.ReactNode }) {
  return <h3 className="text-lg font-semibold text-white mt-2 mb-1">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-slate-300">{children}</p>;
}

export function Methodology({ rows }: { rows: FunctionResult[] }) {
  const toolchains = toolchainsOf(rows);
  const projects = projectsOf(rows);
  return (
    <div className="max-w-3xl space-y-6">
      <section>
        <H>The dataset</H>
        <P>
          Every function in the benchmark is one of two kinds. <strong>Synthetic functions</strong> are small C
          functions we authored, each targeting one feature (arithmetic, loops, struct access, soft-div idioms, …) so
          the ground truth is fully known. <strong>Real functions</strong> are matched functions taken verbatim from
          community decompilation projects — real game-code shapes, each linked to its exact source lines on GitHub:
        </P>
        <div className="mt-2 flex flex-wrap gap-2">
          {projects.map((p) =>
            p.repo ? (
              <a
                key={p.name}
                href={p.repo}
                target="_blank"
                rel="noreferrer"
                className="rounded-md bg-slate-800/60 px-2.5 py-1 font-mono text-xs text-teal-300 hover:bg-slate-700/60"
              >
                {p.name} · {p.cases}
              </a>
            ) : (
              <span key={p.name} className="rounded-md bg-slate-800/60 px-2.5 py-1 font-mono text-xs text-slate-300">
                {p.name} · {p.cases}
              </span>
            ),
          )}
        </div>
      </section>

      <section>
        <H>How a function is measured</H>
        <P>
          The reference C is compiled once with the benchmark's pinned toolchain, producing a target object and its
          assembly text (the compiler's own <span className="font-mono">.s</span> on ARM,{' '}
          <span className="font-mono">objdump</span> disassembly on MIPS/PPC). Both decompilers work from that same text
          — asmlift reads it directly; m2c receives it translated to the GNU-as form it parses, with jump-table data
          recovered from the object. Each decompiler's output is then recompiled with the same toolchain and compared
          against the target with <span className="font-mono">objdiff</span> — identical inputs in, identical scoring
          out. Score 0 is a <em>match</em> (byte-exact); a positive score is a <em>non-match</em>; output that claims
          completeness but will not compile is <em>non-compile</em>; output carrying explicit gap markers (
          <span className="font-mono">ASMLIFT_ERROR</span>, <span className="font-mono">M2C_ERROR</span>,{' '}
          <span className="font-mono">?</span>) is <em>declined</em>; no usable output is <em>failed</em>. One
          classifier judges both decompilers.
        </P>
      </section>

      <section>
        <H>What each decompiler is given</H>
        <P>
          For synthetic functions, both decompilers get only the function's declared signature — its name, return type
          and parameter types, nothing else: no struct layouts, no global variable types. That half measures raw
          recovery from assembly. For real functions where that signature alone left m2c declining, m2c additionally
          receives the project's own headers via <span className="font-mono">--context</span>. The boundary is firm:
          contexts contain exactly what the project declares, never authored types. Remaining declines are genuine
          capability gaps on both sides.
        </P>
      </section>

      <section>
        <H>The four toolchains</H>
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-800/60 text-left text-xs uppercase text-slate-400">
                <th className="px-3 py-2">Toolchain</th>
                <th className="px-3 py-2">ISA</th>
                <th className="px-3 py-2">Compiler</th>
                <th className="px-3 py-2">Asm format</th>
              </tr>
            </thead>
            <tbody>
              {toolchains.map((t) => (
                <tr key={t.id} className="border-t border-slate-800">
                  <td className="px-3 py-2 font-mono text-slate-200">
                    {TOOLCHAIN_LABEL[t.id as keyof typeof TOOLCHAIN_LABEL] ?? t.id}
                  </td>
                  <td className="px-3 py-2 uppercase text-slate-400">{t.isa}</td>
                  <td className="px-3 py-2 text-slate-400">{t.compiler}</td>
                  <td className="px-3 py-2 font-mono text-slate-400">{ASM_FORMAT[t.isa]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <H>Secondary measurements</H>
        <P>
          Each output also gets a 0–100 readability score (penalizing gotos, redundant casts, and undecompiled glue — a
          proxy for how much a human would rewrite), and non-matching functions record their <em>gap size</em>: the best
          compiling candidate's objdiff diff.
        </P>
      </section>

      <section>
        <H>Regenerating the data</H>
        <P>
          This view renders a committed <span className="font-mono">results.json</span>; regenerate it with{' '}
          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-teal-300">pnpm bench run</span> then{' '}
          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-teal-300">pnpm bench merge</span>.
        </P>
      </section>
    </div>
  );
}
