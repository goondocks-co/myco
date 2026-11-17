import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { browser } from '../clients/identity.ts';

export const githubApp: ParityScenario = {
  name: 'github app: sign-in independent of the App key, and admin-only setup status',
  async run(target) {
    // Both targets hold a key that cannot sign, so the status names the key without asking GitHub.
    const status = await browser(target, '/api/github-app', target.ownerHeaders());
    expect(status).toEqual({ status: 200, body: { state: 'unavailable', reason: 'The GitHub App private key is invalid. Generate a new key in GitHub and run the import again.' } });
    expect((await browser(target, '/api/github-app', target.memberHeaders())).status).toBe(401);
    const login = await fetch(`${target.url}/auth/login`, { redirect: 'manual', headers: { 'cf-connecting-ip': '1.2.3.4' } });
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get('location')!);
    expect(authorize.origin).toBe('https://github.com');
    expect(authorize.searchParams.get('client_id')).toBe('parity-client');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${target.url}/auth/callback`);
  },
};
