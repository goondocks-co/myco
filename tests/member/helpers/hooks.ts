/**
 * Drive a hook's `main()` in-process: stdin injected through the hook's own
 * reader, `--symbiont` on argv, the credential source and `fetch` passed the
 * way the CLI dispatcher passes them, stdout/stderr captured.
 */
import { setBufferedStdin } from '@myco/hooks/read-stdin.js';
import { HOOK_DISPATCH, type HookName } from '@myco/hooks/entry.js';
import { _resetManifestCache } from '@myco/hooks/normalize.js';
import type { HookMainOptions } from '@myco/member/capture.js';
import type { CredentialSource } from '@myco/member/credential.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { writeRegistryEntry, REGISTRY_VERSION, type RegistryEntry } from '@myco/member/registry.js';
import type { FetchLike } from '@myco/member/transport.js';
import type { DetachedSpawn } from '@myco/runtime/spawn-detached.js';
import { runHelperVerb } from '@myco/cli/member-helper.js';
import { TEST_MACHINE_ID } from './server.js';

export type { HookName } from '@myco/hooks/entry.js';

/** The one dispatch table the CLI and the compiled binary run hooks through. */
const HOOKS = HOOK_DISPATCH;

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
  /** How a repository's join is started; a test that meets an unconnected repository records it instead of starting it. */
  spawn?: HookMainOptions['spawn'];
  /**
   * How the hook's kick starts the member helper. By default the helper runs in this process with the hook's own
   * fetch, and the run ends once every helper it started has: a hook's capture is delivered when `runHook` returns.
   */
  helperSpawn?: DetachedSpawn;
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
  const helpers: Array<Promise<unknown>> = [];
  const helperSpawn: DetachedSpawn = opts.helperSpawn ?? ((_command, args) => {
    const verb = args.slice(args.indexOf('helper') + 1);
    helpers.push(runHelperVerb(verb, { fetch: opts.fetch, now: opts.now, lingerMs: 0, keepStderr: true, spawn: helperSpawn }).catch((err: unknown) => err));
    return { started: true, pid: process.pid };
  });
  try {
    const mod = await HOOKS[name]();
    await mod.main({
      credential: opts.credential === undefined ? 'registry' : opts.credential, fetch: opts.fetch, now: opts.now, argv: process.argv, startedAt: Date.now(),
      ...(opts.spawn ? { spawn: opts.spawn } : {}), helperSpawn,
    });
    // Each batch is awaited whole, then any helper a batch started (a successor) is awaited in turn.
    for (let done = 0; done < helpers.length;) {
      const until = helpers.length;
      await Promise.all(helpers.slice(done, until));
      done = until;
    }
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
