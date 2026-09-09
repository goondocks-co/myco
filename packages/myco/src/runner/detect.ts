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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HARNESSES, type CredentialProbe, type Harness } from './harnesses.js';

export interface DetectedHarness {
  id: string;
  installed: boolean;
  authenticated: boolean;
}

const expand = (path: string): string => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

/** Where this harness's binary is, or null when the machine has none. */
export function locate(binary: string): string | null {
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [binary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = found.split('\n')[0]?.trim() ?? '';
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/** A file that exists and holds at least one of the keys a login writes. An empty file is a logged-out file. */
function fileHolds(path: string, requires: readonly string[]): boolean {
  const at = expand(path);
  if (!existsSync(at)) return false;
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
    execFileSync(binary, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function authenticated(harness: Harness, probe: CredentialProbe): boolean {
  if (probe.kind === 'file') return fileHolds(probe.path, probe.requires);
  if (probe.kind === 'command') return commandSucceeds(harness.binary, probe.args);
  return fileHolds(probe.path, probe.requires) || commandSucceeds(harness.binary, probe.args);
}

/** Every harness this machine has, with whether each is logged in. A worker offers this list on every claim. */
export function detectHarnesses(only?: readonly string[]): DetectedHarness[] {
  const wanted = only === undefined || only.length === 0 ? null : new Set(only);
  const out: DetectedHarness[] = [];
  for (const harness of HARNESSES) {
    if (wanted !== null && !wanted.has(harness.id)) continue;
    const installed = locate(harness.binary) !== null;
    out.push({ id: harness.id, installed, authenticated: installed && authenticated(harness, harness.credential) });
  }
  return out;
}
