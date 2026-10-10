import { expect, mock, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { devSession } from '../parity/targets/dev-session.ts';

const FAKE_PID = 987654;
const realSetTimeout = globalThis.setTimeout;
const turn = () => new Promise<void>(resolve => realSetTimeout(resolve, 0));

function heldStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  let closed = false;
  return {
    stream: new ReadableStream<Uint8Array<ArrayBuffer>>({ start(value) { controller = value; } }),
    finish(text: string) {
      if (closed) return;
      closed = true;
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  };
}

function controllerFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-parity-controller-test-'));
  const originalExitListeners = new Set(process.listeners('exit'));
  const stdout = heldStream();
  const stderr = heldStream();
  let finishExit!: (code: number) => void;
  const exited = new Promise<number>(resolve => { finishExit = resolve; });
  let reply!: (message: { id: string }) => void;
  const processKill = mock(() => {});
  const unexpected = () => { throw new Error('unexpected controller operation'); };
  const child: Bun.Subprocess = {
    stdin: undefined, terminal: undefined, stdio: [null, null, null], readable: stdout.stream,
    exitCode: null, signalCode: null, killed: false,
    ref: unexpected, unref: unexpected, disconnect: unexpected, resourceUsage: unexpected,
    [Symbol.asyncDispose]: async () => { unexpected(); },
    pid: FAKE_PID, stdout: stdout.stream, stderr: stderr.stream, exited, kill: processKill,
    send(message: { id: string; op: string }) {
      if (message.op === 'close') queueMicrotask(() => reply({ id: message.id }));
    },
  };
  const spawn = spyOn(Bun, 'spawn').mockImplementation(<
    In extends Bun.SpawnOptions.Writable,
    Out extends Bun.SpawnOptions.Readable,
    Err extends Bun.SpawnOptions.Readable,
  >(
    args: string[] | (Bun.SpawnOptions.SpawnOptions<In, Out, Err> & { cmd: string[] }),
    options?: Bun.SpawnOptions.SpawnOptions<In, Out, Err>,
  ): Bun.Subprocess<In, Out, Err> => {
    const config = Array.isArray(args) ? options : args;
    reply = message => config!.ipc!(message, child as Bun.Subprocess<In, Out, Err>);
    return child as Bun.Subprocess<In, Out, Err>;
  });
  const killGroup = spyOn(process, 'kill').mockImplementation(() => true);
  function immediateTimeout(handler: TimerHandler, delay?: number, ...args: unknown[]): number;
  function immediateTimeout(...args: Parameters<typeof realSetTimeout>): ReturnType<typeof realSetTimeout>;
  function immediateTimeout(handler: TimerHandler, _delay?: number, ...args: unknown[]): number | ReturnType<typeof realSetTimeout> {
    return realSetTimeout(() => {
      if (typeof handler !== 'function') throw new Error('the controller timeout requires a callback');
      handler(...args);
    }, 0);
  }
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(Object.assign(immediateTimeout, {
    __promisify__: realSetTimeout.__promisify__,
  }));
  const session = devSession(root);
  return {
    session, stdout, stderr, finishExit, spawn, processKill, killGroup, originalExitListeners,
    async restore() {
      finishExit(137);
      stdout.finish('');
      stderr.finish('');
      await turn();
      for (const listener of process.listeners('exit')) {
        if (!originalExitListeners.has(listener)) process.removeListener('exit', listener);
      }
      timer.mockRestore();
      killGroup.mockRestore();
      spawn.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a command timeout terminates its controller group and waits for exit and both log streams', async () => {
  const fixture = controllerFixture();
  try {
    let settled = false;
    const failure = fixture.session.command({ op: 'start', tag: 'stalled' }).then(
      () => { throw new Error('the stalled command unexpectedly resolved'); },
      error => error,
    ).finally(() => { settled = true; });
    await turn();
    if (process.platform === 'win32') expect(fixture.processKill).toHaveBeenCalledTimes(1);
    else expect(fixture.killGroup).toHaveBeenCalledWith(-FAKE_PID, 'SIGKILL');
    expect(fixture.spawn.mock.calls[0]![1]!.detached).toBe(true);
    expect(settled).toBe(false);
    fixture.finishExit(137);
    await turn();
    expect(settled).toBe(false);
    fixture.stdout.finish('final stdout');
    await turn();
    expect(settled).toBe(false);
    fixture.stderr.finish('final stderr');
    expect(await failure).toMatchObject({ message: expect.stringContaining('start timed out') });
    expect(fixture.session.runtime()).toMatchObject({ alive: false, exitCode: 137 });
    expect(fixture.session.runtime().tail).toContain('final stdout');
    expect(fixture.session.runtime().tail).toContain('final stderr');
    expect(process.listeners('exit')).toEqual([...fixture.originalExitListeners]);
    await expect(fixture.session.command({ op: 'sql' })).rejects.toThrow('is stopped');
    await fixture.session.close();
    expect(process.platform === 'win32' ? fixture.processKill : fixture.killGroup).toHaveBeenCalledTimes(1);
  } finally { await fixture.restore(); }
});

test('close surfaces a retained log-sink failure after disposing the controller', async () => {
  const fixture = controllerFixture();
  const append = spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('ENOSPC test log'); });
  try {
    fixture.stdout.finish('worker output');
    fixture.stderr.finish('');
    fixture.finishExit(0);
    await expect(fixture.session.close()).rejects.toThrow('Wrangler dev log sink failed: Error: ENOSPC test log');
    expect(fixture.session.runtime()).toMatchObject({ alive: false, logFailure: 'Error: ENOSPC test log' });
    expect(process.listeners('exit')).toEqual([...fixture.originalExitListeners]);
  } finally {
    append.mockRestore();
    await fixture.restore();
  }
});
