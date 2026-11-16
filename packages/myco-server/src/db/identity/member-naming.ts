import type { RelationalStore } from '../../core/adapters.js';
import { FIRST_MEMBER_KEY, FIRST_OWNER_MEMBER_LABEL } from '../../core/ownership.js';
import { read, readSet, write, commit } from '../index.js';
export const GITHUB_LOGIN_KEY_PREFIX = 'github_login:';

/**
 * Whether the member row `table` names nobody: no label, a blank one, the member's own id (what a join writes when
 * nothing better is given), the id of the machine a member carried over from one was made from (`mem_<machine>`), or
 * the first-owner placeholder on the first owner. Such a member takes the GitHub login
 * it signs in with as its name; any other label is a name someone gave and stands. `placeholder` and `receiptKey`
 * are the slots holding FIRST_OWNER_MEMBER_LABEL and FIRST_MEMBER_KEY.
 */
export const namesNobodySql = (table: string, placeholder: string, receiptKey: string): string =>
  `(${table}.label IS NULL OR TRIM(${table}.label) = '' OR ${table}.label = ${table}.id OR 'mem_' || ${table}.label = ${table}.id
    OR (${table}.label = ${placeholder} AND ${table}.id = (SELECT value FROM schema_meta WHERE key = ${receiptKey})))`;

const currentLogin = read<[loginPrefix: string, receiptKey: string, memberId: string, githubId: string, placeholder: string], { login: string | null; unnamed: number }>({
  name: 'identity.currentLogin',
  sql: `SELECT (SELECT value FROM schema_meta WHERE key = ?1 || m.github_id) AS login, ${namesNobodySql('m', '?5', '?2')} AS unnamed
    FROM members m WHERE m.id = ?3 AND m.github_id = ?4 AND m.revoked_at IS NULL`,
});
const name = write<[login: string, memberId: string, githubId: string, placeholder: string, receiptKey: string], { label: string }>({
  name: 'identity.nameFromLogin',
  sql: `UPDATE members SET label = ?1 WHERE id = ?2 AND github_id = ?3 AND revoked_at IS NULL AND ${namesNobodySql('members', '?4', '?5')} RETURNING label`,
});
const remember = write<[string, string, string, string]>({
  name: 'identity.rememberLogin',
  sql: `INSERT INTO schema_meta (key, value)
      SELECT ? || github_id, ? FROM members WHERE id = ? AND github_id = ? AND revoked_at IS NULL
      ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE schema_meta.value <> excluded.value`,
});
export async function nameFromLogin(db: RelationalStore, memberId: string, githubId: string, login: string): Promise<string | null> {
  const [[current]] = await readSet(db, currentLogin.bind(GITHUB_LOGIN_KEY_PREFIX, FIRST_MEMBER_KEY, memberId, githubId, FIRST_OWNER_MEMBER_LABEL));
  if (current === undefined || (current.login === login && current.unnamed === 0)) return null;
  const [named] = await commit(
    db,
    name.bind(login, memberId, githubId, FIRST_OWNER_MEMBER_LABEL, FIRST_MEMBER_KEY),
    remember.bind(GITHUB_LOGIN_KEY_PREFIX, login, memberId, githubId),
  );
  return named.results[0]?.label ?? null;
}
