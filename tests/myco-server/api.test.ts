import { describe, it, expect } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { resolveProjectScope } from '@myco-server-worker/api/scope.js';
import worker from '@myco-server-worker/index.js';
import { OWNER_ENV, ownerCookie, PRINCIPAL, asOwner, asOwnerPost } from './helpers/owner.js';
import { MEMBER_TOKEN_PATTERN } from '@myco-server-worker/auth/tokens.js';

/** The principal the chokepoint takes. Unread today; present so a grant check is one edit. */
describe('api scope resolution', () => {
  it('resolves a known project', async () => {
    const { db } = sqliteEnv();
    expect(await resolveProjectScope(db, PRINCIPAL, 'proj_1')).toEqual({ projectId: 'proj_1' });
  });

  it('resolves nothing for an unknown project — existence is not confirmed', async () => {
    const { db } = sqliteEnv();
    expect(await resolveProjectScope(db, PRINCIPAL, 'proj_missing')).toBeNull();
  });
});

describe('GET /api/projects', () => {
  it('lists projects for the owner', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(await asOwner('/api/projects'), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(200);
    expect((await res.json() as { projects: { projectId: string }[] }).projects.map((p) => p.projectId).sort()).toEqual(['proj_1', 'proj_2']);
  });

  it('refuses an anonymous caller', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(new Request('https://s/api/projects', { headers: { 'cf-connecting-ip': '1.2.3.4' } }), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(401);
  });
});

describe('sessions', () => {
  const seed = (e: ReturnType<typeof sqliteEnv>) => {
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, origin_path)
                  VALUES ('proj_1','s1','machine_1','tok_1',5,50,'claude-code','main','/repo'),
                         ('proj_2','s1','machine_9','tok_9',6,60,'other','feature','/elsewhere')`);
  };

  it('returns a session with the facts that identify the run', async () => {
    const e = sqliteEnv();
    seed(e);
    const res = await worker.fetch(await asOwner('/api/projects/proj_1/sessions/s1'), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(200);
    const body = await res.json() as { session: Record<string, unknown>; counts: Record<string, number> };
    expect(body.session).toMatchObject({
      sessionId: 's1', machineId: 'machine_1', createdByTokenId: 'tok_1',
      agent: 'claude-code', branch: 'main', originPath: '/repo',
    });
    expect(body.counts).toEqual({ prompts: 0, toolCalls: 0, responses: 0, plans: 0, attachments: 0 });
  });

  it('never serves another project\'s session under the same id', async () => {
    const e = sqliteEnv();
    seed(e);
    const res = await worker.fetch(await asOwner('/api/projects/proj_1/sessions/s1'), { ...e.env, ...OWNER_ENV });
    expect((await res.json() as { session: { machineId: string } }).session.machineId).toBe('machine_1');
    const other = await worker.fetch(await asOwner('/api/projects/proj_2/sessions/s1'), { ...e.env, ...OWNER_ENV });
    expect((await other.json() as { session: { machineId: string } }).session.machineId).toBe('machine_9');
  });

  it('answers 404 for an unknown session, and for a session outside the scope', async () => {
    const e = sqliteEnv();
    seed(e);
    for (const path of ['/api/projects/proj_1/sessions/nope', '/api/projects/proj_missing/sessions/s1']) {
      const res = await worker.fetch(await asOwner(path), { ...e.env, ...OWNER_ENV });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('refuses a malformed cursor rather than silently serving page one', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(await asOwner('/api/projects/proj_1/sessions?cursor=garbage'), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_request' });
  });

  it('serves a session\'s children in order, and refuses children of a session outside the scope', async () => {
    const e = sqliteEnv();
    seed(e);
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, prompt_id, session_id, event_id, origin, text, content_hash, created_at, updated_at, token_id, received_at)
                  VALUES ('proj_1','p1','s1','e1','user','first','h1',10,10,'tok_1',10),
                         ('proj_1','p2','s1','e2','user','second','h2',20,20,'tok_1',20)`);
    const res = await worker.fetch(await asOwner('/api/projects/proj_1/sessions/s1/prompts'), { ...e.env, ...OWNER_ENV });
    expect((await res.json() as { rows: { text: string }[] }).rows.map((r) => r.text)).toEqual(['first', 'second']);
    const outside = await worker.fetch(await asOwner('/api/projects/proj_1/sessions/absent/prompts'), { ...e.env, ...OWNER_ENV });
    expect(outside.status).toBe(404);
  });
});

describe('session turns', () => {
  const P1 = '00000000-0000-7000-8000-000000000001';
  const P2 = '00000000-0000-7000-8000-000000000002';
  const seed = (e: ReturnType<typeof sqliteEnv>) => {
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at)
                  VALUES ('proj_1','s1','machine_1','tok_1',5,50,'claude-code','main',5), ('proj_1','s2','machine_1','tok_1',6,60,'codex','fix',6)`);
    e.sqlite.run(`UPDATE sessions SET ended_at = 70 WHERE session_id = 's2'`);
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, prompt_id, session_id, event_id, origin, text, content_hash, created_at, updated_at, token_id, received_at)
                  VALUES ('proj_1',?,'s1','e1','user','first','h1',10,10,'tok_1',10), ('proj_1',?,'s1','e2','system','<system-reminder/>','h2',20,20,'tok_1',20)`, [P1, P2]);
    e.sqlite.run(`INSERT INTO tool_calls (project_id, session_id, tool_call_id, event_id, prompt_id, tool_name, success, created_at, token_id, received_at)
                  VALUES ('proj_1','s1','tc1','ev1',?,'Read',1,11,'tok_1',11), ('proj_1','s1','tc2','ev2',?,'Bash',1,21,'tok_1',21)`, [P1, P2]);
  };
  const get = async (e: ReturnType<typeof sqliteEnv>, path: string) => worker.fetch(await asOwner(path), { ...e.env, ...OWNER_ENV });

  it('lists the session\'s turns with counts, defaulting to what a person typed, and every origin on request', async () => {
    const e = sqliteEnv();
    seed(e);
    const res = await get(e, '/api/projects/proj_1/sessions/s1/turns');
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: { promptId: string; toolCallCount: number; preview: string }[]; cursor: string | null };
    expect(body.rows.map((r) => [r.promptId, r.toolCallCount, r.preview])).toEqual([[P1, 1, 'first']]);
    const all = await (await get(e, '/api/projects/proj_1/sessions/s1/turns?origins=user,system')).json() as { rows: { promptId: string }[] };
    expect(all.rows.map((r) => r.promptId)).toEqual([P1, P2]);
  });

  it('refuses an unknown origin and a malformed cursor, and answers not found outside the scope', async () => {
    const e = sqliteEnv();
    seed(e);
    expect((await get(e, '/api/projects/proj_1/sessions/s1/turns?origins=human')).status).toBe(400);
    expect((await get(e, '/api/projects/proj_1/sessions/s1/turns?cursor=garbage')).status).toBe(400);
    expect((await get(e, '/api/projects/proj_2/sessions/s1/turns')).status).toBe(404);
    expect((await get(e, `/api/projects/proj_1/sessions/s2/turns/${P1}`)).status).toBe(404);
    expect((await get(e, `/api/projects/proj_1/sessions/s2/turns/${P1}/tool-calls`)).status).toBe(404);
  });

  it('serves one turn\'s body and its tool calls on their own', async () => {
    const e = sqliteEnv();
    seed(e);
    const detail = await (await get(e, `/api/projects/proj_1/sessions/s1/turns/${P1}`)).json() as { prompt: { text: string }; responses: unknown[]; attachments: unknown[]; children: unknown[] };
    expect(detail.prompt.text).toBe('first');
    expect([detail.responses, detail.attachments, detail.children]).toEqual([[], [], []]);
    const calls = await (await get(e, `/api/projects/proj_1/sessions/s1/turns/${P1}/tool-calls`)).json() as { rows: { toolCallId: string }[] };
    expect(calls.rows.map((t) => t.toolCallId)).toEqual(['tc1']);
  });

  it('titles a session on an owner\'s ask, answering the outcome, and finds nothing outside the scope', async () => {
    const e = sqliteEnv();
    seed(e);
    const res = await worker.fetch(await asOwnerPost('/api/projects/proj_1/sessions/s1/title'), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(200);
    // No provider is configured in the fixture: the ask is claimed and answered, not thrown.
    expect(await res.json()).toEqual({ outcome: 'no_provider' });
    expect((await worker.fetch(await asOwnerPost('/api/projects/proj_2/sessions/s2/title'), { ...e.env, ...OWNER_ENV })).status).toBe(404);
    expect((await worker.fetch(await asOwnerPost('/api/projects/proj_1/sessions/absent/title'), { ...e.env, ...OWNER_ENV })).status).toBe(404);
  });

  it('sets a plan\'s status as the signed-in member, refuses a status outside the writable set, and finds nothing outside the session', async () => {
    const e = sqliteEnv();
    seed(e);
    const key = '00000000-0000-5000-8000-000000000002';
    e.sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, content, content_hash, status, created_at, updated_at, token_id, received_at)
                  VALUES ('proj_1',?,'s1','ep1','machine_1','- [ ] a','h','active',10,10,'tok_1',10)`, [key]);
    const post = async (path: string, body: unknown) => worker.fetch(await asOwnerPost(path, body), { ...e.env, ...OWNER_ENV });
    const res = await post(`/api/projects/proj_1/sessions/s1/plans/${key}/status`, { status: 'completed' });
    expect(res.status).toBe(200);
    const body = await res.json() as { plan: { status: string; updatedBy: string | null; progress: string; updatedAt: number } };
    expect([body.plan.status, body.plan.updatedBy, body.plan.progress, body.plan.updatedAt > 10]).toEqual(['completed', PRINCIPAL.id, '0/1', true]);
    expect((await post(`/api/projects/proj_1/sessions/s1/plans/${key}/status`, { status: 'all' })).status).toBe(400);
    expect((await post(`/api/projects/proj_1/sessions/s1/plans/${key}/status`, 'nope')).status).toBe(400);
    expect((await post(`/api/projects/proj_1/sessions/s2/plans/${key}/status`, { status: 'active' })).status).toBe(404);
    expect((await post(`/api/projects/proj_1/sessions/s1/plans/00000000-0000-5000-8000-000000000009/status`, { status: 'active' })).status).toBe(404);
  });

  it('lists sessions with their rail facts and honours the state, branch and text filters', async () => {
    const e = sqliteEnv();
    seed(e);
    const rows = async (query: string) => ((await (await get(e, `/api/projects/proj_1/sessions${query}`)).json()) as { rows: { sessionId: string; promptCount: number; toolCallCount: number; activityBuckets: number[] }[] }).rows;
    const all = await rows('');
    expect(all.map((r) => [r.sessionId, r.promptCount, r.toolCallCount, r.activityBuckets.length])).toEqual([['s2', 0, 0, 8], ['s1', 2, 2, 8]]);
    expect((await rows('?state=open')).map((r) => r.sessionId)).toEqual(['s1']);
    expect((await rows('?state=ended')).map((r) => r.sessionId)).toEqual(['s2']);
    expect((await rows('?branch=fix')).map((r) => r.sessionId)).toEqual(['s2']);
    expect((await rows('?q=claude')).map((r) => r.sessionId)).toEqual(['s1']);
    expect((await get(e, '/api/projects/proj_1/sessions?state=live')).status).toBe(400);
  });
});

describe('credentials', () => {
  it('lists without the hash, pages newest lineage first, reports what a credential wrote across projects, and revokes naming who', async () => {
    const e = sqliteEnv();
    const { issueMemberToken } = await import('@myco-server-worker/auth/tokens.js');
    const first = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, 1_000);
    const second = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, 2_000);
    e.sqlite.run(`INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
                  VALUES ('proj_1','ev1','s1',?,'prompt','cli','{}','h1',10,10), ('proj_2','ev2','s2',?,'prompt','cli','{}','h2',20,20)`, [first.tokenId, first.tokenId]);

    const listed = await worker.fetch(await asOwner('/api/credentials?limit=1'), { ...e.env, ...OWNER_ENV });
    const raw = await listed.text();
    expect(raw).not.toContain('token_hash');
    const page = JSON.parse(raw) as { rows: { id: string }[]; cursor: string | null };
    expect(page.rows.map((t) => t.id)).toEqual([second.tokenId]);
    const next = await worker.fetch(await asOwner(`/api/credentials?limit=1&cursor=${encodeURIComponent(page.cursor!)}`), { ...e.env, ...OWNER_ENV });
    expect((await next.json() as { rows: { id: string }[] }).rows.map((t) => t.id)).toEqual([first.tokenId]);

    const activity = await worker.fetch(await asOwner(`/api/credentials/${first.tokenId}/activity`), { ...e.env, ...OWNER_ENV });
    expect((await activity.json() as { rows: { eventId: string; projectId: string }[] }).rows.map((r) => `${r.projectId}:${r.eventId}`)).toEqual(['proj_2:ev2', 'proj_1:ev1']);

    const revoked = await worker.fetch(await asOwnerPost(`/api/credentials/${first.tokenId}/revoke`), { ...e.env, ...OWNER_ENV });
    expect(await revoked.json()).toEqual({ revoked: true, revokedBy: PRINCIPAL.id });
    expect(e.sqlite.query(`SELECT revoked_by FROM member_credentials WHERE id = ?`).get(first.tokenId)).toEqual({ revoked_by: PRINCIPAL.id });
    const again = await worker.fetch(await asOwnerPost(`/api/credentials/${first.tokenId}/revoke`), { ...e.env, ...OWNER_ENV });
    expect(await again.json()).toEqual({ revoked: false, revokedBy: PRINCIPAL.id });
  });

  it('denial of enrollment is attributable, not prevented: one member can revoke another\'s credential, and the record names who did', async () => {
    const e = sqliteEnv();
    const { issueMemberToken } = await import('@myco-server-worker/auth/tokens.js');
    const theirs = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, 1_000);
    const revoked = await worker.fetch(await asOwnerPost(`/api/credentials/${theirs.tokenId}/revoke`), { ...e.env, ...OWNER_ENV });
    expect(await revoked.json()).toEqual({ revoked: true, revokedBy: PRINCIPAL.id });
    expect(e.sqlite.query(`SELECT member_id, revoked_by FROM member_credentials WHERE id = ?`).get(theirs.tokenId))
      .toEqual({ member_id: 'mem_machine_2', revoked_by: PRINCIPAL.id });
  });
});

describe('blob bytes', () => {
  it('serves stored bytes in scope and 404s a blob recorded under another project', async () => {
    const e = sqliteEnv();
    const key = 'a'.repeat(64);
    e.sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES ('proj_2','${key}',5,'text/plain; charset=utf-8','t1',1)`);
    e.bucket.objects.set(`proj_2/${key}`, { size: 5, contentType: 'text/plain; charset=utf-8' });

    const wrong = await worker.fetch(await asOwner(`/api/projects/proj_1/blobs/${key}`), { ...e.env, ...OWNER_ENV });
    expect(wrong.status).toBe(404);

    const right = await worker.fetch(await asOwner(`/api/projects/proj_2/blobs/${key}`), { ...e.env, ...OWNER_ENV });
    expect(right.status).toBe(200);
    expect(right.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });
});

describe('GET /api/status', () => {
  it('reports schema agreement and every capability present', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(await asOwner('/api/status'), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      schema: { matches: boolean; found: number };
      capabilities: { capability: string; label: string; present: boolean; operatorNames: string[] }[];
    };
    expect(body.schema.matches).toBe(true);
    expect(body.capabilities.filter((c) => !c.present)).toEqual([]);
    expect(body.capabilities.map((c) => c.capability).sort())
      .toEqual(['blob-store', 'rate-limiting', 'relational-store']);
  });

  it('reports the capability a dropped binding took with it, and which name to fix', async () => {
    const e = sqliteEnv();
    const { BUCKET: _dropped, ...withoutBucket } = e.env as Record<string, unknown>;
    const res = await worker.fetch(await asOwner('/api/status'), { ...withoutBucket, ...OWNER_ENV } as never);
    const body = await res.json() as {
      capabilities: { capability: string; label: string; present: boolean; operatorNames: string[] }[];
    };

    const absent = body.capabilities.filter((c) => !c.present);
    expect(absent.map((c) => c.capability)).toEqual(['blob-store']);
    // Product wording for the statement, operator wording for the fix.
    expect(absent[0]!.label).toBe('Blob storage');
    expect(absent[0]!.operatorNames).toEqual(['BUCKET']);
  });
});

describe('project creation', () => {
  it('onboards a project, and a member then mints an invitation for a runtime', async () => {
    const e = sqliteEnv();
    const created = await worker.fetch(await asOwnerPost('/api/projects', { projectId: 'proj_new', name: 'New' }), { ...e.env, ...OWNER_ENV });
    expect(created.status).toBe(201);
    const minted = await worker.fetch(await asOwnerPost('/api/enrollment', { memberId: 'mem_machine_1' }), { ...e.env, ...OWNER_ENV });
    expect(minted.status).toBe(201);
  });

  it('refuses a duplicate and an out-of-grammar id', async () => {
    const e = sqliteEnv();
    const dupe = await worker.fetch(await asOwnerPost('/api/projects', { projectId: 'proj_1', name: 'One' }), { ...e.env, ...OWNER_ENV });
    expect(dupe.status).toBe(400);
    for (const projectId of ['..', 'has space', 'x'.repeat(65), '']) {
      const res = await worker.fetch(await asOwnerPost('/api/projects', { projectId, name: 'n' }), { ...e.env, ...OWNER_ENV });
      expect({ projectId, status: res.status }).toEqual({ projectId, status: 400 });
    }
  });
});

describe('blob bytes are never executable on the owner origin', () => {
  const store = (e: ReturnType<typeof sqliteEnv>, key: string, mediaType: string) => {
    e.sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES ('proj_1','${key}',5,'${mediaType}','t1',1)`);
    e.bucket.objects.set(`proj_1/${key}`, { size: 5, contentType: mediaType });
  };

  it('refuses to reflect a member-chosen html type', async () => {
    const e = sqliteEnv();
    const key = 'c'.repeat(64);
    store(e, key, 'text/html');
    const res = await worker.fetch(await asOwner(`/api/projects/proj_1/blobs/${key}`), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it('carries a no-script policy whatever the type', async () => {
    const e = sqliteEnv();
    const key = 'd'.repeat(64);
    store(e, key, 'image/png');
    const res = await worker.fetch(await asOwner(`/api/projects/proj_1/blobs/${key}`), { ...e.env, ...OWNER_ENV });
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('keeps its own cache-control through the security stamp', async () => {
    const e = sqliteEnv();
    const key = 'e'.repeat(64);
    store(e, key, 'image/png');
    const res = await worker.fetch(await asOwner(`/api/projects/proj_1/blobs/${key}`), { ...e.env, ...OWNER_ENV });
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
  });

  it('leaves every other response no-store', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(await asOwner('/api/projects'), { ...e.env, ...OWNER_ENV });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('owner request bodies are bounded', () => {
  it('refuses a body over the cap the member path enforces', async () => {
    const e = sqliteEnv();
    const huge = 'x'.repeat(400_000);
    const res = await worker.fetch(
      new Request('https://s/api/enrollment', {
        method: 'POST',
        headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
        body: JSON.stringify({ pad: huge }),
      }),
      { ...e.env, ...OWNER_ENV }
    );
    expect(res.status).toBe(400);
  });

  it('refuses a member id outside the grammar the join path records', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(await asOwnerPost('/api/enrollment', { memberId: `mem_${'x'.repeat(65)}` }), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(400);
  });
});

describe('finding 1 closed: an exotic session id opens', () => {
  it('serves a session whose id ingest accepts but the old grammar refused', async () => {
    const e = sqliteEnv();
    const weird = 'agent run #7 (café)+~';
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                  VALUES ('proj_1',?,'m','t',1,2)`, [weird] as never);
    const res = await worker.fetch(
      new Request(`https://s/api/projects/proj_1/sessions/${encodeURIComponent(weird)}`, { headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' } }),
      { ...e.env, ...OWNER_ENV }
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { session: { sessionId: string } }).session.sessionId).toBe(weird);
  });
});
