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
