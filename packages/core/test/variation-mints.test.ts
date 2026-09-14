// Every registered variation is minted, read off the type checker rather than off the text.
//
// Enumeration mints a candidate's name as a list of `Variation`s, so `pnpm typecheck` refuses a mint
// site that names an unregistered variation. What typing cannot see is the other direction: a
// registry entry that no mint site names any more. This file closes it.
//
// A MINT POSITION is a string literal whose contextual type accepts every `VariationName` (or every
// `SubjectVariationName`, `withSubject`'s first parameter) and does not accept an arbitrary
// `string`. The literal's value is the name minted there. Stated blind spots, each in the safe
// direction or asserted away:
//   - a mint position in dead code counts as minted;
//   - a name that reaches a mint position through a non-literal (a value read out of the registry)
//     does not count, so such a site turns this test red rather than green;
//   - a cast (`'x' as Variation`, or `{ variations: [...v, 'x'] } as Setting`, which the checker
//     only asks to be comparable) or an `any` would slip a name past the type gate, so no source
//     file outside the registry may assert a variation type or an object type with a property that
//     holds one (an `any` is not asserted: the core tsconfig is `strict`, so one has to be written);
//   - a mint position outside the two enumeration files — a definition's `seeAlso` is one — would
//     count as minting, so every file holding one is named below and a new one fails the roster.
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { VARIATION_TOKENS } from '../src/variation-tokens';

const CORE = join(import.meta.dirname, '..');
const SRC = join(CORE, 'src');

function readMintPositions(): { mints: Map<string, Set<string>>; casts: string[] } {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(CORE, 'tsconfig.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  )!;
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  const checker = program.getTypeChecker();
  const registry = program.getSourceFile(join(SRC, 'variation-tokens.ts'))!;
  const exported = checker.getExportsOfModule(checker.getSymbolAtLocation(registry)!);
  const typeNamed = (name: string): ts.Type => checker.getDeclaredTypeOfSymbol(exported.find((s) => s.name === name)!);
  const accepted = [typeNamed('VariationName'), typeNamed('SubjectVariationName')];
  const variationTypes = ['Variation', 'VariationName', 'SubjectVariation', 'SubjectVariationName'].map(typeNamed);
  const isVariation = (t: ts.Type): boolean =>
    !(t.flags & ts.TypeFlags.Never) && variationTypes.some((v) => checker.isTypeAssignableTo(t, v));
  /** A variation type, or an object type with a property holding one or a list of them. */
  const holdsVariation = (t: ts.Type): boolean =>
    isVariation(t) ||
    checker.getPropertiesOfType(t).some((p) => {
      const held = checker.getTypeOfSymbol(p);
      const element = checker.isArrayLikeType(held) ? checker.getIndexTypeOfType(held, ts.IndexKind.Number) : held;
      return element !== undefined && isVariation(element);
    });
  const isMintPosition = (node: ts.Expression): boolean => {
    const contextual = checker.getContextualType(node);
    return (
      contextual !== undefined &&
      !checker.isTypeAssignableTo(checker.getStringType(), contextual) &&
      accepted.some((t) => checker.isTypeAssignableTo(t, contextual))
    );
  };

  const mints = new Map<string, Set<string>>();
  const casts: string[] = [];
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(`${SRC}/`) || file === registry) {
      continue;
    }
    const where = relative(SRC, file.fileName);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (isMintPosition(node)) {
          mints.set(node.text, (mints.get(node.text) ?? new Set()).add(where));
        }
      } else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        if (holdsVariation(checker.getTypeFromTypeNode(node.type))) {
          casts.push(`${where}: ${node.getText(file)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { mints, casts };
}

/** The files that mint a candidate's name. */
const ENUMERATION = ['rank-variations.ts', 'rank.ts'];
/** The files that hold a mint position without minting: `seeAlso` cross-references a definition. */
const READERS = ['variation-definitions.ts'];

describe('closure over the typed mint sites', () => {
  const { mints, casts } = readMintPositions();

  test('every registered variation is minted by enumeration', () => {
    const minted = [...mints].filter(([, files]) => ENUMERATION.some((f) => files.has(f))).map(([name]) => name);
    expect(minted.sort()).toEqual(VARIATION_TOKENS.map((t) => t.name).sort());
  });

  test('every file holding a mint position is one of the files named above', () => {
    expect([...new Set([...mints.values()].flatMap((files) => [...files]))].sort()).toEqual(
      [...ENUMERATION, ...READERS].sort(),
    );
  });

  test('no source file asserts a variation type past the checker', () => {
    expect(casts).toEqual([]);
  });
});
