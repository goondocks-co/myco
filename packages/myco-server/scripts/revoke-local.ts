#!/usr/bin/env bun
import { revokeMemberLineage, revokeMemberToken } from '../src/auth/tokens.ts';
import { sqlCapture } from './sql-capture.ts';

const args = process.argv.slice(2);
const lineage = args.includes('--lineage');
const [tokenId] = args.filter((a) => a !== '--lineage');
if (!tokenId) {
  console.error('usage: bun scripts/revoke-local.ts <token_id> [--lineage]');
  process.exit(2);
}

const { db, statements } = sqlCapture();
if (lineage) await revokeMemberLineage(db, tokenId, Date.now());
else await revokeMemberToken(db, tokenId, Date.now());
console.log(`${statements[0]};`);
if (lineage) console.error(`-- the statement reports how many live tokens of the lineage it revoked; 0 rows means no token had that id or none of its lineage was live`);
else console.error(`-- the statement reports 1 row changed when the token was live; 0 rows means no live token had that id`);
