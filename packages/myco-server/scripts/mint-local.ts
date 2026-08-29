#!/usr/bin/env bun
import { ensureMember } from '../src/auth/enrollment.ts';
import { issueExternalGrant } from '../src/auth/grants.ts';
import { issueMemberToken } from '../src/auth/tokens.ts';
import { sqlCapture } from './sql-capture.ts';

const USAGE = [
  'usage: bun scripts/mint-local.ts <member_id> <machine_id> [--print-token]',
  '       bun scripts/mint-local.ts --grant <project_id> [--label <text>] [--by <member_id>] [--print-token]',
].join('\n');

const args = process.argv.slice(2);
const printToken = args.includes('--print-token');
const valueOf = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
const now = Date.now();
const { db, statements } = sqlCapture();

if (args.includes('--grant')) {
  const projectId = valueOf('--grant');
  if (!projectId || projectId.startsWith('--')) {
    console.error(USAGE);
    process.exit(2);
  }
  const issued = await issueExternalGrant(db, { projectId }, valueOf('--label') ?? null, valueOf('--by') ?? 'operator', now);
  console.log(`-- grant_id ${issued.id} project ${projectId}`);
  for (const statement of statements) console.log(`${statement};`);
  if (printToken) console.error(`MYCO_EXTERNAL_KEY=${issued.key}`);
  else console.error(`-- grant_id ${issued.id} minted; rerun with --print-token to print the raw key to stderr`);
} else {
  const [memberId, machineId] = args.filter((a) => a !== '--print-token');
  if (!memberId || !machineId) {
    console.error(USAGE);
    process.exit(2);
  }
  await ensureMember(db, memberId, now);
  const issued = await issueMemberToken(db, { memberId, machineId }, now);
  console.log(`-- token_id ${issued.tokenId} expires_at ${issued.expiresAt}`);
  for (const statement of statements) console.log(`${statement};`);
  if (printToken) console.error(`MYCO_MEMBER_TOKEN=${issued.token}`);
  else console.error(`-- token_id ${issued.tokenId} minted; rerun with --print-token to print the raw token to stderr`);
}
