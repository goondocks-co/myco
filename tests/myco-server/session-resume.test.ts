/**
 * The resume command on a session's detail (`GET /api/projects/{p}/sessions/{s}` → `resumeCommand`).
 *
 * It comes from the capturing agent's symbiont manifest, carried into myco-shared by `gen-hook-config.ts`, with the
 * session id filled in. An agent whose manifest names none, a session with no agent, and an id that is not a plain
 * token all answer null.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { RESUME_COMMANDS } from '@goondocks/myco-shared/resume-commands-data';
import { BUNDLED_MANIFESTS } from '../../packages/myco/src/symbionts/manifests.generated';

function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const session = (id: string, agent: string | null) =>
    fixture.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent)
                        VALUES ('proj_1', ?, 'm1', 'tok_1', 1, 1, ?)`, [id, agent]);
  const resume = async (id: string, sub?: string) => {
    const res = await worker.fetch(new Request(`https://s/api/projects/proj_1/sessions/${encodeURIComponent(id)}`, { headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), env);
    expect(res.status).toBe(200);
    return (await res.json() as { resumeCommand: string | null }).resumeCommand;
  };
  return { sqlite: fixture.sqlite, session, resume };
}

describe('the resume command on a session', () => {
  it('fills in each agent\'s manifest template with the session id', async () => {
    const h = harness();
    h.session('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', 'codex');
    h.session('5f8e7d6c-1a2b-4c3d-9e8f-7a6b5c4d3e2f', 'claude-code');
    h.session('1781655805296_o3zf7', 'cline');
    h.session('ses_4b7a1c2d', 'opencode');
    expect(await h.resume('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toBe('codex resume 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
    expect(await h.resume('5f8e7d6c-1a2b-4c3d-9e8f-7a6b5c4d3e2f')).toBe('claude --resume 5f8e7d6c-1a2b-4c3d-9e8f-7a6b5c4d3e2f');
    expect(await h.resume('1781655805296_o3zf7')).toBe('cline --id 1781655805296_o3zf7');
    expect(await h.resume('ses_4b7a1c2d')).toBe('opencode --session ses_4b7a1c2d');
  });

  it('answers null for an agent with no template, a session with no agent, and an id that is not a plain token', async () => {
    const h = harness();
    h.session('cursor-chat-1', 'cursor');
    h.session('no-agent', null);
    h.session('abc;touch x', 'codex');
    h.session('$(id)', 'claude-code');
    expect(await h.resume('cursor-chat-1')).toBeNull();
    expect(await h.resume('no-agent')).toBeNull();
    expect(await h.resume('abc;touch x')).toBeNull();
    expect(await h.resume('$(id)')).toBeNull();
  });

  it('is read by a member who is not an admin', async () => {
    const h = harness();
    seedMemberRoleAccount(h.sqlite);
    h.session('0199a1b2-aaaa-7e5f-8a9b-0c1d2e3f4a5b', 'codex');
    expect(await h.resume('0199a1b2-aaaa-7e5f-8a9b-0c1d2e3f4a5b', MEMBER_SUB)).toBe('codex resume 0199a1b2-aaaa-7e5f-8a9b-0c1d2e3f4a5b');
  });

  it('carries every manifest\'s template and no other, so the manifests stay the one source', () => {
    const declared: Record<string, string> = Object.fromEntries(BUNDLED_MANIFESTS.flatMap((m) => (m.resumeCommand === undefined ? [] : [[m.name, m.resumeCommand]])));
    expect(RESUME_COMMANDS).toEqual(declared);
    for (const template of Object.values(RESUME_COMMANDS)) expect(template).toContain('{sessionId}');
  });
});
