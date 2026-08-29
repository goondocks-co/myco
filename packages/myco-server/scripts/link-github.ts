#!/usr/bin/env bun
/**
 * Break-glass: bind a GitHub account to a member directly in the store.
 *
 * The steady-state path is `myco member link-github`, which proves the account
 * through GitHub. This one proves nothing and connects to nothing: it renders
 * the UPDATE for an operator to apply with their own database access, exactly
 * as mint-enrollment.ts does. It also clears any earlier account, which is how
 * a member's account is changed once linked.
 */
import { GITHUB_ACCOUNT_ID, linkStatement } from '../src/auth/identity-link.ts';
import { sqlCapture } from './sql-capture.ts';

const [memberId, githubId] = process.argv.slice(2);

if (!memberId || !githubId || !/^mem_[A-Za-z0-9._-]{1,64}$/.test(memberId) || !GITHUB_ACCOUNT_ID.test(githubId)) {
  console.error('usage: bun scripts/link-github.ts <member_id> <github_account_id>');
  process.exit(2);
}

const { db, statements } = sqlCapture();
await linkStatement(db, memberId, githubId).run();

console.log(`-- bind GitHub account ${githubId} to ${memberId}; replaces any earlier account`);
for (const s of statements) console.log(s);
