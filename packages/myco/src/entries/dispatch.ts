/**
 * What a compiled binary runs first: the `hook` verb goes straight to its own chunk (`hooks/entry.ts`), and every other
 * verb registers the embedded native artifacts and loads the CLI.
 *
 * Built with `--splitting`, each dynamic import below is a chunk the binary reads only when it is reached, so a hook
 * never parses the CLI, the daemon or the server code a hook does not run. The steps the CLI takes before it dispatches
 * a hook are taken here in the same order: loopback dials kept off any proxy, then the start directory's `.env`.
 */
import { loadEnv } from '../cli/env-file.js';
import { keepLoopbackOffProxy } from '../cli/loopback-proxy.js';

/** Whether argv asks for help, which the CLI answers for every verb. */
const asksForHelp = (args: readonly string[]): boolean => args.includes('--help') || args.includes('-h');

export async function dispatch(registerNativeDeps: () => Promise<void>): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'hook' && !asksForHelp(args)) {
    loadEnv();
    keepLoopbackOffProxy();
    await (await import('../hooks/entry.js')).runHook(args);
    return;
  }
  await registerNativeDeps();
  await import('../cli.js');
}
