import { describe, it, expect } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { resolveProjectScope } from '@myco-server-worker/api/scope.js';
import worker from '@myco-server-worker/index.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { MEMBER_TOKEN_PATTERN } from '@myco-server-worker/auth/tokens.js';

/** The principal the chokepoint takes. Unread today; present so a grant check is one edit. */
const PRINCIPAL = { sub: '583231', iat: 0, exp: 9_999_999_999_999 };

const asOwner = async (path: string) =>
  new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' } });

const asOwnerPost = async (path: string, body?: unknown) =>
  new Request(`https://s${path}`, {
    method: 'POST',
    headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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

describe('tokens', () => {
  it('mints once, lists without the hash, revokes, and reports what the token wrote', async () => {
    const e = sqliteEnv();
    const minted = await worker.fetch(await asOwnerPost('/api/projects/proj_1/tokens', { machineId: 'machine_1' }), { ...e.env, ...OWNER_ENV });
    expect(minted.status).toBe(201);
    const issued = await minted.json() as { id: string; token: string };
    // The id carries the `mt_` prefix; the secret itself is bare base64url and must satisfy
    // the pattern the pipeline admits, or a freshly minted token could not authenticate.
    expect(issued.id.startsWith('mt_')).toBe(true);
    expect(MEMBER_TOKEN_PATTERN.test(issued.token)).toBe(true);

    const listed = await worker.fetch(await asOwner('/api/projects/proj_1/tokens'), { ...e.env, ...OWNER_ENV });
    const raw = await listed.text();
    expect(raw).not.toContain(issued.token);
    expect(raw).not.toContain('token_hash');
    expect((JSON.parse(raw) as { tokens: { id: string }[] }).tokens.map((t) => t.id)).toEqual([issued.id]);

    e.sqlite.run(`INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
                  VALUES ('proj_1','ev1','s1','${issued.id}','prompt','cli','{}','h1',10,10)`);
    const activity = await worker.fetch(await asOwner(`/api/projects/proj_1/tokens/${issued.id}/activity`), { ...e.env, ...OWNER_ENV });
    expect((await activity.json() as { rows: { eventId: string }[] }).rows.map((r) => r.eventId)).toEqual(['ev1']);

    const revoked = await worker.fetch(await asOwnerPost(`/api/projects/proj_1/tokens/${issued.id}/revoke`), { ...e.env, ...OWNER_ENV });
    expect(await revoked.json()).toEqual({ revoked: true, revokedBy: PRINCIPAL.sub });
  });

  it('revokes a credential whatever project segment the path carries, and names who revoked it', async () => {
    // Membership is flat: a credential belongs to a member and the Deployment, so no
    // project owns it and none can withhold it. The project segment is inert here — the
    // dashboard re-scope in #918 removes it — and every revocation records its actor.
    const e = sqliteEnv();
    const minted = await worker.fetch(await asOwnerPost('/api/projects/proj_2/tokens', { machineId: 'machine_2' }), { ...e.env, ...OWNER_ENV });
    const issued = await minted.json() as { id: string };
    const res = await worker.fetch(await asOwnerPost(`/api/projects/proj_1/tokens/${issued.id}/revoke`), { ...e.env, ...OWNER_ENV });
    expect(await res.json()).toEqual({ revoked: true, revokedBy: PRINCIPAL.sub });
    // The actor lands in the same statement that revokes: a revocation and the record of
    // who made it cannot come apart, so an operator can always answer who ended it.
    expect(e.sqlite.query(`SELECT revoked_by FROM member_credentials WHERE id = ?`).get(issued.id)).toEqual({ revoked_by: PRINCIPAL.sub });
    expect((e.sqlite.query(`SELECT revoked_at FROM member_credentials WHERE id = ?`).get(issued.id) as any).revoked_at).not.toBeNull();
    // A second revoke changes nothing: the row is already revoked.
    const again = await worker.fetch(await asOwnerPost(`/api/projects/proj_1/tokens/${issued.id}/revoke`), { ...e.env, ...OWNER_ENV });
    expect(await again.json()).toEqual({ revoked: false, revokedBy: PRINCIPAL.sub });
  });

  it('denial of enrollment is attributable, not prevented: one member can revoke another\'s credential, and the record names who did', async () => {
    // Flat membership puts revocation in reach of every member, so the threat here is
    // denial of service rather than disclosure — a member ending somebody else's
    // credential. That is accepted (D5) on the condition it can always be attributed:
    // a destroy path that does not record its actor is the shape of Vault
    // CVE-2023-24999, where an endpoint neither checked nor recorded who called it.
    const e = sqliteEnv();
    const theirs = await worker.fetch(await asOwnerPost('/api/projects/proj_1/tokens', { machineId: 'machine_2', memberId: 'mem_them' }), { ...e.env, ...OWNER_ENV });
    const victim = await theirs.json() as { id: string; token: string };

    const revoked = await worker.fetch(await asOwnerPost(`/api/projects/proj_1/tokens/${victim.id}/revoke`), { ...e.env, ...OWNER_ENV });
    expect(await revoked.json()).toEqual({ revoked: true, revokedBy: PRINCIPAL.sub });

    // The victim is denied — and the row says who denied them, and whose credential it was.
    expect(e.sqlite.query(`SELECT member_id, revoked_by FROM member_credentials WHERE id = ?`).get(victim.id))
      .toEqual({ member_id: 'mem_them', revoked_by: PRINCIPAL.sub });
    const after = await worker.fetch(new Request('https://s/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${victim.token}`, 'cf-connecting-ip': '1.2.3.4', 'x-myco-project': 'proj_1', 'x-myco-protocol': '1' },
      body: '{}',
    }), e.env);
    expect(after.status).toBe(401);
  });

  it('refuses a mint with no machine identity', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(await asOwnerPost('/api/projects/proj_1/tokens', {}), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(400);
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
  it('reports schema agreement and binding presence', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(await asOwner('/api/status'), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(200);
    const body = await res.json() as { schema: { matches: boolean; found: number }; bindings: { missing: string[] } };
    expect(body.schema.matches).toBe(true);
    expect(body.bindings.missing).toEqual([]);
  });

  it('names a binding the deploy dropped', async () => {
    const e = sqliteEnv();
    const { BUCKET: _dropped, ...withoutBucket } = e.env as Record<string, unknown>;
    const res = await worker.fetch(await asOwner('/api/status'), { ...withoutBucket, ...OWNER_ENV } as never);
    expect((await res.json() as { bindings: { missing: string[] } }).bindings.missing).toEqual(['BUCKET']);
  });
});

describe('project creation', () => {
  it('onboards a project and then mints its first token', async () => {
    const e = sqliteEnv();
    const created = await worker.fetch(await asOwnerPost('/api/projects', { projectId: 'proj_new', name: 'New' }), { ...e.env, ...OWNER_ENV });
    expect(created.status).toBe(201);
    const minted = await worker.fetch(await asOwnerPost('/api/projects/proj_new/tokens', { machineId: 'machine_1' }), { ...e.env, ...OWNER_ENV });
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
      new Request('https://s/api/projects/proj_1/tokens', {
        method: 'POST',
        headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
        body: JSON.stringify({ machineId: 'm', pad: huge }),
      }),
      { ...e.env, ...OWNER_ENV }
    );
    expect(res.status).toBe(400);
  });

  it('refuses a machine identity outside the grammar ingest accepts', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(await asOwnerPost('/api/projects/proj_1/tokens', { machineId: 'x'.repeat(65) }), { ...e.env, ...OWNER_ENV });
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
