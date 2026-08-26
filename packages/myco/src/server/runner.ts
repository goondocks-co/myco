/**
 * The seam every Deployment operation runs its commands through.
 *
 * Compose is driven by a subprocess, and a subprocess in a test is either a
 * real container or a mock. Real containers make the suite depend on a Docker
 * daemon and a registry; mocking `child_process` globally leaks across files.
 * A named port keeps the orchestration under test and the container out of it,
 * and it is the same shape the harness ports already use.
 *
 * The real implementation is the only place in the Deployment path that spawns
 * anything, so `tests/server/deployment-*.test.ts` can assert the exact argv a
 * command produces rather than its effect on a machine.
 */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<CommandResult>;
}

/** Spawns for real. */
export function systemRunner(): CommandRunner {
  return {
    async run(command, args, options) {
      const { spawn } = await import('node:child_process');
      return new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(command, [...args], {
          cwd: options?.cwd,
          env: options?.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });
    },
  };
}

/** Raised with the command's own stderr, which is what an operator needs to see. */
export class CommandFailed extends Error {
  constructor(readonly command: string, readonly args: readonly string[], readonly result: CommandResult) {
    super(`${command} ${args.join(' ')} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = 'CommandFailed';
  }
}

export async function runOrThrow(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  const result = await runner.run(command, args, options);
  if (result.code !== 0) throw new CommandFailed(command, args, result);
  return result;
}
