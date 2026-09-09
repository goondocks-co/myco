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
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { credentialFile, HARNESSES, type Harness } from './harnesses.js';

export interface DetectedHarness {
  id: string;
  installed: boolean;
  authenticated: boolean;
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
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(at, 'utf8')); } catch { return false; }
  if (parsed === null || typeof parsed !== 'object') return false;
  const held = parsed as Record<string, unknown>;
  if (Object.keys(held).length === 0) return false;
  if (requires.length === 0) return true;
  return requires.some((key) => held[key] !== undefined && held[key] !== null && held[key] !== '');
}

function commandSucceeds(binary: string, args: readonly string[]): boolean {
  try {
    execFileSync(binary, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: probeEnv() });
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

/** Every harness this machine has, with whether each is logged in. A worker offers this list on every claim. */
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
