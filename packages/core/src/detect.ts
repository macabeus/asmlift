// asmlift — small pure helpers over raw asm TEXT (no parsing): shared by the CLI and the
// web playground, which both need a function name before they can call `decompile`.

/** Best-effort function-name detection: the objdump symbol header, else Splat's `glabel` marker,
 *  else the `.globl` name, else the first label. Returns undefined when the asm names nothing
 *  (caller asks the user). Returns the FIRST function in multi-function input, matching how the
 *  objdump header case auto-selects. */
export function detectName(asm: string): string | undefined {
  return (
    asm.match(/^[0-9a-f]+ <([\w.$]+)>:/m)?.[1] ??
    asm.match(/^\s*glabel\s+([\w.$]+)/m)?.[1] ??
    asm.match(/^\s*\.globl\s+([\w.$]+)/m)?.[1] ??
    asm.match(/^([A-Za-z_]\w*):/m)?.[1]
  );
}
