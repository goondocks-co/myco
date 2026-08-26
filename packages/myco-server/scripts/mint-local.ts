#!/usr/bin/env bun
import { ensureMember } from '../src/auth/enrollment.ts';
import { issueMemberToken } from '../src/auth/tokens.ts';
import { sqlCapture } from './sql-capture.ts';

const args = process.argv.slice(2);
const printToken = args.includes('--print-token');
const [memberId, machineId] = args.filter((a) => a !== '--print-token');
if (!memberId || !machineId) {
  console.error('usage: bun scripts/mint-local.ts <member_id> <machine_id> [--print-token]');
  process.exit(2);
}

const now = Date.now();
const { db, statements } = sqlCapture();
await ensureMember(db, memberId, now);
const issued = await issueMemberToken(db, { memberId, machineId }, now);
console.log(`-- token_id ${issued.tokenId} expires_at ${issued.expiresAt}`);
for (const statement of statements) console.log(`${statement};`);
if (printToken) console.error(`MYCO_MEMBER_TOKEN=${issued.token}`);
else console.error(`-- token_id ${issued.tokenId} minted; rerun with --print-token to print the raw token to stderr`);
