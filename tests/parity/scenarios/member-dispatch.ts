import { expect } from 'bun:test';
import { type ParityScenario, type ParityTarget } from '../harness.ts';
import { createProject, putCapability } from '../clients/requests.ts';
import { cancelRun, linkedMember, runList } from '../clients/runs.ts';

/** The GitHub account the scenario links to the member-role member it joins. */
const MEMBER_ROLE_SUB = '1518005';
const TASK = 'title-summary';

/**
 * A member who is not an admin starting a task by hand, on both targets (#1518 A10): it reads which tasks a Project
 * has turned on and may not change them; it starts runs, each recorded as its own, up to its daily ceiling, past which
 * the dispatch answers 429 with when the ceiling resets and writes no run; a fresh run is refused to it. An admin is
 * never capped, and a task a capability gates is refused to both where the Project has it off.
 */
export const memberDispatch: ParityScenario = {
  name: 'member dispatch: a member starts tasks up to its daily ceiling, reads capabilities, and is refused what an admin alone does',
  dedicated: { timeoutMs: 120_000 },
  async run(target: ParityTarget) {
    const admin = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    const joined = await linkedMember(target, MEMBER_ROLE_SUB);
    const member = joined.headers;
    const started: string[] = [];
    const dispatch = async (headers: Record<string, string>, body: Record<string, unknown>) => {
      const res = await fetch(`${target.url}/api/harness/dispatch`, { method: 'POST', headers, body: JSON.stringify({ task: TASK, projectId: target.projectId, ...body }) });
      const answer = await res.json() as Record<string, any>;
      if (typeof answer.runId === 'string') started.push(answer.runId);
      return { status: res.status, body: answer };
    };
    try {
      const capabilities = await fetch(`${target.url}/api/projects/${target.projectId}/capabilities`, { headers: member });
      expect(capabilities.status).toBe(200);
      const change = await fetch(`${target.url}/api/projects/${target.projectId}/capabilities/vault_evolution`, { method: 'PUT', headers: member, body: JSON.stringify({ enabled: true }) });
      expect({ status: change.status, body: await change.json() }).toMatchObject({ status: 403, body: { error: 'not_admin' } });

      expect(await dispatch(member, { fresh: true })).toEqual({ status: 403, body: { error: 'fresh_needs_admin' } });

      // Start runs until the ceiling answers; the ceiling is whatever this Deployment's settings make it.
      let refused: { status: number; body: Record<string, any> } | null = null;
      for (let i = 0; i < 20 && refused === null; i += 1) {
        const answer = await dispatch(member, {});
        if (answer.status === 429) refused = answer;
        else expect({ status: answer.status, queued: answer.body.queued }).toEqual({ status: 200, queued: true });
      }
      expect(refused).not.toBeNull();
      expect(refused!.body).toMatchObject({ error: 'daily_limit', task: TASK });
      expect(started.length).toBe(refused!.body.perDay);
      if (started.length > 0) expect(typeof refused!.body.resetsAt).toBe('number');
      const listed = await (await fetch(`${target.url}/api/projects/${target.projectId}/runs?task=${TASK}`, { headers: member })).json() as { rows: Array<{ id: string; startedBy: string | null }> };
      for (const id of started) expect(listed.rows.find((r) => r.id === id)?.startedBy).toBe(joined.memberId);

      // An admin is never capped.
      expect((await dispatch(admin, {})).status).toBe(200);

      // A task a capability gates is refused, to a member and an admin alike, where the Project has it off.
      const gated = `parity-member-gate-${Date.now()}`;
      expect((await createProject(target, gated, gated)).status).toBe(201);
      expect((await putCapability(target, 'vault_evolution', false, gated)).status).toBe(200);
      for (const headers of [member, admin]) {
        const res = await fetch(`${target.url}/api/harness/dispatch`, { method: 'POST', headers, body: JSON.stringify({ task: 'extract-curate', projectId: gated }) });
        expect({ status: res.status, body: await res.json() }).toMatchObject({ status: 409, body: { error: 'capability_off', capability: 'vault_evolution' } });
      }
      expect(await runList({ ...target, projectId: gated })).toEqual([]);
    } finally {
      for (const id of started) await cancelRun(target, id);
    }
  },
};
