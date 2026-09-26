import { spawnSync } from 'node:child_process';

/**
 * Signs a Darwin executable built on Darwin ad hoc, keeping its entitlements and identifier,
 * then refuses it unless `codesign --verify --strict` passes and the kernel
 * runs it: a signature can verify and still be killed at exec.
 */
export function signExecutable({ target, outfile, platform = process.platform, run = spawnSync }) {
  if (platform !== 'darwin' || !target.startsWith('darwin-')) return;
  for (const [command, args] of [
    ['codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements,identifier', outfile]],
    ['codesign', ['--verify', '--strict', outfile]],
    [outfile, ['--version']],
  ]) {
    const result = run(command, args, { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      const step = command === outfile ? `${outfile} --version` : `codesign ${args[0]}`;
      throw new Error(`Darwin executable signing failed at ${step}: ${result.error?.message ?? result.signal ?? result.status}`);
    }
  }
}
