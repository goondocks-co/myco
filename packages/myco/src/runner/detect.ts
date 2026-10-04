/**
 * Which harnesses this machine has, and which of them are logged in.
 *
 * Local files and local processes only. Nothing here reaches the network, and
 * no registry answers whether a harness is authenticated: the published agent
 * registry carries no credential field at all, so a probe is always of the tool
 * itself. `myco doctor` reads the same manifest and the same probes, so an
 * operator's report and a worker's offer cannot disagree.
 *
 * A probe never prints a credential. It answers whether one is present.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { credentialFile, harnessById, HARNESSES, offerable, type Harness } from './harnesses.js';
import type { ProfileCapability } from '@goondocks/myco-shared/execution-profile';

export interface DetectedHarness {
  id: string;
  installed: boolean;
  authenticated: boolean;
}

export interface OfferedHarness extends DetectedHarness {
  profile: ProfileCapability;
}

/**
 * The environment every probe runs under: this process's own, passed explicitly.
 *
 * A probe must resolve a binary against the PATH this process actually holds,
 * because that is the PATH a driver's `spawn` resolves the harness against. The
 * two are not the same by default — a synchronous child inherits the environment
 * the process STARTED with, while an asynchronous one reads it as it stands — so
 * a probe left to the default answers for a PATH the launch no longer uses, and
 * a worker can refuse to offer a harness it would spawn without trouble, or
 * offer one it cannot find. `tests/member/worker-claim-wire.test.ts` holds the
 * two together.
 */
const probeEnv = (): NodeJS.ProcessEnv => process.env;
const PROBE_TIMEOUT_MS = 10_000;
export const HARNESS_DETECTION_MAX_MS = 2 * PROBE_TIMEOUT_MS;
export const HARNESS_DETECTION_TTL_MS = 30_000;

/** Where this harness's binary is, or null when the machine has none. */
export function locate(binary: string): string | null {
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [binary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: probeEnv() });
    const first = found.split('\n')[0]?.trim() ?? '';
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/** A file that exists and holds at least one of the keys a login writes. An empty file is a logged-out file. */
function fileHolds(at: string | null, requires: readonly string[]): boolean {
  if (at === null || !existsSync(at)) return false;
  try { return holdsCredentials(readFileSync(at, 'utf8'), requires); } catch { return false; }
}

function holdsCredentials(content: string, requires: readonly string[]): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return false; }
  if (parsed === null || typeof parsed !== 'object') return false;
  const held = parsed as Record<string, unknown>;
  if (Object.keys(held).length === 0) return false;
  if (requires.length === 0) return true;
  return requires.some((key) => held[key] !== undefined && held[key] !== null && held[key] !== '');
}

function commandSucceeds(binary: string, args: readonly string[]): boolean {
  try {
    execFileSync(binary, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MS, env: probeEnv() });
    return true;
  } catch {
    return false;
  }
}

function authenticated(harness: Harness): boolean {
  const probe = harness.credential;
  if (probe.kind === 'file') return fileHolds(credentialFile(harness), probe.requires);
  if (probe.kind === 'command') return commandSucceeds(harness.binary, probe.args);
  return fileHolds(credentialFile(harness), probe.requires) || commandSucceeds(harness.binary, probe.args);
}

/** Every harness this machine has, with whether each is logged in, for synchronous diagnostic callers. */
export function detectHarnesses(only?: readonly string[]): DetectedHarness[] {
  const wanted = only === undefined || only.length === 0 ? null : new Set(only);
  const out: DetectedHarness[] = [];
  for (const harness of HARNESSES) {
    if (wanted !== null && !wanted.has(harness.id)) continue;
    const installed = locate(harness.binary) !== null;
    out.push({ id: harness.id, installed, authenticated: installed && authenticated(harness) });
  }
  return out;
}

/** A bounded local probe; output is read only for binary lookup and is never logged. */
function probeCommand(binary: string, args: readonly string[], signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted === true) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(binary, [...args], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: probeEnv(), signal }, (error, stdout) => {
      resolve(error === null ? stdout : null);
    });
  });
}

async function fileHoldsAsync(at: string | null, requires: readonly string[]): Promise<boolean> {
  if (at === null) return false;
  try { return holdsCredentials(await readFile(at, 'utf8'), requires); } catch { return false; }
}

/** Worker detection leaves the event loop free for leases, requests and shutdown. */
export async function detectHarnessesAsync(only?: readonly string[], signal?: AbortSignal): Promise<DetectedHarness[]> {
  const wanted = only === undefined || only.length === 0 ? null : new Set(only);
  return Promise.all(HARNESSES.filter((harness) => wanted === null || wanted.has(harness.id)).map(async (harness) => {
    const found = await probeCommand(process.platform === 'win32' ? 'where' : 'which', [harness.binary], signal);
    const installed = (found?.split('\n')[0]?.trim() ?? '').length > 0;
    if (!installed) return { id: harness.id, installed, authenticated: false };
    const probe = harness.credential;
    const fileAuthenticated = probe.kind !== 'command' && await fileHoldsAsync(credentialFile(harness), probe.requires);
    const authenticated = fileAuthenticated || (probe.kind !== 'file' && await probeCommand(harness.binary, probe.args, signal) !== null);
    return { id: harness.id, installed, authenticated };
  }));
}

/** One worker's coalesced detection snapshot; invalidation also refuses results from an older in-flight probe. */
export function harnessDetection(options: { detect: () => Promise<DetectedHarness[]>; clock: () => number }): {
  read: () => Promise<DetectedHarness[]>;
  invalidate: () => void;
} {
  let generation = 0;
  let snapshot: { at: number; detected: DetectedHarness[] } | null = null;
  let pending: { generation: number; work: Promise<DetectedHarness[]> } | null = null;
  return {
    async read() {
      for (;;) {
        if (snapshot !== null && options.clock() - snapshot.at < HARNESS_DETECTION_TTL_MS) return snapshot.detected;
        if (pending === null) {
          const revision = generation;
          const work = options.detect().then((detected) => {
            if (revision === generation) snapshot = { at: options.clock(), detected };
            return detected;
          }).finally(() => { pending = null; });
          pending = { generation: revision, work };
        }
        const held = pending;
        const detected = await held.work;
        if (held.generation === generation) return detected;
      }
    },
    invalidate() { generation += 1; snapshot = null; },
  };
}

/**
 * What a worker offers of what it detected: each logged-in harness a run can be
 * held on, and the rest named with why they are not offered, for the operator.
 */
export function offerOf(detected: readonly DetectedHarness[]): { offered: OfferedHarness[]; withheld: string[] } {
  const holdable = (found: DetectedHarness): boolean => {
    const harness = harnessById(found.id);
    return harness !== null && offerable(harness);
  };
  return {
    offered: detected.flatMap((found) => {
      const harness = harnessById(found.id);
      return harness !== null && offerable(harness) ? [{ ...found, profile: harness.profile }] : [];
    }),
    withheld: detected.filter((found) => found.authenticated && !holdable(found)).map((found) => found.id),
  };
}

/** Why a logged-in harness is not offered, in the operator's words. */
export const WITHHELD_REASON = 'its own configuration would approve a run\'s calls unasked, and a run cannot be given one of its own';
