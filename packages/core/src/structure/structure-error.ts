// asmlift structurer — the loud decline. `StructureError` is what every part of the structurer
// throws where no correct spelling exists (structure.ts's header lists what is recovered and what
// is declined); a leaf of its own so the modules split out of structure.ts can raise it without
// importing the structuring entry point.

// Raised when the CFG contains control flow the structurer cannot recover (see the module scope
// note above for what IS recovered vs declined). It is an explicit, catchable "out of scope"
// signal — NOT a bug — so callers fail loud with a diagnostic instead of stack-overflowing.
export class StructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructureError';
  }
}
