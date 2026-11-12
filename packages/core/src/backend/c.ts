// asmlift — the C language backend. Consumes the language-NEUTRAL L3 AST and owns ALL C spelling.
// Text is produced ONLY by a precedence-aware printer over the typed AST — never by string-
// concatenating over IR ops.
//
// Expression/statement/type spelling lives in backend/cfamily.ts, shared with the C++ backend;
// this backend owns only the C SIGNATURE line. The Pascal backend implements the same
// LanguageBackend interface over the same L3 with its OWN spelling.
import { LanguageBackend, SFn } from '../l3/ast';
import { nameVariables } from '../l3/names';
import { cComment, cDeclare, cType, emitCFamily } from './cfamily';

export { cComment }; // re-export: the shared spelling lives in cfamily.ts

export const cBackend: LanguageBackend = {
  id: 'c',
  spellsSwitchFallthrough: true,
  spellsSwitchBreak: true,
  spellsEarlyReturn: true,
  emit(fn0: SFn): string {
    const print = (fn: SFn): string => {
      // The SAME declarator placement the local list and the struct-field printer use, so one
      // function cannot spell the `*` on the type in its signature and on the declarator in its
      // body.
      const params = fn.params.map((p) => cDeclare(p.type, p.name)).join(', ') || 'void';
      return emitCFamily(`${cType(fn.retType)} ${fn.name}(${params})`, fn);
    };
    // The names a reader would give the parameters and locals (l3/names.ts), checked against every
    // identifier the function prints under the structurer's own names; here, at emit, for the reason
    // the slot order is (l3/slotorder.ts).
    let plain: string | undefined;
    const fn = nameVariables(fn0, () => (plain ??= print(fn0)));
    return fn === fn0 ? (plain ?? print(fn0)) : print(fn);
  },
  comment: cComment,
};
