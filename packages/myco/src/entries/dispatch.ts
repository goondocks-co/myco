/**
 * What a compiled binary runs first: hooks and the bounded member file reader go straight to their own chunks; every other
 * verb registers the embedded native artifacts and loads the CLI.
 *
 * Built with `--splitting`, each dynamic import below is a chunk the binary reads only when it is reached, so a hook
 * never parses the CLI, the daemon or the server code a hook does not run. The steps the CLI takes before it dispatches
 * a hook are taken here too: loopback dials stay off any proxy.
 */
import { PROMPT_FILE_READER_VERB } from '../member/prompt-file-policy.js';
import { keepLoopbackOffProxy } from '../cli/loopback-proxy.js';

/** Whether argv asks for help, which the CLI answers for every verb. */
const asksForHelp = (args: readonly string[]): boolean => args.includes('--help') || args.includes('-h');

/**
 * Runs the verb argv names. A failure is reported as the CLI reports one (`cli.ts`): `myco: <message>` on stderr and
 * exit 1, never a stack.
 */
export async function dispatch(registerNativeDeps: () => Promise<void>): Promise<void> {
  try {
    const [cmd, ...args] = process.argv.slice(2);
    if (cmd === 'member' && args[0] === PROMPT_FILE_READER_VERB && !asksForHelp(args)) {
      await (await import('../member/prompt-file-reader.js')).runPromptFileReader();
      return;
    }
    if (cmd === 'hook' && !asksForHelp(args)) {
      keepLoopbackOffProxy();
      await (await import('../hooks/entry.js')).runHook(args);
      return;
    }
    await registerNativeDeps();
    await import('../cli.js');
  } catch (err) {
    console.error(`myco: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
