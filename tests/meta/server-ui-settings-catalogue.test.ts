/**
 * The dashboard's settings catalogue and the server's Deployment leaf list are
 * one set. A leaf added on one side without the other fails here by name: the
 * server would accept a value the dashboard cannot edit, or the dashboard would
 * offer a control the server refuses as not its tier.
 */
import { describe, expect, it } from 'bun:test';
import { DEPLOYMENT_LEAVES, STEP_UP_LEAVES } from '@myco-server-worker/core/settings.js';
import { STEP_UP_HEADER } from '@myco-server-worker/constants.js';
import { LEAF_FIELDS, LEAF_GROUPS } from '../../packages/myco-server/ui/src/settings/catalogue.js';
import { STEP_UP_HEADER as UI_STEP_UP_HEADER } from '../../packages/myco-server/ui/src/hooks/use-settings.js';

describe('settings catalogue', () => {
  it('names every Deployment leaf exactly once, and nothing else', () => {
    const catalogued = LEAF_FIELDS.map((f) => f.leaf);
    expect(new Set(catalogued).size).toBe(catalogued.length);
    expect([...catalogued].sort()).toEqual([...DEPLOYMENT_LEAVES].sort());
  });

  it('warns on every step-up leaf in its note, so the person is told before the server refuses', () => {
    for (const leaf of STEP_UP_LEAVES) {
      const field = LEAF_FIELDS.find((f) => f.leaf === leaf);
      expect({ leaf, note: field?.note ?? '' }).toEqual({ leaf, note: expect.stringMatching(/step-up key/) });
    }
  });

  it('sends the step-up key in the header the server reads', () => {
    expect(UI_STEP_UP_HEADER).toBe(STEP_UP_HEADER);
  });

  it('gives every select its options and every group a note', () => {
    for (const field of LEAF_FIELDS) {
      if (field.kind === 'select') expect({ leaf: field.leaf, options: (field.options ?? []).length > 0 }).toEqual({ leaf: field.leaf, options: true });
    }
    for (const group of LEAF_GROUPS) expect({ group: group.id, note: group.note.length > 0 }).toEqual({ group: group.id, note: true });
  });
});
