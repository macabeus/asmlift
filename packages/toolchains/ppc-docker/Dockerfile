# asmlift PowerPC toolchain image — runs Metrowerks CodeWarrior `mwcceppc.exe` (a 32-bit Win32 PE)
# through `wibo`, exactly as decomp.me does (backend/coreapp/compilers.py runs
# `${WIBO} mwcceppc.exe -proc gekko …`), and carries a PowerPC objdump so the produced object can
# be disassembled into the asm text asmlift's frontend consumes (real GC/Wii projects use
# `powerpc-eabi-objdump -Drz`).
#
# The CodeWarrior binaries are PROPRIETARY and are NOT baked in — they are bind-mounted at run time
# from decomp.me's vendored `mwcc_<version>` dir (see MWCC_PPC_TOOLCHAIN in
# packages/toolchains/src/toolchain.ts).
#
# WHY linux/386 + a 32-bit wibo (Apple-Silicon lesson): wibo is a Win32 API SHIM, not a CPU
# emulator — it runs the PE's x86 code directly, so an x86 emulator is needed on arm64. mwcceppc is
# a 32-bit (i386) PE. A 64-bit wibo runs it by switching to a 32-bit code segment, and that mode
# switch aborts under BOTH Rosetta ("invalid gdt selector") and qemu-x86_64 (segfault). A 32-bit
# wibo running a 32-bit PE needs NO mode switch and runs cleanly under qemu-i386 (Rosetta is
# x86_64-only, so linux/386 containers already use qemu-i386 — the same path the KMC-GCC harness
# uses). So: build wibo as i386 and run everything in a linux/386 container.
#
# wibo VERSION: 0.6.16 — the newest release BEFORE wibo added a mandatory libclang/python-clang
# trampoline-codegen build step (1.0.x+), while still carrying enough Win32 API coverage
# (msvcrt/ntdll/vcruntime/lmgr) to run mwcceppc. Pinned for reproducibility.

# ── stage 1: build a 32-bit wibo from source ─────────────────────────────────────────────────
FROM --platform=linux/386 i386/debian:bookworm AS wibo-build
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       git cmake make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch 0.6.16 https://github.com/decompals/wibo.git /wibo \
    && cmake -S /wibo -B /wibo/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /wibo/build -j"$(nproc)"

# ── stage 2: runtime — wibo + a PowerPC-capable objdump ──────────────────────────────────────
FROM --platform=linux/386 i386/debian:bookworm
# binutils-multiarch teaches the stock objdump every BFD target (incl. PowerPC): objdump is a
# cross-disassembler — it reads the object's arch from the ELF header — so it disassembles
# CodeWarrior's EABI object fine. `ln` gives it the `powerpc-eabi-objdump` name real projects use.
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       binutils binutils-multiarch \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/objdump /usr/bin/powerpc-eabi-objdump
COPY --from=wibo-build /wibo/build/wibo /usr/bin/wibo
# CodeWarrior wants a writable HOME for its temp/license bookkeeping.
ENV HOME=/tmp
WORKDIR /work
