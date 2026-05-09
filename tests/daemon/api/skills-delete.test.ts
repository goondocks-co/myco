import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import { initTeamContext, resetTeamContext } from '@myco/daemon/team-context.js';
import { handleDeleteSkillRecord } from '@myco/daemon/api/skills.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';
import type { GroveProjectId } from '@myco/grove/ids.js';

const PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as GroveProjectId;

const REQUEST_CONTEXT: MycoRequestContext = {
  projectRoot: '/workspace/project-a',
  projectId: PROJECT_ID,
  groveId: 'grove-a',
  machineId: 'machine-a',
  sessionId: null,
  projectVaultDir: '/workspace/project-a/.myco',
  databasePath: '/tmp/grove-a/myco.db',
  source: 'headers',
};

describe('skill record API deletion', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: 'agent-test', name: 'Agent Test', created_at: 10 });
  });
  afterEach(() => { resetTeamContext(); });

  it('includes project_id in team-sync delete tombstones', async () => {
    insertSkillRecord({
      id: 'skill-scoped',
      project_id: PROJECT_ID,
      agent_id: 'agent-test',
      name: 'scoped-skill',
      display_name: 'Scoped Skill',
      description: 'Project-scoped skill',
      path: '.agents/skills/scoped-skill/SKILL.md',
      created_at: 10,
      updated_at: 10,
    });
    initTeamContext(true, 'machine-a');

    const response = await handleDeleteSkillRecord({
      params: { id: 'skill-scoped' },
      requestContext: REQUEST_CONTEXT,
    } as never);

    expect(response.status ?? 200).toBe(200);
    const row = getDatabase().prepare(
      "SELECT payload FROM team_outbox WHERE table_name = 'skill_records' AND row_id = ? AND operation = 'delete'",
    ).get('skill-scoped') as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({
      id: 'skill-scoped',
      project_id: PROJECT_ID,
      name: 'scoped-skill',
    });
  });
});
