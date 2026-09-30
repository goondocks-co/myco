/**
 * How to resume a session, on its detail (`GET /api/projects/{p}/sessions/{s}` → `resume: { command, line } | null`).
 *
 * `command` is the capturing agent's manifest template with the session id filled in; `line` is what to paste: the
 * command after entering the session's folder, quoted for the shell that reads it, or the command alone where the
 * session recorded no folder. Everything here is pasted into a shell and came from the capturing member, so an agent
 * is only ever the catalogue's own key, an id must be a plain token and not a 1.4 minted one, and a folder with a
 * control character gets nothing.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { resumeCommandFor } from '@myco-server-worker/core/resume-command.js';
import { RESUME_COMMANDS } from '@goondocks/myco-shared/resume-commands-data';
import { BUNDLED_MANIFESTS } from '../../packages/myco/src/symbionts/manifests.generated';

const ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const session = (id: string, agent: string | null, originPath: string | null = null) =>
    fixture.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, origin_path)
                        VALUES ('proj_1', ?, 'm1', 'tok_1', 1, 1, ?, ?)`, [id, agent, originPath]);
  const resume = async (id: string, sub?: string) => {
    const res = await worker.fetch(new Request(`https://s/api/projects/proj_1/sessions/${encodeURIComponent(id)}`, { headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), env);
    expect(res.status).toBe(200);
    return (await res.json() as { resume: { command: string; line: string } | null }).resume;
  };
  return { sqlite: fixture.sqlite, session, resume };
}

describe('how to resume a session, served on its detail', () => {
  it('serves each agent\'s command, and the line that enters the session\'s folder first', async () => {
    const h = harness();
    h.session(ID, 'codex', '/Users/chris/Repos/myco');
    h.session('5f8e7d6c-1a2b-4c3d-9e8f-7a6b5c4d3e2f', 'claude-code');
    h.session('1781655805296_o3zf7', 'cline', '/home/dev/my repo');
    h.session('ses_4b7a1c2d', 'opencode', 'C:\\Users\\chris\\repo');
    expect(await h.resume(ID)).toEqual({ command: `codex resume ${ID}`, line: `cd '/Users/chris/Repos/myco' && codex resume ${ID}` });
    expect(await h.resume('5f8e7d6c-1a2b-4c3d-9e8f-7a6b5c4d3e2f')).toEqual({ command: 'claude --resume 5f8e7d6c-1a2b-4c3d-9e8f-7a6b5c4d3e2f', line: 'claude --resume 5f8e7d6c-1a2b-4c3d-9e8f-7a6b5c4d3e2f' });
    expect(await h.resume('1781655805296_o3zf7')).toEqual({ command: 'cline --id 1781655805296_o3zf7', line: `cd '/home/dev/my repo' && cline --id 1781655805296_o3zf7` });
    expect(await h.resume('ses_4b7a1c2d')).toEqual({ command: 'opencode --session ses_4b7a1c2d', line: `Set-Location -LiteralPath 'C:\\Users\\chris\\repo'; opencode --session ses_4b7a1c2d` });
  });

  it('serves null for an agent with no template, a session with no agent, and an id that is not a plain token', async () => {
    const h = harness();
    h.session('cursor-chat-1', 'cursor');
    h.session('no-agent', null);
    h.session('abc;touch x', 'codex');
    h.session('constructor-agent', 'constructor');
    for (const id of ['cursor-chat-1', 'no-agent', 'abc;touch x', 'constructor-agent']) expect({ id, resume: await h.resume(id) }).toEqual({ id, resume: null });
  });

  it('is read by a member who is not an admin', async () => {
    const h = harness();
    seedMemberRoleAccount(h.sqlite);
    h.session(ID, 'codex');
    expect(await h.resume(ID, MEMBER_SUB)).toEqual({ command: `codex resume ${ID}`, line: `codex resume ${ID}` });
  });
});

describe('the resume command and line', () => {
  it('looks an agent up as the catalogue\'s own key, never one every object inherits', () => {
    for (const agent of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'no-such-agent', '']) {
      expect({ agent, resume: resumeCommandFor(agent, ID, null) }).toEqual({ agent, resume: null });
    }
    expect(resumeCommandFor(null, ID, null)).toBeNull();
  });

  it('refuses an id carrying any shell metacharacter, one past 128 characters, and a 1.4 minted id', () => {
    for (const ch of [';', '&', '|', '`', '(', ')', '<', '>', "'", '"', ' ', '\n', '*', '$', '\\', '/']) {
      expect({ ch, resume: resumeCommandFor('codex', `abc${ch}def`, null) }).toEqual({ ch, resume: null });
    }
    expect(resumeCommandFor('codex', 'a'.repeat(128), null)).toEqual({ command: `codex resume ${'a'.repeat(128)}`, line: `codex resume ${'a'.repeat(128)}` });
    expect(resumeCommandFor('codex', 'a'.repeat(129), null)).toBeNull();
    expect(resumeCommandFor('codex', `sess_${'0123456789abcdef'.repeat(2)}`, null)).toBeNull();
    // A 1.4-shaped id that is not what 1.4 minted is an agent's own.
    expect(resumeCommandFor('codex', `sess_${'0123456789abcdef'.repeat(2)}0`, null)?.command).toBe(`codex resume sess_${'0123456789abcdef'.repeat(2)}0`);
  });

  it('quotes a POSIX folder so nothing in it runs', () => {
    expect(resumeCommandFor('codex', ID, "/tmp/it's here")!.line).toBe(`cd '/tmp/it'\\''s here' && codex resume ${ID}`);
    expect(resumeCommandFor('codex', ID, '/tmp/$(id)/`whoami`;rm -rf x')!.line).toBe(`cd '/tmp/$(id)/\`whoami\`;rm -rf x' && codex resume ${ID}`);
    expect(resumeCommandFor('codex', ID, '')!.line).toBe(`codex resume ${ID}`);
  });

  it('quotes a Windows folder for PowerShell, a drive or a share', () => {
    expect(resumeCommandFor('codex', ID, "C:\\Users\\chris\\it's repo")!.line).toBe(`Set-Location -LiteralPath 'C:\\Users\\chris\\it''s repo'; codex resume ${ID}`);
    expect(resumeCommandFor('codex', ID, 'D:/work/myco')!.line).toBe(`Set-Location -LiteralPath 'D:/work/myco'; codex resume ${ID}`);
    expect(resumeCommandFor('codex', ID, '\\\\host\\share\\repo')!.line).toBe(`Set-Location -LiteralPath '\\\\host\\share\\repo'; codex resume ${ID}`);
  });

  it('gives nothing for a folder carrying a control character', () => {
    for (const path of ['/tmp/a\nb', '/tmp/a\u0000b', '/tmp/a\u001bb', 'C:\\a\rb', '/tmp/a\u007fb']) {
      expect({ path, resume: resumeCommandFor('codex', ID, path) }).toEqual({ path, resume: null });
    }
  });

  it('carries every manifest\'s template and no other, so the manifests stay the one source', () => {
    const declared: Record<string, string> = Object.fromEntries(BUNDLED_MANIFESTS.flatMap((m) => (m.resumeCommand === undefined ? [] : [[m.name, m.resumeCommand]])));
    expect(RESUME_COMMANDS).toEqual(declared);
    for (const template of Object.values(RESUME_COMMANDS)) expect(template).toContain('{sessionId}');
  });
});
