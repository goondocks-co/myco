/**
 * Interactive confirmation gate for destructive CLI operations.
 *
 * Callers that accept `--yes` skip this entirely; everyone else routes
 * destructive work through `confirmDestructive` so a bare invocation can
 * never tear state down without an explicit human "y".
 */

/**
 * Print `summary` and ask for y/N confirmation on the controlling TTY.
 *
 * Returns true only on an explicit yes. When stdin is not a TTY the
 * question cannot be asked, so the summary is printed with a
 * "re-run with --yes" hint and the result is false — the caller is
 * expected to abort with a non-zero exit code.
 */
export async function confirmDestructive(summary: string): Promise<boolean> {
  process.stderr.write(`${summary}\n`);

  if (!process.stdin.isTTY) {
    process.stderr.write(
      'Confirmation required but stdin is not a TTY. Re-run with --yes to proceed.\n',
    );
    return false;
  }

  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question('Proceed? [y/N] ', (reply) => resolve(reply));
  });
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
