import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Longest any one step may take; a program that hangs at exec fails the build rather than holding it. */
const STEP_TIMEOUT_MS = 60_000;

/**
 * Signs a Darwin executable built on Darwin ad hoc, keeping its entitlements and identifier,
 * then refuses it unless `codesign --verify --strict` passes and the kernel
 * runs it: a signature can verify and still be killed at exec.
 */
export function signExecutable({ target, outfile, platform = process.platform, run = spawnSync }) {
  if (platform !== 'darwin' || !target.startsWith('darwin-')) return;
  const probeDir = mkdtempSync(path.join(tmpdir(), 'myco-sign-verify-'));
  const executable = path.resolve(outfile);
  try {
    for (const [command, args] of [
      ['codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements,identifier', executable]],
      ['codesign', ['--verify', '--strict', executable]],
      [executable, ['--version']],
    ]) {
      const result = run(command, args, { cwd: probeDir, stdio: 'inherit', timeout: STEP_TIMEOUT_MS });
      if (result.error || result.status !== 0) {
        const step = command === executable ? `${outfile} --version` : `codesign ${args[0]}`;
        throw new Error(`Darwin executable signing failed at ${step}: ${result.error?.message ?? result.signal ?? result.status}`);
      }
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}
