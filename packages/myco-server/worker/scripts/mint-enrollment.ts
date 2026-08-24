#!/usr/bin/env bun
/**
 * Break-glass: mint an enrollment authority directly in the store.
 *
 * This is the recovery path of last resort — the one that works when every
 * credential is lost but the operator still controls the infrastructure. It
 * connects to nothing and holds no credential: it renders the SQL for the
 * operator to apply with their own database access, exactly as mint-local.ts
 * does for member tokens.
 *
 * The raw key is written to stderr, and only when asked for. Nothing prints it
 * to stdout, so the rendered SQL can be piped into a database client without
 * the secret travelling with it.
 */
import { enrollmentInsert, ENROLLMENT_ID_PREFIX, ENROLLMENT_KEY_BYTES, ENROLLMENT_TTL_MS } from '../src/auth/enrollment.ts';
import { sha256Hex } from '../src/hash.ts';
import { sqlCapture } from './sql-capture.ts';

const args = process.argv.slice(2);
const printKey = args.includes('--print-key');
const rest = args.filter((a) => a !== '--print-key');
const ttlMinutes = rest.length > 0 ? Number(rest[0]) : ENROLLMENT_TTL_MS / 60_000;

if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
  console.error('usage: bun scripts/mint-enrollment.ts [ttl_minutes] [--print-key]');
  process.exit(2);
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const key = b64url(crypto.getRandomValues(new Uint8Array(ENROLLMENT_KEY_BYTES)));
const id = `${ENROLLMENT_ID_PREFIX}${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;

const now = Date.now();
const { db, statements } = sqlCapture();
const { statement, expiresAt } = enrollmentInsert(db, now, ttlMinutes * 60_000, null, await sha256Hex(key), id);
await statement.run();

console.log(`-- enrollment authority ${id}; expires_at ${expiresAt} (${ttlMinutes} minutes)`);
for (const rendered of statements) console.log(`${rendered};`);

if (printKey) console.error(`MYCO_ENROLLMENT_KEY=${key}`);
else console.error(`-- ${id} minted; rerun with --print-key to print the raw key to stderr`);
