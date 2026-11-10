import type { RelationalStore } from '../../core/adapters.js';
import { memberWritePredicate } from '../../auth/authorization.js';
import { MemberWriteRefused } from '../../auth/member-write-store.js';
import { first, read, write } from '../index.js';

const issue = write<[id: string, actor: string, at: number, attempt: number | null, forgettableAt: number | null], { id: string }>({ name: 'recovery.issueForget', sql:
  `INSERT INTO recovery_forget_commands (id, actor_id, created_at, attempt, forgettable_at)
    SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${memberWritePredicate('?2', 'NULL')} RETURNING id` });
const command = read<[id: string], { attempt: number | null; forgettableAt: number | null }>({ name: 'recovery.forgetCommand', sql:
  'SELECT attempt, forgettable_at AS forgettableAt FROM recovery_forget_commands WHERE id = ?1' });

/** The relational write issues one durable command, under the actor's current write authority; the producer applies that command once. */
export async function issueRecoveryForget(db: RelationalStore, actorId: string, now: number, target: { attempt: number; forgettableAt: number } | null): Promise<string> {
  const issued = await first(db, issue.bind(crypto.randomUUID(), actorId, now, target?.attempt ?? null, target?.forgettableAt ?? null));
  if (issued === null) throw new MemberWriteRefused();
  return issued.id;
}

/** A checkpoint command is authorized by its committed issuance, independent of a request's cached role. */
export function readRecoveryForget(db: RelationalStore, id: string): Promise<{ attempt: number | null; forgettableAt: number | null } | null> {
  return first(db, command.bind(id));
}
