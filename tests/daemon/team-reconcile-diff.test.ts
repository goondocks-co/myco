/**
 * Pure unit tests for diffPartition — no DB, no I/O.
 *
 * Covers the five canonical cases from the symmetric-reconcile spec:
 *   1. local-only id   → upsertIds
 *   2. D1-only id      → deleteIds
 *   3. both, same hash → no action (none bucket)
 *   4. both, hash differs, content-hash table → staleIds
 *   5. both ids match, table has no content_hash → presence-only, no stale
 */

import { describe, expect, it } from 'bun:test';
import { diffPartition, type LocalRow, type ManifestItemLike } from '@myco/daemon/team-reconcile.js';

// Convenience constructors.
function local(id: string, hash?: string): LocalRow {
  return hash !== undefined ? { id, content_hash: hash } : { id };
}

function manifest(id: string, hash?: string): ManifestItemLike {
  return hash !== undefined ? { id, content_hash: hash } : { id };
}

describe('diffPartition', () => {
  it('case 1: local-only id → upsertIds', () => {
    const result = diffPartition(
      [local('a')],
      [],
    );
    expect(result.upsertIds).toEqual(['a']);
    expect(result.deleteIds).toEqual([]);
    expect(result.staleIds).toEqual([]);
  });

  it('case 2: D1-only id → deleteIds', () => {
    const result = diffPartition(
      [],
      [manifest('b')],
    );
    expect(result.upsertIds).toEqual([]);
    expect(result.deleteIds).toEqual(['b']);
    expect(result.staleIds).toEqual([]);
  });

  it('case 3: id in both, same content_hash → no action', () => {
    const result = diffPartition(
      [local('c', 'hash-abc')],
      [manifest('c', 'hash-abc')],
    );
    expect(result.upsertIds).toEqual([]);
    expect(result.deleteIds).toEqual([]);
    expect(result.staleIds).toEqual([]);
  });

  it('case 4: id in both, hashes differ (content-hash table) → staleIds', () => {
    const result = diffPartition(
      [local('d', 'hash-old')],
      [manifest('d', 'hash-new')],
    );
    expect(result.upsertIds).toEqual([]);
    expect(result.deleteIds).toEqual([]);
    expect(result.staleIds).toEqual(['d']);
  });

  it('case 5: id in both, no content_hash (presence-only table) → no stale, no action', () => {
    // Tables like skill_usage, entities, graph_edges have no content_hash.
    // Presence alone confirms the row is in sync.
    const result = diffPartition(
      [local('e')],           // no content_hash
      [manifest('e')],        // no content_hash
    );
    expect(result.upsertIds).toEqual([]);
    expect(result.deleteIds).toEqual([]);
    expect(result.staleIds).toEqual([]);
  });

  it('mixed partition: multiple ids in all three buckets', () => {
    const result = diffPartition(
      [
        local('local-only'),
        local('both-same', 'same-hash'),
        local('both-stale', 'local-hash'),
        local('presence-both'),      // presence-only (no hash)
      ],
      [
        manifest('d1-only'),
        manifest('both-same', 'same-hash'),
        manifest('both-stale', 'd1-hash'),
        manifest('presence-both'),   // presence-only (no hash)
      ],
    );

    expect(result.upsertIds).toEqual(['local-only']);
    expect(result.deleteIds).toEqual(['d1-only']);
    expect(result.staleIds).toEqual(['both-stale']);
    // 'both-same' and 'presence-both' land in none of the three buckets.
  });

  it('no stale when only one side carries content_hash (asymmetric schema)', () => {
    // If local has a hash but manifest does not (or vice versa), we cannot
    // conclude staleness — treat as presence-only for that row.
    const localHashOnly = diffPartition(
      [local('x', 'some-hash')],
      [manifest('x')],               // D1 item has no hash
    );
    expect(localHashOnly.staleIds).toEqual([]);

    const manifestHashOnly = diffPartition(
      [local('y')],                  // local row has no hash
      [manifest('y', 'some-hash')],
    );
    expect(manifestHashOnly.staleIds).toEqual([]);
  });

  it('empty inputs produce empty diff', () => {
    const result = diffPartition([], []);
    expect(result.upsertIds).toEqual([]);
    expect(result.deleteIds).toEqual([]);
    expect(result.staleIds).toEqual([]);
  });
});
