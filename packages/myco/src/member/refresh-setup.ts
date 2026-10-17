/** Refresh member agent setup using the installed binary under a bounded subprocess budget. */
import { spawnSync } from 'node:child_process';

export const MEMBER_REFRESH_TIMEOUT_MS = 120_000;

export async function refreshMemberSetup(binary: string, home: string, timeoutMs = MEMBER_REFRESH_TIMEOUT_MS): Promise<void> {
  const ran = spawnSync(binary, ['member', 'provision', '--refresh'], {
    cwd: home, env: { ...process.env, MYCO_HOME: home }, encoding: 'utf8', timeout: Math.min(MEMBER_REFRESH_TIMEOUT_MS, timeoutMs),
  });
  for (const line of (ran.stdout ?? '').split('\n').filter(line => line.trim() !== '')) console.log(`  ${line}`);
  if (ran.error || ran.status !== 0) throw new Error(ran.error?.message ?? ran.stderr?.trim().split('\n')[0] ?? `refresh exited ${ran.status}`);
}
