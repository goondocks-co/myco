import { expect, it } from 'bun:test';
import { cloudflareBlobReader, cloudflareObjectStore } from '@myco/server/cloudflare.js';
import type { CommandRunner } from '@myco/server/runner.js';

const options = { accountId: 'fixture-account', bucketName: 'fixture-bucket', configDir: '/operator' };

it('shares one operator login across object streams, pins the API origin and disables credential logging', async () => {
  let authentications = 0;
  const runner: CommandRunner = { async run(command, args, runOptions) {
    authentications += 1;
    expect(command).toBe('npx');
    expect(args).toEqual(['--no-install', 'wrangler', 'auth', 'token', '--json']);
    expect(runOptions?.cwd).toBe('/operator');
    expect(runOptions?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: options.accountId, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG: 'log', WRANGLER_LOG_SANITIZE: 'true' });
    return { code: 0, stdout: JSON.stringify({ type: 'oauth', token: 'fixture-token' }), stderr: '' };
  } };
  const urls: string[] = [];
  const read = cloudflareBlobReader({ ...options, runner, fetch: async (input, init) => {
    urls.push(String(input));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-token');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(new Uint8Array([0, 127, 255]));
  } });
  const bodies = await Promise.all(['project/a', 'project/b', 'project/key?#'].map(async (key) => new Uint8Array(await new Response(await read(key)).arrayBuffer())));
  expect(authentications).toBe(1);
  expect(bodies).toEqual(Array.from({ length: 3 }, () => new Uint8Array([0, 127, 255])));
  expect(urls.at(-1)).toBe('https://api.cloudflare.com/client/v4/accounts/fixture-account/r2/buckets/fixture-bucket/objects/project/key%3F%23');
});

it('refreshes a rejected login once and keeps an authentication failure explicit without echoing secrets', async () => {
  let authentications = 0;
  let requests = 0;
  const read = cloudflareBlobReader({ ...options, runner: { async run() {
    authentications += 1;
    return { code: 0, stdout: JSON.stringify({ type: 'api_token', token: `fixture-private-${authentications}` }), stderr: '' };
  } }, fetch: async () => {
    requests += 1;
    return new Response('fixture-private-response', { status: 403 });
  } });
  let message = '';
  try { await read('project/key'); } catch (error) { message = String(error); }
  expect(message).toContain('HTTP 403');
  expect(message).not.toContain('fixture-private');
  expect({ authentications, requests }).toEqual({ authentications: 2, requests: 2 });
});

it('uses a refreshed OAuth token for the resumed object request', async () => {
  let authentications = 0;
  const read = cloudflareBlobReader({ ...options, runner: { async run() {
    return { code: 0, stdout: JSON.stringify({ type: 'oauth', token: `fixture-${++authentications}` }), stderr: '' };
  } }, fetch: async (_input, init) => new Headers(init?.headers).get('authorization') === 'Bearer fixture-1'
    ? new Response(null, { status: 401 }) : new Response('recovered') });
  expect(await new Response(await read('project/key')).text()).toBe('recovered');
  expect(authentications).toBe(2);
});

it('supports the operator API-key login without turning it into a bearer token', async () => {
  const read = cloudflareBlobReader({ ...options, runner: { async run() {
    return { code: 0, stdout: JSON.stringify({ type: 'api_key', key: 'fixture-key', email: 'fixture@example.invalid' }), stderr: '' };
  } }, fetch: async (_input, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-auth-key')).toBe('fixture-key');
    expect(headers.get('x-auth-email')).toBe('fixture@example.invalid');
    return new Response('body');
  } });
  expect(await new Response(await read('project/key')).text()).toBe('body');
});

it('refuses malformed or failed credential responses before any object request without exposing their output', async () => {
  for (const result of [
    { code: 1, stdout: 'fixture-private-stdout', stderr: 'fixture-private-stderr' },
    { code: 0, stdout: JSON.stringify({ type: 'api_token', token: 'fixture-private\r\nvalue' }), stderr: '' },
  ]) {
    const read = cloudflareBlobReader({ ...options, runner: { run: async () => result }, fetch: async () => { throw new Error('unexpected fetch'); } });
    let message = '';
    try { await read('project/key'); } catch (error) { message = String(error); }
    expect(message).toContain('Wrangler');
    expect(message).not.toContain('fixture-private');
    expect(message).not.toContain('unexpected fetch');
  }
});

it('refuses path traversal before obtaining any credential', async () => {
  const read = cloudflareBlobReader({ ...options, runner: { async run() { throw new Error('unexpected credential read'); } } });
  await expect(read('../other-account')).rejects.toThrow('invalid segment');
  await expect(read('project/../key')).rejects.toThrow('invalid segment');
});

it('reopens the upload body after authentication refresh and shares the login with readback', async () => {
  let logins = 0;
  let opened = 0;
  let uploaded = '';
  const store = cloudflareObjectStore({ ...options, runner: { async run() {
    return { code: 0, stdout: JSON.stringify({ type: 'oauth', token: `fixture-${++logins}` }), stderr: '' };
  } }, fetch: async (_url, init) => {
    expect(init.redirect).toBe('error');
    const headers = new Headers(init.headers);
    if (init.method === 'PUT') {
      expect(headers.get('content-length')).toBe('7');
      expect(headers.get('content-type')).toBe('application/octet-stream');
      uploaded = await new Response(init.body).text();
      if (headers.get('authorization') === 'Bearer fixture-1') return new Response(null, { status: 401 });
      return Response.json({ success: true });
    }
    return new Response(uploaded);
  } });
  await store.put('project/key', () => { opened++; return new Blob(['a\0value']); });
  expect(await new Response(await store.get('project/key')).text()).toBe('a\0value');
  expect({ logins, opened }).toEqual({ logins: 2, opened: 2 });
});

it('distinguishes an absent restore object from refusal and rejects unconfirmed writes', async () => {
  let status = 404;
  const store = cloudflareObjectStore({ ...options, runner: { async run() {
    return { code: 0, stdout: JSON.stringify({ type: 'api_token', token: 'fixture-only' }), stderr: '' };
  } }, fetch: async () => status === 200 ? Response.json({ success: false }) : new Response(null, { status }) });
  expect(await store.get('project/key')).toBeNull();
  status = 403;
  await expect(store.get('project/key')).rejects.toThrow('HTTP 403');
  await expect(store.put('project/key', () => new Blob())).rejects.toThrow('HTTP 403');
  status = 200;
  await expect(store.put('project/key', () => new Blob())).rejects.toThrow('did not confirm');
});
