import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SqliteVecVectorStore } from '@myco/daemon/embedding/sqlite-vec-store';
import { EMBEDDING_DIMENSIONS } from '@myco/db/schema';

const DIMS = EMBEDDING_DIMENSIONS;
const unit = (axis: number): number[] => { const v = new Array(DIMS).fill(0); v[axis] = 1; return v; };
// Mostly along axis 0 (close to unit(0)) but farther than unit(0) itself.
const near0 = (eps: number): number[] => { const v = new Array(DIMS).fill(0); v[0] = Math.sqrt(1 - eps * eps); v[1] = eps; return v; };
const meta = (domain: Record<string, unknown>) => ({ model: 'm', provider: 'p', content_hash: 'h', embedded_at: 1, domain_metadata: domain });

describe('SqliteVecVectorStore filtered search', () => {
  let store: SqliteVecVectorStore;
  beforeEach(() => { store = new SqliteVecVectorStore(); });
  afterEach(() => { store.close(); });

  it('applies observation_type filter INSIDE the knn (small limit still returns matches)', () => {
    store.upsert('spores', 'a-decision', unit(0), meta({ project_id: 'proj_a', observation_type: 'decision' }));
    store.upsert('spores', 'b-wisdom', near0(0.2), meta({ project_id: 'proj_a', observation_type: 'wisdom' }));
    store.upsert('spores', 'c-wisdom-far', unit(5), meta({ project_id: 'proj_a', observation_type: 'wisdom' }));
    const res = store.search(unit(0), { namespace: 'spores', limit: 1, threshold: -1, filters: { observation_type: 'wisdom' } });
    expect(res.map((r) => r.id)).toEqual(['b-wisdom']);
  });

  it('scopes by project_id partition key', () => {
    store.upsert('spores', 'a', unit(0), meta({ project_id: 'proj_a', observation_type: 'wisdom' }));
    store.upsert('spores', 'b', near0(0.1), meta({ project_id: 'proj_b', observation_type: 'wisdom' }));
    const res = store.search(unit(0), { namespace: 'spores', limit: 10, threshold: -1, filters: { project_id: 'proj_a' } });
    expect(res.map((r) => r.id)).toEqual(['a']);
  });

  it('combines partition + metadata filter in one knn', () => {
    store.upsert('spores', 'a-dec', unit(0), meta({ project_id: 'proj_a', observation_type: 'decision' }));
    store.upsert('spores', 'b-wis', near0(0.2), meta({ project_id: 'proj_a', observation_type: 'wisdom' }));
    store.upsert('spores', 'c-wis-other', unit(0), meta({ project_id: 'proj_b', observation_type: 'wisdom' }));
    const res = store.search(unit(0), { namespace: 'spores', limit: 1, threshold: -1, filters: { project_id: 'proj_a', observation_type: 'wisdom' } });
    expect(res.map((r) => r.id)).toEqual(['b-wis']);
  });

  it('long-string filter (session_id) falls back to post-KNN over-fetch and still matches', () => {
    store.upsert('spores', 'a-dec', unit(0), meta({ project_id: 'proj_a', observation_type: 'decision', session_id: 'sess_x' }));
    store.upsert('spores', 'b-wis', near0(0.2), meta({ project_id: 'proj_a', observation_type: 'wisdom', session_id: 'sess_y' }));
    const res = store.search(unit(0), { namespace: 'spores', limit: 5, threshold: -1, filters: { session_id: 'sess_y' } });
    expect(res.map((r) => r.id)).toEqual(['b-wis']);
  });

  it('null-partition records are excluded by a project filter but returned unfiltered', () => {
    store.upsert('spores', 'g-global', unit(0), meta({ observation_type: 'wisdom' }));
    store.upsert('spores', 'p-scoped', near0(0.1), meta({ project_id: 'proj_a', observation_type: 'wisdom' }));
    const scoped = store.search(unit(0), { namespace: 'spores', limit: 10, threshold: -1, filters: { project_id: 'proj_a' } });
    expect(scoped.map((r) => r.id)).toEqual(['p-scoped']);
    const all = store.search(unit(0), { namespace: 'spores', limit: 10, threshold: -1 });
    expect(all.map((r) => r.id).sort()).toEqual(['g-global', 'p-scoped']);
  });

  it('created_at range filter (post-KNN) excludes undated rows on an upper bound', () => {
    // created_at is post-KNN: json_extract NULL semantics, so a row with NO
    // created_at must NOT match created_at_lte (the sentinel-collision bug).
    store.upsert('spores', 'old', unit(0), meta({ project_id: 'proj_a', created_at: 100 }));
    store.upsert('spores', 'new', near0(0.2), meta({ project_id: 'proj_a', created_at: 5000 }));
    store.upsert('spores', 'undated', near0(0.3), meta({ project_id: 'proj_a' }));
    const gte = store.search(unit(0), { namespace: 'spores', limit: 10, threshold: -1, filters: { created_at_gte: 1000 } });
    expect(gte.map((r) => r.id)).toEqual(['new']);
    const lte = store.search(unit(0), { namespace: 'spores', limit: 10, threshold: -1, filters: { created_at_lte: 1000 } });
    expect(lte.map((r) => r.id).sort()).toEqual(['old']); // NOT 'undated'
  });

  it('fail-loud over-fetch: a post-KNN match ranked beyond the initial pool is still returned', () => {
    // limit 1 → initial over-fetch k = 8. Eight non-matching rows rank nearer
    // than the single matching one (rank ~9), so the initial pool misses it;
    // the widen loop must surface it instead of silently returning [].
    for (let i = 0; i < 8; i++) {
      const v = new Array<number>(DIMS).fill(0);
      v[0] = 1; v[1] = 0.01 * (i + 1); // near — ranks 1..8
      store.upsert('spores', `near-${i}`, v, meta({ project_id: 'proj_a', session_id: 'other' }));
    }
    const far = new Array<number>(DIMS).fill(0);
    far[0] = 1; far[1] = 0.5; // rank ~9
    store.upsert('spores', 'target', far, meta({ project_id: 'proj_a', session_id: 'target' }));

    const res = store.search(unit(0), { namespace: 'spores', limit: 1, threshold: -1, filters: { session_id: 'target' } });
    expect(res.map((r) => r.id)).toEqual(['target']);
  });
});
