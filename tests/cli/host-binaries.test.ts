import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  headscaleAssetName,
  headscaleAssetUrl,
  provisionOverlayBinaries,
  resolveOverlayTarget,
  tailscaleLinuxTarballName,
  HEADSCALE_VERSION,
  TAILSCALE_VERSION,
  type BinaryFetcher,
  type CommandRunner,
} from '@myco/team-host/binaries.js';

const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const bytes = (s: string) => new TextEncoder().encode(s);

/** A fetcher backed by an in-memory URL→bytes map; unknown URLs throw (404-shape). */
function fakeFetcher(routes: Record<string, Uint8Array>): BinaryFetcher {
  return {
    async download(url: string): Promise<Uint8Array> {
      const hit = routes[url];
      if (!hit) throw new Error(`download failed: 404 (${url})`);
      return hit;
    },
  };
}

describe('resolveOverlayTarget', () => {
  it('maps darwin/arm64 and linux/x64 to the vendor arch vocabulary', () => {
    expect(resolveOverlayTarget('darwin', 'arm64')).toEqual({ os: 'darwin', arch: 'arm64' });
    expect(resolveOverlayTarget('darwin', 'x64')).toEqual({ os: 'darwin', arch: 'amd64' });
    expect(resolveOverlayTarget('linux', 'arm64')).toEqual({ os: 'linux', arch: 'arm64' });
    expect(resolveOverlayTarget('linux', 'x64')).toEqual({ os: 'linux', arch: 'amd64' });
  });

  it('refuses Windows and unsupported arches with a clear message', () => {
    expect(() => resolveOverlayTarget('win32', 'x64')).toThrow(/needs macOS or Linux/);
    expect(() => resolveOverlayTarget('linux', 'ia32' as NodeJS.Architecture)).toThrow(/Unsupported CPU architecture/);
  });

  it('tells a Windows user that MEMBERSHIP is unavailable, not just hosting', () => {
    // The old wording said "Windows hosts are not supported", which reads as a
    // host-only limitation to someone who is trying to JOIN — the exact user
    // the same guard also refuses.
    expect(() => resolveOverlayTarget('win32', 'x64')).toThrow(/join one as a member/);
  });

  it('pins the headscale asset names + urls to the four platforms', () => {
    expect(headscaleAssetName({ os: 'darwin', arch: 'arm64' })).toBe(`headscale_${HEADSCALE_VERSION}_darwin_arm64`);
    expect(headscaleAssetUrl({ os: 'linux', arch: 'amd64' }))
      .toBe(`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/headscale_${HEADSCALE_VERSION}_linux_amd64`);
    expect(tailscaleLinuxTarballName({ os: 'linux', arch: 'arm64' })).toBe(`tailscale_${TAILSCALE_VERSION}_arm64.tgz`);
  });
});

describe('provisionOverlayBinaries', () => {
  let tmp: string;
  let binDir: string;
  let brewDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-bin-'));
    binDir = path.join(tmp, 'bin');
    brewDir = path.join(tmp, 'brew');
    fs.mkdirSync(brewDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const target = { os: 'darwin' as const, arch: 'arm64' as const };
  const headscaleBytes = bytes('#!/fake headscale binary payload\n');

  function checksums(assetName: string, hash: string): Uint8Array {
    return bytes(`${hash}  ${assetName}\n0000  some_other_asset\n`);
  }

  function darwinRunner(): CommandRunner {
    return {
      async run(command: string, args: string[]) {
        if (command === 'brew' && args[0] === 'list') return { stdout: 'tailscale', exitCode: 0 };
        if (args[0] === 'version' && command.endsWith('headscale')) return { stdout: `v${HEADSCALE_VERSION}\n`, exitCode: 0 };
        if (args[0] === 'version') return { stdout: `${TAILSCALE_VERSION}\n  tailscale commit: abc\n`, exitCode: 0 };
        return { stdout: '', exitCode: 0 };
      },
    };
  }

  it('downloads, checksum-verifies, and places headscale; locates brew tailscale; records provenance', async () => {
    // Pretend brew already linked the two binaries.
    fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
    fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tsd', { mode: 0o755 });

    const fetcher = fakeFetcher({
      [headscaleAssetUrl(target)]: headscaleBytes,
      [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
        checksums(headscaleAssetName(target), sha256(headscaleBytes)),
    });

    const result = await provisionOverlayBinaries({
      target, fetcher, runner: darwinRunner(), binDir, brewBinDirs: [brewDir],
    });

    expect(result.headscaleBin).toBe(path.join(binDir, 'headscale'));
    expect(fs.existsSync(result.headscaleBin)).toBe(true);
    // Placed binary is executable (verify-landed passed).
    expect(fs.statSync(result.headscaleBin).mode & 0o111).not.toBe(0);
    expect(result.tailscaledBin).toBe(path.join(brewDir, 'tailscaled'));
    expect(result.source).toEqual({ headscale: 'download', tailscale: 'brew' });
    expect(result.headscaleVersion).toBe(HEADSCALE_VERSION);
    // Required mode (darwin): the provisioner records NO version — brew
    // metadata resolves it in the enable flow; probing the CLI is gone
    // (§14.8: the probe was the fail-open mechanism).
    expect(result.tailscaleVersion).toBeNull();
  });

  it('skips the binary download on re-run when the on-disk copy already matches (idempotent)', async () => {
    fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
    fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tsd', { mode: 0o755 });
    let binaryHits = 0;
    const url = headscaleAssetUrl(target);
    const checksumsUrl = `https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`;
    const fetcher: BinaryFetcher = {
      async download(u: string): Promise<Uint8Array> {
        if (u === url) { binaryHits += 1; return headscaleBytes; }
        if (u === checksumsUrl) return checksums(headscaleAssetName(target), sha256(headscaleBytes));
        throw new Error(`404 ${u}`);
      },
    };
    const opts = { target, fetcher, runner: darwinRunner(), binDir, brewBinDirs: [brewDir] };
    await provisionOverlayBinaries(opts);
    await provisionOverlayBinaries(opts);
    // First run downloads the binary; the second reuses the verified on-disk copy.
    expect(binaryHits).toBe(1);
  });

  it('REJECTS a checksum mismatch and never places the binary', async () => {
    fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
    fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tsd', { mode: 0o755 });
    const fetcher = fakeFetcher({
      [headscaleAssetUrl(target)]: headscaleBytes,
      [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
        checksums(headscaleAssetName(target), 'deadbeef'.repeat(8)),
    });

    await expect(provisionOverlayBinaries({
      target, fetcher, runner: darwinRunner(), binDir, brewBinDirs: [brewDir],
    })).rejects.toThrow(/checksum mismatch/);
    expect(fs.existsSync(path.join(binDir, 'headscale'))).toBe(false);
  });

  it('REJECTS when the checksums file has no entry for the asset', async () => {
    fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
    fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tsd', { mode: 0o755 });
    const fetcher = fakeFetcher({
      [headscaleAssetUrl(target)]: headscaleBytes,
      [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
        bytes('0000  unrelated_asset\n'),
    });

    await expect(provisionOverlayBinaries({
      target, fetcher, runner: darwinRunner(), binDir, brewBinDirs: [brewDir],
    })).rejects.toThrow(/no entry for/);
  });

  it('surfaces a brew-install failure instead of proceeding with a missing tailscaled', async () => {
    const runner: CommandRunner = {
      async run(command: string, args: string[]) {
        if (command === 'brew' && args[0] === 'list') return { stdout: 'not installed', exitCode: 1 };
        if (command === 'brew' && args[0] === 'install') return { stdout: 'network error', exitCode: 1 };
        return { stdout: '', exitCode: 0 };
      },
    };
    const fetcher = fakeFetcher({
      [headscaleAssetUrl(target)]: headscaleBytes,
      [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
        checksums(headscaleAssetName(target), sha256(headscaleBytes)),
    });
    await expect(provisionOverlayBinaries({
      target, fetcher, runner, binDir, brewBinDirs: [brewDir],
    })).rejects.toThrow(/brew install --formula tailscale failed/);
  });

  it('skips brew entirely when tailscale/tailscaled are already present (no PATH dependency)', async () => {
    fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
    fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tsd', { mode: 0o755 });
    const brewCalls: string[][] = [];
    const runner: CommandRunner = {
      async run(command: string, args: string[]) {
        if (command.endsWith('brew')) { brewCalls.push([command, ...args]); return { stdout: '', exitCode: 127 }; }
        if (args[0] === 'version' && command.endsWith('headscale')) return { stdout: `v${HEADSCALE_VERSION}\n`, exitCode: 0 };
        if (args[0] === 'version') return { stdout: `${TAILSCALE_VERSION}\n`, exitCode: 0 };
        return { stdout: '', exitCode: 0 };
      },
    };
    const fetcher = fakeFetcher({
      [headscaleAssetUrl(target)]: headscaleBytes,
      [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
        checksums(headscaleAssetName(target), sha256(headscaleBytes)),
    });

    const result = await provisionOverlayBinaries({ target, fetcher, runner, binDir, brewBinDirs: [brewDir] });

    expect(result.tailscaleBin).toBe(path.join(brewDir, 'tailscale'));
    expect(result.tailscaledBin).toBe(path.join(brewDir, 'tailscaled'));
    // The invariant behind the old zero-invocations pin was: a broken /
    // PATH-less brew (exit 127) must never fail provisioning, and Myco must
    // never INSTALL once the binaries are on disk. The read-only
    // `list --versions` metadata query is allowed — and with brew broken it
    // degrades to an UNKNOWN version, never a fabricated pin (§14.6).
    expect(brewCalls.filter((c) => c.includes('install'))).toHaveLength(0);
    expect(result.tailscaleVersion).toBeNull();
  });

  it('resolves brew at its known Homebrew-prefix path instead of relying on PATH', async () => {
    // A non-interactive shell (headless serve box) has no `brew` on PATH — a
    // bare `brew` invocation would exit 127 (ENOENT). Homebrew itself lives in
    // the same prefix as the linked tailscale/tailscaled binaries, so the
    // resolver locates `<brewBinDir>/brew` directly rather than shelling the
    // bare command name. Neither tailscale nor tailscaled exist on disk yet,
    // so this forces the brew list/install path (not the already-present skip).
    const resolvedBrewBin = path.join(brewDir, 'brew');
    fs.writeFileSync(resolvedBrewBin, '#!/bin/sh\n', { mode: 0o755 });
    const runner: CommandRunner = {
      async run(command: string, args: string[]) {
        if (command === 'brew') return { stdout: '', exitCode: 127 }; // ENOENT: not on PATH
        if (command === resolvedBrewBin && args[0] === 'list') {
          // brew reports the formula already linked at the known prefix.
          fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
          fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tsd', { mode: 0o755 });
          return { stdout: 'tailscale', exitCode: 0 };
        }
        if (args[0] === 'version' && command.endsWith('headscale')) return { stdout: `v${HEADSCALE_VERSION}\n`, exitCode: 0 };
        if (args[0] === 'version') return { stdout: `${TAILSCALE_VERSION}\n`, exitCode: 0 };
        return { stdout: '', exitCode: 0 };
      },
    };
    const fetcher = fakeFetcher({
      [headscaleAssetUrl(target)]: headscaleBytes,
      [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
        checksums(headscaleAssetName(target), sha256(headscaleBytes)),
    });

    const result = await provisionOverlayBinaries({ target, fetcher, runner, binDir, brewBinDirs: [brewDir] });

    expect(result.tailscaleBin).toBe(path.join(brewDir, 'tailscale'));
    expect(result.source).toEqual({ headscale: 'download', tailscale: 'brew' });
  });

  it('extracts the linux tarball via tar and verifies against the .sha256 sidecar', async () => {
    const linuxTarget = { os: 'linux' as const, arch: 'amd64' as const };
    const tarBytes = bytes('fake-tgz-payload');
    const tarUrl = `https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz`;
    const fetcher = fakeFetcher({
      [headscaleAssetUrl(linuxTarget)]: headscaleBytes,
      [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
        checksums(headscaleAssetName(linuxTarget), sha256(headscaleBytes)),
      [tarUrl]: tarBytes,
      [`${tarUrl}.sha256`]: bytes(`${sha256(tarBytes)}  tailscale_${TAILSCALE_VERSION}_amd64.tgz\n`),
    });
    // The tar seam honors `-C <dir>` like real tar — and the assertion that
    // the dir is a per-run STAGING dir (never binDir) is §14.4's atomicity
    // gate: extraction must never touch live paths.
    const tarDirs: string[] = [];
    const runner: CommandRunner = {
      async run(command: string, args: string[]) {
        if (command === 'tar') {
          const dashC = args[args.indexOf('-C') + 1]!;
          tarDirs.push(dashC);
          fs.writeFileSync(path.join(dashC, 'tailscale'), 'ts');
          fs.writeFileSync(path.join(dashC, 'tailscaled'), 'tsd');
          return { stdout: '', exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
      },
    };
    const result = await provisionOverlayBinaries({ target: linuxTarget, fetcher, runner, binDir });
    expect(result.source.tailscale).toBe('download');
    expect(result.tailscaledBin).toBe(path.join(binDir, 'tailscaled'));
    expect(fs.existsSync(result.tailscaledBin)).toBe(true);
    // GATE (§14.4): tar extracted into staging, never the live bin dir.
    expect(tarDirs).toHaveLength(1);
    expect(tarDirs[0]).not.toBe(binDir);
    // Managed provisioning recorded both binaries in the manifest, the
    // version is the PIN (never probed), and the run reports what changed.
    expect(result.tailscaleVersion).toBe(TAILSCALE_VERSION);
    expect(result.changed.sort()).toEqual(['headscale', 'tailscale', 'tailscaled']);
    const manifest = JSON.parse(fs.readFileSync(path.join(binDir, 'provisioning-manifest.json'), 'utf-8'));
    expect(Object.keys(manifest.binaries).sort()).toEqual(['headscale', 'tailscale', 'tailscaled']);
    // GATE (§14.7): the tarball artifact was GC'd after successful placement.
    expect(fs.readdirSync(binDir).filter((f) => f.endsWith('.tgz'))).toEqual([]);

    // Second run: digest-converged — no downloads of the tarball, nothing changed.
    const result2 = await provisionOverlayBinaries({ target: linuxTarget, fetcher, runner, binDir });
    expect(result2.changed).toEqual([]);
    expect(tarDirs).toHaveLength(1);

    // GATE (§14.9 gate 2 / review B4): TAMPERED on-disk bytes re-provision.
    // Under the old exist-skip this run would trust the tampered binary
    // forever — the mutant that reverts convergence to existsSync goes red
    // exactly here.
    fs.writeFileSync(path.join(binDir, 'tailscaled'), 'TAMPERED');
    const result3 = await provisionOverlayBinaries({ target: linuxTarget, fetcher, runner, binDir });
    expect(tarDirs).toHaveLength(2);
    expect(result3.changed).toContain('tailscaled');
    expect(fs.readFileSync(path.join(binDir, 'tailscaled'), 'utf-8')).toBe('tsd');
  });

  it('GATE (§14.7 / review M8): superseded legacy tarball artifacts are GC\'d on a provisioning run', async () => {
    const linuxTarget = { os: 'linux' as const, arch: 'amd64' as const };
    const tarBytes = bytes('fake-tgz-payload');
    const tarUrl = `https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz`;
    const fetcher = fakeFetcher({
      [headscaleAssetUrl(linuxTarget)]: headscaleBytes,
      [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
        checksums(headscaleAssetName(linuxTarget), sha256(headscaleBytes)),
      [tarUrl]: tarBytes,
      [`${tarUrl}.sha256`]: bytes(`${sha256(tarBytes)}  tailscale_${TAILSCALE_VERSION}_amd64.tgz\n`),
    });
    const runner: CommandRunner = {
      async run(command: string, args: string[]) {
        if (command === 'tar') {
          const dashC = args[args.indexOf('-C') + 1]!;
          fs.writeFileSync(path.join(dashC, 'tailscale'), 'ts');
          fs.writeFileSync(path.join(dashC, 'tailscaled'), 'tsd');
          return { stdout: '', exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
      },
    };
    // A pre-PR-7 run left its tarball in the bin dir (the ~30MB-per-version
    // leak §14.7 names).
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'tailscale_1.97.0_amd64.tgz'), 'legacy');

    await provisionOverlayBinaries({ target: linuxTarget, fetcher, runner, binDir });

    expect(fs.existsSync(path.join(binDir, 'tailscale_1.97.0_amd64.tgz'))).toBe(false);
  });

  it('GATE (§14.9 gate 7): a SPLIT pair (binaries in different prefixes) refuses with actionable copy', async () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-brew-other-'));
    fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
    fs.writeFileSync(path.join(otherDir, 'tailscaled'), 'tsd', { mode: 0o755 });
    const fetcher = fakeFetcher({
      [headscaleAssetUrl(target)]: headscaleBytes,
      [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
        checksums(headscaleAssetName(target), sha256(headscaleBytes)),
    });
    const runner: CommandRunner = { async run() { return { stdout: '', exitCode: 0 }; } };

    await expect(provisionOverlayBinaries({
      target, fetcher, runner, binDir, brewBinDirs: [brewDir, otherDir],
    })).rejects.toThrow(/DIFFERENT Homebrew prefixes/);
  });

  it('GATE (R-M8/§14.6): the lifecycle-coupling disclosure is emitted on the ADOPT path with the blast-radius sentence', async () => {
    fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
    fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tsd', { mode: 0o755 });
    const fetcher = fakeFetcher({
      [headscaleAssetUrl(target)]: headscaleBytes,
      [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
        checksums(headscaleAssetName(target), sha256(headscaleBytes)),
    });
    const runner: CommandRunner = { async run() { return { stdout: '', exitCode: 0 }; } };
    const logs: string[] = [];

    await provisionOverlayBinaries({ target, fetcher, runner, binDir, brewBinDirs: [brewDir], logger: (m) => logs.push(m) });

    const disclosure = logs.find((m) => m.includes('managed by YOUR Homebrew'));
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain('Myco never upgrades or removes it');
    expect(disclosure).toContain('takes them all down at once');
  });

  it('GATE (R-M8): the disclosure is ALSO emitted on the brew-INSTALL path', async () => {
    const fetcher = fakeFetcher({
      [headscaleAssetUrl(target)]: headscaleBytes,
      [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
        checksums(headscaleAssetName(target), sha256(headscaleBytes)),
    });
    const runner: CommandRunner = {
      async run(command: string, args: string[]) {
        if (args[0] === 'install') {
          // brew install materializes the pair in ONE prefix.
          fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
          fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tsd', { mode: 0o755 });
          return { stdout: '', exitCode: 0 };
        }
        if (args[0] === 'list' && args[1] === '--formula') return { stdout: '', exitCode: 1 };
        return { stdout: '', exitCode: 0 };
      },
    };
    const logs: string[] = [];

    await provisionOverlayBinaries({ target, fetcher, runner, binDir, brewBinDirs: [brewDir], logger: (m) => logs.push(m) });

    expect(logs.some((m) => m.includes('managed by YOUR Homebrew'))).toBe(true);
  });

  it('GATE (review B2): the checksum-match SKIP path writes the manifest entry — an already-provisioned host is never permanently unknown', async () => {
    const linuxTarget = { os: 'linux' as const, arch: 'amd64' as const };
    const tarBytes = bytes('fake-tgz-payload');
    const tarUrl = `https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz`;
    const fetcher = fakeFetcher({
      [headscaleAssetUrl(linuxTarget)]: headscaleBytes,
      [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
        checksums(headscaleAssetName(linuxTarget), sha256(headscaleBytes)),
      [tarUrl]: tarBytes,
      [`${tarUrl}.sha256`]: bytes(`${sha256(tarBytes)}  tailscale_${TAILSCALE_VERSION}_amd64.tgz\n`),
    });
    const runner: CommandRunner = {
      async run(command: string, args: string[]) {
        if (command === 'tar') {
          const dashC = args[args.indexOf('-C') + 1]!;
          fs.writeFileSync(path.join(dashC, 'tailscale'), 'ts');
          fs.writeFileSync(path.join(dashC, 'tailscaled'), 'tsd');
          return { stdout: '', exitCode: 0 };
        }
        return { stdout: '', exitCode: 0 };
      },
    };
    await provisionOverlayBinaries({ target: linuxTarget, fetcher, runner, binDir });
    // Simulate the pre-PR-7 host: binary on disk matches upstream, no record.
    fs.rmSync(path.join(binDir, 'provisioning-manifest.json'));

    await provisionOverlayBinaries({ target: linuxTarget, fetcher, runner, binDir });

    const manifest = JSON.parse(fs.readFileSync(path.join(binDir, 'provisioning-manifest.json'), 'utf-8'));
    expect(manifest.binaries.headscale.version).toBe(HEADSCALE_VERSION);
  });

  it('GATE (§14.9 gate 5): no code path invokes brew upgrade or brew uninstall', () => {
    // Pure-JS scan (no shell quoting): flag any argv whose first element is
    // 'upgrade'/'uninstall' passed to a brew-shaped command. Prose mentions
    // are fine; argv is not.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const source = fs.readFileSync(full, 'utf-8');
        if (/[Bb]rew(?:Bin)?['"`]?\s*,\s*\[\s*['"`](?:upgrade|uninstall)['"`]/.test(source)) {
          offenders.push(full);
        }
      }
    };
    walk(path.join(process.cwd(), 'packages/myco/src'));
    expect(offenders).toEqual([]);
  });
});
