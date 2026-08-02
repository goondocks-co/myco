/**
 * Team Host HOST-side binary provisioning (Task 2.1).
 *
 * Provisions the pinned overlay binaries into the machine-global host control
 * home (`~/.myco-team/host/bin/`), checksum-verified, before either is installed
 * as a root service. Two provisioning sources, per the live spike (§0.1b) and
 * each vendor's actual distribution model:
 *
 *   - Headscale v0.29.2 (control plane): a single static binary published as a
 *     GitHub release asset on every platform. Downloaded and verified against
 *     the release's own `checksums.txt` (goreleaser default) — the same
 *     download-both-then-verify discipline as `upgrade/apply-binary.ts`, so no
 *     brittle hardcoded per-arch digest. This is HOST-only: a member never runs
 *     the control plane.
 *   - Tailscale / tailscaled 1.98.8 (data plane): provisioned by the shared
 *     `@myco/host/overlay-binaries.ts` module (macOS via Homebrew, Linux via the
 *     static tarball) so the host and the member (`myco join`, Task 2.2) share
 *     ONE Tailscale-provisioning implementation.
 *
 * The seams ({@link BinaryFetcher}, {@link CommandRunner}), platform resolution,
 * and the Tailscale halves now live in `@myco/host/overlay-binaries.ts`; this
 * module re-exports the symbols its callers/tests already import so its public
 * surface is unchanged.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseSha256Sum } from '@myco/upgrade/release-assets.js';
import { updateProvisioningManifest } from '@myco/host/overlay-provisioning-manifest.js';
import { resolveHostControlDir } from '@myco/grove/paths.js';
import {
  downloadCapped,
  provisionTailscaleBinaries,
  placeExecutable,
  sha256,
  verifyLanded,
  type BinaryFetcher,
  type CommandRunner,
  type OverlayTarget,
} from '@myco/host/overlay-binaries.js';

// Re-export the shared seams + Tailscale/platform surface so existing importers
// (`overlay.ts`, `tests/cli/host-binaries.test.ts`) keep resolving from here.
export {
  DEFAULT_BREW_BIN_DIRS,
  MAX_DOWNLOAD_BYTES,
  TAILSCALE_VERSION,
  provisionTailscaleBinaries,
  realCommandRunner,
  realFetcher,
  resolveOverlayTarget,
  tailscaleLinuxTarballName,
  tailscaleLinuxTarballUrl,
} from '@myco/host/overlay-binaries.js';
export type {
  BinaryFetcher,
  CommandRunner,
  OverlayArch,
  OverlayOs,
  OverlayTarget,
  TailscaleBinaries,
} from '@myco/host/overlay-binaries.js';

export const HEADSCALE_VERSION = '0.29.2';

/** The Headscale release asset name for a target (goreleaser naming). */
export function headscaleAssetName(target: OverlayTarget): string {
  return `headscale_${HEADSCALE_VERSION}_${target.os}_${target.arch}`;
}

/** The Headscale release asset download URL. */
export function headscaleAssetUrl(target: OverlayTarget): string {
  return `https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/${headscaleAssetName(target)}`;
}

/** The Headscale release checksums file (verifies every asset in the release). */
export function headscaleChecksumsUrl(): string {
  return `https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ProvisionedBinaries {
  /** Absolute path to the verified headscale binary. */
  headscaleBin: string;
  /** Absolute path to the tailscale CLI. */
  tailscaleBin: string;
  /** Absolute path to the tailscaled daemon binary. */
  tailscaledBin: string;
  /** Version provenance, recorded into host state. Managed = the verified
   *  pin; required (darwin tailscale) = null here, resolved from brew
   *  metadata by the enable flow. */
  headscaleVersion: string;
  tailscaleVersion: string | null;
  /** Binary names whose content changed this run — the caller restarts the
   *  supervised service(s) or convergence converged nothing (§14.4). */
  changed: string[];
  /** How each family was obtained (audit / provenance). */
  source: { headscale: 'download'; tailscale: 'download' | 'brew' };
}

export interface ProvisionOptions {
  target: OverlayTarget;
  fetcher: BinaryFetcher;
  runner: CommandRunner;
  /** Bin dir to place downloaded binaries in. Defaults to `<host-control>/bin`. */
  binDir?: string;
  /**
   * Directories to search for the brew-installed tailscale/tailscaled (macOS).
   * Defaults to the two standard Homebrew prefixes; injected by tests so the
   * darwin locate path is hermetic (no real /opt/homebrew dependency).
   */
  brewBinDirs?: string[];
  logger?: (message: string) => void;
}

export function resolveHostBinDir(): string {
  return path.join(resolveHostControlDir(), 'bin');
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * Resolve + fetch + verify the overlay binaries for `target` (headscale + the
 * shared Tailscale pair). Idempotent: a binary already present and passing its
 * checksum / verify-landed is left in place (no re-fetch).
 */
export async function provisionOverlayBinaries(opts: ProvisionOptions): Promise<ProvisionedBinaries> {
  const binDir = opts.binDir ?? resolveHostBinDir();
  const log = opts.logger ?? (() => {});
  fs.mkdirSync(binDir, { recursive: true });

  const headscale = await provisionHeadscale(opts.target, binDir, opts.fetcher, log);
  const tailscale = await provisionTailscaleBinaries({
    target: opts.target,
    fetcher: opts.fetcher,
    runner: opts.runner,
    binDir,
    brewBinDirs: opts.brewBinDirs,
    logger: log,
  });

  // §14.8: the headscale version is the pin its content digest just verified
  // — probing the binary was the fail-open path (probe failure returned the
  // pin, so a broken binary reported "converged" forever).
  return {
    headscaleBin: headscale.dest,
    tailscaleBin: tailscale.tailscaleBin,
    tailscaledBin: tailscale.tailscaledBin,
    headscaleVersion: HEADSCALE_VERSION,
    tailscaleVersion: tailscale.tailscaleVersion,
    changed: [...headscale.changed, ...tailscale.changed],
    source: { headscale: 'download', tailscale: tailscale.source },
  };
}

async function provisionHeadscale(
  target: OverlayTarget,
  binDir: string,
  fetcher: BinaryFetcher,
  log: (m: string) => void,
): Promise<{ dest: string; changed: string[] }> {
  const dest = path.join(binDir, 'headscale');
  const assetName = headscaleAssetName(target);

  // The checksums file is tiny — always fetch it and use it as the source of
  // truth. An already-present binary whose bytes match the expected digest is
  // NEVER re-downloaded (checks already-done); a truncated prior copy (the spike
  // flake) fails the digest and gets re-fetched, so a stale partial is never
  // trusted just because the file exists.
  const checksumsText = new TextDecoder().decode(
    await downloadCapped(fetcher, headscaleChecksumsUrl(), 'checksums.txt'),
  );
  const expected = parseSha256Sum(checksumsText, assetName);
  if (!expected) {
    throw new Error(`Headscale checksums.txt has no entry for ${assetName} — refusing to install an unverified control-plane binary.`);
  }

  if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)).toLowerCase() === expected.toLowerCase()) {
    await verifyLanded(dest);
    // Write the manifest entry HERE too (review B2): an already-provisioned
    // host otherwise never gains a record, and the doctor's "no provisioning
    // record — run `myco host enable`" row becomes permanent and unfixable
    // because this very branch re-runs on every enable.
    updateProvisioningManifest(binDir, 'headscale', {
      version: HEADSCALE_VERSION, sha256: expected.toLowerCase(), provisioned_at: new Date().toISOString(),
    });
    log(`headscale ${HEADSCALE_VERSION} already provisioned at ${dest} (checksum match) — skipping download.`);
    return { dest, changed: [] };
  }

  const bytes = await downloadCapped(fetcher, headscaleAssetUrl(target), assetName);
  const actual = sha256(bytes);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Headscale ${assetName} checksum mismatch (expected ${expected}, got ${actual}) — refusing to install.`);
  }

  await placeExecutable(dest, bytes);
  await verifyLanded(dest);
  updateProvisioningManifest(binDir, 'headscale', {
    version: HEADSCALE_VERSION, sha256: expected.toLowerCase(), provisioned_at: new Date().toISOString(),
  });
  log(`headscale ${HEADSCALE_VERSION} verified + placed at ${dest}`);
  return { dest, changed: ['headscale'] };
}
