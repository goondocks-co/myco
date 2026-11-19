import type { RelationalStore } from '../../core/adapters.js';
import { read, rows, write } from '../index.js';

/** A GitHub account whose App installations this Deployment's admins approved, as GitHub named it when approved. */
export interface ApprovedAccount {
  accountId: number;
  login: string;
  type: 'User' | 'Organization';
  approvedBy: string;
  approvedAt: number;
}

const COLUMNS = 'account_id AS accountId,login,account_type AS type,approved_by AS approvedBy,approved_at AS approvedAt';
const all = read<[], ApprovedAccount>({ name: 'githubApp.approvedAccounts', sql: `SELECT ${COLUMNS} FROM github_app_accounts ORDER BY login,account_id` });
const one = read<[account: number], ApprovedAccount>({ name: 'githubApp.approvedAccount', sql: `SELECT ${COLUMNS} FROM github_app_accounts WHERE account_id=?1` });
const approve = write<[account: number, login: string, type: string, by: string, at: number], ApprovedAccount>({ name: 'githubApp.approveAccount', sql:
  `INSERT INTO github_app_accounts(account_id,login,account_type,approved_by,approved_at) VALUES(?1,?2,?3,?4,?5)
   ON CONFLICT(account_id) DO UPDATE SET login=excluded.login,account_type=excluded.account_type RETURNING ${COLUMNS}` });
const withdraw = write<[account: number], { accountId: number }>({ name: 'githubApp.withdrawAccount', sql:
  'DELETE FROM github_app_accounts WHERE account_id=?1 RETURNING account_id AS accountId' });

export const approvedAccounts = (db: RelationalStore): Promise<ApprovedAccount[]> => rows(db, all.bind());
export const approvedAccount = async (db: RelationalStore, accountId: number): Promise<ApprovedAccount | null> => (await rows(db, one.bind(accountId)))[0] ?? null;
/** Answers the stored approval; an account approved before keeps who approved it and when. */
export const approveAccount = async (db: RelationalStore, account: Omit<ApprovedAccount, 'approvedBy' | 'approvedAt'>, actor: string, now: number): Promise<ApprovedAccount> =>
  (await rows(db, approve.bind(account.accountId, account.login, account.type, actor, now)))[0]!;
/** Answers whether an approval was withdrawn. */
export const withdrawAccount = async (db: RelationalStore, accountId: number): Promise<boolean> => (await rows(db, withdraw.bind(accountId))).length === 1;
