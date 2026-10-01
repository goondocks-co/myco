/**
 * The `hook` verb: the one entry every harness's hook command reaches.
 *
 * A compiled binary sends `myco hook <name>` here before it loads the rest of the CLI (`entries/dispatch.ts`), so a hook
 * loads its own chunk and nothing else: the preamble, the hook's module and the member seam it runs on. Its import
 * closure is held light by `tests/meta/hook-entry-closure.test.ts`.
 */
import { runLaunchPreamble } from '../cli/launch-preamble.js';
import { parseCredentialFlag } from '../member/credential.js';
import type { HookMainOptions } from '../member/capture.js';

type HookModule = { main: (opts: HookMainOptions) => Promise<void> };

/** Every hook a harness can run, by the name its hook command carries. */
export const HOOK_DISPATCH: Readonly<Record<string, () => Promise<HookModule>>> = {
  'session-start': () => import('./session-start.js'),
  'session-end': () => import('./session-end.js'),
  'stop': () => import('./stop.js'),
  'user-prompt-submit': () => import('./user-prompt-submit.js'),
  'pre-tool-use': () => import('./pre-tool-use.js'),
  'post-tool-use': () => import('./post-tool-use.js'),
  'post-tool-use-failure': () => import('./post-tool-use-failure.js'),
  'subagent-start': () => import('./subagent-start.js'),
  'subagent-stop': () => import('./subagent-stop.js'),
  'stop-failure': () => import('./stop-failure.js'),
  'task-completed': () => import('./task-completed.js'),
  'pre-compact': () => import('./pre-compact.js'),
  'post-compact': () => import('./post-compact.js'),
  'error-occurred': () => import('./error-occurred.js'),
  'notification': () => import('./notification.js'),
};

/**
 * Run `myco hook <name> [flags]`: anchor the process to the harness's project and honour its runtime pin, then run the
 * named hook with the credential source its command declares. An unknown name exits 1 and names the hooks there are.
 */
export async function runHook(args: readonly string[]): Promise<void> {
  runLaunchPreamble('hook', [...args]);
  const hookName = args[0] ?? '';
  const loader = HOOK_DISPATCH[hookName];
  if (!loader) {
    console.error(`Unknown hook: ${hookName}. Available: ${Object.keys(HOOK_DISPATCH).join(', ')}`);
    process.exit(1);
  }
  // The credential source is declared on the hook command (`--credential registry|env`) and handed down; a hook never infers it.
  return (await loader()).main({ credential: parseCredentialFlag(args) });
}
