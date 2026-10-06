import { issueRecoveryForget } from '../../../packages/myco-server/src/core/recovery-forget.ts';
import { MemberWriteRefused, memberWriteStore } from '../../../packages/myco-server/src/auth/member-write-store.ts';
import type { PreparedStatement, RelationalStore } from '../../../packages/myco-server/src/core/adapters.ts';

const STOP_WRITE = /^UPDATE member_credentials SET revoked_at\s*=/i;

/** A one-shot interleaving at the real credential UPDATE, after the HTTP route has resolved its actor. */
export function stopRaceFixture() {
  let pendingMemberId: string | null = null;
  let fired = false;
  let write = STOP_WRITE;
  let revoke = false;
  let serving: RelationalStore | undefined;

  const wrap = (db: RelationalStore): RelationalStore => {
    const originals = new WeakMap<PreparedStatement, { original: PreparedStatement; sql: string }>();
    const interleave = async (sql: string) => {
      if (pendingMemberId === null || !write.test(sql)) return;
      const memberId = pendingMemberId;
      pendingMemberId = null;
      await db.prepare(revoke ? 'UPDATE members SET revoked_at = 1 WHERE id = ?'
        : "UPDATE members SET role = 'member', role_revision = role_revision + 1 WHERE id = ? AND role = 'admin'")
        .bind(memberId).run();
      fired = true;
    };
    const statement = (sql: string, original: PreparedStatement): PreparedStatement => {
      const wrapped: PreparedStatement = {
        bind: (...values) => statement(sql, original.bind(...values)),
        first: <T = Record<string, unknown>>() => original.first<T>(),
        all: <T = Record<string, unknown>>() => original.all<T>(),
        run: async () => { await interleave(sql); return original.run(); },
      };
      originals.set(wrapped, { original, sql });
      return wrapped;
    };
    const store: RelationalStore = {
      prepare: (sql) => statement(sql, db.prepare(sql)),
      batch: async (statements) => {
        const captured = statements.map(value => originals.get(value));
        for (const held of captured) if (held !== undefined) await interleave(held.sql);
        return db.batch(statements.map((value, index) => captured[index]?.original ?? value));
      },
    };
    serving = store;
    return store;
  };

  const endpoint = async (request: Request): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    if (path === '/__parity/live-write' && request.method === 'POST' && serving !== undefined) {
      const body = await request.json() as { memberId: string; operation: string; projectId: string };
      try {
        if (body.operation === 'recovery') return Response.json({ id: await issueRecoveryForget(serving, body.memberId, Date.now(), null) });
        const db = memberWriteStore(serving, body.memberId, 'admin');
        const statement = db.prepare("WITH target AS (SELECT ? AS id) UPDATE projects SET name='returning write' WHERE project_id=(SELECT id FROM target) RETURNING name").bind(body.projectId);
        return Response.json(await (body.operation === 'first' ? statement.first() : statement.all()));
      } catch (error) {
        if (error instanceof MemberWriteRefused) return Response.json({ error: 'not_admin' }, { status: 403 });
        throw error;
      }
    }
    if (path === '/__parity/stop-race/arm'  && request.method === 'POST') {
      const body = await request.json() as { memberId?: unknown; write?: string; revoke?: boolean };
      if (typeof body.memberId !== 'string') return new Response(null, { status: 400 });
      pendingMemberId = body.memberId;
      fired = false;
      write = body.write === undefined ? STOP_WRITE : new RegExp(body.write, 'i');
      revoke = body.revoke === true;
      return Response.json({ armed: true });
    }
    if (path === '/__parity/stop-race/status' && request.method === 'GET') {
      return Response.json({ fired, armed: pendingMemberId !== null });
    }
    return null;
  };

  return { wrap, endpoint };
}
