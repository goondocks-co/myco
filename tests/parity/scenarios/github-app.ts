import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { browser } from '../clients/identity.ts';

export const githubApp: ParityScenario = {
  name: 'github app: sign-in beside the App, and admin-only setup status',
  async run(target) {
    // Both targets hold a generated App key and reach the controlled GitHub, which confirms the App's reads.
    const status = await browser(target, '/api/github-app', target.ownerHeaders());
    expect(status).toEqual({ status: 200, body: { state: 'ready', app: { id: 12345, clientId: 'parity-client', slug: 'parity-app', permissions: { contents: 'read', pull_requests: 'read', metadata: 'read' } }, missing: [] } });
    expect((await browser(target, '/api/github-app', target.memberHeaders())).status).toBe(401);
    const login = await fetch(`${target.url}/auth/login`, { redirect: 'manual', headers: { 'cf-connecting-ip': '1.2.3.4' } });
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get('location')!);
    expect(authorize.origin).toBe('https://github.com');
    expect(authorize.searchParams.get('client_id')).toBe('parity-client');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${target.url}/auth/callback`);
  },
};
