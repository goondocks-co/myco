/**
 * The Compose target is retired. A verb that names it, or that would have acted on a Compose bundle this machine
 * still holds, refuses in one line naming what to do instead; with nothing held, a verb acts on this machine's own
 * Deployment. `rotate` and `adopt`, which only a Compose bundle answered, are verbs no longer.
 */
import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));

async function invoke(home: string, args: string[]): Promise<{ code: number; text: string }> {
  const child = Bun.spawn([process.execPath, '--no-env-file', '--tsconfig-override', path.join(repo, 'tsconfig.json'), '-e',
    `import {run} from ${JSON.stringify(path.join(repo, 'packages/myco/src/cli/server.ts'))}; await run(${JSON.stringify(args)});`], {
    cwd: home, env: { ...process.env, MYCO_HOME: home, MYCO_TRAMPOLINED: '1', PATH: home },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timeout = setTimeout(() => { child.kill(); }, 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, text: stdout + stderr };
  } finally { clearTimeout(timeout); child.kill(); }
}

const freshHome = (): string => removeWhenTestsEnd(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-compose-retired-'))));

it('refuses a verb aimed at a held Compose bundle, naming the bundle and what to do instead', async () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, 'server', 'compose'), { recursive: true });
  fs.writeFileSync(path.join(home, 'server', 'compose', 'compose.yaml'), 'services: {}\n');
  for (const verb of [['status'], ['update'], ['destroy'], ['backup', '--to', path.join(home, 'out')]]) {
    const answered = await invoke(home, verb);
    expect({ verb: verb[0], code: answered.code }).toEqual({ verb: verb[0], code: 1 });
    expect(answered.text).toContain(`The Compose target is retired. This machine holds one in ${path.join(home, 'server', 'compose')}`);
    expect(answered.text).toContain('myco server create --target local');
  }
});

it('refuses --target compose by name, and acts on this machine\'s own Deployment when nothing is held', async () => {
  const home = freshHome();
  const named = await invoke(home, ['status', '--target', 'compose']);
  expect(named.code).toBe(1);
  expect(named.text).toContain('The Compose target is retired.');
  expect(named.text).not.toContain('This machine holds one');
  const unheld = await invoke(home, ['status']);
  expect(unheld.code).toBe(0);
  expect(unheld.text).toContain('No Deployment on this machine. `myco server create --target local` provisions one.');
});

it('answers rotate and adopt as verbs it does not know', async () => {
  const home = freshHome();
  for (const verb of ['rotate', 'adopt']) {
    const answered = await invoke(home, [verb, '--yes']);
    expect({ verb, code: answered.code, unknown: answered.text.includes(`Unknown command: ${verb}`) }).toEqual({ verb, code: 2, unknown: true });
  }
});
