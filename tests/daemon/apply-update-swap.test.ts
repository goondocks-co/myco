/**
 * Tests for `applyBinaryUpdate()` — the single-binary self-update PRIMITIVE
 * (apply-binary-update.ts).
 *
 * This is the riskiest primitive in the native-installer feature: it downloads
 * a release asset over the managed binary at `~/.myco/bin/myco`, verifies its
 * SHA256 against the release's SHA256SUMS, swaps it in (keeping `myco.prev` as
 * the rollback target), restarts, and — if the new daemon never becomes healthy
 * on the target version — auto-restores `myco.prev`.
 *
 * The overriding guarantees these tests pin down:
 *   1. VERIFY BEFORE SWAP — a checksum mismatch or a missing SHA entry leaves
 *      `binaryPath` byte-for-byte unchanged, never creates `myco.prev`, cleans
 *      the temp download, writes an error side-channel, and does NOT swap.
 *   2. The daemon ALWAYS comes back — on success the new binary is live; on a
 *      post-swap crash-loop the prior binary is restored and re-restarted.
 *
 * Everything is injected (download / computeSha256 / probeHealth / sleep /
 * service manager) so the test touches no network and only its own temp dir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  applyBinaryUpdate,
  type ApplyBinaryUpdateParams,
  type ApplyBinaryUpdateDeps,
} from '@myco/daemon/apply-binary-update.js';
import { FakeServiceManager } from '../helpers/fake-service-manager';

let tmpDir: string;
let binaryPath: string;
let errorPath: string;

const OLD_BYTES = 'OLD-BINARY-BYTES';
const NEW_BYTES = 'NEW-BINARY-BYTES-v1.1.0';

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-swap-test-'));
  binaryPath = path.join(tmpDir, 'bin', 'myco');
  errorPath = path.join(tmpDir, 'update-error.json');
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, OLD_BYTES);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface Recorder {
  deps: ApplyBinaryUpdateDeps;
  mgr: FakeServiceManager;
  downloads: Array<{ url: string; destPath: string }>;
  restoreSpawns: Array<{ bin: string; args: string[]; cwd?: string }>;
  restartCount: number;
  probeCalls: number;
}

interface RecorderOpts {
  /** Bytes the asset download writes to destPath. Default NEW_BYTES. */
  assetBytes?: string;
  /** Text the SHA256SUMS download yields. Default = a valid line for NEW_BYTES. */
  sha256sumsText?: string;
  /** Sequence of /health responses (consumed one per probe). null = down. */
  healthSequence?: Array<{ version?: string } | null>;
  /** Make the asset download throw. */
  downloadThrows?: boolean;
}

const ASSET_NAME = 'myco-darwin-arm64';

function makeDeps(opts: RecorderOpts = {}): Recorder {
  const mgr = new FakeServiceManager();
  const assetBytes = opts.assetBytes ?? NEW_BYTES;
  const sha256sumsText =
    opts.sha256sumsText ?? `${sha256(NEW_BYTES)}  ${ASSET_NAME}\n${sha256('other')}  myco-linux-x64\n`;
  const healthQueue = [...(opts.healthSequence ?? [{ version: '1.1.0' }])];

  const rec: Recorder = {
    deps: undefined as never,
    mgr,
    downloads: [],
    restoreSpawns: [],
    restartCount: 0,
    probeCalls: 0,
  };

  rec.deps = {
    getServiceManager: () => mgr,
    // The only two NEW deps the primitive needs beyond the shared bag.
    download: vi.fn(async (url: string, destPath: string) => {
      rec.downloads.push({ url, destPath });
      if (opts.downloadThrows) throw new Error('network blew up');
      // The asset URL writes the binary bytes; the SHA256SUMS URL writes text.
      if (destPath.endsWith('.sha256sums') || /SHA256SUMS/i.test(destPath)) {
        fs.writeFileSync(destPath, sha256sumsText);
      } else {
        fs.writeFileSync(destPath, assetBytes);
      }
    }),
    computeSha256: vi.fn(async (filePath: string) => {
      return sha256(fs.readFileSync(filePath, 'utf-8'));
    }),
    // Restart is observed via the service manager (count) AND a direct spawn
    // fallback when there is no service label.
    spawnDetached: vi.fn((bin: string, args: string[], cwd?: string) => {
      rec.restartCount += 1;
      rec.restoreSpawns.push({ bin, args, cwd });
    }),
    probeHealth: vi.fn(async () => {
      rec.probeCalls += 1;
      return healthQueue.length > 0 ? healthQueue.shift()! : null;
    }),
    sleep: vi.fn(async () => {}),
  };

  // Count service-manager restarts toward the restart total too.
  const realRestart = mgr.restart.bind(mgr);
  mgr.restart = vi.fn(async (label: string) => {
    rec.restartCount += 1;
    return realRestart(label);
  }) as never;

  return rec;
}

function baseParams(): ApplyBinaryUpdateParams {
  return {
    assetUrl: 'https://example.test/releases/myco-darwin-arm64',
    sha256sumsUrl: 'https://example.test/releases/SHA256SUMS',
    assetName: ASSET_NAME,
    targetVersion: '1.1.0',
    binaryPath,
    daemonPort: 20915,
    serviceManagedLabel: null,
    projectRoot: '/project',
    maxHealthAttempts: 3,
    healthIntervalMs: 5,
    errorPath,
  };
}

const prevPath = (): string => `${binaryPath}.prev`;

describe('applyBinaryUpdate — happy path', () => {
  it('downloads, verifies, swaps new in, keeps old as myco.prev, restarts, no restore', async () => {
    const rec = makeDeps({ healthSequence: [{ version: '1.1.0' }] });
    await applyBinaryUpdate(baseParams(), rec.deps);

    // New bytes are live; old bytes preserved as the rollback target.
    expect(fs.readFileSync(binaryPath, 'utf-8')).toBe(NEW_BYTES);
    expect(fs.existsSync(prevPath())).toBe(true);
    expect(fs.readFileSync(prevPath(), 'utf-8')).toBe(OLD_BYTES);

    // Restart happened exactly once (no restore / second restart).
    expect(rec.restartCount).toBe(1);

    // Error side-channel cleared on success.
    expect(fs.existsSync(errorPath)).toBe(false);

    // Both downloads happened.
    expect(rec.downloads.length).toBe(2);
  });

  it('service-managed: restarts through the ServiceManager', async () => {
    const rec = makeDeps({ healthSequence: [{ version: '1.1.0' }] });
    await applyBinaryUpdate(
      { ...baseParams(), serviceManagedLabel: 'co.goondocks.myco' },
      rec.deps,
    );
    expect(rec.mgr.restartCalls).toEqual(['co.goondocks.myco']);
    expect(fs.readFileSync(binaryPath, 'utf-8')).toBe(NEW_BYTES);
  });
});

describe('applyBinaryUpdate — verify-before-swap aborts', () => {
  it('checksum mismatch: binary untouched, NO myco.prev, temp cleaned, error written, no swap', async () => {
    // SHA256SUMS lists a hash that does NOT match the downloaded bytes.
    const rec = makeDeps({
      assetBytes: NEW_BYTES,
      sha256sumsText: `${sha256('TAMPERED-DIFFERENT-BYTES')}  ${ASSET_NAME}\n`,
    });
    await applyBinaryUpdate(baseParams(), rec.deps);

    // The single most important guarantee: original binary unchanged.
    expect(fs.readFileSync(binaryPath, 'utf-8')).toBe(OLD_BYTES);
    // No rollback target was created (nothing was swapped).
    expect(fs.existsSync(prevPath())).toBe(false);
    // Temp download cleaned up — only the binary + bin dir remain under tmp/bin.
    const leftovers = fs
      .readdirSync(path.dirname(binaryPath))
      .filter((n) => n !== 'myco');
    expect(leftovers).toEqual([]);
    // Error side-channel written.
    expect(fs.existsSync(errorPath)).toBe(true);
    // No restart of any kind on a failed verify.
    expect(rec.restartCount).toBe(0);
    expect(rec.mgr.restartCalls).toEqual([]);
  });

  it('missing SHA entry: same abort guarantees as a mismatch', async () => {
    const rec = makeDeps({
      // SHA256SUMS has entries, but none for our asset name.
      sha256sumsText: `${sha256(NEW_BYTES)}  myco-linux-x64\n${sha256('x')}  myco-windows-x64.exe\n`,
    });
    await applyBinaryUpdate(baseParams(), rec.deps);

    expect(fs.readFileSync(binaryPath, 'utf-8')).toBe(OLD_BYTES);
    expect(fs.existsSync(prevPath())).toBe(false);
    expect(fs.existsSync(errorPath)).toBe(true);
    expect(rec.restartCount).toBe(0);
  });

  it('download error: aborts, binary untouched, no myco.prev, error written', async () => {
    const rec = makeDeps({ downloadThrows: true });
    await applyBinaryUpdate(baseParams(), rec.deps);

    expect(fs.readFileSync(binaryPath, 'utf-8')).toBe(OLD_BYTES);
    expect(fs.existsSync(prevPath())).toBe(false);
    expect(fs.existsSync(errorPath)).toBe(true);
    expect(rec.restartCount).toBe(0);
  });
});

describe('applyBinaryUpdate — crash-loop auto-restore', () => {
  it('never-healthy-on-target across maxHealthAttempts → restores myco.prev and restarts again', async () => {
    // Verify passes and the swap happens, but the new daemon never reports the
    // target version (down the whole window).
    const rec = makeDeps({
      healthSequence: [null, null, null], // 3 attempts, all down
      assetBytes: NEW_BYTES,
    });
    await applyBinaryUpdate(baseParams(), rec.deps);

    // RESTORED: the prior binary is back in place.
    expect(fs.readFileSync(binaryPath, 'utf-8')).toBe(OLD_BYTES);

    // Probed exactly maxHealthAttempts times before giving up.
    expect(rec.probeCalls).toBe(3);

    // Restarted twice: once for the new binary, once after restore.
    expect(rec.restartCount).toBe(2);

    // Error side-channel describes the rollback.
    expect(fs.existsSync(errorPath)).toBe(true);
    const err = JSON.parse(fs.readFileSync(errorPath, 'utf-8'));
    expect(JSON.stringify(err).toLowerCase()).toContain('rollback');
  });

  it('healthy but on the WRONG version across all attempts → also restores', async () => {
    const rec = makeDeps({
      healthSequence: [{ version: '1.0.0' }, { version: '1.0.0' }, { version: '1.0.0' }],
    });
    await applyBinaryUpdate(baseParams(), rec.deps);

    expect(fs.readFileSync(binaryPath, 'utf-8')).toBe(OLD_BYTES);
    expect(rec.restartCount).toBe(2);
  });

  it('reaches target on a later attempt (after a couple of downs) → success, no restore', async () => {
    const rec = makeDeps({
      healthSequence: [null, { version: '1.1.0' }],
      maxHealthAttempts: 3 as never,
    } as RecorderOpts);
    await applyBinaryUpdate(baseParams(), rec.deps);

    // New binary stays live; old binary remains only as myco.prev.
    expect(fs.readFileSync(binaryPath, 'utf-8')).toBe(NEW_BYTES);
    expect(fs.readFileSync(prevPath(), 'utf-8')).toBe(OLD_BYTES);
    expect(rec.restartCount).toBe(1);
    expect(fs.existsSync(errorPath)).toBe(false);
  });
});
