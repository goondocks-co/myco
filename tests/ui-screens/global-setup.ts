/**
 * Boots the screens launcher and hands its URL and cookies to every worker
 * through the environment.
 *
 * With `MYCO_SHOTS_URL` set, nothing is launched: the checks run against that
 * deployment, signed in with `MYCO_SHOTS_COOKIE` (a complete `name=value`
 * session cookie), which serves as both the owner and the member cookie.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCREENS_ENV, type LaunchInfo } from './env.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAUNCH_TIMEOUT_MS = 120_000;

export default async function globalSetup(): Promise<void> {
  const shotsUrl = process.env.MYCO_SHOTS_URL;
  if (shotsUrl) {
    const cookie = process.env.MYCO_SHOTS_COOKIE;
    if (!cookie) throw new Error('MYCO_SHOTS_URL is set without MYCO_SHOTS_COOKIE');
    process.env[SCREENS_ENV.url] = shotsUrl.replace(/\/$/, '');
    process.env[SCREENS_ENV.ownerCookie] = cookie;
    process.env[SCREENS_ENV.memberCookie] = cookie;
    process.env[SCREENS_ENV.fixture] = '0';
    return;
  }

  const child = spawn('bun', ['tests/ui-screens/serve.ts'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  process.env[SCREENS_ENV.pid] = String(child.pid);

  const info = await new Promise<LaunchInfo>((resolve, reject) => {
    let buffered = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`the screens launcher printed nothing in ${LAUNCH_TIMEOUT_MS} ms\n${stderr}`)), LAUNCH_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        // The server's own telemetry is also JSON lines; the launch line is the one carrying the cookies.
        if (!line.includes('"ownerCookie"')) continue;
        clearTimeout(timer);
        resolve(JSON.parse(line) as LaunchInfo);
        return;
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the screens launcher exited with ${code} before it was ready\n${stderr}`));
    });
  });

  process.env[SCREENS_ENV.url] = info.url;
  process.env[SCREENS_ENV.ownerCookie] = info.ownerCookie;
  process.env[SCREENS_ENV.memberCookie] = info.memberCookie;
  process.env[SCREENS_ENV.strangerCookie] = info.strangerCookie;
  process.env[SCREENS_ENV.fixture] = '1';
  process.env[SCREENS_ENV.specimen] = info.specimen ? '1' : '0';
  process.env[SCREENS_ENV.projectNames] = JSON.stringify(info.projects.map((project) => project.name));
  process.env[SCREENS_ENV.projects] = JSON.stringify(info.projects.map(({ projectId, name }) => ({ projectId, name })));
  process.env[SCREENS_ENV.now] = String(info.now);
}
