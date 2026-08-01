/**
 * Residency-transition journal (Phase F) — the crash-durable record.
 *
 * Hermetic: a per-test `MYCO_TEAM_HOME` override so the machine-global team home
 * is never touched. The journal is pure `fs`, so no DB/daemon setup is needed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProjectId, createGroveId, createHostId } from '@myco/grove/ids.js';
import {
  RESIDENCY_DIRNAME,
  advanceResidencyPhase,
  clearResidencyFailure,
  clearResidencyJournal,
  listResidencyJournals,
  readResidencyJournal,
  residencyDirExists,
  residencyTransitionInFlight,
  stampResidencyFailure,
  startResidencyJournal,
  writeResidencyJournal,
  type ResidencyJournalInit,
} from '@myco/host/residency-journal.js';

let teamHome: string;
let savedTeamHome: string | undefined;

beforeEach(() => {
  teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-residency-journal-'));
  savedTeamHome = process.env.MYCO_TEAM_HOME;
  process.env.MYCO_TEAM_HOME = teamHome;
});

afterEach(() => {
  if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
  else process.env.MYCO_TEAM_HOME = savedTeamHome;
  fs.rmSync(teamHome, { recursive: true, force: true });
});

function makeInit(overrides: Partial<ResidencyJournalInit> = {}): ResidencyJournalInit {
  return {
    direction: 'attach',
    phase: 'parking',
    host_id: createHostId(),
    project_id: createProjectId(),
    divert_grove_id: createGroveId(),
    source_grove_id: createGroveId(),
    project_name: 'demo',
    root: '/checkout/demo',
    backup_ref: null,
    cursors: {},
    ...overrides,
  };
}

describe('residency journal', () => {
  test('start writes an atomic file with both timestamps and no torn temp sibling', () => {
    const init = makeInit();
    const written = startResidencyJournal(init);

    expect(written.created_at).toBeTruthy();
    expect(written.updated_at).toBeTruthy();

    const dir = path.join(teamHome, RESIDENCY_DIRNAME);
    const files = fs.readdirSync(dir);
    expect(files).toEqual([`${init.project_id}.json`]); // no .tmp left behind

    const read = readResidencyJournal(init.project_id);
    expect(read).toEqual(written);
  });

  test('advanceResidencyPhase moves the phase and shallow-merges cursors without clobbering the other stream', () => {
    const init = makeInit({ cursors: { entity_mentions: 'em-1' } });
    startResidencyJournal(init);

    advanceResidencyPhase(init.project_id, 'pushing', { cursors: { content_publications: 'cp-1' } });

    const read = readResidencyJournal(init.project_id);
    expect(read?.phase).toBe('pushing');
    expect(read?.cursors).toEqual({ entity_mentions: 'em-1', content_publications: 'cp-1' });
  });

  test('advanceResidencyPhase returns null when no journal exists (a benign race, not a throw)', () => {
    expect(advanceResidencyPhase(createProjectId(), 'pushing')).toBeNull();
  });

  test('clear removes the journal file', () => {
    const init = makeInit();
    startResidencyJournal(init);
    expect(readResidencyJournal(init.project_id)).not.toBeNull();

    clearResidencyJournal(init.project_id);
    expect(readResidencyJournal(init.project_id)).toBeNull();
  });

  test('listResidencyJournals returns every parseable journal', () => {
    const a = makeInit();
    const b = makeInit();
    startResidencyJournal(a);
    startResidencyJournal(b);

    const ids = listResidencyJournals().map((j) => j.project_id).sort();
    expect(ids).toEqual([a.project_id, b.project_id].sort());
  });

  test('residencyTransitionInFlight short-circuits false when the residency dir does not exist', () => {
    // No journal has been written, so the residency dir is absent — the cheap
    // stat path returns false without reading any per-project file.
    expect(residencyDirExists()).toBe(false);
    expect(residencyTransitionInFlight(createProjectId())).toBe(false);
  });

  test('residencyTransitionInFlight is true for a live journal and false once it reaches done', () => {
    const init = makeInit();
    startResidencyJournal(init);
    expect(residencyTransitionInFlight(init.project_id)).toBe(true);

    advanceResidencyPhase(init.project_id, 'done');
    expect(residencyTransitionInFlight(init.project_id)).toBe(false);

    // A different project with no journal is unaffected.
    expect(residencyTransitionInFlight(createProjectId())).toBe(false);
  });

  test('a bad project id never becomes a path segment', () => {
    expect(() => writeResidencyJournal({
      ...makeInit({ project_id: '../escape' }),
      created_at: 'x',
      updated_at: 'x',
    })).toThrow(/grove project id/);
    expect(readResidencyJournal('../escape')).toBeNull();
  });
});

describe('failure stamp/clear — phase-preserving by construction', () => {
  test('stamp records the error against the CURRENT durable phase, not the caller\'s snapshot', () => {
    const init = makeInit({ direction: 'detach', phase: 'pulling' });
    startResidencyJournal(init);
    // The durable journal advances (the flip) while some caller still holds
    // the pulling-phase snapshot it listed at pass start.
    advanceResidencyPhase(init.project_id, 'applying');

    const stamped = stampResidencyFailure(init.project_id, 'database is locked');

    expect(stamped?.phase).toBe('applying'); // never regressed by the stamp
    expect(stamped?.last_error).toBe('database is locked');
    expect(stamped?.last_error_at).toBeTruthy();
    expect(readResidencyJournal(init.project_id)?.phase).toBe('applying');
  });

  test('clear removes the stamp and preserves the current phase', () => {
    const init = makeInit({ direction: 'detach', phase: 'pulling' });
    startResidencyJournal(init);
    stampResidencyFailure(init.project_id, 'transient');
    advanceResidencyPhase(init.project_id, 'applying');

    const cleared = clearResidencyFailure(init.project_id);

    expect(cleared?.phase).toBe('applying');
    expect(cleared?.last_error).toBeUndefined();
    expect(cleared?.last_error_at).toBeUndefined();
  });

  test('stamp and clear on a missing journal are no-ops returning null', () => {
    const projectId = makeInit().project_id;
    expect(stampResidencyFailure(projectId, 'x')).toBeNull();
    expect(clearResidencyFailure(projectId)).toBeNull();
    expect(readResidencyJournal(projectId)).toBeNull(); // nothing was created
  });
});
