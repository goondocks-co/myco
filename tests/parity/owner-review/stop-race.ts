import type { PreparedStatement, RelationalStore } from '../../../packages/myco-server/src/core/adapters.ts';

const STOP_WRITE = /^UPDATE member_credentials SET revoked_at\s*=/i;

/** A one-shot interleaving at the real credential UPDATE, after the HTTP route has resolved its actor. */
export function stopRaceFixture() {
  let pendingMemberId: string | null = null;
  let fired = false;

  const wrap = (db: RelationalStore): RelationalStore => {
    const originals = new WeakMap<PreparedStatement, PreparedStatement>();
    const statement = (sql: string, original: PreparedStatement): PreparedStatement => {
      const wrapped: PreparedStatement = {
        bind: (...values) => statement(sql, original.bind(...values)),
        first: <T = Record<string, unknown>>() => original.first<T>(),
        all: <T = Record<string, unknown>>() => original.all<T>(),
        run: async () => {
          if (pendingMemberId !== null && STOP_WRITE.test(sql)) {
            const memberId = pendingMemberId;
            pendingMemberId = null;
            await db.prepare("UPDATE members SET role = 'member', role_revision = role_revision + 1 WHERE id = ? AND role = 'admin'")
              .bind(memberId).run();
            fired = true;
          }
          return original.run();
        },
      };
      originals.set(wrapped, original);
      return wrapped;
    };
    return {
      prepare: (sql) => statement(sql, db.prepare(sql)),
      batch: (statements) => db.batch(statements.map(value => originals.get(value) ?? value)),
    };
  };

  const endpoint = async (request: Request): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    if (path === '/__parity/stop-race/arm' && request.method === 'POST') {
      const body = await request.json() as { memberId?: unknown };
      if (typeof body.memberId !== 'string') return new Response(null, { status: 400 });
      pendingMemberId = body.memberId;
      fired = false;
      return Response.json({ armed: true });
    }
    if (path === '/__parity/stop-race/status' && request.method === 'GET') {
      return Response.json({ fired, armed: pendingMemberId !== null });
    }
    return null;
  };

  return { wrap, endpoint };
}
