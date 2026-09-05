/**
 * The runtime entry as a process, on the port the platform probes.
 *
 * The hosted target holds a container awake by talking to `/probe` on its
 * container port, and releases it when a run ends; `/spawn` is what proves a
 * container can start a child at all. Both are served by this entry and by
 * nothing else, and a runtime that came up serving no listener would leave the
 * hold renewing against a socket that is not there.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_PROBE_PORT, runtimePortFrom } from '@myco/agent/runtime/runtime-port.js';
import { RUNTIME_EXIT, RUNTIME_OWN_ENDINGS } from '@myco/agent/runtime/process-signals.js';

const ENTRY = fileURLToPath(new URL('../../packages/myco/src/agent/runtime/server-entry.ts', import.meta.url));

const children: { kill(signal?: NodeJS.Signals): void }[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill('SIGKILL'); });

/** A port nothing holds: bound, read, and released before the entry claims it. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = Number(probe.port);
  probe.stop(true);
  return port;
}

/** Boot the entry with no dispatch: it claims nothing and serves its port. */
async function bootEntry(runtimePort: string): Promise<number> {
  const port = runtimePort === '' ? freePort() : Number(runtimePort);
  const env: Record<string, string | undefined> = { ...process.env, MYCO_RUNTIME_PORT: String(port) };
  for (const key of ['MYCO_SERVER_URL', 'MYCO_MEMBER_TOKEN', 'MYCO_PROJECT', 'MYCO_RUN_ID', 'MYCO_TASK']) delete env[key];
  const child = Bun.spawn({
    cmd: [process.execPath, ENTRY],
    cwd: join(fileURLToPath(new URL('../../', import.meta.url))),
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(child);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const answered = await fetch(`http://127.0.0.1:${port}/probe`);
      if (answered.ok) return port;
    } catch { /* not listening yet */ }
    await Bun.sleep(50);
  }
  throw new Error(`the runtime entry never served ${port}: ${await new Response(child.stderr as ReadableStream).text()}`);
}

describe('the runtime entry on its port', () => {
  it('serves the probe the platform holds a container by, and the spawn that proves it can start a child', async () => {
    const port = await bootEntry('');

    const probe = await (await fetch(`http://127.0.0.1:${port}/probe`)).json() as Record<string, unknown>;
    // A runtime handed no dispatch claims nothing and names no run.
    const { ok, running, draining, result, fatal, dispatched } = probe;
    expect({ ok, running, draining, result, fatal, dispatched })
      .toEqual({ ok: true, running: false, draining: false, result: null, fatal: null, dispatched: null });
    expect(typeof probe.pid).toBe('number');
    expect(typeof probe.startedAt).toBe('number');

    expect(await (await fetch(`http://127.0.0.1:${port}/spawn`)).json()).toEqual({ code: 0, out: 'child-ok' });

    expect((await fetch(`http://127.0.0.1:${port}/nothing`)).status).toBe(404);
  }, 30_000);

  it('names the container port as the one a launch that says nothing gets', () => {
    expect(runtimePortFrom(undefined)).toBe(RUNTIME_PROBE_PORT);
  });
});

describe('what this runtime tells its supervisor by leaving', () => {
  it('leaves with a code that says whether the run it held carries an ending', () => {
    // What the supervisor reads: an ending already written, a failure this
    // process could not post, and a run it never claimed at all.
    expect(RUNTIME_EXIT).toEqual({ ran: 0, named: 2, unposted: 3, unclaimed: 4 });
    expect([...RUNTIME_OWN_ENDINGS].sort()).toEqual([RUNTIME_EXIT.ran, RUNTIME_EXIT.named]);
    // `1` is a process that never got as far as holding a run, and `4` is one
    // that started and claimed nothing: both leave a run for the supervisor.
    expect(RUNTIME_OWN_ENDINGS.has(1)).toBe(false);
    expect(RUNTIME_OWN_ENDINGS.has(RUNTIME_EXIT.unclaimed)).toBe(false);
  });

  it('uses those codes where it names a run and where it cannot', () => {
    const source = readFileSync(ENTRY, 'utf8');
    // The one exit that reports what became of a named run.
    expect(source).toContain('process.exit(named ? RUNTIME_EXIT.named : RUNTIME_EXIT.unposted)');
    expect(source).not.toMatch(/process\.exit\(named \? 1 : 0\)/);
  });
});
