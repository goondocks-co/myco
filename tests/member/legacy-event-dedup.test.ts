import { expect, it } from 'bun:test';
import path from 'node:path';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { legacySpoolDir, migrateLegacySpool } from '@myco/member/spool-migration.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient } from '@myco/member/transport.js';
import { unboundedBudget } from '@myco/member/budget.js';
import { registerTestMember } from './helpers/hooks.js';
import { memberRig, tempMycoHome } from './helpers/server.js';

it('the Deployment deduplicates an event delivered from both migrated and old journals', async () => {
  const mycoHome = tempMycoHome();
  const rig = await memberRig();
  const entry = registerTestMember({ mycoHome, root: path.join(mycoHome, 'repo'), serverUrl: 'https://s', projectId: 'proj_1', token: rig.token });
  const source = new MemberSpool(null, { mycoHome, dir: legacySpoolDir(entry.projectId, mycoHome) });
  const event = promptEvent({ agent: 'claude-code', sessionId: 'same-session', stage: source.stagerFor('same-session') }, { promptId: mintId(), text: 'one durable event' });
  source.append('same-session', event);
  expect(migrateLegacySpool(entry, mycoHome)).toMatchObject({ status: 'migrated', copied: 1 });
  const target = new MemberSpool(entry, { mycoHome });
  const client = new ServerClient(entry, rig.fetch);
  expect(await target.drainSession('same-session', client, unboundedBudget())).toMatchObject({ acked: 1, remaining: 0 });
  const replay = await rig.postEvent(event.envelope);
  expect(replay.duplicate).toBe(true);
  expect(rig.rows('events')).toBe(1);
  expect(rig.rows('prompt_batches')).toBe(1);
});
