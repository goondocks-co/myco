/**
 * Team Host overlay binary provisioning (Task 2.1).
 *
 * Resolves and fetches the pinned overlay binaries into the machine-global host
 * control home (`~/.myco-team/host/bin/`), checksum-verified, before either is
 * installed as a root service. Two provisioning sources, per the live spike
 * (§0.1b) and each vendor's actual distribution model:
 *
 *   - Headscale v0.29.2 (control plane): a single static binary published as a
 *     GitHub release asset on every platform. Downloaded and verified against
 *     the release's own `checksums.txt` (goreleaser default) — the same
 *     download-both-then-verify discipline as `upgrade/apply-binary.ts`, so no
 *     brittle hardcoded per-arch digest.
 *   - Tailscale / tailscaled 1.98.8 (data plane):
 *       · macOS: the open-source variant is distributed through Homebrew (there
 *         is no standalone macOS `tailscaled` binary on pkgs.tailscale.com). The
 *         spike installed it exactly this way — `brew install --formula
 *         tailscale`, yielding a headless kernel-TUN `tailscaled`. Brew verifies
 *         its own bottle; we then locate + version-probe the installed binaries.
 *       · Linux: the static tarball on pkgs.tailscale.com carries both binaries;
 *         downloaded, verified against its `.sha256`, and extracted.
 *
 * ALL network + command + filesystem effects run behind injectable seams
 * ({@link BinaryFetcher}, {@link CommandRunner}) so this module unit-tests with
 * no network and no real install. The one non-seam I/O is writing the verified
 * bytes into the (test-temp) bin dir.
 *
 * VERIFY-LANDED-BEFORE-USE: the spike hit a partial-binary-copy flake, so every
 * placed binary is re-stat'd (exists + non-empty + executable) before this
 * module reports success. A caller must never invoke a binary this module has
 * not confirmed landed whole.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseSha256Sum } from '@myco/upgrade/release-assets.js';
import { resolveHostControlDir } from '@myco/grove/paths.js';

export const HEADSCALE_VERSION = '0.29.2';
export const TAILSCALE_VERSION = '1.98.8';

/** OS families Team Host supports. Windows is out of scope (spike §1). */
export type OverlayOs = 'darwin' | 'linux';
/** CPU arches, in the vendor's own asset-naming vocabulary. */
export type OverlayArch = 'arm64' | 'amd64';

/** Bounds a downloaded body — a compromised CDN returning a huge response would
 *  otherwise OOM the CLI. Well above the largest expected asset (~40 MB). */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export interface BinaryFetcher {
  /** GET `url` → raw bytes. MUST throw on any non-2xx / network failure. */
  download(url: string): Promise<Uint8Array>;
}

export interface CommandRunner {
  /** Run `command args`, resolving with combined output + exit code (never rejects on non-zero). */
  run(command: string, args: string[], opts?: { input?: string }): Promise<{ stdout: string; exitCode: number }>;
}

// ---------------------------------------------------------------------------
// Platform resolution
// ---------------------------------------------------------------------------

export interface OverlayTarget {
  os: OverlayOs;
  arch: OverlayArch;
}

/**
 * Map a Node platform/arch pair onto an {@link OverlayTarget}. Throws a clear,
 * operator-facing error on an unsupported platform (Windows) or arch rather than
 * silently resolving a wrong asset.
 */
export function resolveOverlayTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): OverlayTarget {
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(
      `Team Host is only supported on macOS and Linux; this machine reports "${platform}". `
      + 'Windows hosts are not supported in v1.',
    );
  }
  const overlayArch: OverlayArch | null =
    arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : null;
  if (!overlayArch) {
    throw new Error(`Unsupported CPU architecture for Team Host: "${arch}" (need arm64 or x64).`);
  }
  return { os: platform, arch: overlayArch };
}

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

/** The Tailscale static Linux tarball asset name (contains tailscale + tailscaled). */
export function tailscaleLinuxTarballName(target: OverlayTarget): string {
  return `tailscale_${TAILSCALE_VERSION}_${target.arch}.tgz`;
}

export function tailscaleLinuxTarballUrl(target: OverlayTarget): string {
  return `https://pkgs.tailscale.com/stable/${tailscaleLinuxTarballName(target)}`;
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
  /** Version provenance, recorded into host state. */
  headscaleVersion: string;
  tailscaleVersion: string;
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

const DEFAULT_BREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

export function resolveHostBinDir(): string {
  return path.join(resolveHostControlDir(), 'bin');
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * Resolve + fetch + verify the overlay binaries for `target`. Idempotent: a
 * binary already present and passing its checksum is left in place (no re-fetch).
 */
export async function provisionOverlayBinaries(opts: ProvisionOptions): Promise<ProvisionedBinaries> {
  const binDir = opts.binDir ?? resolveHostBinDir();
  const log = opts.logger ?? (() => {});
  fs.mkdirSync(binDir, { recursive: true });

  const headscaleBin = await provisionHeadscale(opts.target, binDir, opts.fetcher, log);
  const tailscale = opts.target.os === 'darwin'
    ? await provisionTailscaleDarwin(opts.runner, opts.brewBinDirs ?? DEFAULT_BREW_BIN_DIRS, log)
    : await provisionTailscaleLinux(opts.target, binDir, opts.fetcher, opts.runner, log);

  const headscaleVersion = await probeVersion(opts.runner, headscaleBin, ['version'], HEADSCALE_VERSION);
  const tailscaleVersion = await probeVersion(opts.runner, tailscale.tailscaleBin, ['version'], TAILSCALE_VERSION);

  return {
    headscaleBin,
    tailscaleBin: tailscale.tailscaleBin,
    tailscaledBin: tailscale.tailscaledBin,
    headscaleVersion,
    tailscaleVersion,
    source: { headscale: 'download', tailscale: tailscale.source },
  };
}

async function provisionHeadscale(
  target: OverlayTarget,
  binDir: string,
  fetcher: BinaryFetcher,
  log: (m: string) => void,
): Promise<string> {
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
    verifyLanded(dest);
    log(`headscale ${HEADSCALE_VERSION} already provisioned at ${dest} (checksum match) — skipping download.`);
    return dest;
  }

  const bytes = await downloadCapped(fetcher, headscaleAssetUrl(target), assetName);
  const actual = sha256(bytes);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Headscale ${assetName} checksum mismatch (expected ${expected}, got ${actual}) — refusing to install.`);
  }

  placeExecutable(dest, bytes);
  verifyLanded(dest);
  log(`headscale ${HEADSCALE_VERSION} verified + placed at ${dest}`);
  return dest;
}

interface TailscaleBinaries {
  tailscaleBin: string;
  tailscaledBin: string;
  source: 'download' | 'brew';
}

async function provisionTailscaleDarwin(
  runner: CommandRunner,
  brewBinDirs: string[],
  log: (m: string) => void,
): Promise<TailscaleBinaries> {
  // The open-source macOS variant ships via Homebrew (spike §1.1): there is no
  // standalone macOS tailscaled binary to download+checksum. Ensure the formula
  // is present, then locate the binaries brew put on PATH.
  const listed = await runner.run('brew', ['list', '--formula', 'tailscale']);
  if (listed.exitCode !== 0) {
    log('installing tailscale via Homebrew (open-source, headless variant)…');
    const install = await runner.run('brew', ['install', '--formula', 'tailscale']);
    if (install.exitCode !== 0) {
      throw new Error(
        `brew install --formula tailscale failed (exit ${install.exitCode}): ${install.stdout.trim()}. `
        + 'Install Homebrew and the tailscale formula, then re-run host enable.',
      );
    }
  }

  const tailscaleBin = firstExisting(brewBinDirs.map((d) => path.join(d, 'tailscale')));
  const tailscaledBin = firstExisting(brewBinDirs.map((d) => path.join(d, 'tailscaled')));
  if (!tailscaleBin || !tailscaledBin) {
    throw new Error(
      `tailscale/tailscaled not found after brew install (looked in ${brewBinDirs.join(', ')}). `
      + 'Confirm the Homebrew prefix and that the tailscale formula linked its binaries.',
    );
  }
  verifyLanded(tailscaleBin);
  verifyLanded(tailscaledBin);
  log(`tailscale (brew) located: ${tailscaledBin}`);
  return { tailscaleBin, tailscaledBin, source: 'brew' };
}

async function provisionTailscaleLinux(
  target: OverlayTarget,
  binDir: string,
  fetcher: BinaryFetcher,
  runner: CommandRunner,
  log: (m: string) => void,
): Promise<TailscaleBinaries> {
  const tarballName = tailscaleLinuxTarballName(target);
  const tarball = await downloadCapped(fetcher, tailscaleLinuxTarballUrl(target), tarballName);
  // pkgs.tailscale.com publishes a sidecar `<tarball>.sha256` (single hash).
  const shaText = new TextDecoder().decode(
    await downloadCapped(fetcher, `${tailscaleLinuxTarballUrl(target)}.sha256`, `${tarballName}.sha256`),
  ).trim();
  const expected = shaText.split(/\s+/)[0];
  const actual = sha256(tarball);
  if (!expected || actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Tailscale ${tarballName} checksum mismatch (expected ${expected || '(none)'}, got ${actual}) — refusing to install.`);
  }

  const tarPath = path.join(binDir, tarballName);
  fs.writeFileSync(tarPath, tarball);
  // Extract just the two binaries (they live under `tailscale_<v>_<arch>/`).
  const extract = await runner.run('tar', ['-xzf', tarPath, '-C', binDir, '--strip-components=1',
    `tailscale_${TAILSCALE_VERSION}_${target.arch}/tailscale`,
    `tailscale_${TAILSCALE_VERSION}_${target.arch}/tailscaled`]);
  if (extract.exitCode !== 0) {
    throw new Error(`Failed to extract ${tarballName} (exit ${extract.exitCode}): ${extract.stdout.trim()}`);
  }
  const tailscaleBin = path.join(binDir, 'tailscale');
  const tailscaledBin = path.join(binDir, 'tailscaled');
  fs.chmodSync(tailscaleBin, 0o755);
  fs.chmodSync(tailscaledBin, 0o755);
  verifyLanded(tailscaleBin);
  verifyLanded(tailscaledBin);
  log(`tailscale ${TAILSCALE_VERSION} extracted to ${binDir}`);
  return { tailscaleBin, tailscaledBin, source: 'download' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function downloadCapped(fetcher: BinaryFetcher, url: string, label: string): Promise<Uint8Array> {
  const bytes = await fetcher.download(url);
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`download of ${label} exceeded ${MAX_DOWNLOAD_BYTES} bytes — aborting (${url}).`);
  }
  if (bytes.byteLength === 0) {
    throw new Error(`download of ${label} was empty (${url}).`);
  }
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function placeExecutable(dest: string, bytes: Uint8Array): void {
  // Same-dir temp + rename → the final placement is atomic (never a torn/partial
  // binary at `dest`, guarding against the spike's partial-copy flake).
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, bytes);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
}

/** Re-stat a just-placed binary: exists, non-empty, executable. Throws otherwise. */
function verifyLanded(binPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(binPath);
  } catch {
    throw new Error(`binary did not land at ${binPath} — refusing to use a missing binary.`);
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`binary at ${binPath} is empty or not a regular file (size ${stat.size}) — likely a partial copy.`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
    throw new Error(`binary at ${binPath} is not executable — refusing to use.`);
  }
}

function firstExisting(candidates: string[]): string | null {
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function probeVersion(
  runner: CommandRunner,
  bin: string,
  args: string[],
  fallback: string,
): Promise<string> {
  try {
    const { stdout, exitCode } = await runner.run(bin, args);
    if (exitCode !== 0) return fallback;
    const first = stdout.split('\n').map((l) => l.trim()).find(Boolean);
    const match = first?.match(/\d+\.\d+\.\d+/);
    return match ? match[0] : (first || fallback);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Default (real) seams
// ---------------------------------------------------------------------------

export const realFetcher: BinaryFetcher = {
  async download(url: string): Promise<Uint8Array> {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  },
};
