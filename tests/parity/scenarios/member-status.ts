import { expect } from 'bun:test';
import { jsonBody } from '../../helpers/json-body.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { SIZE_LIMIT_UNAVAILABLE } from '@myco-server-worker/platform/cloudflare/store-maintenance.js';
import { RUN_SCOPE } from '@myco-server-worker/pipeline.js';
import { lit, waitFor, type ParityScenario } from '../harness.ts';

interface Measurement { name: string; state: 'measured' | 'unavailable'; value?: number; unit?: string; reason?: string }
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
  async run(target) {
    const owner = { ...target.ownerHeaders(), origin: target.url };
    const ownerPost = (path: string, body: Record<string, unknown> = {}) =>
      fetch(`${target.url}${path}`, { method: 'POST', headers: { ...owner, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const unseen = 'proj_parity_status_unseen';
    const read = (body: string, headers: Record<string, string> = target.memberHeaders({ 'x-myco-project': unseen })) =>
      fetch(`${target.url}/members/status`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });

    const ran = await ownerPost('/api/maintenance/optimize/run');
    expect(ran.status).toBe(200);
    const optimize = async () => {
      const checks = ((await (await fetch(`${target.url}/api/maintenance`, { headers: owner })).json()) as { checks: Array<{ check: string; latest: Outcome | null }> }).checks;
      return checks.find((c) => c.check === 'optimize')?.latest ?? null;
    };
    const recorded = (await waitFor(optimize, (latest) => latest?.finishedAt != null))!;

    const tokenId = String((await target.sql(`SELECT id FROM member_credentials WHERE token_hash = ${lit(await sha256Hex(target.memberToken))}`))[0]?.id);
    const stored = async () => Number((await target.sql(`SELECT bytes_written AS n FROM member_credentials WHERE id = ${lit(tokenId)}`))[0]?.n);
    const blobs = async () => Number((await target.sql('SELECT COALESCE(SUM(size), 0) AS n FROM blobs'))[0]?.n);

    const res = await read('{}');
    expect(res.status).toBe(200);
    const health = (await res.json()) as {
      persisted: boolean; target: string | null; schema: unknown;
      stored: unknown; retention: unknown;
      storage: Array<Measurement & { measuredAt: number | null }>;
    };
    expect(Object.keys(health).sort()).toEqual(['persisted', 'retention', 'schema', 'storage', 'stored', 'target']);
    expect(health.persisted).toBe(true);
    expect(health.target).toBe(target.name === 'cloudflare' ? 'cloudflare' : 'bun');
    expect(health.schema).toEqual({ expected: SERVER_SCHEMA_VERSION, found: SERVER_SCHEMA_VERSION, matches: true });
    expect(health.stored).toEqual({ state: 'measured', value: await stored(), unit: 'bytes' });
    expect(health.retention).toEqual({ transcripts: { state: 'forever', configured: false } });
    const named = (name: string) => health.storage.find((m) => m.name === name);
    expect(health.storage.slice(0, 2).map((m) => m.name)).toEqual(['blob_bytes', 'size']);
    expect(named('blob_bytes')).toEqual({ name: 'blob_bytes', state: 'measured', value: await blobs(), unit: 'bytes', measuredAt: recorded.finishedAt });
    for (const m of recorded.measurements) expect(named(m.name)).toEqual({ ...m, measuredAt: recorded.finishedAt });
    expect(named('size')?.state).toBe('measured');
    expect(named('size')?.value).toBeGreaterThan(0);
    if (target.name === 'cloudflare') {
      expect(named('size_limit')).toEqual({ name: 'size_limit', state: 'unavailable', reason: SIZE_LIMIT_UNAVAILABLE, measuredAt: recorded.finishedAt });
    }
    expect(await target.sql(`SELECT COUNT(*) AS n FROM projects WHERE project_id = ${lit(unseen)}`)).toEqual([{ n: 0 }]);

    expect(await jsonBody(await read(JSON.stringify({ project: target.projectId })))).toEqual({ persisted: false, code: 'unknown_field', reason: 'unknown field project' });

    const now = Date.now();
    const harnessToken = `status-parity-harness-${now}`.padEnd(43, 'x');
    const harnessId = `mt_status_harness_${now}`;
    await target.sql(`INSERT OR IGNORE INTO members(id,label,created_at) VALUES ('mem_harness','harness',${now})`);
    await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,lineage_root,lineage_started_at)
      VALUES (${lit(harnessId)},'mem_harness','harness',${lit(await sha256Hex(harnessToken))},${now},${now + 3_600_000},0,${lit(harnessId)},${now})`);
    try {
      expect(await jsonBody(await read('{}', { ...target.memberHeaders(), authorization: `Bearer ${harnessToken}` }))).toEqual({ persisted: false, code: 'run_scope', reason: RUN_SCOPE });
    } finally {
      await target.sql(`DELETE FROM member_credentials WHERE id = ${lit(harnessId)}`);
    }

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
    await target.sql(`DELETE FROM schema_meta WHERE key = 'maintenance.optimize'`);
  },
};
