/**
 * The `hook` verb: the one entry every harness's hook command reaches.
 *
 * A compiled binary sends `myco hook <name>` here before it loads the rest of the CLI (`entries/dispatch.ts`), so a hook
 * loads its own chunk and nothing else: the preamble, the hook's module and the member seam it runs on. Its import
 * closure is held light by `tests/meta/boundaries/hook-entry-closure.test.ts`.
 */
import { runLaunchPreamble } from '../cli/launch-preamble.js';
import { recordStartingJob } from '../runtime/spawn-detached.js';
import { parseCredentialFlag } from '../member/credential.js';
import { readSymbiontFlag } from './symbiont-flag.js';
import { recordRefusedHook } from '../member/refused-hooks.js';
import { resolveMycoHome } from '../paths/home.js';
import type { HookMainOptions } from '../member/capture.js';

type HookModule = { main: (opts: HookMainOptions) => Promise<void> };

/** Every hook a harness can run, by the name its hook command carries. `tests/meta/hook-dispatch-coverage.test.ts` holds it to every name a template or the hook config uses. */
export const HOOK_DISPATCH = {
  'session-start': () => import('./session-start.js'),
  'session-end': () => import('./session-end.js'),
  'stop': () => import('./stop.js'),
  'user-prompt-submit': () => import('./user-prompt-submit.js'),
  'pre-tool-use': () => import('./pre-tool-use.js'),
  'post-tool-use': () => import('./post-tool-use.js'),
  'prompt-recall': () => import('./prompt-recall.js'),
  'post-tool-use-failure': () => import('./post-tool-use-failure.js'),
  'subagent-start': () => import('./subagent-start.js'),
  'subagent-stop': () => import('./subagent-stop.js'),
  'stop-failure': () => import('./stop-failure.js'),
  'task-completed': () => import('./task-completed.js'),
  'pre-compact': () => import('./pre-compact.js'),
  'post-compact': () => import('./post-compact.js'),
  'error-occurred': () => import('./error-occurred.js'),
  'notification': () => import('./notification.js'),
} as const satisfies Readonly<Record<string, () => Promise<HookModule>>>;

export type HookName = keyof typeof HOOK_DISPATCH;

export const isHookName = (name: string): name is HookName => Object.hasOwn(HOOK_DISPATCH, name);

/**
 * Run `myco hook <name> [flags]`: anchor the process to the harness's project and honour its runtime pin, then run the
 * named hook with the credential source its command declares. Unhandled harness hooks are counted and ignored;
 * a bare unknown name exits 1 and names the hooks there are.
 */
export async function runHook(args: readonly string[], deps: { preamble?: typeof runLaunchPreamble } = {}): Promise<void> {
  const hookName = args[0] ?? '';
  // Before anything is spawned, the preamble's runtime-pin re-exec included: what a helper started from this hook can
  // outlive depends on the job it began in.
  recordStartingJob();
  (deps.preamble ?? runLaunchPreamble)('hook', [...args]);
  if (!isHookName(hookName)) {
    if (readSymbiontFlag(args) !== undefined) {
      recordRefusedHook('unknown-hook', { mycoHome: resolveMycoHome({ cwd: process.cwd() }), now: Date.now(), hook: hookName });
      return;
    }
    console.error(`Unknown hook: ${hookName}. Available: ${Object.keys(HOOK_DISPATCH).join(', ')}`);
    process.exit(1);
  }
  // The credential source is declared on the hook command (`--credential registry|env`) and handed down; a hook never infers it.
  return (await HOOK_DISPATCH[hookName]()).main({ credential: parseCredentialFlag(args) });
}
