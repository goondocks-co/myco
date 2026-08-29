#!/usr/bin/env bun
import { revokeCredentialStatement, revokeMemberLineage } from '../src/auth/tokens.ts';
import { MEMBER_ID } from '../src/constants.ts';
import { sqlCapture } from './sql-capture.ts';

const args = process.argv.slice(2);
const lineage = args.includes('--lineage');
const [tokenId, actor] = args.filter((a) => a !== '--lineage');
if (!tokenId || !actor || !MEMBER_ID.test(actor)) {
  console.error('usage: bun scripts/revoke-local.ts <token_id> <actor_member_id> [--lineage]');
  process.exit(2);
}

const { db, statements } = sqlCapture();
if (lineage) await revokeMemberLineage(db, tokenId, Date.now(), actor);
else await revokeCredentialStatement(db, actor, tokenId, Date.now()).run();
console.log(`${statements[0]};`);
if (lineage) console.error(`-- the statement reports how many live tokens of the lineage it revoked, naming ${actor}; 0 rows means no token had that id or none of its lineage was live`);
else console.error(`-- the statement reports 1 row changed when the token was live, naming ${actor}; 0 rows means no live token had that id`);
