// asmlift — the shared DESIGNED loud-failure signal for RAISE passes (the frontend twin is
// `FrontendUnsupportedError`). A raise pass throws this when it meets a shape it cannot faithfully
// recover (an overlapping/packed struct layout, …). The class stays distinct from the frontend's
// so `stageOf` (pipeline.ts) routes a raise decline to the "raise" Diagnostic stage, not "lift".
export class RaiseUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RaiseUnsupportedError';
  }
}

/** The one raise refusal a caller ACTS ON rather than only reporting: raise/structs.ts cannot
 *  reproduce a layout because two accesses' byte ranges COLLIDE, and for a base whose address is
 *  declared outside the function that is not a reason to decline — each access is spellable on its
 *  own. A CLASS rather than a substring test on the message, because the two facts a caller needs
 *  (which refusal this is, and what to tell the reader) would otherwise be the same string, and the
 *  guard would then fall open the day the message is reworded. The only raise refusal outside this
 *  class today is raise/structs.ts's packed-layout throw, which stays a plain
 *  RaiseUnsupportedError and declines — a subclass is minted for a caller that acts on it, not for
 *  every refusal that wants a name. */
export class StructOverlapError extends RaiseUnsupportedError {
  constructor(message: string) {
    super(message);
    this.name = 'StructOverlapError';
  }
}
