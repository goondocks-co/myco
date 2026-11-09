import { expect, test } from 'bun:test';
import net from 'node:net';
import { createRequire } from 'node:module';

const load = createRequire(import.meta.url);
type BridgeWorker = {
  once(event: 'message' | 'error', listener: (value: unknown) => void): void;
  terminate(): Promise<number>;
};
type Threads = { Worker: new (script: string, options: { eval: true; workerData: unknown }) => BridgeWorker };

/** Answers each request on a kept-alive connection, except the second, which `dropSecond` handles. */
async function withKeepAliveServer(dropSecond: (socket: net.Socket) => void, run: (url: string, seen: { requests: number }) => Promise<void>): Promise<void> {
  const seen = { requests: 0 };
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      if (!String(chunk).includes('\r\n\r\n')) return;
      seen.requests += 1;
      if (seen.requests === 2) dropSecond(socket);
      else socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  try { await run(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`, seen); }
  finally { server.close(); }
}

/** Two POSTs from an eval Worker that loads undici the way Miniflare's synchronous bridge does; reports the outcome. */
const BRIDGE_SHAPED_SCRIPT = `
const { createRequire } = require("module");
const { parentPort, workerData } = require("worker_threads");
const actualRequire = createRequire(workerData.filename);
const { fetch } = actualRequire("undici");
(async () => {
  try {
    for (let i = 0; i < 2; i += 1) await (await fetch(workerData.url, { method: "POST", body: "x" })).text();
    parentPort.postMessage("sent");
  } catch (error) { parentPort.postMessage(String(error.message)); }
})();
`;

async function bridgeOutcome(url: string): Promise<unknown> {
  const { Worker } = load('node:worker_threads') as Threads;
  const worker = new Worker(BRIDGE_SHAPED_SCRIPT, { eval: true, workerData: { url, filename: import.meta.path } });
  try { return await new Promise((settled, failed) => { worker.once('message', settled); worker.once('error', failed); }); }
  finally { await worker.terminate(); }
}

const CLOSED_MESSAGE = 'The socket connection was closed unexpectedly';

test('a bridge request dropped by workerd closing its kept-alive connection is resent and answered', async () => {
  await withKeepAliveServer((socket) => socket.destroy(), async (url, seen) => {
    expect(await bridgeOutcome(url)).toBe('sent');
    expect(seen.requests).toBe(3);
  });
});

test('a connection closed after the request has had time to run fails the call instead of sending it twice', async () => {
  await withKeepAliveServer((socket) => { setTimeout(() => socket.destroy(), 800); }, async (url, seen) => {
    expect(String(await bridgeOutcome(url))).toContain(CLOSED_MESSAGE);
    expect(seen.requests).toBe(2);
  });
});
