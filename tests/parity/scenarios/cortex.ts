import { expect } from 'bun:test';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { type ParityScenario, type ParityTarget } from '../harness.ts';
import { allowWorkerClaims, claimRun, endRun, event, owner, putCapability, putSetting, resetSetting, wake } from '../clients/requests.ts';

const MAP_INSTRUCTION = "Keep this project's repository map";

export const cortex: ParityScenario = {
  name: 'an outcome run: the ask queues a run carrying its prompt and hash, the wake leaves it for a worker, and session start serves the Project and its instructions',
  // Completing another scenario's queued runs has no client path. This Deployment holds only the runs this scenario asks for.
  dedicated: { timeoutMs: 180_000 },
  async run(target: ParityTarget) {
    const post = (sessionId: string, kind: string, payload: Record<string, unknown>) => event(target, sessionId, kind, payload);
    const ask = async (instruction: string) => {
      const res = await owner<{ queued: boolean; runId?: string; heldBy?: string }>(target, '/api/harness/dispatch', { method: 'POST', body: JSON.stringify({ projectId: target.projectId, task: MAP_TASK, instruction, harness: 'claude-code' }) });
      expect(res.status).toBe(200);
      return res.body;
    };
    const runOf = async (runId: string) => {
      const read = await owner<{ run: { status: string; heldBy: string | null; dryRun: boolean; instruction: string | null } }>(target, `/api/projects/${target.projectId}/runs/${runId}`);
      expect(read.status).toBe(200);
      return read.body.run;
    };

    const stamp = Date.now();
    const session = `parity-cortex-${stamp}`;
    await allowWorkerClaims(target);
    for (const capability of ['canopy', 'cortex']) {
      const saved = await putCapability(target, capability, true);
      expect({ capability, status: saved.status, body: saved.body }).toMatchObject({ status: 200 });
    }
    const repository = await owner(target, `/api/projects/${target.projectId}/repository`, {
      method: 'PUT', body: JSON.stringify({ url: 'https://example.test/parity-cortex.git', branch: 'main', revision: null }),
    });
    expect(repository.status).toBe(200);
    const first = await ask('Map the repository.');
    expect(first.queued).toBe(true);
    expect(first.runId).toBeDefined();
    expect(await runOf(first.runId!)).toMatchObject({ status: 'queued', heldBy: 'worker', dryRun: false });
    expect((await runOf(first.runId!)).instruction).toContain(MAP_INSTRUCTION);
    const finished = await claimRun(target);
    expect(finished.run?.id).toBe(first.runId);
    expect(await endRun(target, finished.run!)).toMatchObject({ ended: true });

    const limited = await putSetting(target, 'agent.limits.concurrent_runs', 1);
    expect(limited.status).toBe(200);
    try {
      const blocker = await ask('Hold the slot.');
      expect(blocker.queued).toBe(true);
      const held = await claimRun(target);
      expect(held.run?.id).toBe(blocker.runId);
      const second = await ask('Wait for the slot.');
      expect(second).toMatchObject({ queued: true, heldBy: 'concurrent_runs' });
      expect((await runOf(second.runId!)).instruction).toContain(MAP_INSTRUCTION);
      expect(await endRun(target, held.run!)).toMatchObject({ ended: true });
      await wake(target);
      const next = await claimRun(target); expect({ claimed: next.claimed, id: next.run?.id }).toEqual({ claimed: true, id: second.runId }); // The freed slot goes to the waiting run.
      expect(await endRun(target, next.run!)).toMatchObject({ ended: true });
    } finally {
      expect((await resetSetting(target, 'agent.limits.concurrent_runs')).status).toBe(200);
    }

    await post(session, 'session.start', { agent: 'claude-code', startedAt: stamp });
    const guidance = `Keep the plan for ${stamp} current.`;
    const template = await putSetting(target, 'instructions.template', `  ${guidance}  `);
    expect(template.status).toBe(200);
    try {
      const res = await fetch(`${target.url}/context/session`, { method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session, kind: 'start' }) });
      expect(res.status).toBe(200);
      const body = await res.json() as { persisted: boolean; context: string };
      expect([body.persisted, body.context.startsWith('Project:: '), body.context.includes(target.projectId), body.context.endsWith(guidance)]).toEqual([true, true, true, true]);
    } finally {
      expect((await resetSetting(target, 'instructions.template')).status).toBe(200);
    }
  },
};
