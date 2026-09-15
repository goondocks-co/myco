import { spawnSync } from 'node:child_process';

/** Signs locally built Darwin executables and refuses invalid output. */
export function signExecutable({ target, outfile, platform = process.platform, run = spawnSync }) {
  if (platform !== 'darwin' || !target.startsWith('darwin-')) return;
  for (const args of [
    ['--force', '--sign', '-', '--preserve-metadata=entitlements', outfile],
    ['--verify', outfile],
  ]) {
    const result = run('codesign', args, { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`Darwin executable signing failed: ${result.error?.message ?? result.signal ?? result.status}`);
  }
}
