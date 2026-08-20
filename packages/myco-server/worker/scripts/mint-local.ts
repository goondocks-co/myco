#!/usr/bin/env bun
import { issueMemberToken } from '../src/auth/tokens.ts';
import { sqlCapture } from './sql-capture.ts';

const args = process.argv.slice(2);
const printToken = args.includes('--print-token');
const [projectId, machineId] = args.filter((a) => a !== '--print-token');
if (!projectId || !machineId) {
  console.error('usage: bun scripts/mint-local.ts <project_id> <machine_id> [--print-token]');
  process.exit(2);
}

const now = Date.now();
const { db, statements } = sqlCapture();
await db.prepare(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).bind(projectId, projectId, now).run();
const issued = await issueMemberToken(db, { projectId, machineId }, now);
console.log(`-- token_id ${issued.tokenId} expires_at ${issued.expiresAt}`);
for (const statement of statements) console.log(`${statement};`);
if (printToken) console.error(`MYCO_MEMBER_TOKEN=${issued.token}`);
else console.error(`-- token_id ${issued.tokenId} minted; rerun with --print-token to print the raw token to stderr`);
