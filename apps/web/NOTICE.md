# Licensing notice — asmlift webapp

This app (`apps/web`) is licensed under the **GNU General Public License v2.0 only**
(see [`LICENSE`](LICENSE)) — unlike the rest of the asmlift monorepo, which is
[MIT](../../LICENSE).

Why: the playground bundles [`agbcc`](https://www.npmjs.com/package/agbcc) (a
browser build of the GCC-2.9-derived GBA compiler, from
[Dream-Atelier/agbcc](https://github.com/Dream-Atelier/agbcc)), which is
**GPL-2.0-only**. The deployed site is therefore a combined work distributed under
GPLv2 terms, so the app's own code carries the same license to keep the whole
bundle coherent.

Corresponding source:

- This app: this repository (`apps/web/`).
- agbcc 0.2.0: https://github.com/Dream-Atelier/agbcc — the source of the exact
  npm build.
- `@asmlift/core` (bundled, MIT): [`packages/core`](../../packages/core). MIT is
  GPL-compatible; the MIT-licensed parts remain available under MIT on their own.

Other bundled dependencies are under permissive licenses (MIT / Apache-2.0 / ISC)
and are compatible with this distribution.
