/**
 * Sync-check between the backend CANDIDATE_STATUS constants and the
 * UI mirror in packages/myco/ui/src/lib/skill-candidate-status.ts. The two files
 * exist separately because the UI is a distinct TypeScript project
 * with no alias into the backend src tree — this test catches any
 * drift at CI time.
 */

import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  CANDIDATE_STATUS,
  AGENT_SETTABLE_STATUSES,
  REST_SETTABLE_STATUSES,
  PIPELINE_FILTER_VALUE,
} from '@myco/constants/skill-candidate-status.js';

describe('skill-candidate-status constants', () => {
  it('AGENT_SETTABLE_STATUSES contains only identified, dismissed, and deferred', () => {
    expect([...AGENT_SETTABLE_STATUSES].sort()).toEqual(
      [
        CANDIDATE_STATUS.IDENTIFIED,
        CANDIDATE_STATUS.DISMISSED,
        CANDIDATE_STATUS.DEFERRED,
      ].sort(),
    );
  });

  it('REST_SETTABLE_STATUSES contains identified, approved, dismissed, deferred but not generated', () => {
    const rest = [...REST_SETTABLE_STATUSES].sort();
    expect(rest).toEqual(
      [
        CANDIDATE_STATUS.IDENTIFIED,
        CANDIDATE_STATUS.APPROVED,
        CANDIDATE_STATUS.DISMISSED,
        CANDIDATE_STATUS.DEFERRED,
      ].sort(),
    );
    expect(rest).not.toContain(CANDIDATE_STATUS.GENERATED);
  });

  it('PIPELINE_FILTER_VALUE concatenates approved and generated with comma', () => {
    expect(PIPELINE_FILTER_VALUE).toBe(
      `${CANDIDATE_STATUS.APPROVED},${CANDIDATE_STATUS.GENERATED}`,
    );
  });

  it('UI mirror file at packages/myco/ui/src/lib/skill-candidate-status.ts has matching string values', () => {
    const uiMirrorPath = path.resolve(
      process.cwd(),
      'packages/myco/ui/src/lib/skill-candidate-status.ts',
    );
    expect(fs.existsSync(uiMirrorPath)).toBe(true);

    const uiSource = fs.readFileSync(uiMirrorPath, 'utf-8');

    // Every backend status value must appear as a string literal in
    // the UI mirror. This is the load-bearing invariant — if the UI
    // uses different strings for the same semantic status, the filter
    // dropdown breaks silently.
    for (const value of Object.values(CANDIDATE_STATUS)) {
      expect(uiSource).toContain(`'${value}'`);
    }

    // The PIPELINE_FILTER_VALUE export must exist with the same name
    // so components can import it. Actual value is derived from the
    // same status strings above, which we already verified.
    expect(uiSource).toContain('PIPELINE_FILTER_VALUE');
  });
});
