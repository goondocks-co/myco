import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processedBody } from '@myco-server-worker/read/processed.js';
import { publishFixture } from '../myco-server/helpers/fixtures.js';
import { memberRig, tempMycoHome } from './helpers/server.js';
import { registerTestMember, runHook } from './helpers/hooks.js';

it('stages a spilled body inside the session capture transaction', () => {
  const result = spawnSync(process.execPath, ['--no-env-file', '-e', `
    import { MemberSpool } from '@myco/member/spool.ts';
    import { planEvent } from '@myco/member/envelope.ts';
    import fs from 'node:fs';
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'http://127.0.0.1:1' });
    const body = '# Large plan\\n' + 'x'.repeat(300000);
    const ctx = { agent: 'codex', sessionId: 'large-plan', stage: spool.stagerFor('large-plan'), now: Date.now };
    spool.appendAndRecord('large-plan', () => [planEvent(ctx, { planKey: 'plan-1', content: body })]);
    const plan = spool.readRecords('large-plan').find(row => row?.kind === 'plan');
    if (!plan?._blobSource || fs.readFileSync(plan._blobSource.path, 'utf8') !== body) throw new Error('missing durable body');
  `], { encoding: 'utf8', timeout: 6000, env: process.env });
  expect({ error: result.error?.message, status: result.status, stderr: result.stderr }).toEqual({ error: undefined, status: 0, stderr: '' });
}, 10000);

for (const symbiont of ['claude-code', 'codex']) it(`${symbiont}: source submissions own pasted plans across hook replay and absent hook keys`, async () => {
  const saved = process.env.MYCO_HOME;
  const mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  const rig = await memberRig();
  try {
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pasted-source-'));
    const tx = path.join(dir, 'source.jsonl');
    const session = 'pasted-source';
    const codex = symbiont === 'codex';
    const body = `Please implement <${codex ? 'proposed_plan' : 'ultraplan'}># One</${codex ? 'proposed_plan' : 'ultraplan'}><${codex ? 'proposed_plan' : 'ultraplan'}># Two${'x'.repeat(300000)}</${codex ? 'proposed_plan' : 'ultraplan'}><${codex ? 'proposed_plan' : 'ultraplan'}># One</${codex ? 'proposed_plan' : 'ultraplan'}>`;
    const records = codex ? [
      { type: 'session_meta', payload: { id: session, source: 'cli', cwd: process.cwd() } },
      { type: 'turn_context', payload: { turn_id: 'turn-1' } },
    ] : [];
    fs.writeFileSync(tx, records.map(row => JSON.stringify(row)).join('\n') + '\n');
    const options = { symbiont, fetch: rig.fetch, helpers: 'run' as const };
    const common = { session_id: session, transcript_path: tx, cwd: process.cwd() };
    await runHook('session-start', { ...common, hook_event_name: 'SessionStart' }, options);
    for (let index = 0; index < 2; index++) {
      const hook = { ...common, turn_id: codex ? 'turn-1' : undefined, prompt: body };
      await runHook('user-prompt-submit', hook, options);
      await runHook('user-prompt-submit', hook, options);
      const row = codex
        ? { type: 'response_item', metadata: { user_input_order: index }, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] } }
        : { type: 'user', uuid: `record-${index}`, promptId: `prompt-${index}`, message: { role: 'user', content: [{ type: 'text', text: body }] } };
      fs.appendFileSync(tx, JSON.stringify(row) + '\n');
    }
    const stop = async () => {
      await runHook('stop', { ...common, hook_event_name: 'Stop', last_assistant_message: '' }, options);
      await publishFixture(rig.env);
    };
    await stop();
    const plans = rig.env.sqlite.query('SELECT plan_key, content FROM plans ORDER BY plan_key').all() as Array<{ plan_key: string; content: string }>;
    expect(plans).toHaveLength(6);
    const bodies = await Promise.all(plans.map(plan => processedBody(rig.env.serverEnv, { projectId: 'proj_1' }, 'plan', plan.plan_key)));
    expect(bodies.filter(body => body === '# Two' + 'x'.repeat(300000))).toHaveLength(2);
    expect(new Set(plans.map(plan => plan.plan_key)).size).toBe(6);
    await stop();
    expect(rig.env.sqlite.query('SELECT plan_key, content FROM plans ORDER BY plan_key').all()).toEqual(plans);
  } finally { process.env.MYCO_HOME = saved; }
});
