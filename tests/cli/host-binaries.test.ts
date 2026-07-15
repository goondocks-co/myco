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
    expect(() => resolveOverlayTarget('win32', 'x64')).toThrow(/only supported on macOS and Linux/);
    expect(() => resolveOverlayTarget('linux', 'ia32' as NodeJS.Architecture)).toThrow(/Unsupported CPU architecture/);
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
    expect(result.tailscaleVersion).toBe(TAILSCALE_VERSION);
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
    // brew (even a broken/PATH-less one, exit 127) is never invoked once the
    // binaries are already on disk — the non-interactive-shell exit-127 case.
    expect(brewCalls).toHaveLength(0);
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
    // The tar seam materializes the two extracted binaries (mimicking real tar).
    const runner: CommandRunner = {
      async run(command: string, args: string[]) {
        if (command === 'tar') {
          fs.writeFileSync(path.join(binDir, 'tailscale'), 'ts');
          fs.writeFileSync(path.join(binDir, 'tailscaled'), 'tsd');
          return { stdout: '', exitCode: 0 };
        }
        if (args[0] === 'version') return { stdout: `${TAILSCALE_VERSION}\n`, exitCode: 0 };
        return { stdout: '', exitCode: 0 };
      },
    };
    const result = await provisionOverlayBinaries({ target: linuxTarget, fetcher, runner, binDir });
    expect(result.source.tailscale).toBe('download');
    expect(result.tailscaledBin).toBe(path.join(binDir, 'tailscaled'));
    expect(fs.existsSync(result.tailscaledBin)).toBe(true);
  });
});
