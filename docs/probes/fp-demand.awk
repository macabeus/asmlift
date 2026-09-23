# ONE RECORD PER FUNCTION in a decomp project's remaining-work tree: a `glabel` whose body contains
# at least one INSTRUCTION. The instruction test is what excludes a data label — these trees put
# `.word`/`.float`/`.asciz` under `glabel` too — and the mnemonic is the first token AFTER the `*/`
# that closes spimdisasm's address/word comment. An anchorless or case-insensitive match reads the
# HEX column instead (`/* 4EC3C 8004E03C 27BDFFD8 */` yields `EC3C`) and reports near-zero.
/^[[:space:]]*glabel[[:space:]]/ { flush(); open=1; fp=0; call=0; conv=0; insn=0; next }
/^[[:space:]]*endlabel[[:space:]]/ { flush(); next }
open && /\*\// {
  n = index($0, "*/"); rest = substr($0, n+2); split(rest, w, /[[:space:]]+/);
  m = w[1]; if (m == "") m = w[2];
  if (m !~ /^[a-z]/) next            # a data directive (.word, .float) or a blank tail
  insn = 1
  if (m ~ /^(lwc1|swc1|ldc1|sdc1)$/) { fp = 1 }
  else if (m ~ /^(mfc1|mtc1|cfc1|ctc1|bc1[tf]l?)$/ ||
           m ~ /^(add|sub|mul|div|mov|neg|abs|c|cvt|trunc|round|ceil|floor|sqrt|recip|rsqrt)\.[sdwl]/) { fp = 1; conv = 1 }
  if (m ~ /^(jal|jalr)$/) { call = 1 }
}
function flush() {
  if (open && insn) {
    total++
    if (fp) { FP++; if (!call) FPNC++; if (!conv) { CARRY++; if (!call) CARRYNC++ } }
  }
  open = 0
}
END { printf "%-22s functions=%-7d fp=%-6d fp_no_call=%-5d carrier_only=%-5d carrier_no_call=%d\n", PROJ, total, FP, FPNC, CARRY, CARRYNC }
