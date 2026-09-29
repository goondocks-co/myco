import { expect } from 'bun:test';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { lit, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';
import { loadRecallFixture, seedStatements } from '../recall/fixture.ts';
import { startEmbeddingStub } from '../recall/embedding-stub.ts';
import { compareToBaseline, withTarget, type Served } from '../recall/score.ts';
import { readRecallBaseline, writeRecallBaseline } from '../recall/baseline-file.ts';

/** Steps past which calibration is taken as stuck: one per source, then the hubness pages, with room to spare. */
const MAX_EMBEDDING_STEPS = 3_000;
const AGENT_ID = 'recall-gold';
/** Each target's name in the baseline, which lives in the server's platform-neutral source. */
const FRONT_DOOR = { selfhosted: 'self-hosted', cloudflare: 'hosted' } as const;
/** Runs, each with its own credential, the embedding steps rotate across. */
const HOLDERS = 4;

/**
 * The recall gold set (#1154), on each front door.
 *
 * 48 real prompts from captured sessions, each judged by the owner against
 * what its injected block should carry, are served through the shipped
 * `POST /context/prompt` over a frozen copy of the dogfood corpus. The corpus
 * is embedded and calibrated by the shipped `/runs/embedding-step`; only the
 * embedding model (and, on the Worker, the Vectorize index) answer from the
 * frozen fixture. Each target's served blocks are held to the baseline
 * recorded for it; `MYCO_EVAL_RECORD=1` records instead.
 */
export const recallGold: ParityScenario = {
  name: 'recall gold set: real prompts served through the shipped path hold to the recorded baseline',
  dedicated: { cloudflare: { main: '../../tests/parity/recall/worker-entry.ts' }, timeoutMs: 600_000 },
  async run(target: ParityTarget) {
    const { gold, corpus, lookup } = loadRecallFixture();
    const now = Date.now();
    const projectId = target.projectId;
    const owner = async (route: string, method: string, body: unknown) => {
      const res = await fetch(`${target.url}${route}`, { method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(`${method} ${route}: ${res.status}`).toBe(`${method} ${route}: 200`);
    };
    const post = async <T,>(route: string, token: string, body: unknown): Promise<T> => {
      const res = await fetch(`${target.url}${route}`, { method: 'POST', headers: memberHeadersFor(token, projectId, { 'content-type': 'application/json' }), body: JSON.stringify(body) });
      expect(`${route}: ${res.status}`).toBe(`${route}: 200`);
      return await res.json() as T;
    };

    const stub = target.name === 'selfhosted' ? startEmbeddingStub(lookup) : null;
    try {
      await target.sql(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (${lit(projectId)}, 'Recall gold', ${now})`);
      await target.sql(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (${lit(AGENT_ID)}, ${lit(AGENT_ID)}, 'built-in', 1, ${now})`);
      if (stub !== null) {
        // The self-hosted Deployment reaches the fixture through its own configured provider.
        for (const [leaf, value] of [['embedding.provider', 'openai-compatible'], ['embedding.model', 'bge-m3'], ['embedding.base_url', stub.url]] as const) {
          await target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (${lit(leaf)}, ${lit(JSON.stringify(value))}, ${now}, 'recall-gold')`);
        }
      }
      await owner(`/api/projects/${projectId}/capabilities/cortex`, 'PUT', { enabled: true });
      for (const statement of seedStatements(projectId, corpus, AGENT_ID, now)) await target.sql(statement);
      const seeded = await target.sql(`SELECT (SELECT COUNT(*) FROM spores WHERE project_id = ${lit(projectId)} AND status = 'active') AS spores,
        (SELECT COUNT(*) FROM plans WHERE project_id = ${lit(projectId)}) AS plans`);
      expect(seeded).toEqual([{ spores: corpus.spores.length, plans: corpus.plans.length }]);

      // The corpus is embedded and calibrated by the shipped embedding step, under runs this scenario holds as the
      // harness would: each run names the credential that drives it, with a lease well past the scenario. One
      // credential per run spreads the steps under the per-credential request limit a single harness never reaches.
      await target.sql(`INSERT OR IGNORE INTO members (id, label, created_at) VALUES ('mem_harness', 'harness', ${now})`);
      const holders: Array<{ token: string; runId: string }> = [];
      for (let i = 0; i < HOLDERS; i++) {
        const token = `recall-gold-${target.name}-${i}-${now}`.padEnd(43, 'x');
        const tokenId = `mt_recall_${i}_${now}`;
        const runId = `recall_gold_${i}_${now}`;
        await target.sql(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, bytes_written, lineage_root, lineage_started_at)
          VALUES (${lit(tokenId)}, 'mem_harness', 'harness', ${lit(await sha256Hex(token))}, ${now}, ${now + 3_600_000}, 0, ${lit(tokenId)}, ${now})`);
        await target.sql(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, dispatched_by, lease_expires_at, run_context)
          VALUES (${lit(projectId)}, ${lit(runId)}, ${lit(AGENT_ID)}, 'embedding-reconcile', 'running', ${now}, ${lit(tokenId)}, ${now + 3_600_000}, ${lit(JSON.stringify({ timeoutSeconds: 3_600 }))})`);
        holders.push({ token, runId });
      }
      let settled = false;
      for (let step = 0; step < MAX_EMBEDDING_STEPS && !settled; step++) {
        const { token, runId } = holders[step % HOLDERS]!;
        const answer = await post<{ held?: boolean; phase?: string; provider_unavailable?: boolean }>('/runs/embedding-step', token, { runId });
        if (answer.held !== true || answer.provider_unavailable === true) throw new Error(`the embedding step refused the run: ${JSON.stringify(answer)}${stub?.misses.length ? ` (${stub.misses[0]})` : ''}`);
        settled = answer.phase === 'settled';
      }
      expect({ settled, misses: stub?.misses ?? [] }).toEqual({ settled: true, misses: [] });
      const calibrated = await target.sql(`SELECT
        (SELECT COUNT(*) FROM embedding_receipts WHERE project_id = ${lit(projectId)} AND ready = 1 AND type = 'spore') AS spores,
        (SELECT COUNT(*) FROM embedding_receipts WHERE project_id = ${lit(projectId)} AND ready = 1 AND type = 'plan') AS plans,
        (SELECT COUNT(*) FROM embedding_receipts WHERE project_id = ${lit(projectId)} AND ready = 1 AND type = 'spore' AND neighbor_mean IS NOT NULL) AS calibrated`);
      expect(calibrated).toEqual([{ spores: corpus.spores.length, plans: corpus.plans.length, calibrated: corpus.spores.length }]);

      // Every case in a session of its own, so no case's record withholds anything from another.
      interface Answer { persisted?: boolean; parts?: Array<{ kind: string; sporeIds?: string[]; planIds?: string[] }>; skipped?: string[] }
      const measured: Record<string, Served> = {};
      for (const c of gold.cases) {
        const answer = await post<Answer>('/context/prompt', target.memberToken, { sessionId: `recall-gold-${c.id}-${now}`, promptId: crypto.randomUUID(), text: c.prompt });
        const refused = (answer.skipped ?? []).filter((s) => s.startsWith('spores') && s !== 'spores:empty');
        if (answer.persisted !== true || refused.length > 0) throw new Error(`${c.id} was not scored: ${JSON.stringify(answer)}`);
        const part = answer.parts?.find((p) => p.kind === 'spores');
        measured[c.id] = { spores: part?.sporeIds ?? [], plans: part?.planIds ?? [] };
      }

      const recorded = readRecallBaseline();
      if (process.env.MYCO_EVAL_RECORD === '1') {
        writeRecallBaseline(withTarget(gold.cases, recorded, FRONT_DOOR[target.name], measured));
        return;
      }
      const baseline = recorded?.targets[FRONT_DOOR[target.name]];
      if (baseline === undefined) throw new Error(`no recall baseline is recorded for ${FRONT_DOOR[target.name]}; record one with MYCO_EVAL_RECORD=1 npm run test:parity`);
      const { regressions, drift } = compareToBaseline(gold.cases, measured, baseline);
      expect({ target: target.name, regressions }).toEqual({ target: target.name, regressions: [] });
      // Anything else that moved leaves the committed baseline, and the Recall quality it reports, describing another release.
      expect({ target: target.name, staleBaseline: drift }).toEqual({ target: target.name, staleBaseline: [] });
    } finally {
      stub?.stop();
    }
  },
};
