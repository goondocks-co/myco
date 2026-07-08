/**
 * The real {@link CommandRunner} for Team Host orchestration — a thin spawn
 * wrapper shared by binary provisioning, the system-service supervisor, and the
 * headscale/tailscale CLI seams. Mirrors `@myco/service/run-command`'s
 * combined-output decoding but adds optional stdin (`input`), which the headscale
 * preauth-key mint and secret-put style calls need.
 *
 * NEVER rejects on a non-zero exit — the exit code is returned so callers decide
 * what a failure means (an idempotent step tolerates "already exists"; a hard
 * step surfaces it). A spawn error (ENOENT) resolves as exit 127 so a missing
 * binary reads as a normal failure, not an unhandled rejection.
 */
import { spawn } from 'node:child_process';

import type { CommandRunner } from './binaries.js';

export const realRunner: CommandRunner = {
  run(command: string, args: string[], opts?: { input?: string }): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: [opts?.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on('data', (b: Buffer) => out.push(b));
      child.stderr?.on('data', (b: Buffer) => err.push(b));
      child.on('error', (e: Error) => resolve({ stdout: String(e.message), exitCode: 127 }));
      child.on('close', (code) => resolve({
        stdout: Buffer.concat(out).toString('utf8') + Buffer.concat(err).toString('utf8'),
        exitCode: code ?? 0,
      }));
      if (opts?.input !== undefined && child.stdin) {
        child.stdin.write(opts.input);
        child.stdin.end();
      }
    });
  },
};
