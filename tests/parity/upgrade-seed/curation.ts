import { expect } from 'bun:test';
import { putCapability } from '../clients/requests.ts';
import { type SeedTarget } from './requests.ts';
import { offerCurationGroup, curationMembers } from '../clients/curation.ts';
import { endRun, putSetting, runTool } from '../clients/requests.ts';
import { failRun, takeRun } from '../clients/runs.ts';

/** The owner enables curation, lets it rewrite one note it visits, then pauses it with its discovery checkpoint retained. */
export async function seedCuration(target: SeedTarget): Promise<void> {
  expect((await putSetting(target, 'agent.scheduled_tasks_enabled', false)).status).toBe(200);
  await offerCurationGroup(target);
  let reviewed = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const run = await takeRun(target);
    if (run.task !== 'curate-spores') { await failRun(target, run); continue; }
    const [rewritten, ...kept] = curationMembers(run).map(member => member.id);
    expect(await runTool(target, run, 'myco_run_curation', { op: 'answer', retire: [], keep: kept, reason: 'One note is rewritten; the rest stay distinct.',
      notes: [{ sources: [rewritten], observation_type: 'gotcha', agent_line: 'When the upgrade carries notes, keep their written date.', content: 'Rewritten by curation before the upgrade.' }] })).toMatchObject({ completed: true, applied: true });
    expect(await endRun(target, run)).toMatchObject({ ended: true, status: 'completed' });
    reviewed = true; break;
  }
  expect(reviewed).toBe(true);
  expect((await putCapability(target, 'spore_curation', false)).status).toBe(200);
}
