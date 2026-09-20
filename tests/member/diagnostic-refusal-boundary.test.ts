/**
 * What a refusal log can put into the export.
 *
 * The log is a file on the member's own disk, so the report reads every field
 * against what a member could have shipped: an event id matching the id
 * grammar, a session id within the opaque bound ingest accepts, a kind from the
 * shipped vocabulary, a code from the member's own, and an instant a reader can
 * date. Anything else is null, and no field carries text a writer chose.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { MemberSpool, OFFLINE_LATCH_FILE } from '@myco/member/spool.js';
import { REGISTRY_VERSION, writeRegistryEntry, type RegistryEntry } from '@myco/member/registry.js';
import { projectDiagnostics } from '@myco/member/diagnostics.js';
import { tempMycoHome } from './helpers/server.js';

const NOW = 1_800_000_000_000;
const EVENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SESSION_ID = 'sess-a';

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
beforeEach(() => { mycoHome = tempMycoHome(); process.env.MYCO_HOME = mycoHome; });
afterEach(() => { process.env.MYCO_HOME = savedHome; });

const entry = (): RegistryEntry => ({
  version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl: 'https://srv.example/', token: 'A'.repeat(43),
  root: '/w/p', machineId: 'm1', joinedAt: 1, updatedAt: 1,
});

/** Writes `records` as the refusal log a drain appends, one JSON object per line. */
function logRefusals(records: readonly Record<string, unknown>[]): RegistryEntry {
  const e = entry();
  writeRegistryEntry(e, { mycoHome });
  const spool = new MemberSpool('proj_1', { mycoHome });
  fs.mkdirSync(spool.dir, { recursive: true });
  fs.writeFileSync(path.join(spool.dir, 'refused.jsonl'), records.map((r) => JSON.stringify(r)).join('\n'), 'utf-8');
  return e;
}

const whole = { eventId: EVENT_ID, sessionId: SESSION_ID, kind: 'prompt', code: 'refused', reason: 'no', at: NOW };

describe('a refusal the log holds', () => {
  it('carries an event, session, kind, code and instant a member could have shipped', () => {
    const facts = projectDiagnostics(logRefusals([whole]), mycoHome, NOW).refusals;
    expect(facts.entries).toEqual([{ eventId: EVENT_ID, sessionId: SESSION_ID, kind: 'prompt', code: 'refused', at: NOW }]);
  });

  it('nulls an event id outside the grammar rather than carrying what the file says', () => {
    const facts = projectDiagnostics(logRefusals([
      { ...whole, eventId: 'not-an-id; rm -rf /' },
      { ...whole, eventId: `${EVENT_ID} and a sentence` },
    ]), mycoHome, NOW).refusals;
    expect(facts.entries.map((e) => e.eventId)).toEqual([null, null]);
    expect(JSON.stringify(facts)).not.toContain('rm -rf');
    expect(JSON.stringify(facts)).not.toContain('and a sentence');
  });

  it('nulls a kind outside the vocabulary a member ships', () => {
    const facts = projectDiagnostics(logRefusals([{ ...whole, kind: 'whatever the writer put here' }]), mycoHome, NOW).refusals;
    expect(facts.entries.map((e) => e.kind)).toEqual([null]);
    expect(JSON.stringify(facts)).not.toContain('whatever the writer');
  });

  it('keeps an opaque session id, and nulls one longer than ingest accepts', () => {
    // A session id is opaque: non-UUID shapes are legitimate and stay.
    const opaque = '01a0bfee-7e57-7a91-b52d-82c8ed9b960b:child/2';
    const facts = projectDiagnostics(logRefusals([
      { ...whole, sessionId: opaque },
      { ...whole, sessionId: 'x'.repeat(129) },
    ]), mycoHome, NOW).refusals;
    expect(facts.entries.map((e) => e.sessionId)).toEqual([opaque, null]);
  });

  it('nulls an instant no reader can date', () => {
    const facts = projectDiagnostics(logRefusals([
      { ...whole, at: 1e20 },
      { ...whole, at: Number.MAX_VALUE },
    ]), mycoHome, NOW).refusals;
    expect(facts.entries.map((e) => e.at)).toEqual([null, null]);
  });

  it('carries no reason the writer chose, whatever it holds', () => {
    const facts = projectDiagnostics(logRefusals([{ ...whole, reason: 'a sentence about this machine' }]), mycoHome, NOW).refusals;
    expect(JSON.stringify(facts)).not.toContain('a sentence about this machine');
  });
});

describe('an offline latch the report cannot date', () => {
  it('reads as no latch rather than as one holding an instant nothing renders', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    fs.mkdirSync(spool.dir, { recursive: true });
    fs.writeFileSync(path.join(spool.dir, OFFLINE_LATCH_FILE),
      JSON.stringify({ since: 1e20, nextProbeAt: 1e20, backoffMs: 1000 }), { mode: 0o600 });

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.latch).toBeNull();
    // A latch nothing can date is not a member that is online.
    expect(facts.latchReadable).toBe(false);
  });

  it('keeps a latch whose instants a reader can date', () => {
    const e = entry();
    writeRegistryEntry(e, { mycoHome });
    const spool = new MemberSpool('proj_1', { mycoHome });
    fs.mkdirSync(spool.dir, { recursive: true });
    fs.writeFileSync(path.join(spool.dir, OFFLINE_LATCH_FILE),
      JSON.stringify({ since: NOW, nextProbeAt: NOW + 1000, backoffMs: 1000 }), { mode: 0o600 });

    const facts = projectDiagnostics(e, mycoHome, NOW);
    expect(facts.latch).toEqual({ since: NOW, nextProbeAt: NOW + 1000, backoffMs: 1000 });
    expect(facts.latchReadable).toBe(true);
  });
});
