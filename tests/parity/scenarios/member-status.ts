import { expect } from 'bun:test';
import { jsonBody } from '../../helpers/json-body.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { SIZE_LIMIT_UNAVAILABLE } from '@myco-server-worker/platform/cloudflare/store-maintenance.js';
import { RUN_SCOPE } from '@myco-server-worker/pipeline.js';
import { memberHeadersFor, waitFor, type ParityScenario } from '../harness.ts';
import { allowWorkerClaims, claimRun, endRun, event, owner, untilPublished } from '../clients/requests.ts';

interface Measurement { name: string; state: 'measured' | 'unavailable'; value?: number; unit?: string; reason?: string; reasonCode?: string }
interface Outcome { finishedAt: number | null; measurements: Measurement[] }

/**
 * Deployment health read over a member credential on both targets: the target,
 * the schema check, the bytes the presented credential stored (information,
 * never a limit), the transcript retention window, the bytes
 * recorded blobs hold, and the database measurements the target's store
 * maintenance recorded, with what the target cannot report named unavailable;
 * a body that is not the empty object, a run's credential and a grant refused;
 * and no Project created for whatever Project the request names.
 */
export const memberStatus: ParityScenario = {
  name: 'member status: a member credential reads the schema check, its own stored bytes, the retention window and the Deployment\'s storage',
  // The run credential is one this scenario's worker claims. The claim stays off the shared queue.
  dedicated: { timeoutMs: 180_000 },
  async run(target) {
    const dashboard = { ...target.ownerHeaders(), origin: target.url };
    const ownerPost = (path: string, body: Record<string, unknown> = {}) =>
      fetch(`${target.url}${path}`, { method: 'POST', headers: { ...dashboard, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const unseen = 'proj_parity_status_unseen';
    const read = (body: string, headers: Record<string, string> = target.memberHeaders({ 'x-myco-project': unseen })) =>
      fetch(`${target.url}/members/status`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });

    const ran = await ownerPost('/api/maintenance/optimize/run');
    expect(ran.status).toBe(200);
    const optimize = async () => {
      const checks = ((await (await fetch(`${target.url}/api/maintenance`, { headers: dashboard })).json()) as { checks: Array<{ check: string; latest: Outcome | null }> }).checks;
      return checks.find((c) => c.check === 'optimize')?.latest ?? null;
    };
    const recorded = (await waitFor(optimize, (latest) => latest?.finishedAt != null))!;

    const res = await read('{}');
    expect(res.status).toBe(200);
    const health = (await res.json()) as {
      deploymentId: string; persisted: boolean; target: string | null; schema: unknown;
      stored: unknown; retention: unknown;
      storage: Array<Measurement & { measuredAt: number | null }>;
    };
    expect(Object.keys(health).sort()).toEqual(['deploymentId', 'persisted', 'retention', 'schema', 'storage', 'stored', 'target']);
    expect(health.persisted).toBe(true);
    expect(health.deploymentId).toBe(target.deploymentId);
    expect(health.target).toBe(target.name === 'cloudflare' ? 'cloudflare' : 'bun');
    expect(health.schema).toEqual({ expected: SERVER_SCHEMA_VERSION, found: SERVER_SCHEMA_VERSION, matches: true });
    const credentials = await owner<{ rows: Array<{ purpose: string; live: boolean; bytesWritten: number }> }>(target, '/api/credentials?purpose=member');
    expect(credentials.status).toBe(200);
    const liveMember = credentials.body.rows.filter((row) => row.live && row.purpose === 'member');
    expect(liveMember).toHaveLength(1);
    expect(health.stored).toEqual({ state: 'measured', value: liveMember[0]!.bytesWritten, unit: 'bytes' });
    expect(health.retention).toEqual({ transcripts: { state: 'days', days: 90, configured: false, compatibility: 'default' } });
    const named = (name: string) => health.storage.find((m) => m.name === name);
    expect(health.storage.slice(0, 2).map((m) => m.name)).toEqual(['blob_bytes', 'size']);
    for (const m of recorded.measurements) expect(named(m.name)).toEqual({ ...m, measuredAt: recorded.finishedAt });
    expect(named('size')?.state).toBe('measured');
    expect(named('size')?.value).toBeGreaterThan(0);
    if (target.name === 'cloudflare') {
      expect(named('size_limit')).toEqual({ name: 'size_limit', state: 'unavailable', reason: SIZE_LIMIT_UNAVAILABLE, reasonCode: 'measurement_unavailable', measuredAt: recorded.finishedAt });
    }
    const projects = await owner<{ projects: Array<{ projectId: string }> }>(target, '/api/projects?include=archived');
    expect(projects.status).toBe(200);
    expect(projects.body.projects.some((row) => row.projectId === unseen)).toBe(false);

    expect(await jsonBody(await read(JSON.stringify({ project: target.projectId })))).toEqual({ persisted: false, code: 'unknown_field', reason: 'unknown field project' });

    const now = Date.now();
    const session = `parity-status-${now}`;
    const prompt = crypto.randomUUID();
    await allowWorkerClaims(target);
    await event(target, session, 'session.start', { agent: 'claude-code', startedAt: now }, now);
    await event(target, session, 'prompt', { promptId: prompt, text: 'Status the deployment.', origin: 'user' }, now + 1);
    expect((await untilPublished(target, () => owner(target, `/api/projects/${target.projectId}/sessions/${session}/turns/${prompt}`), (page) => page.status === 200)).status).toBe(200);
    expect((await owner(target, `/api/projects/${target.projectId}/sessions/${encodeURIComponent(session)}/title`, { method: 'POST' })).status).toBe(200);
    const claimed = await claimRun(target);
    expect(claimed.claimed).toBe(true);
    try {
      expect(await jsonBody(await read('{}', memberHeadersFor(claimed.run!.runToken, target.projectId)))).toEqual({ persisted: false, code: 'run_scope', reason: RUN_SCOPE });
    } finally { expect(await endRun(target, claimed.run!)).toMatchObject({ ended: true }); }

    const resolved = await fetch(`${target.url}/spores/list`, { method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' }, body: '{}' });
    expect(((await resolved.json()) as { persisted: boolean }).persisted).toBe(true);
    const minted = await ownerPost(`/api/projects/${target.projectId}/grants`, { label: 'parity status reader' });
    expect(minted.status).toBe(201);
    const grant = (await minted.json()) as { key: string; id: string };
    try {
      expect((await read('{}', target.grantHeaders(grant.key))).status).toBe(401);
    } finally {
      expect((await ownerPost(`/api/projects/${target.projectId}/grants/${grant.id}/revoke`)).status).toBe(200);
    }
  },
};
