#!/usr/bin/env bun
import { revokeMemberToken } from '../src/auth/tokens.ts';
import { sqlCapture } from './sql-capture.ts';

const [tokenId] = Bun.argv.slice(2);
if (!tokenId) {
  console.error('usage: bun scripts/revoke-local.ts <token_id>');
  process.exit(2);
}

const { db, statements } = sqlCapture();
await revokeMemberToken(db, tokenId, Date.now());
console.log(`${statements[0]};`);
console.error(`-- the statement reports 1 row changed when the token was live; 0 rows means no live token had that id`);
