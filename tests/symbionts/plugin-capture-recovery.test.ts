import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'bun:test';
import { snippetModule } from '../support/plugin-snippet.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { parseOnce } from '@myco-server-worker/ingest/parse.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
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

async function parse(text: string, agent: string) {
  const { sqlite, serverEnv } = sqliteEnv();
  const { tokenId } = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
  const bytes = new TextEncoder().encode(text);
  const key = await sha256HexOf(bytes);
  const objectKey = registerBlob(sqlite, { projectId: 'proj_1', key, size: bytes.length, tokenId, receivedAt: NOW });
  await serverEnv.blobs.put(objectKey, new Blob([bytes]).stream());
  sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
    VALUES ('proj_1', 'resumed', 'machine_1', ?, ?, ?)`, [tokenId, NOW, NOW]);
  sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id)
    VALUES ('proj_1', 'tx_recovery', 'resumed', 'machine_1', ?, ?, 1, ?, ?, ?)`, [agent, bytes.length, NOW, NOW, tokenId]);
  sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
    VALUES ('proj_1', 'tx_recovery', 0, ?, ?, 'segment', ?, ?, ?)`, [bytes.length, key, NOW, NOW, tokenId]);
  const target = {
    projectId: 'proj_1', transcriptId: 'tx_recovery', sessionId: 'resumed', machineId: 'machine_1',
    tokenId, agent, size: bytes.length, parsedOffset: 0, fidelity: null, openPromptId: null, imported: false,
  };
  const diagnostics: unknown[] = [];
  const log = console.log;
  let report;
  try {
    console.log = (line: string) => { diagnostics.push(JSON.parse(line)); };
    report = await parseOnce(serverEnv, target, NOW, { calls: 30, deadline: Infinity, clock: () => NOW, completeFile: true });
  } finally { console.log = log; }
  const prompts = sqlite.query('SELECT text FROM prompt_batches').all();
  const state = sqlite.query('SELECT parsed_offset, parse_error FROM transcripts').get();
  // A retry with the committed cursor must derive nothing twice.
  await parseOnce(serverEnv, { ...target, parsedOffset: bytes.length }, NOW, { calls: 30, deadline: Infinity, clock: () => NOW, completeFile: true });
  expect(sqlite.query('SELECT text FROM prompt_batches').all()).toEqual(prompts);
  sqlite.close();
  return { report, prompts, state, diagnostics };
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
      else await hooks['chat.message']({}, { message: { sessionID: 'resumed' }, parts: [{ type: 'text', text: 'new route' }] });
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
        const prompt = () => agent === 'cline' ? hooks.beforeModel({ messages: [{ role: 'user', content: 'same prompt' }] }, ctx)
          : hooks['chat.message']({}, { message: { sessionID: 'resumed' }, parts: [{ type: 'text', text: 'same prompt' }] });
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
        const prompt = () => agent === 'cline' ? hooks.beforeModel({ messages: [{ role: 'user', content: 'same prompt' }] }, ctx)
          : hooks['chat.message']({}, { message: { sessionID: 'resumed' }, parts: [{ type: 'text', text: 'same prompt' }] });
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
        expect(records.filter((line) => line.type === 'prompt')).toEqual([expect.objectContaining({ text: 'same prompt', promptId: '00000000-0000-4000-8000-000000000163' })]);
        expect(verbs.filter((verb) => verb === 'session-start')).toHaveLength(failure === 'session hook' ? attemptedStarts + 1 : 1);
        expect(verbs.filter((verb) => verb === 'user-prompt-submit')).toHaveLength(1);
        const parsed = await parse(fs.readFileSync(r.transcript, 'utf8'), agent);
        expect(parsed.prompts).toEqual([{ text: 'same prompt' }]);
      });
    }
  }
});
