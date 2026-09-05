/**
 * The self-hosted launch adapter.
 *
 * Two things are held here. The callback address is the adapter's, not the
 * dispatch's: the runtime posts its claim, status and reports to the origin
 * this process is reachable at, and a request's own origin never decides it.
 * And a refusal is thrown carrying the supervisor's word: the dispatcher writes
 * that word onto the run row, where an operator reads it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { httpHarnessLaunch, LAUNCH_TIMEOUT_MS } from '@myco-server-worker/platform/bun/harness-runner.js';
import { RuntimeDraining } from '@myco-server-worker/core/harness.js';

const TOKEN = 'supervisor-token';
const CALLBACK = 'http://127.0.0.1:8787';
const origin = () => CALLBACK;

interface Seen {
  authorization: string | null;
  body: { runId?: string; timeoutSeconds?: number; envVars?: Record<string, string> };
  path: string;
}

const servers: { stop(closeActiveConnections?: boolean): unknown }[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

/** A stand-in supervisor answering every launch the same way. */
function supervisor(answer: (seen: Seen) => Response): { url: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    development: false,
    fetch: async (request) => {
      const record: Seen = {
        authorization: request.headers.get('authorization'),
        body: await request.json() as Seen['body'],
        path: new URL(request.url).pathname,
      };
      seen.push(record);
      return answer(record);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

const dispatch = {
  runId: 'run_1',
  timeoutSeconds: 300,
  envVars: { MYCO_SERVER_URL: 'https://someone-elses-origin.example', MYCO_TASK: 'container-smoke', MYCO_MEMBER_TOKEN: 'tok' },
};

describe('launching over HTTP', () => {
  it('posts the dispatch to the supervisor under the bearer token it was given', async () => {
    const stand = supervisor(() => Response.json({ runId: 'run_1', pid: 42 }, { status: 202 }));
    await httpHarnessLaunch({ url: stand.url, token: TOKEN, callbackOrigin: origin })(dispatch);

    expect(stand.seen).toHaveLength(1);
    expect(stand.seen[0]!.path).toBe('/launch');
    expect(stand.seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(stand.seen[0]!.body.runId).toBe('run_1');
    expect(stand.seen[0]!.body.timeoutSeconds).toBe(300);
  });

  it('rewrites the callback origin, leaving the rest of the dispatch as it was handed', async () => {
    const stand = supervisor(() => Response.json({}, { status: 202 }));
    await httpHarnessLaunch({ url: stand.url, token: TOKEN, callbackOrigin: origin })(dispatch);

    expect(stand.seen[0]!.body.envVars).toEqual({
      MYCO_SERVER_URL: CALLBACK,
      MYCO_TASK: 'container-smoke',
      MYCO_MEMBER_TOKEN: 'tok',
    });
  });

  it('reaches the supervisor whose address carries a trailing slash', async () => {
    const stand = supervisor(() => Response.json({}, { status: 202 }));
    await httpHarnessLaunch({ url: `${stand.url}/`, token: TOKEN, callbackOrigin: origin })(dispatch);
    expect(stand.seen[0]!.path).toBe('/launch');
  });
});

describe("a refusal reaches the dispatcher in the supervisor's own words", () => {
  const refusing = (status: number, body: Record<string, unknown>) =>
    httpHarnessLaunch({ url: supervisor(() => Response.json(body, { status })).url, token: TOKEN, callbackOrigin: origin });

  it('throws the word for a run already running', async () => {
    await expect(refusing(409, { refusal: 'duplicate' })(dispatch)).rejects.toThrow(/duplicate/);
  });

  it('throws the word for a supervisor that is draining', async () => {
    await expect(refusing(503, { refusal: 'draining' })(dispatch)).rejects.toThrow(/draining/);
  });

  it('throws the word and the detail for a spawn that failed', async () => {
    const launch = refusing(500, { refusal: 'spawn', error: 'ENOENT: no such file' });
    await expect(launch(dispatch)).rejects.toThrow(/spawn/);
    await expect(launch(dispatch)).rejects.toThrow(/ENOENT/);
  });

  it('names the status when the answer carries no word of its own', async () => {
    await expect(refusing(401, {})(dispatch)).rejects.toThrow(/status 401/);
  });

  it('names the run it could not launch', async () => {
    await expect(refusing(409, { refusal: 'duplicate' })(dispatch)).rejects.toThrow(/run_1/);
  });

  it('is a retryable hold, not a failure, when the supervisor is draining', async () => {
    await expect(refusing(503, { refusal: 'draining' })(dispatch)).rejects.toBeInstanceOf(RuntimeDraining);
  });

  it('reads a runtime that is not serving from the status alone, whatever body it carries', async () => {
    // A supervisor mid-restart, a proxy in front of it, a body that is not JSON:
    // 503 is the answer of something that is not serving, not of a run that failed.
    for (const body of [{}, { refusal: 'unknown' }, { error: 'gateway' }]) {
      await expect(refusing(503, body)(dispatch)).rejects.toBeInstanceOf(RuntimeDraining);
    }
  });

  it('reads the draining word as retryable whatever status carries it', async () => {
    await expect(refusing(500, { refusal: 'draining' })(dispatch)).rejects.toBeInstanceOf(RuntimeDraining);
    await expect(refusing(409, { refusal: 'draining' })(dispatch)).rejects.toBeInstanceOf(RuntimeDraining);
  });

  it('tells a runtime that answered nothing apart from one that answered that it is stopping', async () => {
    const stopping = await refusing(503, { refusal: 'draining' })(dispatch).then(() => null, (err: unknown) => err);
    expect((stopping as RuntimeDraining).why).toBe('draining');

    const stand = supervisor(() => Response.json({}, { status: 202 }));
    for (const server of servers.splice(0)) server.stop(true);
    const gone = await httpHarnessLaunch({ url: stand.url, token: TOKEN, callbackOrigin: origin })(dispatch)
      .then(() => null, (err: unknown) => err);
    expect((gone as RuntimeDraining).why).toBe('unreachable');
  });

  it('is a terminal failure for every other refusal', async () => {
    for (const [status, body] of [[409, { refusal: 'duplicate' }], [500, { refusal: 'spawn', error: 'x' }], [400, { refusal: 'invalid' }], [401, {}], [502, { refusal: 'nope' }]] as const) {
      const caught = await refusing(status, body)(dispatch).then(() => null, (err: unknown) => err);
      expect({ status, draining: caught instanceof RuntimeDraining, error: caught instanceof Error })
        .toEqual({ status, draining: false, error: true });
    }
  });

  it('reads the callback origin at each launch, so a port bound after the adapter was built is the one handed out', async () => {
    let bound: number | null = null;
    const stand = supervisor(() => Response.json({}, { status: 202 }));
    const launch = httpHarnessLaunch({ url: stand.url, token: TOKEN, callbackOrigin: () => {
      if (bound === null) throw new RuntimeDraining('the deployment has not bound its port');
      return `http://127.0.0.1:${bound}`;
    } });

    // A launch before the socket is bound holds the run rather than failing it.
    await expect(launch(dispatch)).rejects.toBeInstanceOf(RuntimeDraining);
    expect(stand.seen).toHaveLength(0);

    bound = 51_234;
    await launch(dispatch);
    expect(stand.seen[0]!.body.envVars?.MYCO_SERVER_URL).toBe('http://127.0.0.1:51234');
  });

  it('holds the run when the supervisor takes the call and answers nothing', async () => {
    // The dispatcher awaits this call and the drain awaits the dispatcher, so a
    // supervisor that never answers would hold the tick itself.
    expect(LAUNCH_TIMEOUT_MS).toBe(10_000);
    const stalled = supervisor(() => new Promise<Response>(() => undefined) as never);
    const started = Date.now();
    const caught = await httpHarnessLaunch({ url: stalled.url, token: TOKEN, callbackOrigin: origin, timeoutMs: 150 })(dispatch)
      .then(() => null, (err: unknown) => err);
    expect(caught).toBeInstanceOf(RuntimeDraining);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('names a supervisor it could not reach at all, and holds the run rather than failing it', async () => {
    const stand = supervisor(() => Response.json({}, { status: 202 }));
    for (const server of servers.splice(0)) server.stop(true);

    await expect(httpHarnessLaunch({ url: stand.url, token: TOKEN, callbackOrigin: origin })(dispatch))
      .rejects.toThrow(new RegExp(`${stand.url.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')} could not be reached`));
  });
});
