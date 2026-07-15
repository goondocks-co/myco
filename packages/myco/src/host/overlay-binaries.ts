/**
 * Shared overlay-binary provisioning — the seams, target resolution, and
 * Tailscale (data-plane) provisioning used by BOTH sides of Team Host:
 *
 *   - the HOST (`@myco-team/host/binaries.ts`, Task 2.1) which composes this
 *     with its own Headscale (control-plane) provisioning, and
 *   - the MEMBER (`@myco/host/member-overlay.ts`, Task 2.2) which needs ONLY the
 *     Tailscale client + daemon (no Headscale — a member joins, it never controls).
 *
 * Extracted from Task 2.1's `binaries.ts` so the pinned Tailscale version, the
 * checksum/verify-landed discipline, and the injectable {@link BinaryFetcher} /
 * {@link CommandRunner} seams have ONE definition. `@myco-team/host/binaries.ts`
 * re-exports the symbols its callers/tests already import, so that file's public
 * surface is unchanged — this is a source-of-truth extraction, not a fork.
 *
 * Dependency direction: `@myco-team` already depends on `@myco` (it imports
 * `@myco/*` throughout); the reverse is a cycle. So the shared code lives HERE,
 * in `@myco`, where the member consumes it directly and the host reaches back
 * across the existing `@myco-team → @myco` edge.
 *
 * Tailscale distribution model (per the live spike §0.1b):
 *   · macOS: the open-source, headless kernel-TUN variant ships only through
 *     Homebrew — there is no standalone macOS `tailscaled` on pkgs.tailscale.com.
 *     Ensure the formula, then locate + version-probe the linked binaries.
 *   · Linux: the static tarball on pkgs.tailscale.com carries both binaries;
 *     downloaded, verified against its `.sha256` sidecar, and extracted.
 *
 * ALL network + command + filesystem effects run behind the injectable seams so
 * every consumer unit-tests with no network and no real install. The one non-seam
 * I/O is writing the verified bytes into the (test-temp) bin dir.
 *
 * VERIFY-LANDED-BEFORE-USE: the spike hit a partial-binary-copy flake, so every
 * placed binary is re-stat'd (exists + non-empty + executable) before this module
 * reports success. A caller must never invoke a binary this module has not
 * confirmed landed whole.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

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

/** The Tailscale static Linux tarball asset name (contains tailscale + tailscaled). */
export function tailscaleLinuxTarballName(target: OverlayTarget): string {
  return `tailscale_${TAILSCALE_VERSION}_${target.arch}.tgz`;
}

export function tailscaleLinuxTarballUrl(target: OverlayTarget): string {
  return `https://pkgs.tailscale.com/stable/${tailscaleLinuxTarballName(target)}`;
}

// ---------------------------------------------------------------------------
// Tailscale (data-plane) provisioning — shared by host + member
// ---------------------------------------------------------------------------

export interface TailscaleBinaries {
  /** Absolute path to the tailscale CLI. */
  tailscaleBin: string;
  /** Absolute path to the tailscaled daemon binary. */
  tailscaledBin: string;
  /** Version provenance (probed from the binary, falling back to the pin). */
  tailscaleVersion: string;
  /** How the binaries were obtained (audit / provenance). */
  source: 'download' | 'brew';
}

export interface TailscaleProvisionOptions {
  target: OverlayTarget;
  fetcher: BinaryFetcher;
  runner: CommandRunner;
  /** Bin dir the Linux tarball extracts into (ignored on macOS/brew). */
  binDir: string;
  /**
   * Directories to search for the brew-installed tailscale/tailscaled (macOS).
   * Defaults to the two standard Homebrew prefixes; injected by tests so the
   * darwin locate path is hermetic (no real /opt/homebrew dependency).
   */
  brewBinDirs?: string[];
  logger?: (message: string) => void;
}

export const DEFAULT_BREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/**
 * Resolve + fetch + verify the Tailscale client + daemon for `target`. Idempotent:
 * a Linux binary already present and passing verify-landed is left in place (the
 * tarball re-extraction is skipped when both binaries already exist); brew's own
 * idempotence covers macOS.
 */
export async function provisionTailscaleBinaries(opts: TailscaleProvisionOptions): Promise<TailscaleBinaries> {
  const log = opts.logger ?? (() => {});
  const located = opts.target.os === 'darwin'
    ? await provisionTailscaleDarwin(opts.runner, opts.brewBinDirs ?? DEFAULT_BREW_BIN_DIRS, log)
    : await provisionTailscaleLinux(opts.target, opts.binDir, opts.fetcher, opts.runner, log);
  const tailscaleVersion = await probeVersion(opts.runner, located.tailscaleBin, ['version'], TAILSCALE_VERSION);
  return { ...located, tailscaleVersion };
}

async function provisionTailscaleDarwin(
  runner: CommandRunner,
  brewBinDirs: string[],
  log: (m: string) => void,
): Promise<{ tailscaleBin: string; tailscaledBin: string; source: 'brew' }> {
  // Probe for already-linked binaries FIRST — covers both a re-run (the
  // common idempotent case) and a non-interactive/headless shell where `brew`
  // isn't on PATH (spawn resolves to exit 127) but tailscale was already
  // provisioned by a prior run or out of band. No need to shell `brew` at all
  // when the binaries are already there.
  const existingTailscale = firstExisting(brewBinDirs.map((d) => path.join(d, 'tailscale')));
  const existingTailscaled = firstExisting(brewBinDirs.map((d) => path.join(d, 'tailscaled')));
  if (existingTailscale && existingTailscaled) {
    await verifyLanded(existingTailscale);
    await verifyLanded(existingTailscaled);
    log(`tailscale (brew) already present at ${existingTailscaled} — skipping brew.`);
    return { tailscaleBin: existingTailscale, tailscaledBin: existingTailscaled, source: 'brew' };
  }

  // A non-interactive shell (headless serve box) typically has no `brew` on
  // PATH, so a bare `brew` invocation exits 127 (ENOENT) rather than running.
  // Resolve brew at its known Homebrew-prefix location first — the same
  // prefixes `brewBinDirs` already searches for the linked tailscale binaries
  // — and fall back to the bare command name for an interactive shell where
  // PATH does the resolving.
  const brewBin = firstExisting(brewBinDirs.map((d) => path.join(d, 'brew'))) ?? 'brew';

  // The open-source macOS variant ships via Homebrew (spike §1.1): there is no
  // standalone macOS tailscaled binary to download+checksum. Ensure the formula
  // is present, then locate the binaries brew put on PATH.
  const listed = await runner.run(brewBin, ['list', '--formula', 'tailscale']);
  if (listed.exitCode !== 0) {
    log('installing tailscale via Homebrew (open-source, headless variant)…');
    const install = await runner.run(brewBin, ['install', '--formula', 'tailscale']);
    if (install.exitCode !== 0) {
      throw new Error(
        `brew install --formula tailscale failed (exit ${install.exitCode}): ${install.stdout.trim()}. `
        + 'Install Homebrew and the tailscale formula, then re-run.',
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
  await verifyLanded(tailscaleBin);
  await verifyLanded(tailscaledBin);
  log(`tailscale (brew) located: ${tailscaledBin}`);
  return { tailscaleBin, tailscaledBin, source: 'brew' };
}

async function provisionTailscaleLinux(
  target: OverlayTarget,
  binDir: string,
  fetcher: BinaryFetcher,
  runner: CommandRunner,
  log: (m: string) => void,
): Promise<{ tailscaleBin: string; tailscaledBin: string; source: 'download' }> {
  const tailscaleBin = path.join(binDir, 'tailscale');
  const tailscaledBin = path.join(binDir, 'tailscaled');
  // Idempotent: both binaries already extracted and whole → skip the re-fetch.
  if (await pathExists(tailscaleBin) && await pathExists(tailscaledBin)) {
    try {
      await verifyLanded(tailscaleBin);
      await verifyLanded(tailscaledBin);
      log(`tailscale ${TAILSCALE_VERSION} already extracted in ${binDir} — skipping download.`);
      return { tailscaleBin, tailscaledBin, source: 'download' };
    } catch { /* a partial prior extraction — fall through and re-fetch */ }
  }

  await fs.promises.mkdir(binDir, { recursive: true });
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
  await fs.promises.writeFile(tarPath, tarball);
  // Extract just the two binaries (they live under `tailscale_<v>_<arch>/`).
  const extract = await runner.run('tar', ['-xzf', tarPath, '-C', binDir, '--strip-components=1',
    `tailscale_${TAILSCALE_VERSION}_${target.arch}/tailscale`,
    `tailscale_${TAILSCALE_VERSION}_${target.arch}/tailscaled`]);
  if (extract.exitCode !== 0) {
    throw new Error(`Failed to extract ${tarballName} (exit ${extract.exitCode}): ${extract.stdout.trim()}`);
  }
  await fs.promises.chmod(tailscaleBin, 0o755);
  await fs.promises.chmod(tailscaledBin, 0o755);
  await verifyLanded(tailscaleBin);
  await verifyLanded(tailscaledBin);
  log(`tailscale ${TAILSCALE_VERSION} extracted to ${binDir}`);
  return { tailscaleBin, tailscaledBin, source: 'download' };
}

// ---------------------------------------------------------------------------
// Helpers (shared with the host's headscale provisioning)
// ---------------------------------------------------------------------------

export async function downloadCapped(fetcher: BinaryFetcher, url: string, label: string): Promise<Uint8Array> {
  const bytes = await fetcher.download(url);
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`download of ${label} exceeded ${MAX_DOWNLOAD_BYTES} bytes — aborting (${url}).`);
  }
  if (bytes.byteLength === 0) {
    throw new Error(`download of ${label} was empty (${url}).`);
  }
  return bytes;
}

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function placeExecutable(dest: string, bytes: Uint8Array): Promise<void> {
  // Same-dir temp + rename → the final placement is atomic (never a torn/partial
  // binary at `dest`, guarding against the spike's partial-copy flake).
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, bytes);
  await fs.promises.chmod(tmp, 0o755);
  await fs.promises.rename(tmp, dest);
}

/** Re-stat a just-placed binary: exists, non-empty, executable. Throws otherwise. */
export async function verifyLanded(binPath: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(binPath);
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

export function firstExisting(candidates: string[]): string | null {
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Async existence check (no throw either way) — used on the Linux idempotency
 *  path so it never blocks the daemon main loop during first-time provisioning. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function probeVersion(
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

/**
 * The real {@link CommandRunner} — a thin spawn wrapper shared by binary
 * provisioning, service supervision, and the tailscale/headscale CLI seams.
 * Combined stdout+stderr decoding, plus optional stdin (`input`) for the calls
 * that pipe a value in (e.g. the headscale preauth-key mint).
 *
 * NEVER rejects on a non-zero exit — the exit code is returned so callers decide
 * what a failure means. A spawn error (ENOENT) resolves as exit 127 so a missing
 * binary reads as a normal failure, not an unhandled rejection.
 */
export const realCommandRunner: CommandRunner = {
  run(command: string, args: string[], opts?: { input?: string }): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: [opts?.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on('data', (b: Buffer) => out.push(b));
      child.stderr?.on('data', (b: Buffer) => err.push(b));
      child.on('error', (e: Error) => resolve({ stdout: String(e.message), exitCode: 127 }));
      child.on('close', (code) => resolve({
        stdout: Buffer.concat(out).toString('utf8') + Buffer.concat(err).toString('utf8'),
        exitCode: code ?? 0,
      }));
      if (opts?.input !== undefined && child.stdin) {
        child.stdin.write(opts.input);
        child.stdin.end();
      }
    });
  },
};
