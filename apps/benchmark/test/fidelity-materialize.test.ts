// The fidelity gate runs the PUBLISHED scripts with only the user placeholders filled in —
// this pins that substitution, especially the symbol-fed rows' PROJECT_PATH checkout
// placeholder (whatever repoDir it names) landing as the resolved project root.
import { describe, expect, test } from 'vitest';

import { M2C_DIR, REPO_ROOT } from '../src/config';
import { materialize } from '../src/run/fidelity';

const SCRIPT = `#!/usr/bin/env bash
M2C_PATH='/path/to/m2c'
ASMLIFT_PATH='/path/to/asmlift'
PROJECT_PATH='/path/to/klonoa-empire-of-dreams'
pnpm --dir "$ASMLIFT_PATH" bench target kleod:Foo:agbcc --out "$PWD" --project-root "$PROJECT_PATH" 1>&2
`;

describe('fidelity materialize', () => {
  test('fills every placeholder: m2c + asmlift checkouts, and the project root when given', () => {
    const s = materialize(SCRIPT, '/tmp/checkouts/klonoa-empire-of-dreams');
    expect(s).toContain(`M2C_PATH='${M2C_DIR}'`);
    expect(s).toContain(`ASMLIFT_PATH='${REPO_ROOT}'`);
    expect(s).toContain(`PROJECT_PATH='/tmp/checkouts/klonoa-empire-of-dreams'`);
    expect(s).not.toContain('/path/to/');
  });

  test('substitutes the placeholder regardless of the repoDir it names', () => {
    const other = SCRIPT.replace(
      "PROJECT_PATH='/path/to/klonoa-empire-of-dreams'",
      "PROJECT_PATH='/path/to/marioparty3'",
    );
    expect(materialize(other, '/roots/mp3')).toContain("PROJECT_PATH='/roots/mp3'");
  });

  test('without a project root the placeholder stays — bench target then warns and runs map-less', () => {
    expect(materialize(SCRIPT)).toContain("PROJECT_PATH='/path/to/klonoa-empire-of-dreams'");
  });

  test('never touches scripts without the placeholder', () => {
    const plain = "ASMLIFT_PATH='/path/to/asmlift'\n";
    expect(materialize(plain, '/roots/x')).toBe(`ASMLIFT_PATH='${REPO_ROOT}'\n`);
  });
});
