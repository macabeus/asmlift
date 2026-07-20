// asmlift — input-text format classification. Each target's ecosystem produces a different
// textual artifact (agbcc emits GNU-as `.s`; IDO/mwcc emit no asm text, so their input is
// `objdump -d` output), and each frontend reads exactly one of them. Feeding the wrong one
// would otherwise fail confusingly deep in decode (an objdump header parsed as an instruction,
// or a crash on an empty CFG) — this module makes the mismatch a boundary decline instead.
//
// Classification is CONSERVATIVE: it only names a format on a positive signal, and a frontend
// only declines on a positive MISMATCH. Text with no recognizable signals (a bare fragment of
// hand-written instructions) stays "unknown" and flows through to the frontend — the
// decode-level loud-fail nets still own that case.
import { FrontendUnsupportedError } from './errors';

export type AsmTextFormat = 'objdump' | 'gnu-as';

const FORMAT_LABEL: Record<AsmTextFormat, string> = {
  objdump: 'objdump disassembly (`objdump -d --no-show-raw-insn` output)',
  'gnu-as': 'GNU-as assembly text (compiler-emitted `.s`)',
};

// objdump output: `ADDR <sym>:` section headers, address-prefixed instruction lines, or the
// `file format` banner. GNU-as text: assembler directives (`.text`, `.globl`, `.thumb_func`…).
const OBJDUMP_SIGNAL = /^[0-9a-f]{2,} <[^>]+>:|^\s+[0-9a-f]+:\t|file format /im;
const GNU_AS_SIGNAL =
  /^\s*\.(text|code|align|globl|global|thumb_func|section|syntax|arch|cpu|set|ent|type|size|file)\b/im;

/** Classify assembly TEXT by positive signals; "unknown" when neither (or both) match. */
export function classifyAsmText(text: string): AsmTextFormat | 'unknown' {
  const objdump = OBJDUMP_SIGNAL.test(text);
  const gnuAs = GNU_AS_SIGNAL.test(text);
  if (objdump === gnuAs) {
    return 'unknown';
  } // neither, or contradictory signals
  return objdump ? 'objdump' : 'gnu-as';
}

/** Decline loudly when the input positively classifies as a format this frontend does not
 *  read. Called at the top of every frontend's lift. */
export function assertInputFormat(frontendId: string, expected: AsmTextFormat, asm: string): void {
  const got = classifyAsmText(asm);
  if (got === 'unknown' || got === expected) {
    return;
  }
  throw new FrontendUnsupportedError(
    `cannot lift: input looks like ${FORMAT_LABEL[got]}, but the '${frontendId}' frontend reads ` +
      `${FORMAT_LABEL[expected]} — MIPS/PPC targets take objdump output; the ARM/agbcc target takes agbcc .s text`,
  );
}
