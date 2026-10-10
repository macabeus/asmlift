// The af recipe's host checks (cases/project-setup.ts), decided from the host they are handed: the
// big-endian MIPS binutils may live anywhere on PATH (Ubuntu's binutils-mips-linux-gnu, not only a
// /opt/cross build), and the Rosetta probe runs on Apple silicon alone, because `arch -x86_64` is a
// macOS verb that GNU `arch` rejects. The host is a stand-in, so every case runs on every host.
import { describe, expect, test } from 'vitest';

import { type AfHost, requireAfHost } from '../src/cases/project-setup';

/** A stand-in host that records which probes ran. */
const host = (platform: NodeJS.Platform, arch: string, mipsBinutils: boolean, runsX86 = true) => {
  const probed: string[] = [];
  const h: AfHost = {
    platform,
    arch,
    mipsBinutils: () => (probed.push('mipsBinutils'), mipsBinutils),
    runsX86: () => (probed.push('runsX86'), runsX86),
  };
  return { h, probed };
};

const refusal = (h: AfHost): string => {
  try {
    requireAfHost(h);
  } catch (e) {
    return String(e);
  }
  return '';
};

describe('requireAfHost', () => {
  test('refuses a Linux host without mips-linux-gnu-ld, naming the binutils and the apt remedy', () => {
    const r = refusal(host('linux', 'x64', false).h);
    expect(r).toContain('missing host prerequisite — big-endian mips-linux-gnu binutils');
    expect(r).toContain('apt install binutils-mips-linux-gnu');
  });

  test('refuses a macOS host without mips-linux-gnu-ld with the /opt/cross remedy', () => {
    const r = refusal(host('darwin', 'arm64', false).h);
    expect(r).toContain('big-endian mips-linux-gnu binutils');
    expect(r).toContain('--prefix=/opt/cross');
  });

  test('accepts a Linux host with mips-linux-gnu-ld and never probes for Rosetta', () => {
    const { h, probed } = host('linux', 'x64', true);
    expect(refusal(h)).toBe('');
    expect(probed).toEqual(['mipsBinutils']);
  });

  test('accepts an Intel Mac with mips-linux-gnu-ld and never probes for Rosetta', () => {
    const { h, probed } = host('darwin', 'x64', true);
    expect(refusal(h)).toBe('');
    expect(probed).toEqual(['mipsBinutils']);
  });

  test('probes for Rosetta on Apple silicon and names its remedy when x86_64 does not run', () => {
    const { h, probed } = host('darwin', 'arm64', true, false);
    const r = refusal(h);
    expect(probed).toEqual(['mipsBinutils', 'runsX86']);
    expect(r).toContain('Rosetta (af runs the x86_64 IDO recomp binaries)');
    expect(r).toContain('softwareupdate --install-rosetta');
  });

  test('accepts Apple silicon when both the binutils and x86_64 run', () => {
    const { h, probed } = host('darwin', 'arm64', true, true);
    expect(refusal(h)).toBe('');
    expect(probed).toEqual(['mipsBinutils', 'runsX86']);
  });
});
