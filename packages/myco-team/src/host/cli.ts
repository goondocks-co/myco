/**
 * `myco-team host ...` — retired (decision-48174c9f, 2026-07-13). Host
 * operator orchestration (enable/disable/status/rotate-key) now lives in the
 * main `myco` binary: `myco host <command>`. This surface exists only to
 * point operators at the new command; it has no orchestration of its own and
 * no side effects.
 */
export async function runHostCommand(_args: string[]): Promise<void> {
  console.error('`myco-team host` commands have moved to `myco host <command>`. Run `myco host --help` for usage.');
  process.exit(1);
}
