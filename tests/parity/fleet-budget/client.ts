import { PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { toBase64Url } from '@myco-server-worker/base64.js';
import { expect } from 'bun:test';
import type { RouteTarget } from '../clients/requests.ts';
import { owner } from '../clients/requests.ts';

export async function registerRunner(target: RouteTarget): Promise<void> {
  const candidate = `mycorun_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const post = async (path: string, body: unknown, token?: string) => {
    const response = await fetch(`${target.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', ...(token ? { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) } : {}) }, body: JSON.stringify(body) });
    expect(response.status).toBe(200); return response.json() as Promise<any>;
  };
  const machineId = `fleet-${crypto.randomUUID()}`;
  const started = await post('/auth/runner/start', { candidate, name: 'fleet-runner', machineId, machineName: 'Fleet laptop', os: 'linux' });
  expect((await owner(target, '/api/device/approve-runner', { method: 'POST', body: JSON.stringify({ user_code: started.user_code }) })).status).toBe(200);
  expect(await post('/auth/runner/poll', { device_code: started.device_code })).toMatchObject({ registered: true });
  expect(await post('/runners/contact', { machineId }, candidate)).toMatchObject({ persisted: true });
}
