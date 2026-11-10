import { describe, expect, test } from 'vitest';

import * as targets from '../src/target';
import type { CompilerBehaviors, TargetDescription } from '../src/target';

// EVERY EXPORTED TARGET'S `compilerBehaviors`, written out in full, field by field, grouped as the
// interfaces in target.ts group them. A target that inherits by spread (PPC_MWCC_233 and
// PPC_MWCC_247 take PPC_MWCC's) is written out too, not derived from its base, so a change to one
// base flag fails here once for the base and once for each target that inherits it. That is the
// point: a flag changed for one build reaches every build that shares the description, and this
// table makes the author restate each of them. Flags that `targetFor` changes from the codegen
// flags are not here; codegen-flags.test.ts pins those (`FLAG_MADE`).
const BEHAVIORS: Record<string, CompilerBehaviors> = {
  ARMV4T_AGBCC: {
    // ControlFlowBehaviors
    coalesceLoopInit: false,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
    hoistsSingleSetArm: true,
    farJumpRelay: { comment: /^@\s*far jump\s*$/ },
    switchBoundCase: 'taken',
    switchArmsFollowLayout: true,
    switchRequiresFrontLoadedTests: true,
    crossJumpsReturnTails: true,
    // FrameLayoutBehaviors
    spillSlotOrder: 'ascending',
    addressTakenArrayOrder: 'ascending',
    addressTakenArrayAlignment: 4,
    stagesOutgoingArgsInFrame: true,
    localsAboveOutgoingArea: true,
    outgoingAreaNeverLoadedFrom: 0,
    oneWordFrameIsTheCapturedObject: true,
    escapedFrameAddressNamesALocal: true,
    // CallBehaviors
    eightByteReturnScratch: 'r2',
    callThunks: {
      prefix: '_call_via_',
      regs: ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'sl', 'fp', 'ip'],
    },
    aggregateReturn: 'apcs',
    structReturnHandsBackPointer: true,
    forwardsStructReturnDestination: false,
    byValueAggregateArgWords: true,
    discardedReadMayFillArgRegister: true,
    // LoadBehaviors
    narrowParamWitness: 'prologue-extension',
    readsStayWhereWritten: true,
    reloadsLocalReread: true,
    narrowStoreConstantTakesLvalueType: true,
    plainCharSigned: false,
    volatileReadsExtendInRegister: true,
    // SpellingBehaviors
    arrayShapeFromStride: true,
    designatedInitializers: true,
    nearBaseSpan: 255,
    foldsConstAddrOffset: true,
    farMemberStoreOrder: true,
    farMemberBasePerAccess: { past: 0 },
    foldsPointerAdvance: true,
    pointerIntConversionIsFree: true,
    keepsPointerSumAddend: true,
    roundTripsDoubleLiterals: true,
    // AggregateLayoutBehaviors
    aggregateBoundary: 4,
    largestAlignment: 4,
    enumBytes: 4,
    bitfieldPacking: 'contiguous',
    staticLayout: { aggregateAlign: 1, stringAlign: 4, zeroScalar: 'data' },
  },
  MIPS_IDO: {
    // ControlFlowBehaviors
    coalesceLoopInit: true,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
    switchAllowsNeqCase: false,
    // FrameLayoutBehaviors
    spillSlotOrder: 'unknown',
    addressTakenArrayOrder: 'descending',
    addressTakenArrayAlignment: 4,
    localsAboveOutgoingArea: true,
    outgoingAreaNeverLoadedFrom: 16,
    o32LocalArea: 'above-saved-registers',
    // CallBehaviors
    aggregateReturn: 'memory',
    structReturnHandsBackPointer: true,
    forwardsStructReturnDestination: true,
    byValueAggregateArgWords: true,
    discardedReadMayFillArgRegister: false,
    // LoadBehaviors
    narrowParamWitness: 'home-store-and-in-place',
    reloadsLocalReread: false,
    narrowStoreConstantTakesLvalueType: true,
    plainCharSigned: false,
    reloadsAcrossSpellings: true,
    discardsUnusedReadsInto: 'zero',
    // SpellingBehaviors
    farMemberBasePerAccess: { past: 32767 },
    contractsFloatProducts: false,
    // AggregateLayoutBehaviors
    aggregateBoundary: 1,
    largestAlignment: 8,
  },
  MIPS_GCC: {
    // ControlFlowBehaviors
    coalesceLoopInit: true,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
    switchRequiresFrontLoadedTests: true,
    crossJumpsReturnTails: true,
    foldsBranchConstantOnTakenEdge: true,
    // FrameLayoutBehaviors
    spillSlotOrder: 'unknown',
    addressTakenArrayOrder: 'ascending',
    addressTakenArrayAlignment: 8,
    localsAboveOutgoingArea: true,
    outgoingAreaNeverLoadedFrom: 16,
    o32LocalArea: 'above-outgoing-area',
    // CallBehaviors
    aggregateReturn: 'memory',
    structReturnHandsBackPointer: true,
    forwardsStructReturnDestination: false,
    byValueAggregateArgWords: true,
    discardedReadMayFillArgRegister: true,
    // LoadBehaviors
    narrowParamWitness: 'none',
    reloadsLocalReread: false,
    narrowStoreConstantTakesLvalueType: true,
    plainCharSigned: true,
    // SpellingBehaviors
    designatedInitializers: true,
    keepsPointerSumAddend: true,
    contractsFloatProducts: false,
    // AggregateLayoutBehaviors
    aggregateBoundary: 1,
    largestAlignment: 8,
  },
  PPC_MWCC: {
    // ControlFlowBehaviors
    coalesceLoopInit: false,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
    switchBoundCase: 'either',
    switchRequiresFrontLoadedTests: true,
    joinPastReturnsByDefault: true,
    // FrameLayoutBehaviors
    spillSlotOrder: 'unknown',
    localsAboveOutgoingArea: true,
    outgoingAreaNeverLoadedFrom: 8,
    linkageLocalArea: 'above-outgoing-area',
    // CallBehaviors
    aggregateReturn: 'svr4',
    structReturnHandsBackPointer: false,
    forwardsStructReturnDestination: false,
    discardedReadMayFillArgRegister: true,
    // LoadBehaviors
    narrowParamWitness: 'prologue-extension',
    reloadsLocalReread: false,
    narrowStoreConstantTakesLvalueType: true,
    plainCharSigned: true,
    discardsUnusedReadsInto: 'r0',
    // SpellingBehaviors
    strictPointerConversions: true,
    contractsFloatProducts: true,
    // AggregateLayoutBehaviors
    aggregateBoundary: 1,
    largestAlignment: 8,
    staticLayout: {
      aggregateAlign: 4,
      stringAlign: 4,
      zeroScalar: 'bss',
      uninitOrder: { '.sbss': 'reversed', '.bss': 'first-use' },
    },
  },
  PPC_MWCC_233: {
    // ControlFlowBehaviors
    coalesceLoopInit: false,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
    switchBoundCase: 'either',
    switchRequiresFrontLoadedTests: true,
    joinPastReturnsByDefault: true,
    // FrameLayoutBehaviors
    spillSlotOrder: 'unknown',
    localsAboveOutgoingArea: true,
    outgoingAreaNeverLoadedFrom: 8,
    linkageLocalArea: 'above-outgoing-area',
    // CallBehaviors
    aggregateReturn: 'svr4',
    structReturnHandsBackPointer: false,
    forwardsStructReturnDestination: false,
    discardedReadMayFillArgRegister: true,
    // LoadBehaviors
    narrowParamWitness: 'prologue-extension',
    reloadsLocalReread: false,
    narrowStoreConstantTakesLvalueType: true,
    plainCharSigned: true,
    discardsUnusedReadsInto: 'r0',
    // SpellingBehaviors
    strictPointerConversions: true,
    contractsFloatProducts: true,
    // AggregateLayoutBehaviors
    aggregateBoundary: 1,
    largestAlignment: 8,
    staticLayout: {
      aggregateAlign: 4,
      stringAlign: 4,
      zeroScalar: 'bss',
      uninitOrder: { '.sbss': 'reversed', '.bss': 'first-use' },
    },
  },
  PPC_MWCC_247: {
    // ControlFlowBehaviors
    coalesceLoopInit: false,
    preserveDivergentBranchSense: true,
    orderArgCopiesByWriteOrder: true,
    switchBoundCase: 'either',
    switchRequiresFrontLoadedTests: true,
    // FrameLayoutBehaviors
    spillSlotOrder: 'unknown',
    localsAboveOutgoingArea: true,
    outgoingAreaNeverLoadedFrom: 8,
    linkageLocalArea: 'above-outgoing-area',
    // CallBehaviors
    aggregateReturn: 'svr4',
    structReturnHandsBackPointer: false,
    forwardsStructReturnDestination: false,
    discardedReadMayFillArgRegister: true,
    // LoadBehaviors
    narrowParamWitness: 'prologue-extension',
    reloadsLocalReread: false,
    narrowStoreConstantTakesLvalueType: true,
    plainCharSigned: true,
    discardsUnusedReadsInto: 'r0',
    // SpellingBehaviors
    strictPointerConversions: true,
    contractsFloatProducts: true,
    // AggregateLayoutBehaviors
    aggregateBoundary: 1,
    largestAlignment: 8,
    staticLayout: {
      aggregateAlign: 4,
      stringAlign: 4,
      zeroScalar: 'bss',
      uninitOrder: { '.sbss': 'reversed', '.bss': 'first-use' },
    },
  },
};

const exportedTargets = (): [string, TargetDescription][] =>
  Object.entries(targets).filter(
    (e): e is [string, TargetDescription] =>
      typeof e[1] === 'object' && e[1] !== null && 'compilerBehaviors' in e[1] && 'capabilities' in e[1],
  );

describe("every exported target's compiler behaviors, resolved", () => {
  test('the table names exactly the exported targets', () => {
    expect(
      exportedTargets()
        .map(([name]) => name)
        .sort(),
    ).toEqual(Object.keys(BEHAVIORS).sort());
  });

  test.each(exportedTargets())('%s', (name, target) => {
    expect(target.compilerBehaviors).toStrictEqual(BEHAVIORS[name]);
  });
});
