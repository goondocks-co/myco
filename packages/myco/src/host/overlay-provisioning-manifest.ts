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

/**
 * Provisioning manifest + the closed binary-mode taxonomy (Overlay
 * Coexistence spec §14.3).
 *
 * `managed` convergence is decided by CONTENT DIGEST against this manifest —
 * never by asking a binary its version (the deleted `probeVersion` returned
 * its caller's pin on every failure, so a truncated-but-executable binary
 * reported "converged" forever). An unknown answer (missing manifest,
 * missing binary, unreadable anything) always means RE-PROVISION, never skip.
 *
 * The manifest is per bin-dir (host and member have genuinely different
 * lifecycles) and is a TWO-WRITER file in the host dir (headscale + tailscale
 * halves), so every write goes read → merge → temp+rename (spec R-M3).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The closed taxonomy (§14.3): every external binary Myco touches has exactly
 * one mode per platform, so the next contributor is never forced to invent a
 * fourth. Iterated by the doctor drift row.
 *
 * - `managed`  — Myco downloads, verifies, owns the lifecycle; converges by
 *                digest against the provisioning manifest.
 * - `required` — upstream publishes no artifact Myco can manage; Myco may
 *                install the package ONCE through the operator's package
 *                manager (disclosed at that moment), never upgrades, never
 *                removes; drift is digest-vs-enable-record.
 * - `platform` — assumed present as part of the OS/toolchain contract; no
 *                pin, no convergence, no doctor row.
 */
export const OVERLAY_BINARY_MODES: Readonly<Record<string, Partial<Record<NodeJS.Platform, 'managed' | 'required' | 'platform'>>>> = Object.freeze({
  headscale: { darwin: 'managed', linux: 'managed' },
  tailscale: { darwin: 'required', linux: 'managed' },
  tailscaled: { darwin: 'required', linux: 'managed' },
  tar: { darwin: 'platform', linux: 'platform' },
  sudo: { darwin: 'platform', linux: 'platform' },
  launchctl: { darwin: 'platform' },
  systemctl: { linux: 'platform' },
  loginctl: { linux: 'platform' },
  brew: { darwin: 'platform' },
});

export const PROVISIONING_MANIFEST_FILENAME = 'provisioning-manifest.json';

export interface ManifestEntry {
  version: string;
  sha256: string;
  provisioned_at: string;
}

export interface ProvisioningManifest {
  schema: 1;
  binaries: Record<string, ManifestEntry>;
}

export function manifestPath(binDir: string): string {
  return path.join(binDir, PROVISIONING_MANIFEST_FILENAME);
}

export function sha256OfFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Read the manifest; ANY unreadability (absent, torn, wrong shape) is null —
 *  which convergence treats as unknown → re-provision. */
export function readProvisioningManifest(binDir: string): ProvisioningManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(binDir), 'utf-8')) as ProvisioningManifest;
    if (parsed?.schema !== 1 || typeof parsed.binaries !== 'object' || parsed.binaries === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Read → merge → temp+rename (spec R-M3: two writers share the host dir;
 *  a whole-file write from one half must not drop the other's entry). */
export function updateProvisioningManifest(binDir: string, name: string, entry: ManifestEntry): void {
  const existing = readProvisioningManifest(binDir);
  const next: ProvisioningManifest = {
    schema: 1,
    binaries: { ...(existing?.binaries ?? {}), [name]: entry },
  };
  const target = manifestPath(binDir);
  const temp = path.join(
    path.dirname(target),
    `.${PROVISIONING_MANIFEST_FILENAME}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`,
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  fs.renameSync(temp, target);
}

/**
 * Is the on-disk binary converged with the manifest? Every unknown is a
 * DIVERGED answer: absent manifest, absent entry, absent binary, or an
 * unreadable digest all mean re-provision. Never "matches → skip" on doubt.
 */
export function binaryConverged(binDir: string, name: string, binaryAbsPath: string, expectedVersion: string): boolean {
  const manifest = readProvisioningManifest(binDir);
  const entry = manifest?.binaries[name];
  if (!entry || entry.version !== expectedVersion) return false;
  try {
    return sha256OfFile(binaryAbsPath) === entry.sha256;
  } catch {
    return false;
  }
}

/** A per-run staging dir for atomic placement; caller removes it in finally. */
export function makeStagingDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `myco-${prefix}-`));
}
