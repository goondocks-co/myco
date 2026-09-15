import { expect } from 'bun:test';
import { expectPersisted, lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * The imported-session backfill (#1203) on both targets: an import brings a
 * session that arrives closed and untitled and makes no titling request; the
 * backfill is off until the operator starts it; once on, one wake parses the
 * imported transcript and dispatches one claim attributed to the backfill, the
 * next wake finds nothing left, and the operator's stop holds. Both targets
 * bind the recording runtime, so the run row waits and no title is written.
 */
export const titlingBackfill: ParityScenario = {
  name: 'titling backfill: off by default, started and stopped by the operator, one claim per imported session after its parse, idempotent',
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const post = async (sessionId: string, kind: string, payload: Record<string, unknown>, channel: 'cli' | 'import' = 'import') => {
      const res = await fetch(`${target.url}/events`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt: stamp, channel, producer: { adapter: 'claude-code', version: '1' }, payload }),
      });
      await expectPersisted(res, kind);
    };
    const owner = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${target.url}${path}`, {
        method, headers: { ...target.ownerHeaders(), origin: target.url, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status).toBe(200);
      return await res.json() as Record<string, unknown>;
    };
    const backfillRuns = () => target.sql(`SELECT status, json_extract(run_context, '$.session_id') AS sessionId, json_extract(run_context, '$.mode') AS mode
      FROM agent_runs WHERE task = 'title-summary' AND json_extract(dispatch_spec, '$.actor') = 'backfill' ORDER BY COALESCE(queued_at, started_at)`);
    for (const [leaf, value] of [['agent.provider.type', 'openai-compatible'], ['agent.provider.model', 'parity-model'], ['agent.provider.base_url', 'http://models.internal/v1'], ['agent.scheduled_tasks_enabled', true]] as const) {
      await target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (${lit(leaf)}, ${lit(JSON.stringify(value))}, ${stamp}, ${lit(MEMBER_ID)})`);
    }

    // An import: one transcript segment holding a user prompt, and the closed session around it, all on the import channel.
    const session = `parity-backfill-${stamp}`;
    const line = `${JSON.stringify({ type: 'user', promptId: crypto.randomUUID(), message: { content: `Wire the backfill ${stamp}` }, timestamp: new Date(stamp - 60_000).toISOString() })}\n`;
    const bytes = new TextEncoder().encode(line);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const blob = await fetch(`${target.url}/blobs/${digest}`, { method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }, body: bytes });
    await expectPersisted(blob, 'blob');
    await post(session, 'session.start', { agent: 'claude-code', startedAt: stamp - 120_000 });
    await post(session, 'transcript.segment', { transcriptId: `tx_${'c'.repeat(32)}`, baseOffset: 0, length: bytes.byteLength, blob: digest, agent: 'claude-code', headHash: 'c'.repeat(64) });
    await post(session, 'session.end', { endedAt: stamp - 60_000 });
    expect(await target.sql(`SELECT titling_requested_at AS requested, titled_at AS titled, title FROM sessions WHERE session_id = ${lit(session)}`)).toEqual([{ requested: null, titled: null, title: null }]);

    // Off by default: the wake parses the import and dispatches nothing.
    expect(await owner('GET', '/api/titling-backfill')).toMatchObject({ scheduledTasksEnabled: true, backfillEnabled: false, enabled: false });
    await owner('POST', '/api/wake');
    expect(await target.sql(`SELECT parsed_offset = size AS parsed FROM transcripts WHERE session_id = ${lit(session)}`)).toEqual([{ parsed: 1 }]);
    expect(await backfillRuns()).toEqual([]);
    expect((await owner('GET', '/api/titling-backfill')).remaining).toBeGreaterThanOrEqual(1);

    // Started: one wake claims the imported session as the backfill; the next finds it attempted.
    expect(await owner('PUT', '/api/titling-backfill', { enabled: true })).toMatchObject({ enabled: true, backfillEnabled: true });
    await owner('POST', '/api/wake');
    const runs = await backfillRuns() as Array<{ status: string; sessionId: string; mode: string }>;
    expect(runs.filter((r) => r.sessionId === session)).toEqual([{ status: 'queued', sessionId: session, mode: 'claim' }]);
    expect(await target.sql(`SELECT title, titled_at IS NOT NULL AS attempted FROM sessions WHERE session_id = ${lit(session)}`)).toEqual([{ title: null, attempted: 1 }]);
    expect(await owner('GET', '/api/titling-backfill')).toMatchObject({ enabled: true, inFlight: runs.length, usedToday: runs.length });

    // Stopped: a further wake dispatches nothing, and the run already queued stands.
    expect(await owner('PUT', '/api/titling-backfill', { enabled: false })).toMatchObject({ enabled: false });
    await owner('POST', '/api/wake');
    expect((await backfillRuns()).length).toBe(runs.length);
    await target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.scheduled_tasks_enabled', 'false', ${stamp}, ${lit(MEMBER_ID)})`);
  },
};
