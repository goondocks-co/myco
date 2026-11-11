import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { planEventWrite } from '@myco-server-worker/ingest/events.js';
import { commit } from '@myco-server-worker/db/index.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from './helpers/member-token.js';
import { uuid } from './helpers/fixtures.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';

const NOW = 1_800_000_000_000;

it('a response names its prompt\'s owner at the same D1 cost as a Project\'s sessions, prompts and runs grow', async () => {
  let token = '';
  expectTwoScale(await d1TwoScale({
    sizes: [500, 5_000],
    setup: async (db: RelationalStore) => {
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('project','Project',1)").run();
      await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','Agent','built-in',1,1)").run();
      await ensureMember(db, 'member', NOW, 'admin');
      token = (await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, NOW)).tokenId;
    },
    grow: async (db, from, to) => {
      await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,summary)
        SELECT 'project',printf('session-%05d',i),'machine',?3,1,1,'A useful summary' FROM n`, token);
      await eachUnit(db, from, to, `INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,ord,created_at)
        SELECT 'project',printf('session-%05d',i),1,printf('00000000-0000-7000-8000-%012d',i),1,1 FROM n`);
      await eachUnit(db, from, to, `INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin,started_at,queued_at)
        SELECT 'project','done-'||i,'agent','title-summary','completed','automatic',1,1 FROM n`);
    },
    cases: [{
      name: 'response admission',
      // A later response reads a few more of the rows earlier ones added, the same at 5,000 sessions as at 40,000.
      extra: 16,
      run: async (db, { scale }) => {
        // Each run answers a prompt of a session it holds: the first credential admission is the warm-up's.
        const prompt = scale === -1 ? 0 : scale === 0 ? 499 : 4_999;
        const planned = await planEventWrite(db, { projectId: 'project', machineId: 'machine', tokenId: token, bodyBytes: 1, now: NOW }, {
          eventId: uuid(90 + scale), sessionId: `session-${String(prompt).padStart(5, '0')}`, kind: 'response', createdAt: NOW, channel: 'cli',
          producer: { adapter: 'fixture', version: '1' }, payload: { promptId: uuid(prompt), responseId: uuid(95 + scale), text: 'Fixed' },
        });
        if (!planned.ok) throw new Error(JSON.stringify(planned));
        expect(planned.write.interpret(await commit(db, ...planned.write.statements))).toMatchObject({ persisted: true });
      },
    }],
    warm: true,
  }));
}, 180_000);
