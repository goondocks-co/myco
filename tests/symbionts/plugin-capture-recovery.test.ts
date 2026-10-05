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
  const notes: string[] = [];
  const load = () => snippetModule(env, [], notes, undefined, ROUTING_KEY, () => now);
  const first = load();
  const claim = path.join(env.MYCO_HOME, 'member', 'claims', ROUTING_KEY, `${agent}-resumed.lock`);
  const transcript = first.transcriptPathFor('/repo', agent, 'resumed');
  return { home, env, first, load, claim, transcript, notes, advance: (ms: number) => { now += ms; } };
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

    it(`${agent}: a refused claim rechecks at a bounded cadence when its holder releases`, () => {
      const r = rig(agent);
      expect(r.first.holdsSessionClaim('/repo', agent, 'resumed')).toBe(true);
      const resumed = r.load();
      expect(resumed.holdsSessionClaim('/repo', agent, 'resumed')).toBe(false);
      r.first.releaseSessionClaim('/repo', agent, 'resumed');
      r.advance(r.first.CLAIM_RECHECK_MS - 1);
      expect(resumed.holdsSessionClaim('/repo', agent, 'resumed')).toBe(false);
      r.advance(1);
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
