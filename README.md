# asmlift

<img src="./media/branding/logo.png" align="right" height="130px" />

> 📜 A spirit that lifts fallen assembly back into the light

A **matching decompiler**: assembly in, C / C++ / Pascal out, aiming for source that recompiles
**byte-identical** to the original object. Designed for retro game decompilation.

Check the [playground](https://macabeus.github.io/asmlift/) to see it in action or the
[benchmark](https://macabeus.github.io/asmlift/?view=benchmark) report to see its current performance.

<img width="1201" height="984" alt="image" src="https://github.com/user-attachments/assets/df5e28ad-90dc-47bb-9ce6-d6c6a76bcc1a" />

<table align="center">
  <tr>
    <td align="center" width="50%">
      <kbd><img width="1437" height="1143" alt="image" src="https://github.com/user-attachments/assets/95cc0a2a-88f2-4793-bc2b-194973e3bc9d" /></kbd><br />
      <i>Explore the benchmark overview</i>
    </td>
    <td align="center" width="50%">
      <kbd><img width="1412" height="1036" alt="image" src="https://github.com/user-attachments/assets/3dc8af49-04de-475e-a97b-1a92444416da" /></kbd><br />
      <i>Check its performance per function</i>
    </td>
  </tr>
</table>

> ⚙️ **What is Matching Decompilation?**
>
> Matching decompilation is the art of converting assembly back into C source code that, when compiled, produces byte-for-byte identical machine code. It’s popular in the retro gaming community for recreating the source code of classic games. For example, [Super Mario 64](https://github.com/n64decomp/sm64) and [The Legend of Zelda: Ocarina of Time](https://github.com/zeldaret/oot) have been fully match-decompiled.
>
> [Learn more by watching my talk.](https://www.youtube.com/watch?v=sF_Yk0udbZw)

## Why not m2c?

[m2c](https://github.com/matt-kempster/m2c) is a great tool built over years of reverse engineering experience from many contributors, and its learnings were very helpful for asmlift.

But I wanted to explore a different approach: using AI to design, from scratch, a modular matching decompiler, plus using an AI loop to automatically iterate on the decompiler itself.

The driving question is: what if, instead of using AI to match a single function, we used AI to build a machine that matches functions programmatically?

**asmlift** is the result of this exploration.

> 📗 Check [`asmlift-101.md`](./docs/asmlift-101.md) for an introduction on how asmlift is designed and how decompilers works.

## Quick start

**1.** Install `@asmlift/cli`:

```sh
# globally, so you can run `asmlift` from anywhere on your system
npm install -g @asmlift/cli

# or inside a decomp project, as a dev dependency you run with `npx asmlift`
npm install --save-dev @asmlift/cli
```

**2.** Configure `decomp.yaml` by adding `platform` and, optionally, add `tools.asmlift.compiler` and `tools.asmlift.target`. Check for more examples [here](./apps/benchmark/dataset/toolchains).

```yaml
# example decomp.yaml snippet for a GBA project

platform: gba

tools:
  asmlift:
    # Optional. Used only for disambiguation when multiple toolchains are available.
    # Possible values: agbcc-arm, ido-mips, gcc-mips, mwcc-ppc
    target: agbcc-arm

    # Optional. Used only for the `--score-against`
    compiler: |
      arm-none-eabi-cpp -nostdinc -I tools/agbcc/include {{inputPath}} -o {{outputPath}}.i
      ./tools/agbcc/bin/agbcc {{outputPath}}.i -o {{outputPath}}.s -mthumb-interwork -O2 -fhex-asm
      arm-none-eabi-as -mcpu=arm7tdmi -mthumb-interwork {{outputPath}}.s -o {{outputPath}}
```

**3.** Decompile and verify in one step:

```sh
asmlift build/src/gfx.s --name ReadUnalignedU16 --score-against build/src/gfx.o
```

```
s32 ReadUnalignedU16(u8 * a0) {
    return *a0 | a0[1] << 8;
}
asmlift: [config] target agbcc-arm (platform 'gba' in ./decomp.yaml)
asmlift: [score] unsigned: 0 (match)
```

> 📚 Check [`packages/cli`](./packages/cli/README.md#cli-reference) to learn about all the configuration options and flags of `asmlift`.

## Layout (pnpm workspace monorepo)

| Package / app                                                                                               | What it is                                                               |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`packages/core`](packages/core/README.md) ([`@asmlift/core`](https://www.npmjs.com/package/@asmlift/core)) | The decompile pipeline                                                   |
| [`packages/cli`](packages/cli/README.md) ([`@asmlift/cli`](https://www.npmjs.com/package/@asmlift/cli))     | The user-facing CLI package                                              |
| [`packages/toolchains`](packages/toolchains/README.md)                                                      | The pinned calibration toolchains. Used only for the tests and benchmark |
| `packages/bench-schema`                                                                                     | The shared benchmark result/manifest schema types                        |
| [`apps/web`](apps/web/README.md)                                                                            | The webapp including the **Playground** and the **Benchmark**            |
| [`apps/benchmark`](apps/benchmark/README.md)                                                                | The asmlift and m2c harness                                              |

## License

**MIT** ([`LICENSE`](LICENSE)) for the whole monorepo, with two carve-outs:

- **`apps/web` is GPL-2.0-only**, since it imports [`agbcc`](https://github.com/Dream-Atelier/agbcc).
- **The game-derived benchmark data is not covered by either license.** Check the original game repositories for their licensing.
