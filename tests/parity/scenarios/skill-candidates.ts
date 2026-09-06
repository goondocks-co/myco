import { expect } from 'bun:test';
import { lit, MEMBER_ID, type ParityScenario } from '../harness.ts';

export const skillCandidates: ParityScenario = {
  name: 'skills: member review preserves approval attribution and refuses stale revisions',
  async run(target) {
    const id = `candidate_review_${Date.now()}`;
    const path = `/api/projects/${target.projectId}/skill-candidates`;
    await target.sql(`INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES (${lit(target.projectId)},'Skills parity',1)`);
    await target.sql(`INSERT INTO skill_candidates(project_id,id,agent_id,topic,rationale,confidence,created_at,updated_at)
      VALUES (${lit(target.projectId)},${lit(id)},'user','Diagnose capture','Repeated evidence',0.8,1,1)`);
    const ask = async (suffix: string, body?: unknown) => {
      const response = await fetch(target.url + path + suffix, { method: body === undefined ? 'GET' : 'PATCH',
        headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const listed = await ask('?status=identified');
    expect(listed.status).toBe(200);
    expect(listed.body.candidates).toContainEqual(expect.objectContaining({ id, revision: 0, approvedAt: null }));
    const approved = await ask(`/${id}`, { revision: 0, status: 'approved' });
    expect(approved.status).toBe(200);
    expect(approved.body.candidate).toMatchObject({ revision: 1, status: 'approved', approvedBy: MEMBER_ID, reviewedBy: MEMBER_ID });
    const firstApproval = approved.body.candidate.approvedAt;
    const stale = await ask(`/${id}`, { revision: 0, status: 'dismissed' });
    expect(stale.status).toBe(409);
    expect(stale.body.candidate.status).toBe('approved');
    expect((await ask(`/${id}`, { revision: 1, status: 'dismissed' })).status).toBe(200);
    const reapproved = await ask(`/${id}`, { revision: 2, status: 'approved' });
    expect(reapproved.status).toBe(200);
    expect(reapproved.body.candidate.approvedAt).toBe(firstApproval);
    expect(reapproved.body.candidate.approvedBy).toBe(MEMBER_ID);
    expect((await ask(`/${id}`, { revision: 3, status: 'generated' })).status).toBe(400);
    expect((await ask('/absent', { revision: 0, status: 'approved' })).status).toBe(404);
  },
};
