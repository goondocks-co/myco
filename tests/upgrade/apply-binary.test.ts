/**
 * Tests for Task 4's new versioned-dir primitives in apply-binary.ts:
 *   - stageBinary      download → verify → rename into versions/<v>/
 *   - adoptStaged      copy versionBinaryPath → managedBinaryPath (atomic)
 *   - restoreVersion   copy-back primitive (same atomicity as adopt)
 *   - pruneVersions    retention floor (never drops current or previous)
 *
 * The failure invariant is the core safety property:
 *   On ANY stageBinary failure (download throws / missing SHA entry /
 *   checksum mismatch): temp cleaned, NOTHING under versions/<v>/, managed
 *   binary untouched.
 *
 * All I/O is hermetic: temp HOME created per-test, no real network, no real
 * binaries.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  stageBinary,
  adoptStaged,
  restoreVersion,
  pruneVersions,
  MAX_DOWNLOAD_BYTES,
  DEFAULT_BINARY_UPDATE_DEPS,
  type StageBinaryDeps,
  type StageBinaryResult,
} from '@myco/upgrade/apply-binary.js';
import {
  managedBinaryPath,
  versionBinaryPath,
  versionDir,
  versionsDir,
} from '@myco/install/managed-binary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHome: string;
const PLATFORM: NodeJS.Platform = 'linux';

const ASSET_NAME = 'myco-linux-x64';
const NEW_BYTES = 'NEW-BINARY-CONTENT-v1.2.3';
const STABLE_BYTES = 'STABLE-BINARY-v1.1.0';
const VERSION = '1.2.3';

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function makeSumsText(assetName: string, bytes: string): string {
  return `${sha256(bytes)}  ${assetName}\n${sha256('other')}  myco-darwin-arm64\n`;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-binary-test-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// stageBinary deps factory
// ---------------------------------------------------------------------------

interface StageRecorder {
  deps: StageBinaryDeps;
  downloads: Array<{ url: string; destPath: string }>;
}

interface StageOpts {
  /** Bytes written for the asset download. Default NEW_BYTES. */
  assetBytes?: string;
  /** SHA256SUMS text. Default: valid entry for NEW_BYTES. */
  sha256sumsText?: string;
  /** Make the asset download throw. */
  downloadThrows?: boolean;
}

function makeStageRec(opts: StageOpts = {}): StageRecorder {
  const assetBytes = opts.assetBytes ?? NEW_BYTES;
  const sha256sumsText = opts.sha256sumsText ?? makeSumsText(ASSET_NAME, NEW_BYTES);
  const rec: StageRecorder = { deps: undefined as never, downloads: [] };

  rec.deps = {
    download: vi.fn(async (url: string, destPath: string) => {
      rec.downloads.push({ url, destPath });
      if (opts.downloadThrows) throw new Error('network blew up');
      if (/SHA256SUMS/i.test(url) || destPath.endsWith('.sha256sums')) {
        fs.writeFileSync(destPath, sha256sumsText);
      } else {
        fs.writeFileSync(destPath, assetBytes);
      }
    }),
    computeSha256: vi.fn(async (filePath: string) => {
      return sha256(fs.readFileSync(filePath, 'utf-8'));
    }),
  };

  return rec;
}

function baseRefs() {
  return {
    assetUrl: 'https://example.test/releases/myco-linux-x64',
    sha256sumsUrl: 'https://example.test/releases/SHA256SUMS',
    assetName: ASSET_NAME,
    targetVersion: VERSION,
  };
}

// ---------------------------------------------------------------------------
// Pre-populate the stable managed binary
// ---------------------------------------------------------------------------

function writeStableBinary(): string {
  const stablePath = managedBinaryPath(tmpHome, PLATFORM);
  fs.mkdirSync(path.dirname(stablePath), { recursive: true });
  fs.writeFileSync(stablePath, STABLE_BYTES);
  return stablePath;
}

// ===========================================================================
// stageBinary — happy path
// ===========================================================================

describe('stageBinary — success', () => {
  it('returns { versionDir, version } and writes binary at versionBinaryPath', async () => {
    const rec = makeStageRec();
    const result = await stageBinary(
      { refs: baseRefs(), home: tmpHome, platform: PLATFORM },
      rec.deps,
    );

    expect('error' in result).toBe(false);
    const ok = result as { versionDir: string; version: string };
    expect(ok.version).toBe(VERSION);
    expect(ok.versionDir).toBe(versionDir(tmpHome, PLATFORM, VERSION));

    const expected = versionBinaryPath(tmpHome, PLATFORM, VERSION);
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.readFileSync(expected, 'utf-8')).toBe(NEW_BYTES);
  });

  it('leaves the stable binary untouched on success', async () => {
    const stablePath = writeStableBinary();
    const rec = makeStageRec();
    await stageBinary({ refs: baseRefs(), home: tmpHome, platform: PLATFORM }, rec.deps);

    expect(fs.readFileSync(stablePath, 'utf-8')).toBe(STABLE_BYTES);
  });

  it('cleans up no temps: only the version dir remains under versions/', async () => {
    const rec = makeStageRec();
    await stageBinary({ refs: baseRefs(), home: tmpHome, platform: PLATFORM }, rec.deps);

    const vDir = versionsDir(tmpHome, PLATFORM);
    const entries = fs.readdirSync(vDir);
    // Only the versioned subdir should remain; no temp files.
    expect(entries).toEqual([VERSION]);
  });

  it('downloads both the asset and SHA256SUMS', async () => {
    const rec = makeStageRec();
    await stageBinary({ refs: baseRefs(), home: tmpHome, platform: PLATFORM }, rec.deps);

    expect(rec.downloads.length).toBe(2);
    expect(rec.downloads.some((d) => d.url === baseRefs().assetUrl)).toBe(true);
    expect(rec.downloads.some((d) => d.url === baseRefs().sha256sumsUrl)).toBe(true);
  });
});

// ===========================================================================
// stageBinary — failure invariants (the core safety property)
// ===========================================================================

describe('stageBinary — failure invariants', () => {
  // Every failure scenario must satisfy ALL of these:
  //   1. Returns { error }
  //   2. Nothing under versions/<v>/
  //   3. No temp files remain under versions/
  //   4. Stable binary untouched

  const FAILURES: Array<{ name: string; opts: StageOpts }> = [
    {
      name: 'download throws',
      opts: { downloadThrows: true },
    },
    {
      name: 'checksum mismatch',
      opts: {
        assetBytes: NEW_BYTES,
        sha256sumsText: `${sha256('TAMPERED-CONTENT')}  ${ASSET_NAME}\n`,
      },
    },
    {
      name: 'missing SHA entry',
      opts: {
        sha256sumsText: `${sha256(NEW_BYTES)}  myco-darwin-arm64\n`,
      },
    },
  ];

  for (const { name, opts } of FAILURES) {
    describe(name, () => {
      it('returns { error }', async () => {
        const rec = makeStageRec(opts);
        const result = await stageBinary(
          { refs: baseRefs(), home: tmpHome, platform: PLATFORM },
          rec.deps,
        );
        expect('error' in result).toBe(true);
        expect(typeof (result as { error: string }).error).toBe('string');
      });

      it('writes NOTHING under versions/<v>/', async () => {
        const rec = makeStageRec(opts);
        await stageBinary({ refs: baseRefs(), home: tmpHome, platform: PLATFORM }, rec.deps);

        const vDir = versionDir(tmpHome, PLATFORM, VERSION);
        expect(fs.existsSync(vDir)).toBe(false);
      });

      it('cleans all temp files from versions/', async () => {
        const rec = makeStageRec(opts);
        await stageBinary({ refs: baseRefs(), home: tmpHome, platform: PLATFORM }, rec.deps);

        const vDir = versionsDir(tmpHome, PLATFORM);
        if (fs.existsSync(vDir)) {
          const leftovers = fs.readdirSync(vDir);
          expect(leftovers).toEqual([]);
        }
      });

      it('stable binary is untouched', async () => {
        const stablePath = writeStableBinary();
        const rec = makeStageRec(opts);
        await stageBinary({ refs: baseRefs(), home: tmpHome, platform: PLATFORM }, rec.deps);

        expect(fs.readFileSync(stablePath, 'utf-8')).toBe(STABLE_BYTES);
      });
    });
  }
});

// ===========================================================================
// adoptStaged
// ===========================================================================

describe('adoptStaged', () => {
  function writeVersionBinary(version: string, content: string): string {
    const vBin = versionBinaryPath(tmpHome, PLATFORM, version);
    fs.mkdirSync(path.dirname(vBin), { recursive: true });
    fs.writeFileSync(vBin, content);
    return vBin;
  }

  it('copies version binary → managed binary atomically (content matches)', async () => {
    writeVersionBinary(VERSION, NEW_BYTES);
    await adoptStaged({ home: tmpHome, platform: PLATFORM, version: VERSION });

    const stablePath = managedBinaryPath(tmpHome, PLATFORM);
    expect(fs.existsSync(stablePath)).toBe(true);
    expect(fs.readFileSync(stablePath, 'utf-8')).toBe(NEW_BYTES);
  });

  it('retains the version dir after adopt (so restoreVersion can use it)', async () => {
    writeVersionBinary(VERSION, NEW_BYTES);
    await adoptStaged({ home: tmpHome, platform: PLATFORM, version: VERSION });

    const vBin = versionBinaryPath(tmpHome, PLATFORM, VERSION);
    expect(fs.existsSync(vBin)).toBe(true);
    expect(fs.readFileSync(vBin, 'utf-8')).toBe(NEW_BYTES);
  });

  it('leaves no temp files in the managed bin dir after adopt', async () => {
    writeVersionBinary(VERSION, NEW_BYTES);
    await adoptStaged({ home: tmpHome, platform: PLATFORM, version: VERSION });

    const binDir = path.dirname(managedBinaryPath(tmpHome, PLATFORM));
    const entries = fs.readdirSync(binDir);
    // Only the managed binary ('myco') + versions dir should remain; no temps.
    const temps = entries.filter((e) => e.startsWith('.myco-adopt-'));
    expect(temps).toEqual([]);
  });

  it('overwrites the existing stable binary correctly', async () => {
    const stablePath = writeStableBinary();
    writeVersionBinary(VERSION, NEW_BYTES);
    expect(fs.readFileSync(stablePath, 'utf-8')).toBe(STABLE_BYTES);

    await adoptStaged({ home: tmpHome, platform: PLATFORM, version: VERSION });

    expect(fs.readFileSync(stablePath, 'utf-8')).toBe(NEW_BYTES);
  });
});

// ===========================================================================
// restoreVersion
// ===========================================================================

describe('restoreVersion', () => {
  const PREV_VERSION = '1.1.0';
  const PREV_BYTES = 'PREV-BINARY-v1.1.0';

  function writeVersionBinary(version: string, content: string): string {
    const vBin = versionBinaryPath(tmpHome, PLATFORM, version);
    fs.mkdirSync(path.dirname(vBin), { recursive: true });
    fs.writeFileSync(vBin, content);
    return vBin;
  }

  it('copies the previous version binary back onto the managed path', async () => {
    // Simulate: new version was adopted (managed path has new bytes), now restoring prev.
    const stablePath = managedBinaryPath(tmpHome, PLATFORM);
    fs.mkdirSync(path.dirname(stablePath), { recursive: true });
    fs.writeFileSync(stablePath, NEW_BYTES);
    writeVersionBinary(PREV_VERSION, PREV_BYTES);

    await restoreVersion(tmpHome, PLATFORM, PREV_VERSION);

    expect(fs.readFileSync(stablePath, 'utf-8')).toBe(PREV_BYTES);
  });

  it('leaves no temp files in the managed bin dir', async () => {
    writeVersionBinary(PREV_VERSION, PREV_BYTES);
    const stablePath = managedBinaryPath(tmpHome, PLATFORM);
    fs.mkdirSync(path.dirname(stablePath), { recursive: true });
    fs.writeFileSync(stablePath, NEW_BYTES);

    await restoreVersion(tmpHome, PLATFORM, PREV_VERSION);

    const binDir = path.dirname(stablePath);
    const temps = fs.readdirSync(binDir).filter((e) => e.startsWith('.myco-restore-'));
    expect(temps).toEqual([]);
  });

  it('leaves the version dir intact after restore', async () => {
    const stablePath = managedBinaryPath(tmpHome, PLATFORM);
    fs.mkdirSync(path.dirname(stablePath), { recursive: true });
    fs.writeFileSync(stablePath, NEW_BYTES);
    const vBin = writeVersionBinary(PREV_VERSION, PREV_BYTES);

    await restoreVersion(tmpHome, PLATFORM, PREV_VERSION);

    expect(fs.existsSync(vBin)).toBe(true);
    expect(fs.readFileSync(vBin, 'utf-8')).toBe(PREV_BYTES);
  });
});

// ===========================================================================
// pruneVersions
// ===========================================================================

describe('pruneVersions', () => {
  /** Write a fake version dir with a dummy binary. */
  function seedVersion(version: string, content = `binary-${version}`): void {
    const vBin = versionBinaryPath(tmpHome, PLATFORM, version);
    fs.mkdirSync(path.dirname(vBin), { recursive: true });
    fs.writeFileSync(vBin, content);
  }

  function listVersionDirs(): string[] {
    const vDir = versionsDir(tmpHome, PLATFORM);
    if (!fs.existsSync(vDir)) return [];
    return fs.readdirSync(vDir).sort();
  }

  it('no-ops when versions dir does not exist', () => {
    expect(() => pruneVersions(tmpHome, PLATFORM, 3, '1.0.0')).not.toThrow();
  });

  it('no-ops when version count is at or below keep', () => {
    seedVersion('1.0.0');
    seedVersion('1.1.0');
    seedVersion('1.2.0');
    pruneVersions(tmpHome, PLATFORM, 3, '1.2.0', '1.1.0');
    expect(listVersionDirs()).toEqual(['1.0.0', '1.1.0', '1.2.0']);
  });

  it('prunes the oldest version when over keep=3', () => {
    seedVersion('1.0.0');
    seedVersion('1.1.0');
    seedVersion('1.2.0');
    seedVersion('1.3.0');
    pruneVersions(tmpHome, PLATFORM, 3, '1.3.0', '1.2.0');
    // Should keep 1.3.0 (current), 1.2.0 (previous), 1.1.0 (newest non-protected)
    // and prune 1.0.0.
    const remaining = listVersionDirs();
    expect(remaining).not.toContain('1.0.0');
    expect(remaining).toContain('1.3.0');
    expect(remaining).toContain('1.2.0');
    expect(remaining.length).toBe(3);
  });

  it('NEVER prunes current or previous even at keep=1 (floor=2)', () => {
    seedVersion('1.0.0');
    seedVersion('1.1.0');
    seedVersion('1.2.0');
    seedVersion('1.3.0');
    // keep=1 is below the floor of 2; current+previous must survive.
    pruneVersions(tmpHome, PLATFORM, 1, '1.3.0', '1.2.0');
    const remaining = listVersionDirs();
    expect(remaining).toContain('1.3.0');
    expect(remaining).toContain('1.2.0');
  });

  it('NEVER prunes current even if it is the only version (keep=1)', () => {
    seedVersion('1.3.0');
    pruneVersions(tmpHome, PLATFORM, 1, '1.3.0', undefined);
    expect(listVersionDirs()).toContain('1.3.0');
  });

  it('NEVER prunes previous even at keep=0 (floor=2 still applies)', () => {
    seedVersion('1.0.0');
    seedVersion('1.1.0');
    seedVersion('1.2.0');
    seedVersion('1.3.0');
    pruneVersions(tmpHome, PLATFORM, 0, '1.3.0', '1.2.0');
    const remaining = listVersionDirs();
    expect(remaining).toContain('1.3.0');
    expect(remaining).toContain('1.2.0');
  });

  it('prunes multiple old versions when keep=2', () => {
    seedVersion('1.0.0');
    seedVersion('1.1.0');
    seedVersion('1.2.0');
    seedVersion('1.3.0');
    seedVersion('1.4.0');
    pruneVersions(tmpHome, PLATFORM, 2, '1.4.0', '1.3.0');
    const remaining = listVersionDirs();
    expect(remaining).toContain('1.4.0');
    expect(remaining).toContain('1.3.0');
    expect(remaining).not.toContain('1.0.0');
    expect(remaining).not.toContain('1.1.0');
    expect(remaining.length).toBe(2);
  });

  it('leaves non-semver entries in versions/ alone', () => {
    seedVersion('1.0.0');
    seedVersion('1.1.0');
    seedVersion('1.2.0');
    seedVersion('1.3.0');
    // Write a non-semver entry that prune should not touch.
    const vDir = versionsDir(tmpHome, PLATFORM);
    fs.mkdirSync(path.join(vDir, 'not-semver'), { recursive: true });

    pruneVersions(tmpHome, PLATFORM, 2, '1.3.0', '1.2.0');
    // non-semver should still be present.
    expect(listVersionDirs()).toContain('not-semver');
  });

  it('default keep=3 is enforced when called without the keep arg', () => {
    seedVersion('1.0.0');
    seedVersion('1.1.0');
    seedVersion('1.2.0');
    seedVersion('1.3.0');
    seedVersion('1.4.0');
    // Pass undefined for keep to exercise the default=3 path; current is required.
    pruneVersions(tmpHome, PLATFORM, undefined as unknown as number, '1.4.0', '1.3.0');
    const remaining = listVersionDirs().filter((v) => /^\d/.test(v));
    expect(remaining.length).toBe(3);
    expect(remaining).toContain('1.4.0');
    expect(remaining).toContain('1.3.0');
  });

  it('NEVER deletes the running version even when it is an OLDER semver than a staged newer version (rollback scenario)', () => {
    // Simulate rollback: daemon rolled back to 1.2.0 after a bad 1.3.0 upgrade,
    // and a 1.4.0 was staged but not yet adopted. current=1.2.0 is NOT the newest.
    seedVersion('1.0.0');
    seedVersion('1.1.0');
    seedVersion('1.2.0'); // <-- running version after rollback
    seedVersion('1.3.0'); // <-- the bad version
    seedVersion('1.4.0'); // <-- staged newer version not yet adopted
    // keep=3: must keep current (1.2.0), previous (1.1.0 — next below current),
    // and one more from the newest. 1.0.0 should be the only candidate to prune.
    pruneVersions(tmpHome, PLATFORM, 3, '1.2.0');
    const remaining = listVersionDirs();
    // The running version must NEVER be pruned, regardless of semver position.
    expect(remaining).toContain('1.2.0');
  });

  it('derives previous automatically as the next-newest version strictly below current', () => {
    seedVersion('1.0.0');
    seedVersion('1.1.0');
    seedVersion('1.2.0');
    seedVersion('1.3.0');
    // current=1.2.0, no explicit previous → should auto-derive previous=1.1.0
    pruneVersions(tmpHome, PLATFORM, 2, '1.2.0');
    const remaining = listVersionDirs();
    expect(remaining).toContain('1.2.0'); // current: protected
    expect(remaining).toContain('1.1.0'); // derived previous: protected
    // 1.3.0 and 1.0.0 are candidates for pruning; keep=2 keeps exactly 2
    expect(remaining.length).toBe(2);
  });
});

// ===========================================================================
// adoptStaged — executable mode + failure propagation (IMPORTANT-2 + MINOR-3)
// ===========================================================================

describe('adoptStaged — mode and failure', () => {
  function writeVersionBinary(version: string, content: string): string {
    const vBin = versionBinaryPath(tmpHome, PLATFORM, version);
    fs.mkdirSync(path.dirname(vBin), { recursive: true });
    fs.writeFileSync(vBin, content);
    return vBin;
  }

  it('adopted binary has executable mode on non-win32 (mode & 0o111 !== 0)', async () => {
    if (process.platform === 'win32') return; // skip on Windows
    writeVersionBinary(VERSION, NEW_BYTES);
    await adoptStaged({ home: tmpHome, platform: PLATFORM, version: VERSION });

    const stablePath = managedBinaryPath(tmpHome, PLATFORM);
    const mode = fs.statSync(stablePath).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it('leaves no temp in bin dir when rename fails (MINOR-3 cleanup)', async () => {
    // Write the version binary so copyFileSync succeeds.
    writeVersionBinary(VERSION, NEW_BYTES);
    // Make the destination dir read-only so renameSync fails.
    const dest = managedBinaryPath(tmpHome, PLATFORM);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.chmodSync(path.dirname(dest), 0o555); // read+execute only — writes forbidden

    try {
      await expect(
        adoptStaged({ home: tmpHome, platform: PLATFORM, version: VERSION }),
      ).rejects.toThrow();
    } finally {
      // Restore permissions so afterEach cleanup can delete the dir.
      fs.chmodSync(path.dirname(dest), 0o755);
    }

    // No temp file should remain in the bin dir.
    const binDir = path.dirname(dest);
    const temps = fs.readdirSync(binDir).filter((e) => e.startsWith('.myco-adopt-'));
    expect(temps).toEqual([]);
  });
});

// ===========================================================================
// restoreVersion — executable mode + failure propagation (IMPORTANT-2 + MINOR-3)
// ===========================================================================

describe('restoreVersion — mode and failure', () => {
  const PREV_VERSION = '1.1.0';
  const PREV_BYTES = 'PREV-BINARY-v1.1.0';

  function writeVersionBinary(version: string, content: string): string {
    const vBin = versionBinaryPath(tmpHome, PLATFORM, version);
    fs.mkdirSync(path.dirname(vBin), { recursive: true });
    fs.writeFileSync(vBin, content);
    return vBin;
  }

  it('restored binary has executable mode on non-win32 (mode & 0o111 !== 0)', async () => {
    if (process.platform === 'win32') return; // skip on Windows
    writeVersionBinary(PREV_VERSION, PREV_BYTES);
    const stablePath = managedBinaryPath(tmpHome, PLATFORM);
    fs.mkdirSync(path.dirname(stablePath), { recursive: true });
    fs.writeFileSync(stablePath, NEW_BYTES);

    await restoreVersion(tmpHome, PLATFORM, PREV_VERSION);

    const mode = fs.statSync(stablePath).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it('leaves no temp in bin dir when rename fails (MINOR-3 cleanup)', async () => {
    writeVersionBinary(PREV_VERSION, PREV_BYTES);
    const dest = managedBinaryPath(tmpHome, PLATFORM);
    const destDir = path.dirname(dest);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, NEW_BYTES);
    fs.chmodSync(destDir, 0o555); // read+execute only — writes forbidden

    try {
      await expect(
        restoreVersion(tmpHome, PLATFORM, PREV_VERSION),
      ).rejects.toThrow();
    } finally {
      fs.chmodSync(destDir, 0o755);
    }

    const temps = fs.readdirSync(destDir).filter((e) => e.startsWith('.myco-restore-'));
    expect(temps).toEqual([]);
  });
});

// ===========================================================================
// T4 — chmod-failure propagation: adoptStaged + restoreVersion
//
// On non-win32, chmodSync failure after copyFileSync must:
//   1. reject / throw
//   2. clean up the temp file (rmSafe)
//   3. leave the stable managed binary UNCHANGED
// ===========================================================================

describe('adoptStaged — chmod-failure propagation (T4)', () => {
  if (process.platform === 'win32') return; // chmod is a no-op on win32; skip

  function writeVersionBinary(version: string, content: string): void {
    const vBin = versionBinaryPath(tmpHome, PLATFORM, version);
    fs.mkdirSync(path.dirname(vBin), { recursive: true });
    fs.writeFileSync(vBin, content);
  }

  it('rejects when chmodSync throws on the temp file', async () => {
    if (process.platform === 'win32') return;
    writeVersionBinary(VERSION, NEW_BYTES);
    // Pre-populate the stable binary so we can verify it is untouched.
    const stablePath = writeStableBinary();

    const chmodSpy = vi.spyOn(fs, 'chmodSync').mockImplementation((p, _mode) => {
      // Only intercept the .myco-adopt-* temp file; let other chmod calls pass.
      if (typeof p === 'string' && p.includes('.myco-adopt-')) {
        throw new Error('chmod injected failure');
      }
      // Pass through to real implementation for other paths.
      return undefined;
    });

    try {
      await expect(
        adoptStaged({ home: tmpHome, platform: PLATFORM, version: VERSION }),
      ).rejects.toThrow();
    } finally {
      chmodSpy.mockRestore();
    }

    // The stable managed binary must be byte-for-byte unchanged.
    expect(fs.readFileSync(stablePath, 'utf-8')).toBe(STABLE_BYTES);

    // No temp file should remain in the managed bin dir.
    const binDir = path.dirname(stablePath);
    const temps = fs.readdirSync(binDir).filter((e) => e.startsWith('.myco-adopt-'));
    expect(temps).toEqual([]);
  });
});

describe('restoreVersion — chmod-failure propagation (T4)', () => {
  if (process.platform === 'win32') return; // chmod is a no-op on win32; skip

  const PREV_VERSION = '1.1.0';
  const PREV_BYTES = 'PREV-BINARY-v1.1.0';

  function writeVersionBinary(version: string, content: string): void {
    const vBin = versionBinaryPath(tmpHome, PLATFORM, version);
    fs.mkdirSync(path.dirname(vBin), { recursive: true });
    fs.writeFileSync(vBin, content);
  }

  it('rejects when chmodSync throws on the temp file', async () => {
    if (process.platform === 'win32') return;
    writeVersionBinary(PREV_VERSION, PREV_BYTES);
    // Pre-populate the stable binary as the "current" managed binary.
    const stablePath = managedBinaryPath(tmpHome, PLATFORM);
    fs.mkdirSync(path.dirname(stablePath), { recursive: true });
    fs.writeFileSync(stablePath, NEW_BYTES);

    const chmodSpy = vi.spyOn(fs, 'chmodSync').mockImplementation((p, _mode) => {
      if (typeof p === 'string' && p.includes('.myco-restore-')) {
        throw new Error('chmod injected failure');
      }
      return undefined;
    });

    try {
      await expect(
        restoreVersion(tmpHome, PLATFORM, PREV_VERSION),
      ).rejects.toThrow();
    } finally {
      chmodSpy.mockRestore();
    }

    // Managed binary must be byte-for-byte unchanged (still NEW_BYTES, not the restored version).
    expect(fs.readFileSync(stablePath, 'utf-8')).toBe(NEW_BYTES);

    // No temp file should remain in the managed bin dir.
    const binDir = path.dirname(stablePath);
    const temps = fs.readdirSync(binDir).filter((e) => e.startsWith('.myco-restore-'));
    expect(temps).toEqual([]);
  });
});

// ===========================================================================
// download() — byte-cap DoS guard (E1)
//
// Tests exercise the real DEFAULT_BINARY_UPDATE_DEPS.download() by injecting
// a fake globalThis.fetch. No real network is used.
//
// The cap is MAX_DOWNLOAD_BYTES (256 MiB). To keep tests fast, we use a tiny
// TEST_CAP and override it in the test — but since MAX_DOWNLOAD_BYTES is a
// module-level constant we instead supply a body that genuinely exceeds the
// real cap is impractical, so we test with a body that is just-under and
// just-over a count that the real streaming counter accumulates.
//
// Strategy: construct a fake ReadableStream that yields chunks summing to
// exactly MAX_DOWNLOAD_BYTES + 1, and verify the download is aborted.
// ===========================================================================

/** Build a fake Response whose body is a ReadableStream of `chunks`. */
function fakeResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200, headers });
}

describe('download() — byte-cap DoS guard (E1)', () => {
  let savedFetch: typeof globalThis.fetch;
  let destPath: string;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    // Use a per-test temp file inside tmpHome (which is recreated each test by
    // the outer beforeEach/afterEach).
    destPath = path.join(tmpHome, 'dl-test.tmp');
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    // Clean up in case a test left the file.
    try { fs.rmSync(destPath, { force: true }); } catch { /* best-effort */ }
  });

  it('streams a response under the cap successfully to disk', async () => {
    // 1 MiB of data — well under 256 MiB.
    const oneMiB = 1024 * 1024;
    const chunk = new Uint8Array(oneMiB).fill(0xab);
    globalThis.fetch = mock(async () => fakeResponse([chunk]));

    await DEFAULT_BINARY_UPDATE_DEPS.download('https://example.test/asset', destPath);

    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.statSync(destPath).size).toBe(oneMiB);
  });

  it('rejects when cumulative bytes exceed MAX_DOWNLOAD_BYTES and cleans up the partial file', async () => {
    // Construct two chunks that together exceed MAX_DOWNLOAD_BYTES by 1 byte.
    // Each chunk is MAX_DOWNLOAD_BYTES/2 + 1 bytes, so after the second chunk
    // the running total is MAX_DOWNLOAD_BYTES + 2 > MAX_DOWNLOAD_BYTES.
    const halfCap = Math.floor(MAX_DOWNLOAD_BYTES / 2) + 1;
    const chunk1 = new Uint8Array(halfCap).fill(0xcc);
    const chunk2 = new Uint8Array(halfCap).fill(0xdd);
    globalThis.fetch = mock(async () => fakeResponse([chunk1, chunk2]));

    await expect(
      DEFAULT_BINARY_UPDATE_DEPS.download('https://example.test/asset', destPath),
    ).rejects.toThrow(/exceeded.*bytes.*cap/i);

    // Partial temp file must be cleaned up.
    expect(fs.existsSync(destPath)).toBe(false);
  });

  it('rejects on a lying Content-Length (small header, large body still caught by streaming counter)', async () => {
    // Content-Length lies small (1 byte), body is actually over the cap.
    const halfCap = Math.floor(MAX_DOWNLOAD_BYTES / 2) + 1;
    const chunk1 = new Uint8Array(halfCap).fill(0xee);
    const chunk2 = new Uint8Array(halfCap).fill(0xff);
    globalThis.fetch = mock(async () =>
      fakeResponse([chunk1, chunk2], { 'content-length': '1' }),
    );

    await expect(
      DEFAULT_BINARY_UPDATE_DEPS.download('https://example.test/asset', destPath),
    ).rejects.toThrow(/exceeded.*bytes.*cap/i);

    // Even though Content-Length was small (passed the early check), the
    // streaming counter caught it and must have cleaned the partial file.
    expect(fs.existsSync(destPath)).toBe(false);
  });
});
