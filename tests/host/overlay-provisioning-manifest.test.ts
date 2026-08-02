/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OVERLAY_BINARY_MODES,
  binaryConverged,
  manifestPath,
  readProvisioningManifest,
  updateProvisioningManifest,
} from '@myco/host/overlay-provisioning-manifest.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-manifest-'));
}

describe('provisioning manifest', () => {
  it('GATE (spec R-M3): two writers into ONE dir keep both entries — merge, never whole-file clobber', () => {
    const dir = tmp();
    updateProvisioningManifest(dir, 'headscale', { version: '0.29.2', sha256: 'aa', provisioned_at: 'x' });
    updateProvisioningManifest(dir, 'tailscaled', { version: '1.98.8', sha256: 'bb', provisioned_at: 'y' });

    const manifest = readProvisioningManifest(dir);
    expect(Object.keys(manifest!.binaries).sort()).toEqual(['headscale', 'tailscaled']);
  });

  it('GATE (§14.3): unknown ALWAYS re-provisions — absent manifest, absent entry, version drift, torn JSON, missing binary, digest mismatch', () => {
    const dir = tmp();
    const bin = path.join(dir, 'tailscaled');
    fs.writeFileSync(bin, 'BINARY BYTES');
    const digest = crypto.createHash('sha256').update('BINARY BYTES').digest('hex');

    // absent manifest
    expect(binaryConverged(dir, 'tailscaled', bin, '1.98.8')).toBe(false);
    updateProvisioningManifest(dir, 'tailscaled', { version: '1.98.8', sha256: digest, provisioned_at: 'x' });
    // converged
    expect(binaryConverged(dir, 'tailscaled', bin, '1.98.8')).toBe(true);
    // version bump ⇒ diverged (the fleet-convergence signal)
    expect(binaryConverged(dir, 'tailscaled', bin, '1.99.0')).toBe(false);
    // absent entry
    expect(binaryConverged(dir, 'tailscale', bin, '1.98.8')).toBe(false);
    // content drift
    fs.writeFileSync(bin, 'TAMPERED');
    expect(binaryConverged(dir, 'tailscaled', bin, '1.98.8')).toBe(false);
    // missing binary
    fs.rmSync(bin);
    expect(binaryConverged(dir, 'tailscaled', bin, '1.98.8')).toBe(false);
    // torn JSON
    fs.writeFileSync(manifestPath(dir), '{"schema":1,"binaries":{', 'utf-8');
    expect(readProvisioningManifest(dir)).toBeNull();
    fs.writeFileSync(bin, 'BINARY BYTES');
    expect(binaryConverged(dir, 'tailscaled', bin, '1.98.8')).toBe(false);
  });

  it('the mode taxonomy is closed and covers every binary the overlay touches', () => {
    expect(OVERLAY_BINARY_MODES.tailscale).toEqual({ darwin: 'required', linux: 'managed' });
    expect(OVERLAY_BINARY_MODES.headscale).toEqual({ darwin: 'managed', linux: 'managed' });
    for (const platform of ['tar', 'sudo', 'brew', 'launchctl', 'systemctl', 'loginctl']) {
      const modes = Object.values(OVERLAY_BINARY_MODES[platform] ?? {});
      expect(modes.length).toBeGreaterThan(0);
      expect(modes.every((mode) => mode === 'platform')).toBe(true);
    }
  });
});
