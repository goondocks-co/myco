import { expect } from 'bun:test';
import { uuidv5 } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * A record's embedding revision on both targets follows the values its vector
 * is built from (#1430): a replayed `session.start`, an identical plan event,
 * and a release state recorded again under the same state and
 * confidence keep every revision; a changed plan and a changed release state
 * move only the record they name.
 */
export const embeddingRevisions: ParityScenario = {
  name: 'embedding revisions: a replayed start, an unchanged plan and an unchanged release state keep the revision; a changed value moves only its record',
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const session = `parity-revisions-${stamp}`;
    const post = async (kind: string, payload: Record<string, unknown>, createdAt: number) => {
      const res = await fetch(`${target.url}/events`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind, createdAt, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      });
      await expectPersisted(res, kind);
    };
    const revision = async (type: string, recordId: string) => (await target.sql(`SELECT revision FROM embedding_versions
      WHERE project_id = ${lit(target.projectId)} AND type = ${lit(type)} AND record_id = ${lit(recordId)}`))[0]?.revision as string | undefined;
    const release = (state: string, checkedAt: number, fingerprint: string) => target.sql(`INSERT INTO knowledge_release_state
        (project_id, id, identity_key, namespace, record_id, source_session_id, state, confidence, basis_kind, reason, evidence_json, checked_at, created_at)
      VALUES (${lit(target.projectId)}, ${lit(`rs_${stamp}`)}, ${lit(`${target.projectId}:sessions:${session}`)}, 'sessions', ${lit(session)}, ${lit(session)},
        ${lit(state)}, 'medium', 'integration_ref', ${lit(`checked at ${checkedAt}`)}, ${lit(JSON.stringify({ source: 'session_end:b:0', refs_fingerprint: fingerprint }))}, ${checkedAt}, ${checkedAt})
      ON CONFLICT(project_id, identity_key) DO UPDATE SET state = excluded.state, confidence = excluded.confidence, reason = excluded.reason,
        evidence_json = excluded.evidence_json, checked_at = excluded.checked_at, updated_at = excluded.checked_at`);

    await post('session.start', { agent: 'claude-code', branch: 'revisions', startedAt: stamp }, stamp);
    await post('prompt', { promptId: crypto.randomUUID(), text: `Embed once ${stamp}`, origin: 'user' }, stamp + 1);
    await target.sql(`UPDATE sessions SET title = 'Parity revisions', summary = 'A summarized session' WHERE session_id = ${lit(session)}`);
    const summarized = await revision('session', session);
    expect(summarized).toBeDefined();

    // A later start of the same session changes no fact the session holds.
    await post('session.start', { agent: 'claude-code', branch: 'revisions', startedAt: stamp + 100 }, stamp + 100);
    expect(await revision('session', session)).toBe(summarized);

    const path = `docs/plans/parity-revisions-${stamp}.md`;
    const key = await uuidv5('plan', target.projectId, path);
    await post('plan', { planKey: key, title: 'Parity', content: '- [ ] one', originPath: path, status: 'active' }, stamp + 10);
    const planned = await revision('plan', key);
    expect(planned).toBeDefined();
    // The same content again: the row holds what it held.
    await post('plan', { planKey: key, title: 'Parity', content: '- [ ] one', originPath: path }, stamp + 20);
    expect(await revision('plan', key)).toBe(planned);

    // A first release state is new metadata for the session's vector.
    await release('merged_unreleased', stamp + 200, 'refs-1');
    const classified = await revision('session', session);
    expect(classified).not.toBe(summarized);
    // A check that records moved refs under the same state and confidence keeps the vector.
    await release('merged_unreleased', stamp + 300, 'refs-2');
    expect(await revision('session', session)).toBe(classified);
    // A new state moves the session alone.
    await release('released', stamp + 400, 'refs-3');
    const released = await revision('session', session);
    expect(released).not.toBe(classified);
    expect(await revision('plan', key)).toBe(planned);

    // New plan content moves the plan alone.
    await post('plan', { planKey: key, title: 'Parity', content: '- [x] one', originPath: path }, stamp + 30);
    expect(await revision('plan', key)).not.toBe(planned);
    expect(await revision('session', session)).toBe(released);
  },
};
