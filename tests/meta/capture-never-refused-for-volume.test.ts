/**
 * Meta gate (#1416): capture is never refused for volume.
 *
 * `member_credentials.bytes_written` is a reporting counter. It is charged for
 * every stored event body and blob byte and carried to a rotated successor,
 * and no admission compares it: a member's capture is admitted while its
 * credential is live, and abuse is bounded by the per-request size caps, the
 * rate limits and revocation. A lifetime byte ceiling was an admission once and
 * shut an active machine's capture off in weeks; this gate keeps one from
 * coming back through a comparison, a CHECK, a pre-check on the auth row, or a
 * capture admission that reads anything but liveness.
 *
 * Static source scan (node:fs), same shape as the other gates in this tree.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { credentialLive, TOKEN_LIVE } from '@myco-server-worker/ingest/live-credential.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(REPO_ROOT, 'packages', 'myco-server', 'src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (file: string): string => path.relative(SRC, file).split(path.sep).join('/');

/** Every file under the server source that names the counter, and what each may do with it. */
const COUNTER_READERS: Record<string, string> = {
  'db/schema.ts': 'the column and its historical DDL',
  'auth/tokens.ts': 'a new credential starts at 0; a successor takes over the carried count',
  'ingest/live-credential.ts': 'the stored-bytes read for reporting, and the carry at rotation',
  'ingest/events.ts': 'the charge for a stored event body',
  'ingest/blobs.ts': 'the charge for a stored blob',
  'read/credentials.ts': 'the dashboard\'s credential list',
};

/** A comparison with the counter on either side, in SQL or in TypeScript. */
const COMPARES = [
  /\bbytes_?[wW]ritten\b\s*(?:\+[^,;)`]*)?(?:<=?|>=?)(?!=)/,
  /(?:<=?|>=?)\s*\(?\s*(?:\w+\.)?bytes_?[wW]ritten\b/,
  /\bbytes_?[wW]ritten\b[^;\n`]*\bBETWEEN\b/i,
];

describe('capture is never refused for volume', () => {
  it('names the counter only where it is charged, carried, reported or declared', () => {
    const naming = sources(SRC).filter((f) => /\bbytes_written\b|\bbytesWritten\b/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
    expect(naming).toEqual(Object.keys(COUNTER_READERS).sort());
  });

  it('compares the counter nowhere in the server source but the frozen DDL of steps 1 and 5', () => {
    const found: { file: string; line: string }[] = [];
    let frozen = 0;
    for (const file of sources(SRC)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!COMPARES.some((p) => p.test(line))) continue;
        // Steps 1 and 5 render byte for byte as a deployed ledger applied them; step 48 drops their CHECK.
        if (rel(file) === 'db/schema.ts' && line.includes('${RETIRED_CREDENTIAL_BYTE_CEILING}')) { frozen += 1; continue; }
        found.push({ file: rel(file), line: line.trim() });
      }
    }
    expect(found).toEqual([]);
    expect(frozen).toBe(2);
    const bounded = SCHEMA_STEPS.filter((s) => s.statements.some((sql) => /CHECK \(bytes_written/.test(sql))).map((s) => s.version);
    expect(bounded).toEqual([1, 5]);
  });

  it('leaves the live credential table with no CHECK on the counter: the last DDL of member_credentials bounds nothing', () => {
    const creates = SCHEMA_STEPS.flatMap((s) => s.statements.map((sql) => ({ version: s.version, sql })))
      .filter(({ sql }) => /^CREATE TABLE (?:IF NOT EXISTS )?member_credentials\b/.test(sql));
    const last = creates[creates.length - 1]!;
    expect(last.version).toBe(48);
    expect(last.sql).toMatch(/bytes_written\s+INTEGER NOT NULL DEFAULT 0/);
    expect(last.sql).not.toMatch(/CHECK/i);
    // No later step adds a bound back by another route.
    const later = SCHEMA_STEPS.filter((s) => s.version >= last.version).flatMap((s) => s.statements);
    expect(later.filter((sql) => /bytes_written/.test(sql) && /CHECK|TRIGGER|RAISE/i.test(sql))).toEqual([]);
  });

  it('admits a member\'s capture on liveness alone: the one admission fragment is the live-credential predicate and nothing else', () => {
    expect(credentialLive('mt_x')).toEqual({ sql: TOKEN_LIVE, params: ['mt_x'] });
    expect(TOKEN_LIVE).toBe('EXISTS (SELECT 1 FROM member_credentials WHERE id = ? AND revoked_at IS NULL)');
    for (const file of ['ingest/events.ts', 'ingest/blobs.ts']) {
      const text = fs.readFileSync(path.join(SRC, file), 'utf8');
      expect({ file, admitsOnLiveness: /\bcredentialLive\(/.test(text) }).toEqual({ file, admitsOnLiveness: true });
    }
  });

  it('refuses nothing for volume on the member pipeline: no pre-check, and no failure read back as a quota refusal', () => {
    const pipeline = fs.readFileSync(path.join(SRC, 'pipeline.ts'), 'utf8');
    expect(pipeline).not.toMatch(/bytes_?[wW]ritten|quota/i);
    const classifier = fs.readFileSync(path.join(SRC, 'telemetry.ts'), 'utf8');
    expect(classifier).not.toMatch(/member_tokens_quota/);
  });
});
