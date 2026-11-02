import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';

it('captures a spilled pasted plan through a turn-key prompt hook', () => {
  const result = spawnSync(process.execPath, ['--no-env-file', '-e', `
    import { main } from './packages/myco/src/hooks/user-prompt-submit.ts';
    import { setBufferedStdin } from './packages/myco/src/hooks/read-stdin.ts';
    import { MemberSpool } from '@myco/member/spool.ts';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    process.env.MYCO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pasted-plan-'));
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'http://127.0.0.1:1' });
    const { cacheDeploymentFeatures } = await import('@myco/member/context-cache.ts');
    cacheDeploymentFeatures('http://127.0.0.1:1', ['turn','prompt-identity','prompt-scheme'], process.env.MYCO_HOME);
    process.argv = [process.execPath, 'myco', 'hook', 'user-prompt-submit', '--symbiont', 'codex'];
    const transcript = path.join(process.env.MYCO_HOME, 'transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'large-plan', source: 'cli' } }) + '\\n');
    const body = '# Large plan\\n' + 'x'.repeat(300000);
    setBufferedStdin(Buffer.from(JSON.stringify({ session_id: 'large-plan', transcript_path: transcript, turn_id: 'turn-1', prompt: 'Please implement this plan: <proposed_plan>' + body + '</proposed_plan>' })));
    await main({ credential: 'env', env: { ...process.env, MYCO_SERVER_URL: 'http://127.0.0.1:1', MYCO_PROJECT: 'proj_1', MYCO_MEMBER_TOKEN: 'a'.repeat(43) }, helperSpawn: () => ({ started: false }) });
    const rows = fs.readFileSync(spool.dir + '/large-plan.jsonl', 'utf8').trim().split('\\n').map(JSON.parse);
    const plan = rows.find(row => row.kind === 'plan');
    if (!plan?._blobSource || fs.readFileSync(plan._blobSource.path, 'utf8') !== body) throw new Error('missing durable plan: ');
    console.log('plan captured');
  `], { encoding: 'utf8', timeout: 6000, env: process.env });
  expect({ error: result.error?.message, status: result.status, stderr: result.stderr, stdout: result.stdout }).toEqual({
    error: undefined, status: 0, stderr: '', stdout: expect.stringContaining('plan captured\n'),
  });
}, 10000);

it('keeps pasted tag occurrences distinct and reuses their identities on replay', () => {
  const result = spawnSync(process.execPath, ['--no-env-file', '-e', `
    import { main } from './packages/myco/src/hooks/user-prompt-submit.ts';
    import { setBufferedStdin } from './packages/myco/src/hooks/read-stdin.ts';
    import { MemberSpool } from '@myco/member/spool.ts';
    import { cacheDeploymentFeatures } from '@myco/member/context-cache.ts';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    process.env.MYCO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-occurrences-'));
    const spool = new MemberSpool({ projectId: 'proj_1', serverUrl: 'http://127.0.0.1:1' });
    cacheDeploymentFeatures('http://127.0.0.1:1', ['prompt-identity','prompt-scheme'], process.env.MYCO_HOME);
    process.argv = [process.execPath, 'myco', 'hook', 'user-prompt-submit', '--symbiont', 'claude-code'];
    const transcript = path.join(process.env.MYCO_HOME, 'transcript.jsonl');
    fs.writeFileSync(transcript, '{}\\n');
    const invoke = async (key) => {
      setBufferedStdin(Buffer.from(JSON.stringify({ session_id: 'plans', transcript_path: transcript, prompt_id: key, prompt: 'Please implement <ultraplan># One</ultraplan><ultraplan># Two</ultraplan><ultraplan># One</ultraplan>' })));
      await main({ credential: 'env', env: { ...process.env, MYCO_SERVER_URL: 'http://127.0.0.1:1', MYCO_PROJECT: 'proj_1', MYCO_MEMBER_TOKEN: 'a'.repeat(43) } });
    };
    await invoke('11111111-1111-4111-8111-111111111111');
    await invoke('11111111-1111-4111-8111-111111111111');
    await invoke('22222222-2222-4222-8222-222222222222');
    const plans = fs.readFileSync(spool.dir + '/plans.jsonl', 'utf8').trim().split('\\n').map(JSON.parse).filter(row => row.kind === 'plan');
    if (plans.length !== 6 || new Set(plans.map(row => row.payload.planKey)).size !== 6) throw new Error('collided or dropped occurrences: ' + JSON.stringify(plans.map(row => row.payload.planKey)));
    console.log('occurrences captured');
  `], { encoding: 'utf8', timeout: 6000, env: process.env });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
});
