import { expect } from 'bun:test';
import { MEMBER_ID } from '../harness.ts';
import { owner, putSetting, resetSetting, type RouteTarget } from '../clients/requests.ts';

export async function selectOwner(target: RouteTarget): Promise<void> {
  const preview = await owner(target, '/api/ownership');
  expect(preview.status).toBe(200);
  if (preview.body.ownerMemberId === MEMBER_ID) return;
  const selected = await owner(target, '/api/ownership', { method: 'POST', body: JSON.stringify({ ownerMemberId: MEMBER_ID, revision: preview.body.revision }) });
  expect(selected.status).toBe(200);
}
export async function credentials(target: RouteTarget): Promise<any[]> {
  const rows: any[] = []; let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const answer: { status: number; body: { rows: any[]; cursor?: string | null } } = await owner(target, `/api/credentials?limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
    expect(answer.status).toBe(200); rows.push(...answer.body.rows);
    if ((cursor = answer.body.cursor ?? null) === null) return rows;
  }
  throw new Error('credential list did not end');
}
export async function joinMachine(target: RouteTarget, machineId = `machine-${crypto.randomUUID()}`): Promise<{ token: string; memberId: string; machineId: string }> {
  const invited = await owner(target, '/api/enrollment', { method: 'POST', body: JSON.stringify({ role: 'member' }) });
  expect(invited.status).toBe(201);
  const response = await fetch(`${target.url}/members/join`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' }, body: JSON.stringify({ key: invited.body.key, machineId }) });
  expect(response.status).toBe(200); const joined = await response.json() as { joined: boolean; token: string; memberId: string };
  expect(joined.joined).toBe(true); return { ...joined, machineId };
}

/** Restores each shared Deployment leaf to the configuration read before the scenario. */
export async function withSettings(target: RouteTarget, settings: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  const before = (await owner(target, '/api/settings')).body.leaves;
  try {
    for (const [leaf, value] of Object.entries(settings)) expect((await putSetting(target, leaf, value)).status).toBe(200);
    await run();
  } finally {
    for (const leaf of Object.keys(settings)) {
      const previous = before.find((row: any) => row.leaf === leaf);
      expect((await (previous?.configured ? putSetting(target, leaf, previous.value) : resetSetting(target, leaf))).status).toBe(200);
    }
  }
}
