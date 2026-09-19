/**
 * The OpenCode member plugin against opencode's plugin contract
 * (`@opencode-ai/plugin` `Hooks`, and what opencode 1.18 triggers):
 * `chat.message` carries the user's message only, and an assistant text part
 * reaches a plugin through `experimental.text.complete({ sessionID, messageID,
 * partID }, { text })` once it is finished. A two-turn session driven with
 * those shapes, and the SDK-shaped events around them, must leave a transcript
 * the Deployment's own parser reads as two prompts and two responses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { opencodeParser } from '../../packages/myco-server/src/ingest/parsers/opencode.js';

let dir: string;
let root: string;
let home: string;
let savedHome: string | undefined;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-opencode-contract-')));
  root = path.join(dir, 'proj');
  home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  // The binary mints a prompt id per prompt, as `myco hook user-prompt-submit` does.
  fs.writeFileSync(path.join(home, 'bin', 'myco'), [
    '#!/bin/sh',
    'cat > /dev/null',
    `if [ "$2" = user-prompt-submit ]; then n=$(($(cat '${dir}/n' 2>/dev/null || echo 0) + 1)); echo $n > '${dir}/n'; printf '{"promptId":"prompt-%s"}' $n; else printf '{}'; fi`,
  ].join('\n'), { mode: 0o755 });
  savedHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function loadPlugin(instance = '') {
  const manifest = loadManifests().find((m) => m.name === 'opencode')!;
  const rendered = new SymbiontInstaller(manifest, root, resolvePackageRoot(), false, undefined, null, 'member-project', home).renderMemberPlugin('registry')!;
  const file = path.join(root, '.opencode', 'plugins', 'myco.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rendered);
  return (await import(`${pathToFileURL(file).href}${instance}`)).MycoPlugin;
}

describe('the OpenCode member plugin under opencode\'s plugin contract', () => {
  it('captures both prompts and both responses of a two-turn session', async () => {
    const MycoPlugin = await loadPlugin();
    const hooks = await MycoPlugin({ client: { session: { prompt: async () => ({}) } }, directory: root, worktree: root });
    const sessionID = 'ses_contract';
    const event = (type: string, properties: Record<string, unknown>) => hooks.event({ event: { type, properties } });

    await event('session.created', { info: { id: sessionID } });
    for (const turn of [1, 2]) {
      const userID = `msg_user${turn}`;
      const assistantID = `msg_assistant${turn}`;
      await hooks['chat.message'](
        { sessionID, agent: 'build', messageID: userID },
        { message: { id: userID, sessionID, role: 'user' }, parts: [{ id: `prt_user${turn}`, messageID: userID, sessionID, type: 'text', text: `question ${turn}` }] },
      );
      await event('message.updated', { info: { id: assistantID, sessionID, role: 'assistant' } });
      await event('message.part.updated', { part: { id: `prt_answer${turn}`, messageID: assistantID, sessionID, type: 'text', text: `answer ${turn}` } });
      await hooks['experimental.text.complete']?.({ sessionID, messageID: assistantID, partID: `prt_answer${turn}` }, { text: `answer ${turn}` });
      await event('session.idle', { sessionID });
    }

    const transcript = path.join(home, 'member', 'transcripts', 'opencode', `${sessionID}.jsonl`);
    const raw = fs.readFileSync(transcript, 'utf8');
    let offset = 0;
    const lines = raw.split('\n').filter(Boolean).map((line) => {
      const parsed = { value: JSON.parse(line) as Record<string, unknown>, offset };
      offset += Buffer.byteLength(line) + 1;
      return parsed;
    });
    const events = await opencodeParser.parse({ lines, sessionId: sessionID, now: Date.now() } as never);
    const turns = events
      .filter((e) => e.kind === 'prompt' || e.kind === 'response')
      .map((e) => ({ kind: e.kind, text: (e.payload as { text: string }).text, promptId: (e.payload as { promptId?: string }).promptId }));
    expect(turns).toEqual([
      { kind: 'prompt', text: 'question 1', promptId: 'prompt-1' },
      { kind: 'response', text: 'answer 1', promptId: 'prompt-1' },
      { kind: 'prompt', text: 'question 2', promptId: 'prompt-2' },
      { kind: 'response', text: 'answer 2', promptId: 'prompt-2' },
    ]);
  });

  it('ends every session it opened when its instance is disposed, so a new instance takes the session at once', async () => {
    const first = await (await loadPlugin('?instance=1'))({ client: { session: { prompt: async () => ({}) } }, directory: root, worktree: root });
    await first.event({ event: { type: 'session.created', properties: { info: { id: 'ses_disposed' } } } });
    const claim = path.join(home, 'member', 'claims', 'opencode-ses_disposed.lock');
    expect(fs.existsSync(claim)).toBe(true);
    await first.event({ event: { type: 'server.instance.disposed', properties: { directory: root } } });
    expect(fs.existsSync(claim)).toBe(false);

    const second = await (await loadPlugin('?instance=2'))({ client: { session: { prompt: async () => ({}) } }, directory: root, worktree: root });
    await second['chat.message'](
      { sessionID: 'ses_disposed', messageID: 'msg_again' },
      { message: { id: 'msg_again', sessionID: 'ses_disposed', role: 'user' }, parts: [{ id: 'prt_again', messageID: 'msg_again', sessionID: 'ses_disposed', type: 'text', text: 'again' }] },
    );
    const lines = fs.readFileSync(path.join(home, 'member', 'transcripts', 'opencode', 'ses_disposed.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.type === 'prompt').map((l) => l.text)).toEqual(['again']);
  });
});
