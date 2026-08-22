/*
 * Subprocess entry for the harness-kill test: runs one hook's `main()` with a
 * `fetch` that never answers (MYCO_TEST_HANG_FETCH=1) or with a fetch that
 * records and refuses (MYCO_TEST_REFUSE_FETCH=1), exactly as a hook process
 * would run it — stdin from the harness, `--symbiont` and `--credential` on
 * argv. The parent kills it at the declared timeout.
 */
import type { HookMainOptions } from '@myco/member/capture.js';
import { parseCredentialFlag } from '@myco/member/credential.js';

const hookName = process.argv[2];
const loaders: Record<string, () => Promise<{ main: (opts?: HookMainOptions) => Promise<void> }>> = {
  'post-tool-use': () => import('@myco/hooks/post-tool-use.js'),
  'user-prompt-submit': () => import('@myco/hooks/user-prompt-submit.js'),
  stop: () => import('@myco/hooks/stop.js'),
};
const loader = loaders[hookName];
if (!loader) process.exit(64);

const hanging: typeof fetch = (() => new Promise<Response>(() => { /* never answers, ignores abort: the hook hangs until the harness kills it */ })) as typeof fetch;
const refusing: typeof fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;

const fetchImpl = process.env.MYCO_TEST_HANG_FETCH === '1' ? hanging : process.env.MYCO_TEST_REFUSE_FETCH === '1' ? refusing : globalThis.fetch;
const mod = await loader();
await mod.main({ credential: parseCredentialFlag(process.argv), fetch: fetchImpl });
