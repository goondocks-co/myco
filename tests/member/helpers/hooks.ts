/**
 * Drive a hook's `main()` in-process: stdin injected through the hook's own
 * reader, `--symbiont` on argv, the credential source and `fetch` passed the
 * way the CLI dispatcher passes them, stdout/stderr captured.
 */
import { setBufferedStdin } from '@myco/hooks/read-stdin.js';
import { _resetManifestCache } from '@myco/hooks/normalize.js';
import type { HookMainOptions } from '@myco/member/capture.js';
import type { CredentialSource } from '@myco/member/credential.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { writeRegistryEntry, REGISTRY_VERSION, type RegistryEntry } from '@myco/member/registry.js';
import type { FetchLike } from '@myco/member/transport.js';
import { TEST_MACHINE_ID } from './server.js';

export type HookName =
  | 'session-start' | 'session-end' | 'stop' | 'user-prompt-submit' | 'pre-tool-use' | 'post-tool-use' | 'post-tool-use-failure'
  | 'subagent-start' | 'subagent-stop' | 'stop-failure' | 'task-completed' | 'pre-compact' | 'post-compact' | 'error-occurred' | 'notification';

const HOOKS: Record<HookName, () => Promise<{ main: (opts?: HookMainOptions) => Promise<void> }>> = {
  'session-start': () => import('@myco/hooks/session-start.js'),
  'session-end': () => import('@myco/hooks/session-end.js'),
  stop: () => import('@myco/hooks/stop.js'),
  'user-prompt-submit': () => import('@myco/hooks/user-prompt-submit.js'),
  'pre-tool-use': () => import('@myco/hooks/pre-tool-use.js'),
  'post-tool-use': () => import('@myco/hooks/post-tool-use.js'),
  'post-tool-use-failure': () => import('@myco/hooks/post-tool-use-failure.js'),
  'subagent-start': () => import('@myco/hooks/subagent-start.js'),
  'subagent-stop': () => import('@myco/hooks/subagent-stop.js'),
  'stop-failure': () => import('@myco/hooks/stop-failure.js'),
  'task-completed': () => import('@myco/hooks/task-completed.js'),
  'pre-compact': () => import('@myco/hooks/pre-compact.js'),
  'post-compact': () => import('@myco/hooks/post-compact.js'),
  'error-occurred': () => import('@myco/hooks/error-occurred.js'),
  notification: () => import('@myco/hooks/notification.js'),
};

export interface HookRunResult {
  stdout: string;
  stderr: string;
}

export interface RunHookOptions {
  fetch: FetchLike;
  credential?: CredentialSource | null;
  symbiont?: string;
  /** Extra argv after `--symbiont <name>` (e.g. `--phases response`). */
  argv?: string[];
  now?: () => number;
}

/** Run one hook in-process with `raw` as its stdin; argv is restored afterwards. */
export async function runHook(name: HookName, raw: Record<string, unknown>, opts: RunHookOptions): Promise<HookRunResult> {
  const originalArgv = process.argv;
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.argv = [originalArgv[0], 'myco', 'hook', name, '--symbiont', opts.symbiont ?? 'claude-code', ...(opts.argv ?? [])];
  _resetManifestCache();
  setBufferedStdin(Buffer.from(JSON.stringify(raw)));
  (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as never;
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = ((chunk: unknown) => { err.push(String(chunk)); return true; }) as never;
  try {
    const mod = await HOOKS[name]();
    await mod.main({ credential: opts.credential === undefined ? 'registry' : opts.credential, fetch: opts.fetch, now: opts.now, argv: process.argv, startedAt: Date.now() });
  } finally {
    (process.stdout as unknown as { write: unknown }).write = origOut;
    (process.stderr as unknown as { write: unknown }).write = origErr;
    process.argv = originalArgv;
    setBufferedStdin(null);
    _resetManifestCache();
  }
  return { stdout: out.join(''), stderr: err.join('') };
}

/** A registry entry for the hooks' own project root (the cwd's worktree-aware root) under the test MYCO_HOME. */
export function registerTestMember(opts: { mycoHome: string; token: string; tokenId?: string; projectId: string; serverUrl?: string; expiresAt?: number; root?: string }): RegistryEntry {
  const entry: RegistryEntry = {
    version: REGISTRY_VERSION,
    projectId: opts.projectId,
    serverUrl: opts.serverUrl ?? 'https://member-test.invalid',
    token: opts.token,
    tokenId: opts.tokenId,
    expiresAt: opts.expiresAt,
    root: opts.root ?? resolveMemberProjectRoot(process.cwd()),
    machineId: TEST_MACHINE_ID,
    joinedAt: Date.now(),
    updatedAt: Date.now(),
  };
  writeRegistryEntry(entry, { mycoHome: opts.mycoHome });
  return entry;
}

/** A fetch that records every request it sees before forwarding it. */
export function recordingFetch(inner: FetchLike): { fetch: FetchLike; requests: Array<{ method: string; path: string; body?: string; headers: Record<string, string> }> } {
  const requests: Array<{ method: string; path: string; body?: string; headers: Record<string, string> }> = [];
  const fetch: FetchLike = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const body = req.method === 'POST' ? await req.clone().text() : undefined;
    requests.push({ method: req.method, path: url.pathname, body, headers: Object.fromEntries(req.headers) });
    return inner(req);
  };
  return { fetch, requests };
}
