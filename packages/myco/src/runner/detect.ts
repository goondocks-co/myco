import { STORED_SIGN_IN_HINT, type RunnerCredentialChoice, type HarnessSignInFailure } from '@goondocks/myco-shared/runner-fleet';
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
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { credentialFile, harnessById, HARNESSES, offerable, type Harness } from './harnesses.js';
import { spawnOwnedGroup, type OwnedProcess } from './process-group.js';
import type { ProfileCapability } from '@goondocks/myco-shared/execution-profile';
import type { CodexInstallationContext, CodexInstallationVerdict } from '@myco/runner/drivers/codex.js';

export interface DetectedHarness {
  id: string;
  installed: boolean;
  authenticated: boolean;
  error?: string;
  unavailableReason?: 'login_missing';
  signInSource?: RunnerCredentialChoice;
  /** The agent's own version, as its CLI prints it; absent where it printed none this worker can read. */
  version?: string;
}

export interface OfferedHarness extends DetectedHarness {
  signInFailure?: HarnessSignInFailure;
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
export const HARNESS_LOGIN_RECHECK_MS = 5 * 60_000;

/** Where this harness's binary is, or null when the machine has none. */
export function locate(binary: string, env: NodeJS.ProcessEnv = probeEnv()): string | null {
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [binary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env });
    const first = found.split('\n')[0]?.trim() ?? '';
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/** A file that exists and holds at least one of the keys a login writes. An empty file is a logged-out file. */
function fileHolds(at: string | null, requires: readonly string[]): boolean {
  if (at === null) return false;
  try { return holdsCredentials(readFileSync(at, 'utf8'), requires); } catch (error) {
    if (ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
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

function commandSucceeds(binary: string, args: readonly string[], env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync(binary, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MS, env });
    return true;
  } catch {
    return false;
  }
}

function credentialProbeEnvironment(harness: Harness, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of harness.omitInherited ?? []) delete env[key];
  return env;
}

function authenticated(harness: Harness, env: NodeJS.ProcessEnv): boolean {
  const probe = harness.credential;
  if (probe.kind === 'command') return commandSucceeds(harness.binary, probe.args, credentialProbeEnvironment(harness, env));
  const file = credentialFile(harness, env);
  return fileHolds(file, probe.requires);
}

/** Every harness this machine has, with whether each is logged in, for synchronous diagnostic callers. */
export function detectHarnesses(only?: readonly string[], env: NodeJS.ProcessEnv = probeEnv()): DetectedHarness[] {
  const wanted = only === undefined || only.length === 0 ? null : new Set(only);
  const out: DetectedHarness[] = [];
  for (const harness of HARNESSES) {
    if (wanted !== null && !wanted.has(harness.id)) continue;
    const installed = locate(harness.binary, env) !== null;
    try { out.push({ id: harness.id, installed, authenticated: installed && authenticated(harness, env) }); }
    catch (error) { out.push({ id: harness.id, installed, authenticated: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return out;
}

export interface RunnerHarnessPreflight {
  harnesses: readonly DetectedHarness[];
  codex: CodexInstallationVerdict;
}

/** Advisory detection under the service's PATH and the same containment predicate as a run. */
export async function runnerHarnessPreflight(env: NodeJS.ProcessEnv, ctx: CodexInstallationContext, deps: {
  detect?: (env: NodeJS.ProcessEnv) => readonly DetectedHarness[];
  locate?: typeof locate;
} = {}): Promise<RunnerHarnessPreflight> {
  const { codexDriver, codexInstallationVerdict } = await import('@myco/runner/drivers/codex.js');
  const codex = harnessById(codexDriver.id)!;
  const harnesses = deps.detect === undefined ? detectHarnesses(undefined, env) : deps.detect(env);
  const installed = harnesses.some((harness) => harness.id === codex.id && harness.installed)
    ? (deps.locate ?? locate)(codex.binary, env) : null;
  return { harnesses, codex: codexInstallationVerdict(installed, ctx) };
}

/** A bounded local probe; output is read only for binary lookup and is never logged. */
function probeCommand(binary: string, args: readonly string[], signal?: AbortSignal, env = probeEnv()): Promise<string | null> {
  if (signal?.aborted === true) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(binary, [...args], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env, signal }, (error, stdout) => {
      resolve(error === null ? stdout : null);
    });
  });
}

async function fileHoldsAsync(at: string | null, requires: readonly string[]): Promise<boolean> {
  if (at === null) return false;
  try { return holdsCredentials(await readFile(at, 'utf8'), requires); } catch (error) {
    if (ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

/** What a file probe reads of a credential file. */
export interface DetectionMode {
  /** False limits a file probe to whether the file exists and is non-empty; its bytes are never read. */
  credentialBytes: boolean;
  /** True asks each installed agent its version in the background, for a worker that stops its probes as it ends. */
  versions?: boolean;
}

const READ_CREDENTIAL_BYTES: DetectionMode = { credentialBytes: true };
const ABSENT_PATH_CODES: readonly string[] = ['ENOENT', 'ENOTDIR'];

/** A credential file that exists as a regular file with content, decided from its metadata alone. */
async function fileNonEmpty(at: string | null): Promise<boolean> {
  if (at === null) return false;
  try {
    const found = await stat(at);
    return found.isFile() && found.size > 0;
  } catch (error) {
    if (ABSENT_PATH_CODES.includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

/** The first version token an agent CLI prints for `--version`: `2.1.3 (Claude Code)` is 2.1.3, `codex-cli 0.50.0` is 0.50.0. */
const VERSION_TOKEN = /\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.]+)?/;
const MAX_VERSION_CHARS = 64;

/** The version an agent CLI printed, or undefined where it printed nothing that reads as one. */
function agentVersionOf(printed: string | null): string | undefined {
  const token = printed === null ? undefined : VERSION_TOKEN.exec(printed)?.[0];
  return token === undefined || token.length > MAX_VERSION_CHARS ? undefined : token;
}

/**
 * Each installed binary's version, asked once per file as it stands on disk: an upgrade replaces the file and is asked
 * again. A probe runs in the background as a process group of its own, stopped with its helpers when the probe timeout
 * passes or the worker stops it; until it answers, the binary has no version.
 */
const versions = new Map<string, { version: string | undefined } | 'asking'>();
const probes = new Set<OwnedProcess>();
let probesStopping = new AbortController();
const MAX_VERSION_OUTPUT_CHARS = 4096;

function askVersion(at: string, key: string): void {
  versions.set(key, 'asking');
  let owned: OwnedProcess;
  // Its input is closed: an agent that reads its input for a session reads none and ends, rather than waiting out the probe.
  try { owned = spawnOwnedGroup(at, ['--version'], { env: probeEnv(), stdio: ['ignore', 'pipe', 'ignore'] }, AbortSignal.any([probesStopping.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])); }
  catch { versions.set(key, { version: undefined }); return; }
  probes.add(owned);
  let printed = '';
  owned.child.stdout?.setEncoding('utf8');
  owned.child.stdout?.on('data', (chunk: string) => { if (printed.length < MAX_VERSION_OUTPUT_CHARS) printed += chunk; });
  void owned.exit.then((code) => code, () => -1).then((code) => {
    probes.delete(owned);
    versions.set(key, { version: code === 0 ? agentVersionOf(printed) : undefined });
  });
}

/** Stop every version probe still running, its helpers included, and wait until they are gone. */
export async function stopVersionProbes(): Promise<void> {
  probesStopping.abort();
  probesStopping = new AbortController();
  await Promise.all([...probes].map((owned) => owned.dispose().catch(() => undefined)));
}

/** The binary's version where its probe has answered; otherwise undefined, with a probe started if none is asking. */
async function knownVersion(at: string, ask: boolean): Promise<string | undefined> {
  let key: string;
  try {
    const found = await stat(at);
    key = `${at}\u0000${found.mtimeMs}\u0000${found.size}`;
  } catch { return undefined; }
  const held = versions.get(key);
  if (held === undefined && ask) askVersion(at, key);
  return typeof held === 'object' ? held.version : undefined;
}

/**
 * Worker detection leaves the event loop free for leases, requests and shutdown. An agent's version is offered once a
 * background probe has read it: detection never waits on it.
 */
export async function detectHarnessesAsync(only?: readonly string[], signal?: AbortSignal, mode: DetectionMode = READ_CREDENTIAL_BYTES): Promise<DetectedHarness[]> {
  const wanted = only === undefined || only.length === 0 ? null : new Set(only);
  return Promise.all(HARNESSES.filter((harness) => wanted === null || wanted.has(harness.id)).map(async (harness) => {
    const found = await probeCommand(process.platform === 'win32' ? 'where' : 'which', [harness.binary], signal);
    const at = found?.split('\n')[0]?.trim() ?? '';
    const installed = at.length > 0;
    if (!installed) return { id: harness.id, installed, authenticated: false };
    const version = knownVersion(at, mode.versions === true);
    const withVersion = async (detected: DetectedHarness): Promise<DetectedHarness> => {
      const known = await version;
      return known === undefined ? detected : { ...detected, version: known };
    };
    try {
      const probe = harness.credential;
      const authenticated = probe.kind === 'command'
        ? await probeCommand(harness.binary, probe.args, signal, credentialProbeEnvironment(harness, probeEnv())) !== null
        : mode.credentialBytes ? await fileHoldsAsync(credentialFile(harness), probe.requires) : await fileNonEmpty(credentialFile(harness));
      return withVersion({ id: harness.id, installed, authenticated });
    } catch (error) { return withVersion({ id: harness.id, installed, authenticated: false, error: error instanceof Error ? error.message : String(error) }); }
  }));
}

/** One worker's coalesced detection snapshot; invalidation also refuses results from an older in-flight probe. */
export function harnessDetection(options: { detect: (excluded: readonly string[]) => Promise<DetectedHarness[]>; clock: () => number }): {
  read: () => Promise<DetectedHarness[]>;
  invalidate: () => void;
  loginMissing: (id: string, source?: RunnerCredentialChoice) => void;
} {
  const signedOut = new Map<string, { until: number; source: RunnerCredentialChoice; detected: DetectedHarness }>();
  let generation = 0;
  let snapshot: { at: number; detected: DetectedHarness[] } | null = null;
  let pending: { generation: number; work: Promise<DetectedHarness[]> } | null = null;
  return {
    async read() {
      for (;;) {
        if (snapshot !== null && options.clock() - snapshot.at < HARNESS_DETECTION_TTL_MS) return snapshot.detected;
        if (pending === null) {
          const revision = generation;
          const excluded = [...signedOut].filter(([, held]) => options.clock() < held.until).map(([id]) => id);
          const work = options.detect(excluded).then((fresh) => {
            const detected = [...fresh, ...excluded.map(id => signedOut.get(id)!.detected)];
            if (revision === generation) {
              for (const harness of fresh) {
                const held = signedOut.get(harness.id);
                if (held === undefined) continue;
                if (held.source === 'stored' || harness.authenticated) signedOut.delete(harness.id);
                else {
                  harness.unavailableReason = 'login_missing';
                  signedOut.set(harness.id, { until: options.clock() + HARNESS_LOGIN_RECHECK_MS, source: held.source, detected: harness });
                }
              }
              snapshot = { at: options.clock(), detected };
            }
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
    loginMissing(id, source = 'own') {
      const known = snapshot?.detected.find(harness => harness.id === id);
      signedOut.set(id, { until: options.clock() + HARNESS_LOGIN_RECHECK_MS, source,
        detected: { ...known, id, installed: known?.installed ?? true, authenticated: false, unavailableReason: 'login_missing', ...(source === 'stored' ? { signInSource: source } : {}) } });
      generation += 1; snapshot = null;
    },
  };
}

/**
 * Report installation and sign-in for agents that can be held to a run.
 */
export function offerOf(detected: readonly DetectedHarness[]): { offered: OfferedHarness[]; withheld: string[] } {
  const holdable = (found: DetectedHarness): boolean => {
    const harness = harnessById(found.id);
    return harness !== null && offerable(harness);
  };
  return {
    offered: detected.flatMap((found) => {
      const harness = harnessById(found.id);
      return harness !== null && offerable(harness) ? [{ id: found.id, installed: found.installed, authenticated: found.authenticated, ...(found.version === undefined ? {} : { version: found.version }), ...(found.unavailableReason === undefined ? {} : { unavailableReason: found.unavailableReason, signInFailure: {
        name: harness.name, source: found.signInSource ?? 'own', hint: found.signInSource === 'stored'
          ? STORED_SIGN_IN_HINT : (process.platform === 'darwin' ? harness.signInHint.darwin : undefined) ?? harness.signInHint.default,
      } }), profile: harness.profile }] : [];
    }),
    withheld: detected.filter((found) => found.authenticated && !holdable(found)).map((found) => found.id),
  };
}

/** Why a logged-in harness is not offered, in the operator's words. */
export const WITHHELD_REASON = 'its own configuration would approve a run\'s calls unasked, and a run cannot be given one of its own';
