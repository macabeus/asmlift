# Releasing `@asmlift/core` + `@asmlift/cli`

These are the only two public packages. Everything else in the workspace is `private: true`
(`packages/toolchains`, `packages/bench-schema`, `apps/*`), so a workspace-wide publish can only
ever touch these two.

## Build shape (it differs per package)

| package         | build                                                                  | ships                                                                  |
| --------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `@asmlift/core` | **none** — raw TS source (`exports` → `./src/*.ts`)                    | `src/`                                                                 |
| `@asmlift/cli`  | esbuild → `dist/asmlift.mjs` (the `bin`), also run by `prepublishOnly` | `dist/` **and** `src/`, so `@asmlift/cli/score` importers keep working |

## The gates

Run all of these from a clean tree on `main`, and read the **exit status**, not the tail of a
pipeline — `cmd | tail` reports `tail`'s status, which is how a failing suite has already been
mistaken for a passing one.

1. `pnpm run typecheck`
2. `pnpm run lint` — 0 errors (warnings are pre-existing)
3. `pnpm run format:check`
4. `pnpm run test:offline`
5. **`pnpm test` — the FULL suite, including the toolchain-backed matching tests.**
6. `pnpm bench run && pnpm bench merge && pnpm bench regression` — 0 lost, 0 missing.

### Why gate 5 is on this list

Gate 5 is the one hosted CI cannot run: `.github/workflows/ci.yml` stops at `test:offline`,
because the matching suite compiles real ARM/MIPS/PPC through toolchains that GitHub runners do
not have. That gap is not theoretical. Two match regressions reached `main` with every hosted gate
green, and both were still there when 0.4.0 was being prepared:

- `b43b71c` (#11) — `branch-shortcircuit` fusion destroyed the CFG signal `raise/retsink.ts`
  gates on, so `if (a && b) return X; return Y;` stopped matching byte-exact;
- `4a85b70` (#24) — `divpow2` legitimately absorbed `modpow2`'s diamond, leaving the
  `/regcopy` end-to-end pin asserting a route that no longer exists.

Neither moved a benchmark row, so gate 6 would not have caught them either. Run gate 5 locally.

### Why gate 6 is on this list, separately

`pnpm bench regression` **only compares two `results.json` files** — it does not run anything. Run
`bench run` and `bench merge` first, or it will cheerfully compare the committed results against
themselves and report "0 lost, 0 gained" without having executed a single row.

## Steps

1. Bump `version` in `packages/core/package.json` and `packages/cli/package.json`.
2. Keep cli's dependency on core at `workspace:^` — it publishes as `^<version>`.
3. `pnpm install` to sync the lockfile (CI runs `--frozen-lockfile`).
4. Verify the tarballs: `pnpm pack` in each package, and inspect `package/package.json`'s deps.
5. Publish **core first, cli second** — cli depends on core:

   ```
   pnpm --filter @asmlift/core publish --access public --otp=<code>
   pnpm --filter @asmlift/cli  publish --access public --otp=<code>
   ```

6. `git tag -a vX.Y.Z <release-commit>` and push the tag.

### 2FA

The npm account has publish-2FA, so a bare `pnpm publish` fails with `EOTP`. Each publish needs its
own **fresh, single-use** `--otp=<code>`; that is a credential, so a human runs these two commands.
`EOTP` halts before upload, so a rejected OTP is never a partial publish.

The private `@asmlift/toolchains` (v0.0.0) is a devDependency of cli. `workspace:*` resolves to
`0.0.0` in the published metadata — harmless, since consumers skip devDeps, and it does not block
the publish.
