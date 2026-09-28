#!/usr/bin/env bun
import { ensureMember } from '../src/auth/enrollment.ts';
import { issueExternalGrant } from '../src/auth/grants.ts';
import { mintInsert, NO_RUNTIME_CLAIMS } from '../src/auth/tokens.ts';
import { sqlCapture } from './sql-capture.ts';

const USAGE = [
  'usage: bun scripts/mint-local.ts <member_id> <machine_id> (--rotating | --non-rotating) [--print-token]',
  '       bun scripts/mint-local.ts --grant <project_id> [--label <text>] [--by <member_id>] [--print-token]',
  '       (a grant names a Project the Deployment already holds; the emitted SQL is refused otherwise)',
].join('\n');

const args = process.argv.slice(2);
const printToken = args.includes('--print-token');
/** Which credential to mint is the operator's to say: each choice is wrong for the other's holder. */
const ROTATION_CHOICE = [
  'say how the credential is held — one of:',
  '  --rotating      for `myco member join … --token-env|--token-stdin`: a registry on one machine renews it every week and it never expires while in use',
  '  --non-rotating  for MYCO_MEMBER_TOKEN, a sandbox or any `--credential env` runtime: every holder shares it, nothing renews it, and it expires 7 days after mint — mint another to renew.',
  '                  It is minted for a member who does not administer the Deployment: name one of its own (e.g. <member_id>-sandbox).',
].join('\n');
/** The value after `flag`, or undefined when the flag is absent; a flag followed by another flag or nothing is a usage error. */
const valueOf = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`${flag} needs a value\n${USAGE}`);
    process.exit(2);
  }
  return value;
};
const now = Date.now();
const { db, statements } = sqlCapture();

/** Fails the applied SQL, naming why, unless the credential it minted exists: a non-rotating mint for a member that administers the Deployment writes none. */
const NON_ADMIN_GUARD = (tokenId: string): string[] => [
  `CREATE TABLE IF NOT EXISTS _mint_refused_member_administers_deployment (ok INTEGER NOT NULL CHECK (ok = 1))`,
  `INSERT INTO _mint_refused_member_administers_deployment (ok) SELECT CASE WHEN EXISTS (SELECT 1 FROM member_credentials WHERE id = '${tokenId}') THEN 1 ELSE 0 END`,
  `DROP TABLE _mint_refused_member_administers_deployment`,
];

if (args.includes('--grant')) {
  const projectId = valueOf('--grant')!;
  const issued = await issueExternalGrant(db, { projectId }, valueOf('--label') ?? null, valueOf('--by') ?? 'operator', now);
  console.log(`-- grant_id ${issued.id} project ${projectId}`);
  for (const statement of statements) console.log(`${statement};`);
  if (printToken) console.error(`MYCO_EXTERNAL_KEY=${issued.key}`);
  else console.error(`-- grant_id ${issued.id} minted; rerun with --print-token to print the raw key to stderr`);
} else {
  const [memberId, machineId] = args.filter((a) => a !== '--print-token' && a !== '--rotating' && a !== '--non-rotating');
  if (!memberId || !machineId) {
    console.error(USAGE);
    process.exit(2);
  }
  const rotating = args.includes('--rotating');
  const nonRotating = args.includes('--non-rotating');
  if (rotating === nonRotating) {
    console.error(`${ROTATION_CHOICE}\n${USAGE}`);
    process.exit(2);
  }
  // A credential every holder shares never carries the Deployment's authority: its member is created a plain member, the
  // insert lands only while that member is one, and the guard after it fails the applied SQL by name when it did not —
  // a member that already administers the Deployment is never downgraded, and never handed one.
  await ensureMember(db, memberId, now, nonRotating ? 'member' : 'admin');
  const { statement, issued } = await mintInsert(db, { memberId, machineId }, now, null, NO_RUNTIME_CLAIMS, nonRotating
    ? { rotates: false, gate: { sql: `EXISTS (SELECT 1 FROM members WHERE id = ? AND role = 'member')`, params: [memberId] } }
    : {});
  await statement.run();
  if (nonRotating) statements.push(...NON_ADMIN_GUARD(issued.tokenId));
  console.log(`-- token_id ${issued.tokenId} expires_at ${issued.expiresAt}${nonRotating ? ` non-rotating, for member ${memberId} which must not administer the Deployment` : ''}`);
  for (const statement of statements) console.log(`${statement};`);
  if (printToken) console.error(`MYCO_MEMBER_TOKEN=${issued.token}`);
  else console.error(`-- token_id ${issued.tokenId} minted; rerun with --print-token to print the raw token to stderr`);
}
