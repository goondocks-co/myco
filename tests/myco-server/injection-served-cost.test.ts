/**
 * What a session has been served costs the same however long the session, on D1 with and without planner statistics:
 * the prompt's check of its candidates, and the receipt that records what it served.
 */
import { expect, it } from 'bun:test';
import { servedAmong } from '@myco-server-worker/db/context/served-items.js';
import { commitServedReceipt } from '@myco-server-worker/db/context/served-receipt.js';
import { contextAdmission } from '@myco-server-worker/db/context-records.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';

const PROJECT = 'served-cost';
const RECEIVER = 'receiver';

it('a prompt\'s served check and its receipt cost the same at 300 and 3,000 receipts in its session', async () => {
  const candidates = [...Array.from({ length: 40 }, (_, i) => ['spore', `spore-${i * 37}`] as const), ['plan', 'plan-11'] as const, ['plan', 'plan-new'] as const];
  const costs = await d1TwoScale({
    sizes: [300, 3_000],
    statistics: ['none', 'analyzed', 'stale'],
    setup: async (db) => {
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES(?,'Served',1)").bind(PROJECT).run();
      for (const id of [RECEIVER, 'other']) {
        await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
          VALUES(?,?,'machine','fixture',1,1)`).bind(PROJECT, id).run();
      }
    },
    // Each unit is one receipt of the session that served five spores and a plan; inserting it records what it served.
    grow: async (db, from, to) => {
      await eachUnit(db, from, to, `INSERT INTO spore_injections(project_id,session_id,id,prompt_id,prompt_hash,spore_ids,plan_ids,created_at)
        SELECT ?3,?4,printf('00000000-0000-4000-8000-%012d',i),'prompt-'||i,'hash-'||i,
          json_array('spore-'||(i*5),'spore-'||(i*5+1),'spore-'||(i*5+2),'spore-'||(i*5+3),'spore-'||(i*5+4)),json_array('plan-'||i),i FROM n`, PROJECT, RECEIVER);
    },
    cases: [
      { name: 'served check', run: async (db) => {
        const served = await servedAmong(db, { project: PROJECT, session: RECEIVER, candidates });
        expect([served.spores.size, served.plans.has('plan-11'), served.plans.has('plan-new')]).toEqual([40, true, false]);
      } },
      { name: 'receipt', run: async (db, { scale }) => {
        const id = crypto.randomUUID();
        expect(await commitServedReceipt(db, { project: PROJECT, session: RECEIVER, id, promptId: `new-${scale}`, scopeReason: null, protocol: 'legacy',
          askedAt: null, promptHash: `new-hash-${scale}`, spores: [`fresh-${scale}`], now: 10,
          plans: [{ planKey: `plan-fresh-${scale}`, title: 'Fresh', sessionId: 'other', contentHash: 'h' }] }, contextAdmission(PROJECT, RECEIVER, 'machine'))).toBe(true);
        const served = await servedAmong(db, { project: PROJECT, session: RECEIVER, candidates: [['spore', `fresh-${scale}`], ['plan', `plan-fresh-${scale}`]] });
        expect([[...served.spores], [...served.plans]]).toEqual([[`fresh-${scale}`], [`plan-fresh-${scale}`]]);
      } },
    ],
  });
  expectTwoScale(costs);
}, 180_000);
