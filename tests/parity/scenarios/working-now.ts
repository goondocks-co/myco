import { expect } from 'bun:test';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

/** A prompt id as the member mints one: a UUIDv7 whose timestamp is `at`. */
const promptIdAt = (at: number): string => {
  const hex = at.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-${crypto.randomUUID().slice(-12)}`;
};

/**
 * A session working now (#1531), on both targets: a prompt asking for context opens the session's turn past the
 * answer, an end older than the turn leaves it open, and the turn's own end closes it; the session list and the
 * detail read it as working while it is open.
 */
export const workingNow: ParityScenario = {
  name: 'working now: a prompt opens the turn past the answer, an older end leaves it open, its own end closes it',
  async run(target: ParityTarget) {
    const now = Date.now();
    const session = `parity-working-${now}`;
    const post = async (kind: string, createdAt: number, payload: Record<string, unknown>) => {
      const res = await fetch(`${target.url}/events`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind, createdAt, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      });
      await expectPersisted(res, kind);
    };
    const ask = async (promptId: string) => {
      const res = await fetch(`${target.url}/context/prompt`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: session, promptId, text: 'keep going' }),
      });
      expect(res.status).toBe(200);
    };
    const stamped = async (): Promise<number | null> => {
      const at = (await target.sql(`SELECT working_since AS at FROM sessions WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(session)}`))[0]?.at;
      return typeof at === 'number' ? at : null;
    };
    /** The stamp is written past the answer: wait for it to land, or for it not to. */
    const settled = async (expected: number | null) => {
      for (let tries = 0; tries < 50 && (await stamped()) !== expected; tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await stamped()).toBe(expected);
    };
    const detail = async () => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${session}`, { headers: target.ownerHeaders() });
      expect(res.status).toBe(200);
      return ((await res.json()) as { session: { working: boolean; workingSince: number | null } }).session;
    };

    const promptId = crypto.randomUUID();
    await post('session.start', now - 120_000, { agent: 'claude-code', startedAt: now - 120_000 });
    await post('prompt', now - 110_000, { promptId, text: 'hi', origin: 'user' });
    const first = now - 60_000;
    await ask(promptIdAt(first));
    await settled(first);
    expect(await detail()).toMatchObject({ working: true, workingSince: first });
    const listed = await fetch(`${target.url}/api/sessions?window=activity&since=${now - 15 * 60_000}&state=open`, { headers: target.ownerHeaders() });
    expect(((await listed.json()) as { rows: Array<{ sessionId: string; working: boolean }> }).rows.find((row) => row.sessionId === session)?.working).toBe(true);

    // An end made before the turn started, drained late, leaves it open; the turn's own end closes it.
    await post('response', first - 5_000, { responseId: crypto.randomUUID(), promptId, text: 'late' });
    expect(await stamped()).toBe(first);
    await post('response', first + 5_000, { responseId: crypto.randomUUID(), promptId, text: 'done' });
    expect(await stamped()).toBe(null);
    expect(await detail()).toMatchObject({ working: false, workingSince: null });
  },
};
