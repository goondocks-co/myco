/*
 * Subprocess entry that runs one hook's `main()` exactly as a hook process would run it — stdin from the harness,
 * `--symbiont` and `--credential` on argv — with seams a test reads afterwards:
 * - `MYCO_TEST_HANG_FETCH=1`: a fetch that never answers and ignores abort; `MYCO_TEST_REFUSE_FETCH=1`: one that
 *   refuses the connection.
 * - `MYCO_TEST_FETCH_LOG=<file>`: every fetch the hook makes is appended to the file, one URL per line.
 * - `MYCO_TEST_KICK_LOG=<file>`: the member helper is not started; each start the hook's kick makes is appended to
 *   the file instead, its arguments as one JSON line.
 * The loader table is the one the CLI dispatches hooks through (`HOOK_DISPATCH`).
 */
import fs from 'node:fs';
import { HOOK_DISPATCH, isHookName } from '@myco/hooks/entry.js';
import type { FetchLike } from '@myco/member/transport.js';
import type { DetachedSpawn } from '@myco/runtime/spawn-detached.js';
import { parseCredentialFlag } from '@myco/member/credential.js';

const hookName = process.argv[2];
if (!isHookName(hookName)) process.exit(64);

const hanging: FetchLike = () => new Promise<Response>(() => { /* never answers, ignores abort: the hook hangs until the harness kills it */ });
const refusing: FetchLike = async () => { throw new Error('ECONNREFUSED'); };
const inner = process.env.MYCO_TEST_HANG_FETCH === '1' ? hanging : process.env.MYCO_TEST_REFUSE_FETCH === '1' ? refusing : globalThis.fetch;
const fetchLog = process.env.MYCO_TEST_FETCH_LOG;
const fetchImpl: FetchLike = fetchLog === undefined ? inner : (input, init) => {
  fs.appendFileSync(fetchLog, `${new Request(input, init).url}\n`);
  return inner(input, init);
};
const kickLog = process.env.MYCO_TEST_KICK_LOG;
const spawn: DetachedSpawn | undefined = kickLog === undefined ? undefined : (_command, args) => {
  fs.appendFileSync(kickLog, `${JSON.stringify(args)}\n`);
  return { started: true, pid: process.pid };
};
const mod = await HOOK_DISPATCH[hookName]();
await mod.main({ credential: parseCredentialFlag(process.argv), fetch: fetchImpl, helperSpawn: spawn });
