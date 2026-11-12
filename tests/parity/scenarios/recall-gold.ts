import { expect } from 'bun:test';
import { memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';
import { loadRecallFixture, importCorpus } from '../recall/fixture.ts';
import { startEmbeddingStub } from '../recall/embedding-stub.ts';
import { compareToBaseline, describeComparison, mustNotRegressions, withTarget, type Served } from '../recall/score.ts';
import { readRecallBaseline, writeRecallBaseline } from '../recall/baseline-file.ts';
import { embeddingPass, embeddingSettings } from '../embedding/runtime.ts';
import { owner as readOwner } from '../clients/requests.ts';
import { revisionHeaders } from '../settings-revision.ts';

/** Runtime passes past which corpus embedding and calibration are taken as stuck. */
const MAX_EMBEDDING_PASSES = 100;
/** Each target's name in the baseline, which lives in the server's platform-neutral source. */
const FRONT_DOOR = { selfhosted: 'self-hosted', cloudflare: 'hosted' } as const;

/**
 * The recall gold set (#1154), on each front door.
 *
 * 48 real prompts from captured sessions, each judged by the owner against
 * what its injected block should carry, are served through the shipped
 * `POST /context/prompt` over a frozen copy of the dogfood corpus. The corpus
 * is embedded and calibrated by dispatched embedding runs; only the
 * embedding model (and, on the Worker, the Vectorize index) answer from the
 * frozen fixture. Each target's served blocks are held to the baseline
 * recorded for it; `MYCO_EVAL_RECORD=1` records instead.
 */
export const recallGold: ParityScenario = {
  name: 'recall gold set: real prompts served through the shipped path hold to the recorded baseline',
  dedicated: { cloudflare: { main: '../../tests/parity/recall/worker-entry.ts' }, selfhosted: { embeddingRuntime: true }, sqliteVec: true, timeoutMs: 600_000 },
  async run(target: ParityTarget) {
    const { gold, corpus, lookup } = loadRecallFixture();
    const now = Date.now();
    const projectId = target.projectId;
    const owner = async (route: string, method: string, body: unknown) => {
      const res = await fetch(`${target.url}${route}`, { method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json', ...((route.includes('/capabilities/') || route === '/api/embedding') ? await revisionHeaders(target, route) : {}) }, body: JSON.stringify(body) });
      expect(`${method} ${route}: ${res.status}`).toBe(`${method} ${route}: 200`);
    };
    const post = async <T,>(route: string, token: string, body: unknown): Promise<T> => {
      const res = await fetch(`${target.url}${route}`, { method: 'POST', headers: memberHeadersFor(token, projectId, { 'content-type': 'application/json' }), body: JSON.stringify(body) });
      expect(`${route}: ${res.status}`).toBe(`${route}: 200`);
      return await res.json() as T;
    };

    const stub = target.name === 'selfhosted' ? startEmbeddingStub(lookup) : null;
    try {
      await embeddingSettings(target);
      await owner('/api/embedding', 'PUT', stub === null ? { provider: 'workers-ai', model: '@cf/baai/bge-m3' } : { provider: 'openai-compatible', model: 'bge-m3', endpoint: stub.url });
      await owner(`/api/projects/${projectId}/capabilities/cortex`, 'PUT', { enabled: true });
      await importCorpus(target, corpus);
      const listed = await readOwner(target, `/api/projects/${projectId}/plans?limit=100`);
      expect(listed.body.plans.map((plan: any) => plan.planKey).sort()).toEqual(corpus.plans.map(plan => plan.planKey).sort());
      let settled = false;
      for (let pass = 0; pass < MAX_EMBEDDING_PASSES && !settled; pass++) settled = await embeddingPass(target) === 'settled';
      expect({ settled, misses: stub?.misses ?? [] }).toEqual({ settled: true, misses: [] });

      // Every case in a session of its own, so no case's record withholds anything from another.
      interface Answer { persisted?: boolean; parts?: Array<{ kind: string; sporeIds?: string[]; planIds?: string[] }>; skipped?: string[] }
      const measured: Record<string, Served> = {};
      for (const c of gold.cases) {
        const answer = await post<Answer>('/context/prompt', target.memberToken, { sessionId: `recall-gold-${c.id}-${now}`, promptId: crypto.randomUUID(), text: c.prompt });
        const refused = (answer.skipped ?? []).filter((s) => s.startsWith('spores') && s !== 'spores:empty');
        if (answer.persisted !== true || refused.length > 0) throw new Error(`${c.id} was not scored: ${JSON.stringify(answer)}`);
        const part = answer.parts?.find((p) => p.kind === 'spores');
        measured[c.id] = { spores: part?.sporeIds ?? [], plans: part?.planIds ?? [] };
        if (c.expectedPlans !== undefined) expect(measured[c.id]!.plans).toEqual(c.expectedPlans);
      }

      // The comparison runs first in either mode, so recording shows a reviewer what it changes, case by case.
      const door = FRONT_DOOR[target.name];
      expect({ target: door, mustNotRegressions: mustNotRegressions(gold.cases, measured, gold.precisionRatchet) })
        .toEqual({ target: door, mustNotRegressions: [] });
      const recorded = readRecallBaseline();
      const previous = recorded?.targets[door];
      if (previous?.mustNot !== undefined) {
        expect({ target: door, mustNotRegressions: mustNotRegressions(gold.cases, measured, previous.mustNot) })
          .toEqual({ target: door, mustNotRegressions: [] });
      }
      const comparison = previous === undefined ? null : compareToBaseline(gold.cases, measured, previous);
      if (process.env.MYCO_EVAL_RECORD === '1') {
        console.log(comparison === null ? `recall gold set, ${door}: no previous record; recording ${gold.cases.length} cases` : describeComparison(door, comparison));
        if (comparison !== null && comparison.regressions.length > 0 && process.env.MYCO_EVAL_ACCEPT_REGRESSIONS !== '1') {
          throw new Error(`refusing to record ${comparison.regressions.length} regressed case(s) for ${door}; set MYCO_EVAL_ACCEPT_REGRESSIONS=1 to record them:\n${comparison.regressions.join('\n')}`);
        }
        writeRecallBaseline(withTarget(gold.cases, recorded, door, measured));
        return;
      }
      if (comparison === null) throw new Error(`no recall baseline is recorded for ${door}; record one with MYCO_EVAL_RECORD=1 npm run test:parity`);
      expect({ target: door, regressions: comparison.regressions }).toEqual({ target: door, regressions: [] });
      // Anything else that moved leaves the committed baseline, and the Recall quality it reports, describing another
      // release: record it again, and the recording lists what changed.
      expect({ target: door, staleBaseline: [...comparison.improvements, ...comparison.drift] }).toEqual({ target: door, staleBaseline: [] });
    } finally {
      stub?.stop();
    }
  },
};
