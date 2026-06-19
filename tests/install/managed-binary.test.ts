import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  managedBinaryPath,
  writeInstallMarker,
  readInstallMarker,
} from '@myco/install/managed-binary';

// The path-layout helpers now live in the shared `scripts/managed-paths.mjs`
// module and are exhaustively covered (myco-home convention, win32 localAppData
// rooting, no doubled `.myco/.myco`) in tests/install/managed-paths.test.ts.
// This file covers what `managed-binary.ts` still OWNS — the install marker —
// plus a smoke that the path helpers are re-exported on the new convention.

describe('managed-binary: re-exports path helpers on the myco-home convention', () => {
  it('roots the managed binary at <mycoHome>/bin (no extra .myco)', () => {
    expect(managedBinaryPath('/home/u/.myco', 'linux')).toBe('/home/u/.myco/bin/myco');
    expect(managedBinaryPath('/home/u/.myco', 'linux')).not.toContain('.myco/.myco');
  });
});

describe('managed-binary: install marker', () => {
  it('round-trips the marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-marker-'));
    try {
      writeInstallMarker(dir, { channel: 'stable', source: 'npm', bin: `${dir}/bin/myco` });
      const marker = readInstallMarker(dir);
      expect(marker?.source).toBe('npm');
      expect(marker?.channel).toBe('stable');
      expect(marker?.bin).toBe(`${dir}/bin/myco`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the marker is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-marker-'));
    try {
      expect(readInstallMarker(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
