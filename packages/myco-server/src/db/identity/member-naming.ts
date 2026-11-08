import type { RelationalStore } from '../../core/adapters.js';
import { FIRST_MEMBER_KEY, FIRST_OWNER_MEMBER_LABEL } from '../../core/ownership.js';
import { read, readSet, write, commit } from '../index.js';
export const GITHUB_LOGIN_KEY_PREFIX = 'github_login:';
const currentLogin = read<[string, string, string, string], { label: string | null; login: string | null; firstOwner: number }>({
  name: 'identity.currentLogin',
  sql: `SELECT m.label,
    (SELECT value FROM schema_meta WHERE key = ? || m.github_id) AS login,
    m.id = (SELECT value FROM schema_meta WHERE key = ?) AS firstOwner
    FROM members m WHERE m.id = ? AND m.github_id = ? AND m.revoked_at IS NULL`,
});
const name = write<[string, string, string, string, string], { label: string }>({
  name: 'identity.nameFromLogin',
  sql: `UPDATE members SET label = ? WHERE id = ? AND github_id = ? AND revoked_at IS NULL AND (label IS NULL OR (label = ? AND id = (SELECT value FROM schema_meta WHERE key = ?))) RETURNING label`,
});
const remember = write<[string, string, string, string]>({
  name: 'identity.rememberLogin',
  sql: `INSERT INTO schema_meta (key, value)
      SELECT ? || github_id, ? FROM members WHERE id = ? AND github_id = ? AND revoked_at IS NULL
      ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE schema_meta.value <> excluded.value`,
});
export async function nameFromLogin(db: RelationalStore, memberId: string, githubId: string, login: string): Promise<string | null> {
  const [[current]] = await readSet(db, currentLogin.bind(GITHUB_LOGIN_KEY_PREFIX, FIRST_MEMBER_KEY, memberId, githubId));
  if (
    current === undefined ||
    (current.login === login && current.label !== null && !(current.label === FIRST_OWNER_MEMBER_LABEL && current.firstOwner === 1))
  )
    return null;
  const [named] = await commit(
    db,
    name.bind(login, memberId, githubId, FIRST_OWNER_MEMBER_LABEL, FIRST_MEMBER_KEY),
    remember.bind(GITHUB_LOGIN_KEY_PREFIX, login, memberId, githubId),
  );
  return named.results[0]?.label ?? null;
}
