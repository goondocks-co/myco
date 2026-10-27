import { expect } from 'bun:test';
import { expectPersisted, lit, type ParityScenario } from '../harness.ts';
import { selectOwner } from './backup-restore.ts';
import { VIEW_SESSION_TABLES, VIEW_GLOBAL_TABLES } from '@myco-server-worker/db/view-tables.js';

/** Capturing and reading facts creates no parser instance state. */
export const viewStoreInert: ParityScenario = {
  name: 'view store: empty instance storage preserves captured turns and additive backup',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    await selectOwner(target);
    const session = 'view-store-inert';
    const prompt = crypto.randomUUID(), response = crypto.randomUUID();
    const now = Date.now();
    for (const [kind, payload] of [
      ['session.start', { agent: 'copilot', startedAt: now }],
      ['prompt', { promptId: prompt, text: 'inertcanary', origin: 'user' }],
      ['response', { responseId: response, promptId: prompt, text: 'unchanged reply' }],
    ] as const) {
      await expectPersisted(await fetch(`${target.url}/events`, { method: 'POST',
        headers: target.memberHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind, payload, createdAt: now,
          channel: 'cli', producer: { adapter: 'parity', version: '1' } }) }), kind);
    }
    const base = `${target.url}/api/projects/${target.projectId}/sessions/${session}`;
    const read = async (path: string) => {
      const res = await fetch(base + path, { headers: target.ownerHeaders() });
      expect(res.status).toBe(200);
      return res.text();
    };
    const page = await read('/turns');
    expect(JSON.parse(page).rows.map((row: { promptId: string }) => row.promptId)).toEqual([prompt]);
    const detail = await read(`/turns/${prompt}`);
    expect(JSON.parse(detail)).toMatchObject({ prompt: { promptId: prompt, text: 'inertcanary' }, responses: [{ responseId: response, text: 'unchanged reply' }] });
    expect(await read('/turns')).toBe(page);
    expect(await read(`/turns/${prompt}`)).toBe(detail);
    const newTables = await target.sql("SELECT name FROM sqlite_schema WHERE type='table' AND (name GLOB 'view_*' OR name IN ('session_views','fact_classes','plan_promotions','learning_sessions','material_versions')) AND name NOT GLOB '*_fts*'");
    expect(newTables.map(row=>row.name).sort()).toEqual([...VIEW_SESSION_TABLES,...VIEW_GLOBAL_TABLES].sort());
    for (const { name } of newTables) expect(await target.sql(`SELECT COUNT(*) AS n FROM ${name}`)).toEqual([{ n: 0 }]);
    const owner = { ...target.ownerHeaders(), 'content-type': 'application/json', origin: target.url };
    const created = await fetch(`${target.url}/api/backups`, { method: 'POST', headers: owner, body: '{}' });
    expect(created.status).toBe(200);
    const id = (await created.json() as { backup: { id: string } }).backup.id;
    const preview = await fetch(`${target.url}/api/backups/${id}/restore-preview`, { method: 'POST', headers: owner, body: '{}' });
    expect(preview.status).toBe(200);
    const counts = (await preview.json() as { header: { counts: Record<string, number> } }).header.counts;
    expect(counts.fact_classes).toBe(0);
    expect(counts.plan_promotions).toBe(0);
    expect(counts.view_instances).toBeUndefined();
    const restored = await fetch(`${target.url}/api/backups/${id}/restore`, { method: 'POST', headers: owner, body: '{}' });
    expect(restored.status).toBe(200);
    expect(await read('/turns')).toBe(page);
    expect(await read(`/turns/${prompt}`)).toBe(detail);
    expect(await target.sql(`SELECT COUNT(*) AS n FROM prompt_batches WHERE project_id=${lit(target.projectId)} AND session_id=${lit(session)}`)).toEqual([{ n: 1 }]);
  },
};
