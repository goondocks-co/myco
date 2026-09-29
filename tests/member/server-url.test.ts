/**
 * The member server URL rule (`member/server-url.ts`): what it admits, and that
 * an admitted loopback host is dialled directly rather than through a proxy
 * the process has configured.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { admitMemberServerUrl } from '@myco/member/server-url.js';
import { keepLoopbackOffProxy } from '@myco/cli/loopback-proxy.js';

describe('admitting a member server URL', () => {
  it('admits https anywhere and http on this machine\'s loopback only', () => {
    for (const url of ['https://myco.example.com', 'http://127.0.0.1:8787', 'http://127.8.9.10:1', 'http://localhost:8787', 'http://[::1]:8787']) {
      expect({ url, admitted: admitMemberServerUrl(url, {}) }).toEqual({ url, admitted: true });
    }
    for (const url of ['http://myco.example.com', 'http://10.0.0.5:8787', 'http://127.0.0.1.example', 'http://[::2]:1', 'ftp://127.0.0.1', 'not a url']) {
      expect({ url, admitted: admitMemberServerUrl(url, {}) }).toEqual({ url, admitted: false });
    }
  });

  it('writes one list to NO_PROXY and no_proxy: what either held, then the admitted loopback host', () => {
    const upper: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://proxy.example:3128', NO_PROXY: 'corp.example' };
    expect(admitMemberServerUrl('http://127.8.9.10:18787', upper)).toBe(true);
    expect({ NO_PROXY: upper.NO_PROXY, no_proxy: upper.no_proxy }).toEqual({ NO_PROXY: 'corp.example,127.8.9.10', no_proxy: 'corp.example,127.8.9.10' });
    admitMemberServerUrl('http://127.8.9.10:18787', upper);
    expect(upper.NO_PROXY).toBe('corp.example,127.8.9.10');
    const both: NodeJS.ProcessEnv = { http_proxy: 'http://proxy.example:3128', NO_PROXY: 'a.example', no_proxy: 'b.example,a.example' };
    admitMemberServerUrl('http://localhost:1', both);
    expect({ NO_PROXY: both.NO_PROXY, no_proxy: both.no_proxy }).toEqual({ NO_PROXY: 'a.example,b.example,localhost', no_proxy: 'a.example,b.example,localhost' });
  });

  it('leaves a bare * where it stands, in either name: it already exempts every host, and a list around it would not', () => {
    for (const env of [{ HTTP_PROXY: 'http://proxy.example:3128', NO_PROXY: '*' }, { HTTP_PROXY: 'http://proxy.example:3128', no_proxy: ' * ' }] as NodeJS.ProcessEnv[]) {
      const before = { ...env };
      expect(admitMemberServerUrl('http://127.0.0.1:1', env)).toBe(true);
      keepLoopbackOffProxy(env);
      expect(env).toEqual(before);
    }
  });

  it('keeps an exemption set only in uppercase working for a real fetch after the rewrite', () => {
    // A host that is not loopback, exempted under NO_PROXY alone. This runtime reads no_proxy first,
    // so a rewrite that created no_proxy with the loopback host alone would send the host to the proxy.
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i !== undefined && i.family === 'IPv4' && !i.internal)?.address;
    if (lan === undefined) return;
    const script = `
      const { admitMemberServerUrl } = await import(${JSON.stringify(path.resolve('packages/myco/src/member/server-url.ts'))});
      const proxied = [];
      const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { proxied.push(req.url); return new Response('proxy'); } });
      const exempt = Bun.serve({ port: 0, hostname: ${JSON.stringify(lan)}, fetch() { return new Response('direct'); } });
      process.env.HTTP_PROXY = 'http://127.0.0.1:' + proxy.port;
      process.env.NO_PROXY = ${JSON.stringify(lan)};
      const url = 'http://' + ${JSON.stringify(lan)} + ':' + exempt.port + '/';
      const before = await (await fetch(url)).text();
      admitMemberServerUrl('http://127.0.0.1:18787');
      const after = await (await fetch(url)).text();
      console.log(JSON.stringify({ before, after, proxied: proxied.length, no_proxy: process.env.no_proxy }));
      proxy.stop(true); exempt.stop(true);
    `;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !/_proxy$/i.test(key)) env[key] = value;
    const ran = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
    expect(JSON.parse(ran.stdout.trim())).toEqual({ before: 'direct', after: 'direct', proxied: 0, no_proxy: `${lan},127.0.0.1` });
  });

  it('touches nothing for https, for a refused URL, or in a process with no proxy', () => {
    const proxied: NodeJS.ProcessEnv = { https_proxy: 'http://proxy.example:3128' };
    admitMemberServerUrl('https://myco.example.com', proxied);
    admitMemberServerUrl('http://10.0.0.5:1', proxied);
    expect(proxied).toEqual({ https_proxy: 'http://proxy.example:3128' });
    const direct: NodeJS.ProcessEnv = {};
    admitMemberServerUrl('http://127.0.0.1:1', direct);
    expect(direct).toEqual({});
  });

  it('keeps the loopback names off a proxy at process start', () => {
    const env: NodeJS.ProcessEnv = { http_proxy: 'http://proxy.example:3128' };
    keepLoopbackOffProxy(env);
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1,[::1]');
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1,[::1]');
  });

  it('is honoured by this runtime\'s fetch: a loopback dial under HTTP_PROXY reaches the server, not the proxy', () => {
    // In a child process: a proxy variable set and then deleted here would stay in force for the rest of this one.
    const script = `
      const { admitMemberServerUrl } = await import(${JSON.stringify(path.resolve('packages/myco/src/member/server-url.ts'))});
      const proxied = [];
      const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) { proxied.push(req.url); return new Response('proxy'); } });
      const target = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { return new Response('direct'); } });
      process.env.HTTP_PROXY = 'http://127.0.0.1:' + proxy.port;
      const url = 'http://127.0.0.1:' + target.port + '/health';
      const before = await (await fetch(url)).text();
      const admitted = admitMemberServerUrl(url);
      const after = await (await fetch(url)).text();
      console.log(JSON.stringify({ before, admitted, after, proxied: proxied.length }));
      proxy.stop(true); target.stop(true);
    `;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && !/_proxy$/i.test(key)) env[key] = value;
    const ran = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
    // Without the bypass this runtime routes loopback http through the proxy; admission is what stops it.
    expect(JSON.parse(ran.stdout.trim())).toEqual({ before: 'proxy', admitted: true, after: 'direct', proxied: 1 });
  });
});
