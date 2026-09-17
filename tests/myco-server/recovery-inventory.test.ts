/**
 * The inventory pass over a staged export: what it verifies before it decodes, what it resumes, what it refuses,
 * and that the identity it answers belongs to the bytes it verified.
 *
 * The object set it answers is held to the canonical owner: the same SQL imported by `importTableDump` into a real
 * database, read back by `snapshotObjectFacts`.
 */
import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import {
  CHECKPOINT_STATEMENT_CHARS, continueInventory, INVENTORY_LIMITS, inventoryObjectOf, newInventoryProgress,
  type InventoryPorts, type InventoryProgress, type RecordedPart,
} from '@myco-server-worker/core/recovery-inventory.js';
import { tableColumns } from '@myco-server-worker/core/sql-statements.js';
import { snapshotObjectFacts } from '@myco/server/recovery-bundle.js';

const digestOf = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
};

/** The tables the fixtures declare, as schema 41 declares them. */
const BLOBS_DDL = 'CREATE TABLE blobs (project_id TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, media_type TEXT, PRIMARY KEY (project_id, key))';
const BACKUPS_DDL = 'CREATE TABLE backups (id TEXT PRIMARY KEY, key TEXT NOT NULL, created_at INTEGER NOT NULL, size_bytes INTEGER NOT NULL, counts_json TEXT NOT NULL, schema_version INTEGER NOT NULL, producer TEXT, pinned INTEGER NOT NULL DEFAULT 0, sha256 TEXT)';
const COLUMNS = { blobs: tableColumns(BLOBS_DDL)!, backups: tableColumns(BACKUPS_DDL)! };
const GENERATION = '0b2c6a8e-5d1f-4e3a-9c7b-1a2b3c4d5e6f';

/** Where a part sits in the staged export. */
const offsetOf = (parts: readonly RecordedPart[], upTo: number): number =>
  parts.slice(0, upTo).reduce((sum, part) => sum + part.bytes, 0);

/** A staged export in memory, cut into the parts a download records. */
async function staged(sql: string, partBytes: number) {
  const bytes = new TextEncoder().encode(sql);
  const parts: RecordedPart[] = [];
  for (let at = 0, part = 1; at < bytes.byteLength; at += partBytes, part += 1) {
    const slice = bytes.subarray(at, Math.min(at + partBytes, bytes.byteLength));
    parts.push({ part, bytes: slice.byteLength, sha256: await digestOf(slice) });
  }
  const store = { bytes, reads: [] as number[] };
  const ports: InventoryPorts = {
    now: () => 0,
    async readPart(_prefix, offset, count) { store.reads.push(offset); return store.bytes.subarray(offset, offset + count); },
    digest: (value) => digestOf(value),
  };
  return { ...store, parts, ports, sha256: await digestOf(bytes) };
}

const run = (held: Awaited<ReturnType<typeof staged>>, over: Partial<InventoryPorts> = {}, limits = INVENTORY_LIMITS, progress?: InventoryProgress) =>
  continueInventory(
    { prefix: 'staging/1', parts: held.parts, sqlBytes: held.bytes.byteLength, startedAt: 0, columns: COLUMNS, progress: progress ?? newInventoryProgress() },
    { ...held.ports, ...over }, { ...limits, maxPartsPerStep: 99 },
  );

const EXPORT = [
  'PRAGMA defer_foreign_keys=TRUE;',
  `${BLOBS_DDL};`,
  `${BACKUPS_DDL};`,
  'CREATE TABLE events (project_id TEXT NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL);',
  `INSERT INTO blobs VALUES('proj_1','${'a'.repeat(64)}',12,'text/plain');`,
  "INSERT INTO events VALUES('proj_1','ev_1','a prompt holding INSERT INTO blobs VALUES(0)');",
  `INSERT INTO blobs VALUES('proj_1','${'b'.repeat(64)}',34,'text/plain');`,
  "INSERT INTO backups VALUES('b1','backups/b1',1789590000000,56,'{}',41,'myco',0,'cccc');",
  "INSERT INTO backups VALUES('b2','backups/b2',1789590000001,78,'{}',41,'myco',0,NULL);",
  '',
].join('\n');

it('answers the object set the canonical owner reads back, on the pinned schema', async () => {
  // The canonical owner reads a real snapshot, so the oracle is built by the pinned migrations and then given the
  // very rows the export carries.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-oracle-'));
  const file = path.join(root, 'snapshot.sqlite');
  const migrations = path.resolve(import.meta.dir, '../../packages/myco-server/migrations');
  const db = new Database(file, { create: true });
  for (const name of fs.readdirSync(migrations).filter((held) => held.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migrations, name), 'utf8'));
  }
  const definitionOf = (table: string) => (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string }).sql;
  const columns = { blobs: tableColumns(definitionOf('blobs'))!, backups: tableColumns(definitionOf('backups'))! };

  // Positional rows, as an export writes them: every column the real schema declares, in its own order.
  const digest = (seed: string) => seed.repeat(64).slice(0, 64);
  const rows = [
    "INSERT INTO projects VALUES('proj_1','Oracle',1789590000000,NULL,NULL);",
    `INSERT INTO blobs VALUES('proj_1','${digest('a')}',12,'text/plain','mt_1',1789590000000,NULL);`,
    `INSERT INTO blobs VALUES('proj_1','${digest('b')}',34,'text/plain','mt_1',1789590000001,'${GENERATION}');`,
    `INSERT INTO backups VALUES('b1','backups/b1.jsonl',1789590000000,56,'{}',41,'myco',0,'${digest('c')}');`,
    "INSERT INTO backups VALUES('b2','backups/b2.jsonl',1789590000001,78,'{}',41,'myco',0,NULL);",
  ];
  for (const row of rows) db.exec(row);
  db.close();
  const canonical = snapshotObjectFacts(file);
  fs.rmSync(root, { recursive: true, force: true });

  // The same statements as an export carries them, read by the inventory pass.
  const held = await staged(`${rows.join('\n')}\n`, 96);
  const step = await continueInventory(
    { prefix: 'staging/1', parts: held.parts, sqlBytes: held.bytes.byteLength, startedAt: 0, columns, progress: newInventoryProgress() },
    held.ports, { ...INVENTORY_LIMITS, maxPartsPerStep: 99 },
  );
  expect(step.done).toBe(true);
  if (!step.done) return;
  const mine = Object.fromEntries(Object.values(step.progress.objects).map((object) => [object.key, { bytes: object.bytes, sha256: object.sha256 }]));
  // Each blob is copied from the object its own row registered; the artifact keeps the logical key.
  expect(Object.values(step.progress.objects).map((object) => object.source).sort())
    .toEqual([`proj_1/${digest('a')}`, `proj_1/${digest('b')}~${GENERATION}`, 'backups/b1.jsonl', 'backups/b2.jsonl'].sort());
  expect(mine).toEqual(Object.fromEntries([...canonical].map(([key, facts]) => [key, { bytes: facts.bytes, sha256: facts.sha256 }])));
  expect(step.database).toEqual({ sha256: held.sha256, bytes: held.bytes.byteLength });
});

it('reads the stored object a blobs row registers, and refuses a row whose mapping is outside the stored grammar', () => {
  const columns = { ...COLUMNS, blobs: [...COLUMNS.blobs, 'generation'] };
  const key = 'f'.repeat(64);
  expect(inventoryObjectOf(`INSERT INTO blobs VALUES('proj_1','${key}',9,'text/plain','${GENERATION}');`, columns))
    .toEqual({ key: `proj_1/${key}`, source: `proj_1/${key}~${GENERATION}`, bytes: 9, sha256: key });
  expect(inventoryObjectOf(`INSERT INTO blobs VALUES('proj_1','${key}',9,'text/plain',NULL);`, columns))
    .toEqual({ key: `proj_1/${key}`, source: `proj_1/${key}`, bytes: 9, sha256: key });
  for (const row of [
    `INSERT INTO blobs VALUES('proj_1','${key}',9,'text/plain','../${GENERATION}');`,
    `INSERT INTO blobs VALUES('proj_1','${key}',9,'text/plain',7);`,
    `INSERT INTO blobs VALUES('proj_1','${key.slice(1)}~x',9,'text/plain',NULL);`,
  ]) expect(() => inventoryObjectOf(row, columns)).toThrow();
});

it('reads a schema-41 backups row by the columns the schema declares', () => {
  const row = "INSERT INTO backups VALUES('b1','backups/b1',1789590000000,56,'{}',41,'myco',0,'cccc');";
  expect(inventoryObjectOf(row, COLUMNS)).toEqual({ key: 'backups/b1', source: 'backups/b1', bytes: 56, sha256: 'cccc' });
  // Without the schema's column order there is nothing to read the row by, and it is refused rather than guessed.
  expect(() => inventoryObjectOf(row, { blobs: COLUMNS.blobs })).toThrow();
});

it('refuses replaced bytes of the recorded length, before they reach either reader', async () => {
  const held = await staged(EXPORT, 96);
  const substituting: Partial<InventoryPorts> = {
    async readPart(_prefix, offset, count) {
      held.reads.push(offset);
      const bytes = held.bytes.subarray(offset, offset + count).slice();
      // A replacement of exactly the recorded length: only the recorded digest can tell it apart.
      if (offset > 0) bytes[0] = bytes[0]! ^ 0x20;
      return bytes;
    },
  };
  const step = await run(held, substituting);
  expect('refusal' in step && [step.refusal, step.facts.part, step.facts.digest]).toEqual(['object_changed', 2, false]);
  // The digest identifies only bytes held to their part's recorded digest, so a refused part is never hashed.
  expect(held.reads.length).toBe(2);
});

it('refuses a relevant row it cannot read rather than losing the object', async () => {
  // A valid export form this reader does not decode, in a field the inventory does not even use.
  const withExpression = EXPORT.replace(
    "INSERT INTO backups VALUES('b1','backups/b1',1789590000000,56,'{}',41,'myco',0,'cccc');",
    "INSERT INTO backups VALUES('b1','backups/b1',1789590000000,56,'{' || char(13) || '}',41,'myco',0,'cccc');",
  );
  const held = await staged(withExpression, 128);
  const step = await run(held);
  expect('refusal' in step && step.refusal).toBe('inventory_unreadable');
});

it('reads a relevant row larger than the selective ceiling', async () => {
  const long = `INSERT INTO blobs VALUES('proj_1','${'c'.repeat(64)}',9,'${'c'.repeat(270_000)}');`;
  const held = await staged(`${EXPORT}${long}\n`, 64 * 1024);
  const step = await run(held);
  expect(step.done).toBe(true);
  if (!step.done) return;
  expect(Object.keys(step.progress.objects)).toContain(`proj_1/${'c'.repeat(64)}`);
});

it('refuses a statement too large to carry in a checkpoint row, and keeps reading one that fits', async () => {
  // A relevant row this long spans parts, so the scan holding it has to travel in the checkpoint.
  const huge = `INSERT INTO blobs VALUES('proj_1','${'d'.repeat(64)}',9,'${'d'.repeat(CHECKPOINT_STATEMENT_CHARS * 2)}');`;
  const held = await staged(`${EXPORT}${huge}\n`, 64 * 1024);
  const step = await run(held);
  expect('refusal' in step && step.refusal).toBe('inventory_oversize');

  // Just inside the bound the same row is read, so the refusal is the row limit and not the row's relevance.
  const fitting = `INSERT INTO blobs VALUES('proj_1','${'e'.repeat(64)}',9,'${'e'.repeat(CHECKPOINT_STATEMENT_CHARS - 1_000)}');`;
  const inside = await staged(`${EXPORT}${fitting}\n`, 64 * 1024);
  const done = await run(inside);
  expect(done.done).toBe(true);
  if (!done.done) return;
  expect(Object.keys(done.progress.objects)).toContain(`proj_1/${'e'.repeat(64)}`);
});

it('resumes at the part it reached, reading each part once for the whole pass', async () => {
  const held = await staged(EXPORT, 48);
  let progress: InventoryProgress = newInventoryProgress();
  let steps = 0;
  for (;;) {
    const step = await continueInventory(
      { prefix: 'staging/1', parts: held.parts, sqlBytes: held.bytes.byteLength, startedAt: 0, columns: COLUMNS, progress },
      held.ports, { ...INVENTORY_LIMITS, maxPartsPerStep: 2 },
    );
    steps += 1;
    if ('refusal' in step) throw new Error(`the pass refused: ${step.refusal}`);
    progress = step.progress;
    if (step.done) break;
  }
  expect(steps).toBeGreaterThan(1);
  // One read serves both readers, so the identity costs no second read of the export.
  expect(held.reads).toEqual(held.parts.map((_part, index) => offsetOf(held.parts, index)));
});

it('refuses recorded parts that do not add up to the staged export, and a short read', async () => {
  const held = await staged(EXPORT, 96);
  const wrong = await continueInventory(
    { prefix: 'staging/1', parts: held.parts.slice(0, -1), sqlBytes: held.bytes.byteLength, startedAt: 0, columns: COLUMNS, progress: newInventoryProgress() },
    held.ports, INVENTORY_LIMITS,
  );
  expect('refusal' in wrong && wrong.refusal).toBe('inventory_disagrees');

  const short = await run(held, { async readPart() { return new Uint8Array(3); } });
  expect('refusal' in short && short.refusal).toBe('object_changed');
});

it('reads a relevant row it cannot read even behind a comment, through the canonical reader alone', async () => {
  const unreadable = "INSERT INTO backups VALUES('b1','backups/b1.jsonl',1789590000000,56,'{' || char(13) || '}',41,'myco',0,NULL);";
  for (const prefix of ['', '-- an export comment\n', '/* a block comment */\n', '\n\t']) {
    const held = await staged(`${prefix}${unreadable}\n`, 64);
    const step = await run(held);
    expect({ prefix, refusal: 'refusal' in step ? step.refusal : step.done }).toEqual({ prefix, refusal: 'inventory_unreadable' });
  }
});

it('tells a port to stop when the pass stops waiting for it', async () => {
  const held = await staged(EXPORT, 96);
  let aborted = 0;
  const stalling = await run(held, {
    async readPart(_prefix, _offset, _bytes, signal) {
      signal.addEventListener('abort', () => { aborted += 1; });
      return new Promise(() => {});
    },
  }, { ...INVENTORY_LIMITS, requestMs: 20 });
  expect('refusal' in stalling && stalling.refusal).toBe('export_stalled');
  expect(aborted).toBe(1);

  // Once the deadline aborts a call, what the call then answers is not an answer. A port that resolves on abort
  // must not read as a short read, which says the stored bytes changed when only the deadline passed.
  for (const [how, answer] of [
    ['resolves null', () => null],
    ['rejects AbortError', () => { throw new DOMException('aborted', 'AbortError'); }],
    ['answers the right bytes', () => held.bytes.subarray(0, held.parts[0]!.bytes)],
  ] as const) {
    const racing = await run(held, {
      // A clock that never advances, so only the abort itself can classify the outcome.
      now: () => 0,
      readPart: (_prefix, _offset, _bytes, signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { try { resolve(answer()); } catch (error) { reject(error); } });
      }),
    }, { ...INVENTORY_LIMITS, requestMs: 5 });
    expect({ how, refusal: 'refusal' in racing ? racing.refusal : racing.done }).toEqual({ how, refusal: 'export_stalled' });
  }

  // A failure of its own is still that failure, not a deadline: only an abort of ours speaks for the deadline.
  await expect(run(held, { async readPart() { throw new Error('the store is broken'); } })).rejects.toThrow('the store is broken');

  // A call may also outrun its budget without ever being aborted, which the clock is read again to catch.
  let clock = 0;
  const late = await run(held, {
    now: () => clock,
    async readPart(prefix, offset, count, signal) {
      clock += 5_000;
      return held.ports.readPart(prefix, offset, count, signal);
    },
  }, { ...INVENTORY_LIMITS, requestMs: 1_000 });
  expect('refusal' in late && [late.refusal, late.facts.parts]).toEqual(['export_stalled', 0]);
});

it('stops beginning parts at the step budget, and overruns it by no more than the part in hand', async () => {
  const held = await staged(EXPORT, 96);
  let clock = 0;
  const begun: number[] = [];
  const slow: Partial<InventoryPorts> = {
    now: () => clock,
    async readPart(prefix, offset, count, signal) {
      begun.push(clock);
      clock += 60;
      return held.ports.readPart(prefix, offset, count, signal);
    },
  };
  const step = await run(held, slow, { ...INVENTORY_LIMITS, stepMs: 100, requestMs: 30_000 });
  // A step out of time returns what it committed; the pass is not stalled and the next continuation carries on.
  expect('refusal' in step ? step.refusal : step.done).toBe(false);
  // Two parts begun within the 100 ms budget, and the second finished at 120 ms: the overrun is one part's work.
  expect([begun, clock]).toEqual([[0, 60], 120]);

  // The pass budget, unlike the step budget, is a refusal, and it names the parts the pass had committed.
  clock = 0;
  const stalled = await run(held, slow, { ...INVENTORY_LIMITS, stepMs: 30_000, inventoryMs: 100 });
  expect('refusal' in stalled && [stalled.refusal, stalled.facts.parts]).toEqual(['export_stalled', 1]);
});

it('carries the digest across continuations, and refuses a checkpoint whose digest and cursor disagree', async () => {
  const held = await staged(EXPORT, 48);
  let progress: InventoryProgress = newInventoryProgress();
  const hashed: number[] = [];
  for (;;) {
    const step = await continueInventory(
      { prefix: 'staging/1', parts: held.parts, sqlBytes: held.bytes.byteLength, startedAt: 0, columns: COLUMNS, progress },
      held.ports, { ...INVENTORY_LIMITS, maxPartsPerStep: 1 },
    );
    if ('refusal' in step) throw new Error(`the pass refused: ${step.refusal}`);
    progress = step.progress;
    hashed.push(progress.digest.bytesHashed);
    if (step.done) {
      // The identity is the plain digest of the staged bytes, accumulated one part at a time.
      expect(step.database).toEqual({ sha256: held.sha256, bytes: held.bytes.byteLength });
      break;
    }
  }
  // Each continuation's saved digest accounts for exactly the bytes its cursor has passed.
  expect(hashed).toEqual(held.parts.map((_part, index) => offsetOf(held.parts, index + 1)));

  // A digest resumed from the durable form of its checkpoint reaches the same identity as one that never stopped.
  let stored: InventoryProgress = newInventoryProgress();
  for (;;) {
    const step = await continueInventory(
      { prefix: 'staging/1', parts: held.parts, sqlBytes: held.bytes.byteLength, startedAt: 0, columns: COLUMNS, progress: stored },
      held.ports, { ...INVENTORY_LIMITS, maxPartsPerStep: 1 },
    );
    if ('refusal' in step) throw new Error(`the pass refused: ${step.refusal}`);
    stored = JSON.parse(JSON.stringify(step.progress)) as InventoryProgress;
    if (step.done) {
      expect(step.database.sha256).toBe(held.sha256);
      break;
    }
  }

  // A digest state that does not account for the cursor's bytes is a checkpoint nothing may trust.
  const tampered = { ...progress, parts: 1, digest: { ...progress.digest, bytesHashed: 0 } };
  const step = await continueInventory(
    { prefix: 'staging/1', parts: held.parts, sqlBytes: held.bytes.byteLength, startedAt: 0, columns: COLUMNS, progress: tampered },
    held.ports, INVENTORY_LIMITS,
  );
  expect('refusal' in step && step.refusal).toBe('inventory_disagrees');
});
