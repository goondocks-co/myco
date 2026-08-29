#!/usr/bin/env bun
/**
 * Break-glass: mint a step-up authority directly in the store.
 *
 * A step-up key is what a member presents for the four operations outside the
 * flat model — storing a provider credential or endpoint among them. Minting is
 * a break-glass operation by design: whoever controls the Deployment's store
 * mints one, hands it to the member, and the dashboard asks for it at the
 * change. It connects to nothing and holds no credential: it renders the SQL for
 * the operator to apply, exactly as mint-enrollment.ts does.
 *
 * The raw key is written to stderr, and only when asked for. Nothing prints it
 * to stdout, so the rendered SQL can be piped into a database client without
 * the secret travelling with it.
 */
import { issueStepUpAuthority, STEP_UP_PURPOSES, STEP_UP_TTL_MS, type StepUpPurpose } from '../src/auth/step-up.ts';
import { sqlCapture } from './sql-capture.ts';

const args = process.argv.slice(2);
const printKey = args.includes('--print-key');
const rest = args.filter((a) => a !== '--print-key');
const purpose = rest[0];
const ttlMinutes = rest.length > 1 ? Number(rest[1]) : STEP_UP_TTL_MS / 60_000;

if (purpose === undefined || !(STEP_UP_PURPOSES as readonly string[]).includes(purpose) || !Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
  console.error(`usage: bun scripts/mint-step-up.ts <purpose> [ttl_minutes] [--print-key]\n  purpose: ${STEP_UP_PURPOSES.join(' | ')}`);
  process.exit(2);
}

const now = Date.now();
const { db, statements } = sqlCapture();
const issued = await issueStepUpAuthority(db, purpose as StepUpPurpose, now, { ttlMs: ttlMinutes * 60_000 });

console.log(`-- step-up authority ${issued.id} for ${purpose}; expires_at ${issued.expiresAt} (${ttlMinutes} minutes); single-use`);
for (const rendered of statements) console.log(`${rendered};`);

if (printKey) console.error(`MYCO_STEP_UP_KEY=${issued.key}`);
else console.error(`-- ${issued.id} minted; rerun with --print-key to print the raw key to stderr`);
