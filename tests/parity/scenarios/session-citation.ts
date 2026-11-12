import { expect } from 'bun:test';
import { expectRunRefusal } from '../../helpers/run-refusal.ts';
import type { ParityScenario } from '../harness.ts';
import { cardSession, learningSettings } from '../clients/capture.ts';
import { captureSession, failRun, takeRun } from '../clients/runs.ts';
import { owner, runTool } from '../clients/requests.ts';

/** Only source material served to a claimed run authorizes its session citations. */
export const sessionCitation: ParityScenario = {
  name: 'session citation: served learning material admits extraction writes and tombstones revoke citation',
  dedicated: { timeoutMs: 180_000 },
  async run(target) {
    await learningSettings(target);
    const session = 'citation-session';
    await captureSession(target, session, 'A whole-session finding', { ended: true, at: Date.now() - 3_600_000 });
    await cardSession(target, session, 'A whole-session finding');
    const run = await takeRun(target);
    expect(run.task).toBe('extract-curate');
    const save = { op: 'save', type: 'gotcha', content: 'A whole-session finding', agent_line: 'When citing a finding, retain its source session.', session_id: session };
    const call = (name: string, args: Record<string, unknown>) => runTool<any>(target, run, name, args);
    expectRunRefusal(await call('myco_spores', save), 'material page 1 has not been read', { tool: 'myco_run_learning', op: 'material', page: 1 });
    await call('myco_run_learning', { op: 'material' });
    const saved = await call('myco_spores', save);
    expect(saved.id).toEqual(expect.any(String));
    const read = await call('myco_run_spores', { op: 'get', id: saved.id });
    expect(read.spore.session_id).toBe(session);
    const consolidation = { op: 'consolidate', source_spore_ids: [saved.id], consolidated_content: 'Session wisdom', observation_type: 'wisdom', agent_line: 'When citing wisdom, retain its source session.', session_id: session };
    expectRunRefusal(await call('myco_spores', consolidation), ['source_spore_ids[0]', 'is missing revision'], { tool: 'myco_spores', op: 'consolidate' });
    const merged = await call('myco_spores', { ...consolidation, source_spore_ids: [{ id: saved.id, revision: read.spore.revision }] });
    expect(merged.new_spore_id).toEqual(expect.any(String));
    expect((await call('myco_run_spores', { op: 'get', id: merged.new_spore_id })).spore.session_id).toBe(session);
    expectRunRefusal(await call('myco_spores', { ...save, session_id: 'unserved-session' }), 'session_id not served to this run', { tool: 'myco_run_learning', op: 'material', page: 1 });
    expectRunRefusal(await call('myco_spores', { ...save, session_id: undefined }), 'session_id is missing', { tool: 'myco_run_learning', op: 'material', page: 1 });
    expect((await owner(target, `/api/projects/${target.projectId}/sessions/${session}/tombstone`, { method: 'POST', body: '{}' })).status).toBe(202);
    expectRunRefusal(await call('myco_spores', save), 'session_id not served to this run', { tool: 'myco_run_learning', op: 'material', page: 1 });
    expect(await failRun(target, run)).toMatchObject({ ended: true });
  },
};
