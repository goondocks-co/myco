import { memberWritePredicate } from '../auth/authorization.js';
import { MemberWriteRefused } from '../auth/member-write-store.js';
import type { RelationalStore } from './adapters.js';

/** The relational write issues one durable command; the producer applies that command once. */
export async function issueRecoveryForget(db: RelationalStore, actorId: string, now: number, target: { attempt: number; forgettableAt: number } | null): Promise<string> {
  const id = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO recovery_forget_commands (id, actor_id, created_at, attempt, forgettable_at)
    SELECT ?, ?, ?, ?, ? WHERE ${memberWritePredicate('?', 'NULL')}`).bind(id, actorId, now, target?.attempt ?? null, target?.forgettableAt ?? null, actorId).run();
  if (result.meta.changes !== 1) throw new MemberWriteRefused();
  return id;
}

/** A checkpoint command is authorized by its committed issuance, independent of a request's cached role. */
export async function readRecoveryForget(db: RelationalStore, id: string): Promise<{ attempt: number | null; forgettableAt: number | null } | null> {
  return db.prepare('SELECT attempt, forgettable_at AS forgettableAt FROM recovery_forget_commands WHERE id = ?').bind(id).first();
}
