/**
 * The member server URL rule (`member/server-url.ts`): what it admits, and that
 * an admitted loopback host is dialled directly rather than through a proxy
 * the process has configured.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
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

  it('adds an admitted loopback host to NO_PROXY and no_proxy when a proxy is configured, keeping what was there', () => {
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: 'http://proxy.example:3128', NO_PROXY: 'corp.example' };
    expect(admitMemberServerUrl('http://127.8.9.10:18787', env)).toBe(true);
    expect(env.NO_PROXY).toBe('corp.example,127.8.9.10');
    expect(env.no_proxy).toBe('127.8.9.10');
    admitMemberServerUrl('http://127.8.9.10:18787', env);
    expect(env.NO_PROXY).toBe('corp.example,127.8.9.10');
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
