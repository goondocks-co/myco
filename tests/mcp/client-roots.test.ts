import { afterEach, expect, it, spyOn } from 'bun:test';
import { PassThrough } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { bootstrapClientRoots, ROOTS_BOOTSTRAP_MAX_MESSAGES, ROOTS_BOOTSTRAP_TIMEOUT_MS, ROOTS_MAX_COUNT } from '@myco/mcp/client-roots.js';
import { SERVER_INSTRUCTIONS } from '@goondocks/myco-shared/mcp-protocol';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function protocol() {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new StdioServerTransport(input, output);
  const messages: any[] = [];
  output.on('data', data => messages.push(...String(data).trim().split('\n').map(line => JSON.parse(line))));
  const result = bootstrapClientRoots(transport).then(() => null, error => error as Error);
  cleanups.push(async () => { await transport.close(); input.destroy(); output.destroy(); });
  const send = (message: object) => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  const initialize = async () => {
    send({ id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'fixture', version: '1' } } });
    await tick();
    return messages[0];
  };
  return { send, result, messages, initialize, tick };
}

it('finishes local initialization before requesting roots and isolates roots response IDs from queued client requests', async () => {
  const probe = protocol();
  const response = await probe.initialize();
  expect(response).toMatchObject({ id: 0, result: { protocolVersion: '2025-11-25', instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } } });
  expect(probe.messages).toHaveLength(1);
  probe.send({ method: 'notifications/initialized' });
  await probe.tick();
  const request = probe.messages[1];
  expect(request.method).toBe('roots/list');
  expect(typeof request.id).toBe('string');
  probe.send({ id: request.id, method: 'tools/list' });
  probe.send({ id: request.id, error: { code: -32601, message: 'Roots unavailable' } });
  expect((await probe.result)?.message).toContain('could not provide roots');
  expect(probe.messages).toContainEqual({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'The MCP client could not provide roots' } });
  probe.send({ id: 7, method: 'tools/list' });
  await probe.tick();
  expect(probe.messages.at(-1)).toMatchObject({ id: 7, error: { code: -32000 } });
});

it('bounds queued client requests while roots are pending', async () => {
  const probe = protocol();
  await probe.initialize();
  probe.send({ method: 'notifications/initialized' });
  let finished = false;
  void probe.result.then(() => { finished = true; });
  for (let id = 0; id < ROOTS_BOOTSTRAP_MAX_MESSAGES; id++) probe.send({ id, method: 'tools/list' });
  await probe.tick();
  expect(finished).toBe(false);
  probe.send({ id: ROOTS_BOOTSTRAP_MAX_MESSAGES, method: 'tools/list' });
  await probe.tick();
  probe.send({ id: probe.messages[1].id, error: { code: -32601, message: 'Roots unavailable' } });
  expect((await probe.result)?.message).toContain('Too many MCP messages');
});

it('bounds the roots list before resolving any registry destinations', async () => {
  const probe = protocol();
  await probe.initialize();
  probe.send({ method: 'notifications/initialized' });
  await probe.tick();
  probe.send({ id: probe.messages[1].id, result: { roots: Array.from({ length: ROOTS_MAX_COUNT + 1 }, () => ({ uri: 'file:///unused' })) } });
  expect((await probe.result)?.message).toContain('invalid roots');
});

it('refuses roots initialization at its declared deadline', async () => {
  const timers = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(Object.assign(<Args extends unknown[]>(callback: (...args: Args) => void, delay?: number, ...args: Args) => {
    if (delay === ROOTS_BOOTSTRAP_TIMEOUT_MS) expire = () => callback(...args);
    return timers(callback, delay, ...args);
  }, timers));
  cleanups.push(() => timer.mockRestore());
  const probe = protocol();
  expect(expire).toBeDefined();
  expire!();
  expect((await probe.result)?.message).toContain('timed out');
});

it('refuses a root change during bootstrap before making a connection', async () => {
  const probe = protocol();
  await probe.initialize();
  probe.send({ method: 'notifications/roots/list_changed' });
  expect((await probe.result)?.message).toContain('roots changed');
});
