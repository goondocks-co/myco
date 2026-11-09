import fs from 'node:fs';
import { declaredScheme } from '@myco-server-worker/ingest/prompt-scheme.js';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'bun:test';
import { snippetModule } from '../support/plugin-snippet.js';
import { issueMemberToken } from '../myco-server/helpers/member-token.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { readFixtureRecords, sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { registerBlob } from '../myco-server/helpers/d1.js';

const ROUTING_KEY = '0123456789abcdef/project';
const NOW = Date.parse('2026-10-04T12:00:00Z');

function rig(agent: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plugin-recovery-'));
  const env = { HOME: home, MYCO_HOME: path.join(home, '.myco') };
  let now = NOW;
  let elapsed = 0;
  const notes: string[] = [];
  const load = () => snippetModule(env, [], notes, undefined, ROUTING_KEY, () => now, fs, () => elapsed);
  const first = load();
  const claim = path.join(env.MYCO_HOME, 'member', 'claims', ROUTING_KEY, `${agent}-resumed.lock`);
  const transcript = first.transcriptPathFor('/repo', agent, 'resumed');
  return { home, env, first, load, claim, transcript, notes, setWall: (ms: number) => { now = ms; }, advance: (ms: number) => { now += ms; elapsed += ms; } };
}

async function parse(text: string, agent: string, options: { endedAt?: number; sessionId?: string } = {}) {
  const { sqlite, serverEnv } = sqliteEnv();
  const sessionId = options.sessionId ?? 'resumed';
  const { tokenId } = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
  const bytes = new TextEncoder().encode(text);
  const key = await sha256HexOf(bytes);
  const objectKey = registerBlob(sqlite, { projectId: 'proj_1', key, size: bytes.length, tokenId, receivedAt: NOW });
  await serverEnv.blobs.put(objectKey, new Blob([bytes]).stream());
  sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
    VALUES ('proj_1', ?, 'machine_1', ?, ?, ?)`, [sessionId, tokenId, NOW, NOW]);
  sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id, prompt_identity_scheme)
    VALUES ('proj_1', 'tx_recovery', ?, 'machine_1', ?, ?, 1, ?, ?, ?, ?)`, [sessionId, agent, bytes.length, NOW, NOW, tokenId, declaredScheme(agent)]);
  sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
    VALUES ('proj_1', 'tx_recovery', 0, ?, ?, 'segment', ?, ?, ?)`, [bytes.length, key, NOW, NOW, tokenId]);
  if (options.endedAt !== undefined) sqlite.run("UPDATE sessions SET ended_at=? WHERE session_id=?", [options.endedAt, sessionId]);
  const target = { recordScheme: 'legacy-session-v1' as const,
    projectId: 'proj_1', transcriptId: 'tx_recovery', sessionId, machineId: 'machine_1',
    tokenId, agent, size: bytes.length, parsedOffset: 0, fidelity: null, openPromptId: null, promptIdentityStale: false, scheme: declaredScheme(agent), imported: false,
  };
  const diagnostics: unknown[] = [];
  const log = console.log;
  let report;
  try {
    console.log = (line: string) => { diagnostics.push(JSON.parse(line)); };
    report = await publishDocuments(serverEnv,NOW,{ calls: 30, deadline: Infinity, clock: () => NOW, completeFile: true });
  } finally { console.log = log; }
  const records = await readFixtureRecords(serverEnv,'proj_1',sessionId);
  const prompts = records.filter(row=>row.k==='prompt').map(row=>({text:row.text}));
  const state = sqlite.query('SELECT published_offset AS parsed_offset, failure AS parse_error FROM transcript_publication').get();
  // A retry with the committed cursor must derive nothing twice.
  await publishDocuments(serverEnv,NOW,{ calls: 30, deadline: Infinity, clock: () => NOW, completeFile: true });
  expect((await readFixtureRecords(serverEnv,'proj_1',sessionId)).filter(row=>row.k==='prompt').map(row=>({text:row.text}))).toEqual(prompts);
  const document = sqlite.query("SELECT prompts,user_prompts,replies,tool_calls,first_prompt FROM session_documents WHERE session_id=?").get(sessionId);
  const session = sqlite.query("SELECT ended_at FROM sessions WHERE session_id=?").get(sessionId);
  sqlite.close();
  return { report, prompts, state, diagnostics, records, document, session };
}

describe('plugin capture recovery', () => {
  it('retries exact-token cleanup after a temporary gate removal failure', () => {
    const r = rig('opencode');
    let failCleanup = false;
    const subject = snippetModule(r.env, [], [], undefined, ROUTING_KEY, () => NOW, {
      ...fs,
      unlinkSync(file) {
        if (failCleanup && String(file).includes('.lock.operation/owner-')) {
          failCleanup = false;
          throw Object.assign(new Error('temporary cleanup denial'), { code: 'EACCES' });
        }
        fs.unlinkSync(file);
      },
    });
    expect(subject.holdsSessionClaim('/repo', 'opencode', 'resumed')).toBe(true);
    failCleanup = true;
    subject.appendTranscriptLine('/repo', 'opencode', 'resumed', { type: 'prompt', text: 'one' });
    subject.appendTranscriptLine('/repo', 'opencode', 'resumed', { type: 'prompt', text: 'two' });
    expect(fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line).text)).toEqual(['one', 'two']);
    expect(fs.existsSync(`${r.claim}.operation`)).toBe(false);
  });

  for (const agent of ['opencode', 'cline']) {
    it(`${agent}: a blocked release keeps cleanup ownership until release succeeds`, () => {
      const r = rig(agent);
      expect(r.first.holdsSessionClaim('/repo', agent, 'resumed')).toBe(true);
      const other = r.load();
      other.withClaimGate(r.claim, undefined, () => {
        r.first.releaseSessionClaim('/repo', agent, 'resumed');
        expect(fs.existsSync(r.claim)).toBe(true);
      });
      r.first.releaseSessionClaim('/repo', agent, 'resumed');
      expect(fs.existsSync(r.claim)).toBe(false);
      expect(other.holdsSessionClaim('/repo', agent, 'resumed')).toBe(true);
    });

    it(`${agent}: a displaced holder release preserves the replacement claim before any late append`, () => {
      const r = rig(agent);
      expect(r.first.holdsSessionClaim('/repo', agent, 'resumed')).toBe(true);
      r.advance(r.first.CLAIM_STALE_MS + 1);
      const replacement = r.load();
      expect(replacement.holdsSessionClaim('/repo', agent, 'resumed')).toBe(true);
      const claim = fs.readFileSync(r.claim, 'utf8');
      r.first.releaseSessionClaim('/repo', agent, 'resumed');
      expect(fs.readFileSync(r.claim, 'utf8')).toBe(claim);
      replacement.appendTranscriptLine('/repo', agent, 'resumed', { type: 'prompt', text: 'replacement' });
      expect(fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line).text)).toEqual(['replacement']);
    });

    for (const jump of [-60 * 60 * 1000, 60 * 60 * 1000]) {
      it(`${agent}: monotonic rechecks survive a wall-clock ${jump < 0 ? 'rollback' : 'forward jump'} and fence a renewed holder`, () => {
        const r = rig(agent);
        expect(r.first.holdsSessionClaim('/repo', agent, 'resumed')).toBe(true);
        const resumed = r.load();
        expect(resumed.appendTranscriptLine('/repo', agent, 'resumed', { type: 'prompt', text: 'healthy' })).toBe('refused');
        r.first.releaseSessionClaim('/repo', agent, 'resumed');
        r.setWall(NOW + jump);
        // Wall time alone cannot trigger a fresh acquisition check.
        expect(resumed.holdsSessionClaim('/repo', agent, 'resumed')).toBe(false);
        r.advance(r.first.CLAIM_RECHECK_MS + 1);
        expect(resumed.appendTranscriptLine('/repo', agent, 'resumed', { type: 'prompt', text: 'healthy' })).toBe('committed');
        const contender = r.load();
        expect(contender.appendTranscriptLine('/repo', agent, 'resumed', { type: 'prompt', text: 'duplicate' })).toBe('refused');
        r.advance(r.first.CLAIM_RECHECK_MS + 1);
        expect(contender.holdsSessionClaim('/repo', agent, 'resumed')).toBe(false);
        expect(fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line).text)).toEqual(['healthy']);
      });
    }

    it(`${agent}: a refused claim rechecks at a bounded cadence when its holder releases`, () => {
      const r = rig(agent);
      expect(r.first.holdsSessionClaim('/repo', agent, 'resumed')).toBe(true);
      const resumed = r.load();
      expect(resumed.holdsSessionClaim('/repo', agent, 'resumed')).toBe(false);
      r.first.releaseSessionClaim('/repo', agent, 'resumed');
      r.advance(r.first.CLAIM_RECHECK_MS / 2);
      expect(resumed.holdsSessionClaim('/repo', agent, 'resumed')).toBe(false);
      r.advance(r.first.CLAIM_RECHECK_MS / 2);
      expect(resumed.holdsSessionClaim('/repo', agent, 'resumed')).toBe(true);
    });

    it(`${agent}: a stale contender cannot take over between ownership validation and append`, () => {
      const r = rig(agent);
      r.first.appendTranscriptLine('/repo', agent, 'resumed', { type: 'session', cwd: '/repo' });
      r.advance(r.first.CLAIM_STALE_MS + 1);
      const competitor = r.load();
      r.first.withClaimGate(r.claim, undefined, () => {
        expect(competitor.holdsSessionClaim('/repo', agent, 'resumed')).toBe(false);
        r.first.appendTranscriptLine('/repo', agent, 'resumed', { type: 'prompt', text: 'holder' });
      });
      r.advance(r.first.CLAIM_RECHECK_MS);
      expect(competitor.holdsSessionClaim('/repo', agent, 'resumed')).toBe(false);
      expect(fs.readFileSync(r.transcript, 'utf8')).toContain('holder');
    });

    it(`${agent}: a refused resumed instance retries after stale expiry without duplicating a live holder`, () => {
      const r = rig(agent);
      expect(r.first.holdsSessionClaim('/repo', agent, 'resumed')).toBe(true);
      const resumed = r.load();
      const competitor = r.load();
      expect(resumed.holdsSessionClaim('/repo', agent, 'resumed')).toBe(false);
      r.advance(r.first.CLAIM_RECHECK_MS);
      r.first.appendTranscriptLine('/repo', agent, 'resumed', { type: 'prompt', text: 'live' });
      expect(resumed.holdsSessionClaim('/repo', agent, 'resumed')).toBe(false);
      r.advance(r.first.CLAIM_STALE_MS + r.first.CLAIM_RECHECK_MS);
      expect(resumed.holdsSessionClaim('/repo', agent, 'resumed')).toBe(true);
      expect(competitor.holdsSessionClaim('/repo', agent, 'resumed')).toBe(false);
      for (const mod of [resumed, competitor, r.first]) {
        mod.appendTranscriptLine('/repo', agent, 'resumed', { type: 'prompt', text: 'after stale' });
      }
      const records = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(records.map((line) => line.text)).toEqual(['live', 'after stale']);
    });

    it(`${agent}: a torn tail followed by append keeps the next record through the server parser`, async () => {
      const r = rig(agent);
      r.first.appendTranscriptLine('/repo', agent, 'resumed', { type: 'session', cwd: '/repo' });
      const torn = '{"v":1,"type":"prompt","text":"cut';
      fs.appendFileSync(r.transcript, torn);
      r.first.appendTranscriptLine('/repo', agent, 'resumed', { type: 'prompt', text: 'healthy', at: new Date(NOW).toISOString() });
      const text = fs.readFileSync(r.transcript, 'utf8');
      expect(text).toContain(`${torn}\n`);
      const result = await parse(text, agent);
      expect(result.prompts).toEqual([{ text: 'healthy' }]);
      expect(result.state).toEqual({ parsed_offset: Buffer.byteLength(text), parse_error: null });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: 'transcript_lines_unreadable', lines: 1 }));
      expect(r.notes.join('')).toContain('unfinished');
    });
  }

  it('recovers a killed holder and its operation gate without reloading the refused resumed instance', async () => {
    const r = rig('opencode');
    const home = r.home;
    const script = path.join(home, 'killed-holder.ts');
    const snippet = fs.readFileSync(path.resolve(import.meta.dirname, '../../packages/myco/src/symbionts/templates/_shared/plugin-helpers.ts.snippet'), 'utf8');
    fs.mkdirSync(path.join(r.env.MYCO_HOME, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(r.env.MYCO_HOME, 'bin/myco'), `#!/bin/sh\nprintf '%s\\n' '${ROUTING_KEY}'\n`, { mode: 0o755 });
    fs.writeFileSync(script, [
      'import nodeFs from "node:fs";',
      'const { accessSync, appendFileSync, closeSync, constants: fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } = nodeFs;',
      'import { spawnSync } from "node:child_process";',
      'import { homedir } from "node:os";',
      'import { dirname, join, resolve } from "node:path";',
      `Date.now = () => ${NOW};`,
      snippet,
      'appendTranscriptLine(process.cwd(), "opencode", "resumed", { type: "session", cwd: process.cwd() });',
      'withClaimGate(claimPathFor(process.cwd(), "opencode", "resumed")!, false, () => {',
      'appendFileSync(transcriptPathFor(process.cwd(), "opencode", "resumed")!, \'{"v":1,"type":"prompt","text":"cut\');',
      'process.stdout.write("ready\\n");',
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);',
      'return true; });',
    ].join('\n'));
    const child = spawn(process.execPath, [script], {
      cwd: home, env: { ...process.env, HOME: home, MYCO_HOME: r.env.MYCO_HOME, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ended = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('holder did not start')), 5000);
        child.stdout!.once('data', () => { clearTimeout(deadline); resolve(); });
        child.once('error', reject);
      });
      const resumed = r.load();
      expect(resumed.holdsSessionClaim('/repo', 'opencode', 'resumed')).toBe(false);
      child.kill('SIGKILL');
      await ended;
      r.advance(r.first.CLAIM_STALE_MS + r.first.CLAIM_RECHECK_MS);
      expect(resumed.holdsSessionClaim('/repo', 'opencode', 'resumed')).toBe(true);
      resumed.appendTranscriptLine('/repo', 'opencode', 'resumed', { type: 'prompt', text: 'after kill' });
      const result = await parse(fs.readFileSync(r.transcript, 'utf8'), 'opencode');
      expect(result.prompts).toEqual([{ text: 'after kill' }]);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: 'transcript_lines_unreadable', lines: 1 }));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await ended;
    }
  });
});


describe('emitted plugin lifecycle recovery', () => {
  for (const agent of ['cline', 'opencode'] as const) {
    it(`${agent}: a prompt pins one fresh routing key through initialization and append`, async () => {
      const r = rig(agent);
      let route = ROUTING_KEY;
      let routingCalls = 0;
      const verbs: string[] = [];
      const subject = snippetModule(r.env, [], [], (_bin, args) => {
        verbs.push(args[1]);
        return { status: 0, stdout: '{}', stderr: '' };
      }, () => { routingCalls += 1; return route; }, () => NOW, fs, () => 0, agent);
      const ctx = { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: '/repo' } };
      const hooks = agent === 'cline' ? subject.MycoClinePlugin.hooks : await subject.MycoPlugin({ directory: '/repo', client: { session: { prompt: async () => {} } } });
      if (agent === 'cline') subject.MycoClinePlugin.setup({}, ctx);
      else await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'resumed' } } } });
      route = 'fedcba9876543210/reassigned';
      if (agent === 'cline') await hooks.beforeModel({ messages: [{ role: 'user', content: 'new route' }] }, ctx);
      else await hooks['chat.message']({}, { message: { sessionID: 'resumed', id: 'submission-1' }, parts: [{ type: 'text', text: 'new route' }] });
      expect(routingCalls).toBe(2);
      expect(verbs).toEqual(['session-start', 'session-start', 'user-prompt-submit']);
      const file = path.join(r.env.MYCO_HOME, 'member/transcripts', route, agent, 'resumed.jsonl');
      expect(fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ type: 'session', cwd: '/repo' }), expect.objectContaining({ type: 'prompt', text: 'new route' }),
      ]);
      expect(fs.readFileSync(r.transcript, 'utf8')).not.toContain('new route');
    });

    for (const fault of ['descriptor close', 'gate cleanup'] as const) {
      it(`${agent}: postcommit ${fault} failure preserves prompt identity and warm callbacks spawn nothing`, async () => {
        const r = rig(agent);
        let failCleanup = false;
        let routingCalls = 0;
        const verbs: string[] = [];
        const promptId = '00000000-0000-4000-8000-000000000163';
        const subject = snippetModule(r.env, [], [], (_bin, args) => {
          verbs.push(args[1]);
          return { status: 0, stdout: JSON.stringify({ promptId }), stderr: '' };
        }, () => { routingCalls += 1; return ROUTING_KEY; }, () => NOW, {
          ...fs,
          appendFileSync: (...args: Parameters<typeof fs.appendFileSync>) => {
            fs.appendFileSync(...args);
            if (String(args[1]).includes('"type":"prompt"')) failCleanup = true;
          },
          closeSync: (fd) => {
            fs.closeSync(fd);
            if (failCleanup && fault === 'descriptor close') {
              failCleanup = false;
              throw Object.assign(new Error('temporary close failure'), { code: 'EIO' });
            }
          },
          unlinkSync: (file) => {
            if (failCleanup && fault === 'gate cleanup' && String(file).includes('.operation/owner-')) {
              failCleanup = false;
              throw Object.assign(new Error('temporary cleanup failure'), { code: 'EACCES' });
            }
            fs.unlinkSync(file);
          },
        }, () => 0, agent);
        const ctx = { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: '/repo' } };
        const hooks = agent === 'cline' ? subject.MycoClinePlugin.hooks : await subject.MycoPlugin({ directory: '/repo', client: { session: { prompt: async () => {} } } });
        const prompt = () => agent === 'cline' ? hooks.beforeModel({ messages: [{ id: 'submission-1', role: 'user', content: 'same prompt' }] }, ctx)
          : hooks['chat.message']({}, { message: { sessionID: 'resumed', id: 'submission-1' }, parts: [{ type: 'text', text: 'same prompt' }] });
        await prompt();
        if (agent === 'cline') await prompt();
        const warmRoutingCalls = routingCalls;
        const warmHooks = [...verbs];
        if (agent === 'cline') {
          await hooks.afterModel({ content: 'response' }, ctx);
          await hooks.afterTool({ name: 'read', input: {} }, ctx);
        } else {
          await hooks['experimental.text.complete']({ sessionID: 'resumed' }, { text: 'response' });
          await hooks['tool.execute.after']({ sessionID: 'resumed', tool: 'read', args: {} }, {});
        }
        expect(routingCalls).toBe(warmRoutingCalls);
        expect(verbs).toEqual(warmHooks);
        expect(verbs.filter((verb) => verb === 'user-prompt-submit')).toHaveLength(1);
        const records = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(records.filter((line) => line.type === 'prompt')).toHaveLength(1);
        expect(records.filter((line) => line.type === 'response' || line.type === 'tool')).toEqual([
          expect.objectContaining({ type: 'response', promptId }), expect.objectContaining({ type: 'tool', promptId }),
        ]);
        expect(fs.existsSync(`${r.claim}.operation`)).toBe(false);
      });
    }

    for (const failure of ['claim', 'header append', 'prompt append', 'session hook'] as const) {
      it(`${agent}: retries the same prompt after a temporary ${failure} failure without committing completion state`, async () => {
        const r = rig(agent);
        let blocked = true;
        let elapsed = 0;
        const verbs: string[] = [];
        const subject = snippetModule(r.env, [], [], (_bin, args) => {
          verbs.push(args[1]);
          if (blocked && failure === 'session hook' && args[1] === 'session-start') return { status: 1, stdout: '', stderr: 'temporary failure' };
          return { status: 0, stdout: JSON.stringify({ promptId: '00000000-0000-4000-8000-000000000163' }), stderr: '' };
        }, ROUTING_KEY, () => NOW, {
          ...fs,
          appendFileSync: (...args: Parameters<typeof fs.appendFileSync>) => {
            if (blocked && ((failure === 'header append' && String(args[1]).includes('"type":"session"'))
              || (failure === 'prompt append' && String(args[1]).includes('"type":"prompt"')))) throw Object.assign(new Error('temporary append failure'), { code: 'EIO' });
            return fs.appendFileSync(...args);
          },
        }, () => elapsed, agent);
        if (failure === 'claim') {
          fs.mkdirSync(path.dirname(r.claim), { recursive: true });
          fs.writeFileSync(r.claim, `crashed-holder ${NOW}`);
        }
        const ctx = { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: '/repo' } };
        const hooks = agent === 'cline' ? subject.MycoClinePlugin.hooks : await subject.MycoPlugin({ directory: '/repo', client: { session: { prompt: async () => {} } } });
        const start = () => agent === 'cline' ? subject.MycoClinePlugin.setup({}, ctx)
          : hooks.event({ event: { type: 'session.created', properties: { info: { id: 'resumed' } } } });
        const prompt = () => agent === 'cline' ? hooks.beforeModel({ messages: [{ id: 'submission-1', role: 'user', content: 'same prompt' }] }, ctx)
          : hooks['chat.message']({}, { message: { sessionID: 'resumed', id: 'submission-1' }, parts: [{ type: 'text', text: 'same prompt' }] });
        await start();
        await prompt();
        const before = fs.existsSync(r.transcript) ? fs.readFileSync(r.transcript, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
        expect(before.filter((line) => line.type === 'prompt')).toHaveLength(0);
        const attemptedStarts = verbs.filter((verb) => verb === 'session-start').length;
        blocked = false;
        if (failure === 'claim') fs.unlinkSync(r.claim);
        elapsed += subject.CLAIM_RECHECK_MS + 1;
        // Recovery uses the model lifecycle; session.created/setup is not replayed.
        await prompt();
        await start();
        if (agent === 'cline') await prompt();
        const records = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(records.filter((line) => line.type === 'session')).toHaveLength(1);
        expect(records[0]).toMatchObject({ type: 'session', cwd: '/repo', agent, sessionId: 'resumed' });
        expect(records.filter((line) => line.type === 'prompt')).toEqual([expect.objectContaining({ text: 'same prompt', ...(failure === 'claim' ? {} : { promptId: '00000000-0000-4000-8000-000000000163' }) })]);
        expect(verbs.filter((verb) => verb === 'session-start')).toHaveLength(failure === 'session hook' ? attemptedStarts + 1 : 1);
        expect(verbs.filter((verb) => verb === 'user-prompt-submit')).toHaveLength(failure === 'claim' ? 0 : 1);
        const parsed = await parse(fs.readFileSync(r.transcript, 'utf8'), agent);
        expect(parsed.prompts).toEqual([{ text: 'same prompt' }]);
      });
    }
  }
});

it('Cline names repeated human submissions separately and reuses observations of each message', async () => {
  const r = rig('cline');
  let prompts = 0;
  const subject = snippetModule(r.env, [], [], (_bin, args) => ({
    status: 0, stdout: JSON.stringify(args[1] === 'user-prompt-submit' ? { promptId: `prompt-${++prompts}` } : {}), stderr: '',
  }), ROUTING_KEY, () => NOW, fs, () => 0, 'cline');
  const ctx = { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: '/repo' } };
  const first = { messages: [{ role: 'user', content: 'continue' }] };
  const second = { messages: [{ role: 'user', content: 'continue' }] };
  for (const request of [first, second]) {
    const stamped = await subject.MycoClinePlugin.hooks.beforeModel(request, ctx) as { messages: unknown[] };
    await subject.MycoClinePlugin.hooks.beforeModel(structuredClone(stamped), ctx);
    await subject.MycoClinePlugin.hooks.afterModel({ content: 'reply' }, ctx);
  }
  const records = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(records.filter(row => row.type === 'prompt' || row.type === 'response').map(row => [row.type, row.promptId])).toEqual([
    ['prompt', 'prompt-1'], ['response', 'prompt-1'], ['prompt', 'prompt-2'], ['response', 'prompt-2'],
  ]);
  expect(prompts).toBe(2);
});

it('a replacement Cline host captures immediately after its writer is killed', async () => {
  const r = rig('cline');
  const bin = path.join(r.env.MYCO_HOME, 'bin', 'myco');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh
if [ "$1" = member ]; then printf '%s\\n' '${ROUTING_KEY}'; else printf '%s\\n' '{"promptId":"first"}'; fi
`, { mode: 0o700 });
  const script = path.join(r.home, 'host.ts');
  const source = fs.readFileSync(path.resolve(import.meta.dir, '../../packages/myco/src/symbionts/templates/cline/plugin.ts'), 'utf8').replaceAll('{{mycoCredentialSource}}', 'registry');
  fs.writeFileSync(script, source.replace('import { spawnSync } from "node:child_process";', 'import { spawnSync as nativeSpawnSync } from "node:child_process";\nconst spawnSync = (bin, ...args) => bin === "ps" ? { status: 0, stdout: "Mon Nov 2 12:00:00 2026", stderr: "" } : nativeSpawnSync(bin, ...args);') + `
const ctx = { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: process.env.HOME } };
await MycoClinePlugin.hooks.beforeModel({ messages: [{ id: 'first', role: 'user', content: 'first' }] }, ctx);
await MycoClinePlugin.hooks.afterModel({ content: 'first reply' }, ctx);
console.log('ready');
await Bun.stdin.text();
`);
  const child = spawn(process.execPath, ['--no-env-file', script], { env: { ...process.env, ...r.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('host did not capture')), 5000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`host exited ${code}`)); });
    });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
    const subject = snippetModule(r.env, [], [], () => ({ status: 0, stdout: '{"promptId":"second"}', stderr: '' }), ROUTING_KEY, Date.now, fs, () => 0, 'cline');
    const ctx = { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: r.home } };
    await subject.MycoClinePlugin.hooks.beforeModel({ messages: [{ id: 'second', role: 'user', content: 'second' }] }, ctx);
    await subject.MycoClinePlugin.hooks.afterModel({ content: 'second reply' }, ctx);
    const rows = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.filter(row => row.type === 'prompt' || row.type === 'response').map(row => row.text)).toEqual([
      'first', 'first reply', 'second', 'second reply',
    ]);
  } finally { child.kill('SIGKILL'); }
}, 10000);

it('retains plugin turns durably while a writer identity cannot be verified and replays them once', async () => {
  const r = rig('cline');
  fs.mkdirSync(path.dirname(r.claim), { recursive: true });
  fs.writeFileSync(r.claim, `legacy-instance ${NOW}`, { mode: 0o600 });
  const load = () => snippetModule(r.env, [], [], () => ({ status: 0, stdout: '{}', stderr: '' }), ROUTING_KEY, () => NOW, fs, () => 0, 'cline');
  const subject = load();
  const ctx = { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: '/repo' } };
  await subject.MycoClinePlugin.hooks.beforeModel({ messages: [{ id: 'held', role: 'user', content: 'held prompt' }] }, ctx);
  await subject.MycoClinePlugin.hooks.afterModel({ content: 'held reply' }, ctx);
  expect(fs.existsSync(r.transcript)).toBe(false);
  expect(fs.readdirSync(`${r.claim}.pending`).length).toBeGreaterThan(0);
  fs.writeFileSync(r.claim, 'legacy-instance 1', { mode: 0o600 });
  const dead = spawnSync(process.execPath, ['--no-env-file', '-e', '0'], { env: process.env }).pid;
  const pending = path.join(`${r.claim}.pending`, `${dead}-exited.jsonl`);
  const sources = fs.readdirSync(`${r.claim}.pending`).sort().map(name => path.join(`${r.claim}.pending`, name));
  fs.writeFileSync(pending, sources.map(file => fs.readFileSync(file, 'utf8')).join(''));
  for (const file of sources) fs.unlinkSync(file);
  let appended = false;
  const replacement = snippetModule(r.env, [], [], () => ({ status: 0, stdout: '{}', stderr: '' }), ROUTING_KEY, () => NOW, {
    ...fs,
    readFileSync: ((file: fs.PathOrFileDescriptor, options: unknown) => {
      const content = fs.readFileSync(file, options as BufferEncoding);
      if (String(file) === pending && !appended) {
        appended = true;
        fs.appendFileSync(pending, JSON.stringify({ type: 'prompt', sessionId: 'resumed', text: 'late prompt', captureId: 'late-source-record' }) + '\n');
      }
      return content;
    }) as typeof fs.readFileSync,
  }, () => 0, 'cline');
  for (let i = 0; i < 2; i++) await replacement.MycoClinePlugin.hooks.afterTool({ name: 'read' }, ctx);
  const rows = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows.filter(row => row.type === 'prompt' || row.type === 'response').map(row => row.text)).toEqual(['held prompt', 'held reply', 'late prompt']);
  expect((await parse(fs.readFileSync(r.transcript, 'utf8'), 'cline')).prompts).toEqual([{ text: 'held prompt' }, { text: 'late prompt' }]);
});

it('recovers a claim and operation token whose PID now belongs to a newer process instance', () => {
  const r = rig('cline');
  const oldBirth = performance.timeOrigin - 60_000;
  const instance = `${process.pid}-old-instance`;
  fs.mkdirSync(`${r.claim}.operation`, { recursive: true });
  fs.writeFileSync(r.claim, `${instance} ${NOW} ${oldBirth}`, { mode: 0o600 });
  fs.writeFileSync(path.join(`${r.claim}.operation`, `owner-${process.pid}-birth-${oldBirth}-old-instance-1`), '', { mode: 0o600 });
  const subject = r.load();
  const status = subject.appendTranscriptLine('/repo', 'cline', 'resumed', { type: 'prompt', text: 'new process' });
  expect(status).toBe('committed');
  expect(fs.readFileSync(r.transcript, 'utf8')).toContain('new process');
  expect(fs.existsSync(`${r.claim}.operation`)).toBe(false);
  expect(r.first.appendTranscriptLine('/repo', 'cline', 'resumed', { type: 'prompt', text: 'duplicate instance' })).toBe('refused');
});

it('Cline captures native snapshot callbacks and content parts with stable message ids', async () => {
  const r = rig('cline');
  let prompts = 0;
  const subject = snippetModule(r.env, [], [], (_bin, args) => ({
    status: 0, stderr: '', stdout: JSON.stringify(args[1] === 'user-prompt-submit' ? { promptId: `native-${++prompts}`, ...(prompts === 1 ? {} : { additionalContext: 'context' }) } : { additionalContext: 'start context' }),
  }), ROUTING_KEY, () => NOW, fs, () => 0, 'cline');
  subject.MycoClinePlugin.setup({}, { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: '/repo' } });
  const snapshot = { conversationId: 'conv_native', agentId: 'agent', iteration: 1, messages: [] };
  await subject.MycoClinePlugin.hooks.onEvent({ type: 'run-started', snapshot });
  expect(JSON.parse(fs.readFileSync(r.transcript, 'utf8').trim()).type).toBe('session');
  for (const id of ['first', 'second']) {
    const input = { snapshot, request: { messages: [{ id, role: 'user', content: [{ type: 'text', text: 'continue' }], createdAt: NOW }] } };
    const result = await subject.MycoClinePlugin.hooks.beforeModel(input) as { messages: Array<{ content: unknown }> };
    expect(result.messages.at(-1)?.content).toEqual([{ type: 'text', text: expect.stringContaining(id === 'first' ? 'start context' : 'context') }]);
    await subject.MycoClinePlugin.hooks.beforeModel(structuredClone(input));
    await subject.MycoClinePlugin.hooks.afterModel({ snapshot, assistantMessage: { id: `reply-${id}`, content: [{ type: 'text', text: `reply ${id}` }] }, finishReason: 'stop' });
    await subject.MycoClinePlugin.hooks.afterTool({ snapshot, toolCall: { type: 'tool-call', toolCallId: `tool-${id}`, toolName: 'read' }, input: { path: '/repo/a' }, result: { output: 'ok', isError: false } });
  }
  const rows = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows.filter(row => row.type === 'prompt' || row.type === 'response').map(row => [row.type, row.promptId])).toEqual([
    ['prompt', 'native-1'], ['response', 'native-1'], ['prompt', 'native-2'], ['response', 'native-2'],
  ]);
  expect(rows.filter(row => row.type === 'tool').map(row => [row.promptId, row.output])).toEqual([['native-1', 'ok'], ['native-2', 'ok']]);
  expect(prompts).toBe(2);
});

it('damaged pending lines are reported while valid retained and new capture continue', async () => {
  const r = rig('cline');
  const pending = path.join(`${r.claim}.pending`, `${process.pid}-damaged.jsonl`);
  fs.mkdirSync(path.dirname(pending), { recursive: true });
  fs.writeFileSync(pending, '{broken}\n' + JSON.stringify({ type: 'prompt', sessionId: 'resumed', text: 'retained', promptId: 'retained-id', captureId: 'retained-source' }) + '\n');
  const notes: string[] = [];
  const subject = snippetModule(r.env, [], notes, () => ({ status: 0, stderr: '', stdout: '{"promptId":"new-id"}' }), ROUTING_KEY, () => NOW, fs, () => 0, 'cline');
  subject.MycoClinePlugin.setup({}, { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: '/repo' } });
  const snapshot = { conversationId: 'conv_pending' };
  await subject.MycoClinePlugin.hooks.beforeModel({ snapshot, request: { messages: [{ id: 'new', role: 'user', content: [{ type: 'text', text: 'new' }] }] } });
  await subject.MycoClinePlugin.hooks.afterModel({ snapshot, assistantMessage: { content: [{ type: 'text', text: 'reply' }] } });
  const rows = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows.filter(row => row.type === 'prompt' || row.type === 'response').map(row => row.text)).toEqual(['retained', 'new', 'reply']);
  expect(notes.join('\n')).toContain('damaged pending capture');
  expect(fs.readFileSync(pending, 'utf8')).toContain('{broken}');
});

it('replay shares live submission identities and preserves retained prompt stamps', async () => {
  const r = rig('cline');
  const subject = snippetModule(r.env, [], [], () => ({ status: 0, stderr: '', stdout: '{"promptId":"live-id"}' }), ROUTING_KEY, () => NOW, fs, () => 0, 'cline');
  const ctx = { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: '/repo' } };
  await subject.MycoClinePlugin.hooks.beforeModel({ messages: [{ id: 'S', role: 'user', content: 'same' }] }, ctx);
  const pending = path.join(`${r.claim}.pending`, `${process.pid}-other.jsonl`);
  fs.mkdirSync(path.dirname(pending), { recursive: true });
  fs.writeFileSync(pending, [
    { type: 'prompt', sessionId: 'resumed', text: 'same', submissionId: 'message:S', captureId: 'submission-message:S' },
    { type: 'response', sessionId: 'resumed', text: 'retained reply', submissionId: 'message:S', captureId: 'retained-reply' },
    { type: 'prompt', sessionId: 'resumed', text: 'held', promptId: 'minted-before-refusal', submissionId: 'message:H', captureId: 'submission-message:H' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await subject.MycoClinePlugin.hooks.afterTool({ name: 'read' }, ctx);
  await subject.MycoClinePlugin.hooks.afterTool({ name: 'read' }, ctx);
  const rows = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows.filter(row => row.type === 'prompt').map(row => row.promptId)).toEqual(['live-id', 'minted-before-refusal']);
  expect(rows.find(row => row.text === 'retained reply').promptId).toBe('live-id');
});

it('verifies another PID birth before replacing its writer and caches unavailable probes', async () => {
  const child = spawn(process.execPath, ['--no-env-file', '-e', 'console.log("ready"); await Bun.stdin.text()'], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
    });
    const birth = Date.parse('2026-11-02T12:00:00Z');
    const r = rig('cline');
    fs.mkdirSync(path.dirname(r.claim), { recursive: true });
    fs.writeFileSync(r.claim, `${child.pid}-old ${NOW} ${birth - 60_000}`, { mode: 0o600 });
    const subject = snippetModule(r.env, [], [], undefined, ROUTING_KEY, () => NOW, fs, () => 0, undefined,
      () => ({ status: 0, stdout: new Date(birth).toISOString(), stderr: '' }));
    expect(subject.appendTranscriptLine('/repo', 'cline', 'resumed', { type: 'prompt', text: 'replacement' })).toBe('committed');

    const held = rig('cline');
    fs.mkdirSync(path.dirname(held.claim), { recursive: true });
    fs.writeFileSync(held.claim, `${child.pid}-unavailable ${NOW} ${birth}`, { mode: 0o600 });
    let probes = 0;
    const waiting = snippetModule(held.env, [], [], undefined, ROUTING_KEY, () => NOW, fs, () => 0, 'cline',
      () => { probes += 1; return { status: null, stdout: '', stderr: 'probe timed out' }; }, 'win32');
    const snapshot = { session: { sessionId: 'resumed' }, conversationId: 'conv_pending' };
    for (let i = 0; i < 5; i++) await waiting.MycoClinePlugin.hooks.afterModel({ snapshot, assistantMessage: { id: `reply-${i}`, content: [{ type: 'text', text: 'held' }] } });
    expect(probes).toBe(2);
    const pending = fs.readdirSync(`${held.claim}.pending`).filter(file => file.endsWith('.jsonl'));
    expect(pending).toHaveLength(5);
    expect(pending.every(file => JSON.parse(fs.readFileSync(path.join(`${held.claim}.pending`, file), 'utf8')).text === 'held')).toBe(true);
  } finally { child.kill('SIGKILL'); }
});

it('a prompt without a submission key cannot reuse a different failed prompt answer', async () => {
  const r = rig('opencode');
  let fail = true;
  let minted = 0;
  const subject = snippetModule(r.env, [], [], (_bin, args) => ({ status: 0, stderr: '', stdout: args[1] === 'user-prompt-submit' ? JSON.stringify({ promptId: `minted-${++minted}` }) : '{}' }), ROUTING_KEY, () => NOW, {
    ...fs,
    appendFileSync: (...args: Parameters<typeof fs.appendFileSync>) => {
      if (fail && String(args[1]).includes('"type":"prompt"')) {
        fail = false;
        throw Object.assign(new Error('temporary full disk'), { code: 'ENOSPC' });
      }
      fs.appendFileSync(...args);
    },
  }, () => 0, 'opencode');
  const hooks = await subject.MycoPlugin({ directory: '/repo', client: { session: { prompt: async () => {} } } });
  for (const text of ['first prompt', 'second prompt']) await hooks['chat.message']({}, { message: { sessionID: 'resumed' }, parts: [{ type: 'text', text }] });
  const rows = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows.filter(row => row.type === 'prompt').map(row => [row.text, row.promptId])).toEqual([
    ['first prompt', 'minted-1'], ['second prompt', 'minted-2'],
  ]);
});

it('a surviving producer retains new callbacks after a partial inbox write', async () => {
  const r = rig('cline');
  fs.mkdirSync(path.dirname(r.claim), { recursive: true });
  fs.writeFileSync(r.claim, `unverified-writer ${NOW}`);
  let partial = true;
  const notes: string[] = [];
  const subject = snippetModule(r.env, [], notes, undefined, ROUTING_KEY, () => NOW, {
    ...fs,
    appendFileSync(file, data, ...options) {
      if (partial && String(data).includes('"type":"response"')) {
        partial = false;
        fs.appendFileSync(file, String(data).slice(0, 30));
        throw Object.assign(new Error('partial write'), { code: 'ENOSPC' });
      }
      fs.appendFileSync(file, data, ...options);
    },
  }, () => 0, 'cline');
  subject.MycoClinePlugin.setup({}, { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: '/repo' } });
  const snapshot = { conversationId: 'conv_pending' };
  await subject.MycoClinePlugin.hooks.afterModel({ snapshot, assistantMessage: { id: 'torn', content: [{ type: 'text', text: 'torn' }] } });
  await subject.MycoClinePlugin.hooks.afterModel({ snapshot, assistantMessage: { id: 'next', content: [{ type: 'text', text: 'complete' }] } });
  fs.unlinkSync(r.claim);
  const resumed = r.load();
  expect(resumed.initializeTranscriptSession('/repo', 'cline', 'resumed').status).toBe('committed');
  const rows = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows.filter(row => row.type === 'response').map(row => row.text)).toEqual(['complete']);
  expect(notes.join('\n')).toContain('partial write');
});

it('same-process plugin instances share the kernel birth proof across VM clocks', () => {
  const r = rig('cline');
  const birth = Date.parse('2020-01-01T00:00:00Z');
  fs.mkdirSync(path.dirname(r.claim), { recursive: true });
  const holder = `${process.pid}-another-vm ${NOW} ${birth}`;
  fs.writeFileSync(r.claim, holder);
  const subject = snippetModule(r.env, [], [], undefined, ROUTING_KEY, () => NOW, fs, () => 0, undefined,
    () => ({ status: 0, stdout: new Date(birth).toUTCString(), stderr: '' }));
  expect(subject.holdsSessionClaim('/repo', 'cline', 'resumed')).toBe(false);
  expect(fs.readFileSync(r.claim, 'utf8')).toBe(holder);
});

it('Cline keeps one session across run ids and a replacement plugin host', async () => {
  const r = rig('cline');
  const ctx = { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: '/repo' } };
  let prompt = 0;
  const load = () => snippetModule(r.env, [], [], (_bin, args) => ({ status: 0, stdout: args[1] === 'user-prompt-submit' ? JSON.stringify({ promptId: `prompt-${++prompt}` }) : '{}', stderr: '' }), ROUTING_KEY, () => NOW, fs, () => 0, 'cline');
  let subject = load();
  subject.MycoClinePlugin.setup({}, ctx);
  try {
    for (const [i, conversationId] of ['conv_first', 'conv_second', 'conv_restarted'].entries()) {
      if (i === 2) {
        subject.releaseSessionClaim('/repo', 'cline', 'resumed');
        subject = load();
        subject.MycoClinePlugin.setup({}, ctx);
      }
      const snapshot = { agentId: 'agent', conversationId, parentAgentId: null, iteration: 1, messages: [] };
      await subject.MycoClinePlugin.hooks.onEvent({ type: 'run-started', snapshot });
      await subject.MycoClinePlugin.hooks.beforeModel({ snapshot, request: { messages: [{ id: `message-${i}`, role: 'user', content: [{ type: 'text', text: `prompt ${i}` }] }] } });
      await subject.MycoClinePlugin.hooks.afterModel({ snapshot, assistantMessage: { id: `reply-${i}`, content: [{ type: 'text', text: `reply ${i}` }] } });
      await subject.MycoClinePlugin.hooks.afterRun({ snapshot });
    }
    const root = path.dirname(r.transcript);
    expect(fs.readdirSync(root)).toEqual(['resumed.jsonl']);
    const rows = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(new Set(rows.filter(row => row.type === 'session').map(row => row.sessionId))).toEqual(new Set(['resumed']));
    expect(rows.filter(row => row.type === 'prompt').map(row => row.text)).toEqual(['prompt 0', 'prompt 1', 'prompt 2']);
    expect(rows.filter(row => row.type === 'response').map(row => row.text)).toEqual(['reply 0', 'reply 1', 'reply 2']);
    expect(rows.every(row => row.sessionId === 'resumed')).toBe(true);
  } finally { fs.rmSync(r.home, { recursive: true, force: true }); }
});

it('Cline subagent task callbacks use a child session', async () => {
  const r = rig('cline');
  const subject = snippetModule(r.env, [], [], () => ({ status: 0, stdout: '{}', stderr: '' }), ROUTING_KEY, () => NOW, fs, () => 0, 'cline');
  try {
    subject.MycoClinePlugin.setup({}, { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: '/repo' } });
    const snapshot = { agentId: 'child', parentAgentId: 'parent', conversationId: 'conv_child', iteration: 1, messages: [] };
    await subject.MycoClinePlugin.hooks.onEvent({ type: 'run-started', snapshot });
    await subject.MycoClinePlugin.hooks.beforeModel({ snapshot, request: { messages: [{ id: 'task', role: 'user', content: [{ type: 'text', text: 'delegated task' }] }] } });
    const rows = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(fs.readdirSync(path.dirname(r.transcript))).toContain('resumed-agent-child.jsonl');
    expect(rows.filter(row => row.type === 'prompt')).toEqual([]);
  } finally { fs.rmSync(r.home, { recursive: true, force: true }); }
});


it('Cline teammates keep tasks and prompt ownership outside the lead session', async () => {
  const r = rig('cline');
  let prompts = 0;
  const stops: string[] = [];
  const subject = snippetModule(r.env, [], [], (_bin, args, options) => {
    if (args[1] === 'stop') stops.push(JSON.parse(Reflect.get(options, 'input')).conversationId);
    return { status: 0, stdout: args[1] === 'user-prompt-submit' ? JSON.stringify({ promptId: `p-${++prompts}` }) : '{}', stderr: '' };
  }, ROUTING_KEY, () => NOW, fs, () => 0, 'cline');
  try {
    subject.MycoClinePlugin.setup({}, { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: '/repo' } });
    const lead = { agentId: 'lead', conversationId: 'conv_lead', iteration: 1, messages: [] };
    const teammate = { agentId: 'teammate', conversationId: 'conv_teammate', iteration: 1, messages: [] };
    for (const [snapshot, text] of [[lead, 'human prompt'], [teammate, 'delegated team task']] as const) {
      await subject.MycoClinePlugin.hooks.onEvent({ type: 'run-started', snapshot });
      await subject.MycoClinePlugin.hooks.beforeModel({ snapshot, request: { messages: [{ id: text, role: 'user', content: [{ type: 'text', text }] }] } });
    }
    for (const snapshot of [teammate, lead]) {
      await subject.MycoClinePlugin.hooks.afterModel({ snapshot, assistantMessage: { id: snapshot.agentId, content: [{ type: 'text', text: `${snapshot.agentId} reply` }] } });
      await subject.MycoClinePlugin.hooks.afterTool({ snapshot, toolCall: { toolCallId: `${snapshot.agentId}-tool`, toolName: 'read' }, input: {}, result: { output: 'ok' } });
      await subject.MycoClinePlugin.hooks.afterRun({ snapshot });
    }
    const rows = fs.readFileSync(r.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.filter(row => row.type === 'prompt').map(row => row.text)).toEqual(['human prompt']);
    expect(rows.filter(row => row.type === 'response' || row.type === 'tool').map(row => row.promptId)).toEqual(['p-1', 'p-1']);
    const child = fs.readdirSync(path.dirname(r.transcript)).find(file => file !== 'resumed.jsonl');
    expect(child).toBeDefined();
    const childRows = fs.readFileSync(path.join(path.dirname(r.transcript), child!), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(childRows.filter(row => row.type === 'prompt').map(row => row.text)).toEqual(['delegated team task']);
    const childPrompt = childRows.find(row => row.type === 'prompt');
    expect(childPrompt.origin).toBe('agent_dispatch');
    expect(childRows.filter(row => row.type === 'response' || row.type === 'tool').map(row => row.promptId)).toEqual([childPrompt.promptId, childPrompt.promptId]);
    expect(prompts).toBe(1);
    expect(stops).toEqual(['resumed-agent-teammate', 'resumed']);
  } finally { fs.rmSync(r.home, { recursive: true, force: true }); }
});


it('Cline child dispatches retain a non-human origin through capture and document publication', async () => {
  for (const parented of [false, true]) {
    const r = rig('cline');
    let promptHooks = 0;
    const subject = snippetModule(r.env, [], [], (_bin, args) => {
      if (args[1] === 'user-prompt-submit') promptHooks += 1;
      return { status: 0, stdout: JSON.stringify({ promptId: '11111111-1111-4111-8111-111111111111', additionalContext: 'served context' }), stderr: '' };
    }, ROUTING_KEY, () => NOW, fs, () => 0, 'cline');
    try {
      subject.MycoClinePlugin.setup({}, { session: { sessionId: 'resumed' }, workspaceInfo: { rootPath: '/repo' } });
      await subject.MycoClinePlugin.hooks.onEvent({ type: 'run-started', snapshot: { agentId: 'lead', conversationId: 'conv_lead' } });
      const snapshot = { agentId: 'child', conversationId: 'conv_child', ...(parented ? { parentAgentId: 'lead' } : {}), iteration: 1, messages: [] };
      await subject.MycoClinePlugin.hooks.onEvent({ type: 'run-started', snapshot });
      const input = { snapshot, request: { messages: [{ id: 'task', role: 'user', content: [{ type: 'text', text: 'delegated task' }] }] } };
      const response = await subject.MycoClinePlugin.hooks.beforeModel(input) as { messages: unknown[] };
      await subject.MycoClinePlugin.hooks.beforeModel(structuredClone(input));
      await subject.MycoClinePlugin.hooks.afterModel({ snapshot, assistantMessage: { id: 'reply', content: [{ type: 'text', text: 'delegated reply' }] } });
      await subject.MycoClinePlugin.hooks.afterTool({ snapshot, toolCall: { toolCallId: 'call', toolName: 'read' }, input: { path: 'a' }, result: { output: 'ok' } });
      const file = subject.transcriptPathFor('/repo', 'cline', 'resumed-agent-child');
      const text = fs.readFileSync(file, 'utf8');
      const raw = text.trim().split('\n').map(line => JSON.parse(line));
      const prompt = raw.find(row => row.type === 'prompt');
      expect(prompt.origin).toBe('agent_dispatch');
      expect(raw.filter(row => row.type === 'prompt')).toHaveLength(1);
      expect(response.messages).toHaveLength(1);
      expect(promptHooks).toBe(0);
      const parsed = await parse(text, 'cline', { endedAt: NOW - 1, sessionId: 'resumed-agent-child' });
      expect(parsed.records.filter(row => row.k === 'prompt').map(row => [row.id, row.origin])).toEqual([[prompt.promptId, 'agent_dispatch']]);
      expect(parsed.records.filter(row => row.k === 'reply' || row.k === 'tool').map(row => row.prompt_id)).toEqual([prompt.promptId, prompt.promptId]);
      expect(parsed.document).toEqual({ prompts: 1, user_prompts: 0, replies: 1, tool_calls: 1, first_prompt: null });
      expect(parsed.session).toEqual({ ended_at: NOW - 1 });
    } finally { fs.rmSync(r.home, { recursive: true, force: true }); }
  }
});
