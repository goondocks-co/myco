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

/**
 * §14.5/§14.6 doctor gates (4 + 6): a version bump without re-enable
 * produces a row; the required row reports DRIFT (digest-primary), and
 * unknown as unknown — never as converged.
 */
describe('checkOverlayBinaryDrift', () => {
  // FULLY HERMETIC (review round 4): isolate chunks run FILES CONCURRENTLY
  // in one process sharing process.env, so an env-swap fixture races by
  // construction. State and binDir are INJECTED through the check's seams;
  // no process.env is touched anywhere in this file.
  function hostFixture(overrides: Partial<import('@myco/team-host/state.js').HostState> = {}) {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-drift-bin-'));
    const headscaleBin = path.join(binDir, 'headscale');
    fs.writeFileSync(headscaleBin, 'HEADSCALE BYTES');
    const state: import('@myco/team-host/state.js').HostState = {
      host_id: 'host_x', enabled_at: 'x', server_url: 'https://h:8080',
      overlay_address: '100.64.0.1', node_id: '1', headscale_user: 'myco-host',
      headscale_version: '0.29.2', tailscale_version: '1.98.8',
      platform: process.platform,
      headscale_bin: headscaleBin,
      tailscale_bin: path.join(binDir, 'tailscale'),
      tailscaled_bin: path.join(binDir, 'tailscaled'),
      ...overrides,
    };
    return { binDir, headscaleBin, state };
  }

  it('returns null on a machine with no host state and no member registry', async () => {
    const { checkOverlayBinaryDrift } = await import('@myco/cli/doctor.js');
    expect(await checkOverlayBinaryDrift(process.platform, { state: null })).toBeNull();
  });

  it('GATE 4 (§14.9): a managed binary whose provisioned version differs from the pin produces a row naming `myco host enable`', async () => {
    const { updateProvisioningManifest, sha256OfFile } = await import('@myco/host/overlay-provisioning-manifest.js');
    const { checkOverlayBinaryDrift } = await import('@myco/cli/doctor.js');
    const { binDir, headscaleBin, state } = hostFixture();
    // Provisioned at an OLDER version than this binary's pin.
    updateProvisioningManifest(binDir, 'headscale', {
      version: '0.28.0', sha256: sha256OfFile(headscaleBin), provisioned_at: 'x',
    });

    const row = await checkOverlayBinaryDrift('darwin', { binDir, state });
    expect(row).not.toBeNull();
    expect(row!.detail).toContain('headscale: provisioned 0.28.0');
    expect(row!.detail).toContain('myco host enable');
  });

  it('a managed binary with a matching manifest produces NO headscale complaint', async () => {
    const { updateProvisioningManifest, sha256OfFile } = await import('@myco/host/overlay-provisioning-manifest.js');
    const { HEADSCALE_VERSION } = await import('@myco/team-host/binaries.js');
    const { checkOverlayBinaryDrift } = await import('@myco/cli/doctor.js');
    const { binDir, headscaleBin, state } = hostFixture({ headscale_version: HEADSCALE_VERSION });
    updateProvisioningManifest(binDir, 'headscale', {
      version: HEADSCALE_VERSION, sha256: sha256OfFile(headscaleBin), provisioned_at: 'x',
    });

    const row = await checkOverlayBinaryDrift('darwin', { binDir, state });
    // tailscale/tailscaled rows may fire (no manifest entries in this
    // fixture); headscale must not.
    expect(row?.detail ?? '').not.toContain('headscale:');
  });

  it('GATE 6 (§14.6): the required row reports digest DRIFT against the enable record, and unreadable as its own case', async () => {
    const { updateProvisioningManifest, sha256OfFile } = await import('@myco/host/overlay-provisioning-manifest.js');
    const { HEADSCALE_VERSION, TAILSCALE_VERSION } = await import('@myco/team-host/binaries.js');
    const { checkOverlayBinaryDrift } = await import('@myco/cli/doctor.js');
    const { binDir, headscaleBin, state } = hostFixture({ headscale_version: HEADSCALE_VERSION });
    updateProvisioningManifest(binDir, 'headscale', {
      version: HEADSCALE_VERSION, sha256: sha256OfFile(headscaleBin), provisioned_at: 'x',
    });
    const tailscaledBin = path.join(binDir, 'tailscaled');
    fs.writeFileSync(tailscaledBin, 'ORIGINAL BREW BYTES');
    const recorded = {
      ...state,
      tailscaled_bin: tailscaledBin,
      tailscaled_sha256: crypto.createHash('sha256').update('ORIGINAL BREW BYTES').digest('hex'),
    };

    // Converged: no tailscaled complaint.
    let row = await checkOverlayBinaryDrift('darwin', { binDir, state: recorded });
    expect(row?.detail ?? '').not.toContain('tailscaled (Homebrew) changed');

    // Drift (a `brew upgrade` replaced the bytes).
    fs.writeFileSync(tailscaledBin, 'UPGRADED BREW BYTES');
    row = await checkOverlayBinaryDrift('darwin', { binDir, state: recorded });
    expect(row!.detail).toContain('tailscaled (Homebrew) changed since enable');

    // Unreadable (a `brew uninstall`): its own case, never silently converged.
    fs.rmSync(tailscaledBin);
    row = await checkOverlayBinaryDrift('darwin', { binDir, state: recorded });
    expect(row!.detail).toContain('tailscaled (Homebrew) unreadable');
  });

  it('GATE (R-B2): a record with NO enable-time digest reports unknown — never converged', async () => {
    const { checkOverlayBinaryDrift } = await import('@myco/cli/doctor.js');
    const { binDir, state } = hostFixture({ tailscaled_sha256: null });

    const row = await checkOverlayBinaryDrift('darwin', { binDir, state });
    expect(row!.detail).toContain('no enable-time digest recorded');
  });
});
