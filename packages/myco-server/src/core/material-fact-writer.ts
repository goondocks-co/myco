import type { ServerEnv, RelationalStore, PreparedStatement } from './adapters.js';
import { contentAssertion, readVerifiedContentText } from './registered-content.js';
import { publicationVersionStatements, finishVersionStatements, readFactVersion } from './material-versions.js';
import { viewContentHash, materialContentHash } from './material-content.js';
import { preparePlanStatusWrite } from './plan-status.js';
import type { ReadScope } from '../read/scope.js';
import { sha256Hex } from '../hash.js';
import { blobObjectKey } from './blob-objects.js';
import { measuredContentEnv, remainingContentBudget, CONTENT_WALL_MS } from './content-budget.js';
import { planEventWrite, refused, type EventWrite, type IngestContext, type IngestResult } from '../ingest/events.js';
import type { Fragment } from '../ingest/projections.js';
import type { Refused } from '../ingest/envelope.js';
import { createPlanSave } from './plans.js';
import { getPlan } from '../read/plans.js';
import { readBundleEntry } from './archive-bundle.js';
import { bindMaterialSql, type PreparedMaterialEffect } from '../ingest/material-mutation.js';
import type { ContentPublicationGuard } from './registered-content.js';
import type { ContextCommit, ContextWrite } from './context-writes.js';
import { prepareMaterialRestore } from './material-restore.js';

export class MaterialWriteRetryableError extends Error {
  readonly code = 'material_write_retryable';
  readonly retryable = true;
  constructor() {
    super('material write exhausted its contention admission');
    this.name = 'MaterialWriteRetryableError';
  }
}

interface MaterialAttempt<T> {
  evidence: readonly MaterialEvidence[];
  commit: () => Promise<T>;
  release?: () => Promise<unknown>;
}

interface MaterialEvidence extends Fragment {
  isolated?: boolean;
}
const retryQueues = new WeakMap<RelationalStore, Promise<void>>();

async function reserveMaterialRetry(db: RelationalStore): Promise<() => void> {
  const previous = retryQueues.get(db) ?? Promise.resolve();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  retryQueues.set(db, tail);
  await previous;
  return () => {
    release();
    if (retryQueues.get(db) === tail) retryQueues.delete(db);
  };
}

async function retryMaterialWrite<Env extends { db: RelationalStore; blobs?: ServerEnv['blobs'] }, T>(
  source: Env,
  prepare: (env: Env, batch: RelationalStore['batch']) => Promise<MaterialAttempt<T>>,
): Promise<T> {
  const measured = measuredContentEnv(source, { ...remainingContentBudget(source.db), enforceWall: true });
  let releaseRetry: (() => void) | undefined;
  try {
    for (;;) {
      let attempt: MaterialAttempt<T> | undefined;
      try {
        attempt = await prepare(measured.env, measured.batch);
        try {
          return await attempt.commit();
        } catch (error) {
          if (!(error instanceof Error) || !/CHECK constraint failed.*ok\s*=\s*1/i.test(error.message)) throw error;
          if (await materialEvidenceIntact(measured.env.db, attempt.evidence)) throw error;
        }
      } finally {
        await attempt?.release?.();
      }
      releaseRetry ??= await reserveMaterialRetry(source.db);
    }
  } catch (error) {
    if (error instanceof Error && /^content_(?:wall|statement|blob|call)_budget_exhausted$/.test(error.message))
      throw new MaterialWriteRetryableError();
    throw error;
  } finally {
    releaseRetry?.();
  }
}
const balancedAnd = (values: readonly string[]): string =>
  values.length === 0
    ? '1'
    : values.length === 1
      ? values[0]!
      : '(' +
        balancedAnd(values.slice(0, Math.floor(values.length / 2))) +
        ' AND ' +
        balancedAnd(values.slice(Math.floor(values.length / 2))) +
        ')';
const IDENTIFIER = /^[a-z_][a-z_0-9]*$/i;
const planTagsSql = `(SELECT json_group_array(tag) FROM(SELECT tag FROM tags WHERE project_id=p.project_id AND entity_kind='plan' AND entity_id=p.plan_key ORDER BY tag))`;
const authoritativeFactEvidence = (project: string, table: string, key: string): Fragment => ({
  sql: `NOT EXISTS(SELECT 1 FROM fact_classes WHERE project_id=? AND table_name=? AND record_id=? AND class='legacy')`,
  params: [project, table, key],
});

interface FactPlanSnapshot {
  logical: Record<string, unknown>;
  session: string;
  identity: string;
  evidence: readonly MaterialEvidence[];
}

const materialGuards = (db: RelationalStore, evidence: readonly MaterialEvidence[]): PreparedStatement[] => {
  const guards: PreparedStatement[] = [];
  for (let offset = 0; offset < evidence.length; ) {
    if (evidence[offset]!.isolated) {
      const proof = bindMaterialSql(evidence[offset++]!);
      guards.push(...contentAssertion(db, proof.sql, proof.params));
      continue;
    }
    let end = offset + 1;
    while (end < evidence.length && end - offset < 5 && !evidence[end]!.isolated) end++;
    const page = evidence.slice(offset, end).map(bindMaterialSql);
    offset = end;
    guards.push(
      ...contentAssertion(
        db,
        `NOT EXISTS(SELECT 1 FROM (${page.map((proof) => `SELECT (${proof.sql}) admitted`).join(' UNION ALL ')}) WHERE admitted IS NOT 1)`,
        page.flatMap((proof) => proof.params),
      ),
    );
  }
  return guards;
};

async function materialEvidenceIntact(db: RelationalStore, evidence: readonly Fragment[]): Promise<boolean> {
  for (let offset = 0; offset < evidence.length; offset += 5) {
    const page = evidence.slice(offset, offset + 5).map(bindMaterialSql);
    const rows = (
      await db
        .prepare(page.map((proof) => `SELECT (${proof.sql}) admitted`).join(' UNION ALL '))
        .bind(...page.flatMap((proof) => proof.params))
        .all<{ admitted: number }>()
    ).results;
    if (rows.length !== page.length) throw new Error('material_evidence_invalid');
    if (rows.some((row) => row.admitted !== 1)) return false;
  }
  return true;
}

async function verifiedMaterialBlob(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  project: string,
  key: string,
  evidence: Fragment[],
): Promise<string> {
  const held = await env.db
    .prepare(`SELECT generation,size FROM blobs WHERE project_id=? AND key=?`)
    .bind(project, key)
    .first<{ generation: string | null; size: number }>();
  if (held === null) throw new Error('material_body_unavailable');
  const content = await readVerifiedContentText(env, blobObjectKey(project, key, held.generation), held.size, key);
  evidence.push({
    sql: `EXISTS(SELECT 1 FROM blobs WHERE project_id=? AND key=? AND generation IS ? AND size=?)`,
    params: [project, key, held.generation, held.size],
  });
  return content;
}

async function completeMaterialBody(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  project: string,
  row: Record<string, unknown>,
  evidence: Fragment[],
  field: 'content' | 'text' = 'content',
): Promise<string> {
  let content = row[field];
  if (typeof row.blob_key === 'string') {
    content = await verifiedMaterialBlob(env, project, row.blob_key, evidence);
  }
  if (typeof content !== 'string' || (await sha256Hex(content)) !== row.content_hash)
    throw new Error('material_body_digest');
  return content;
}

async function completeToolBody(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  project: string,
  row: Record<string, unknown>,
  effect: PreparedMaterialEffect,
  evidence: Fragment[],
) {
  const logical = { ...row };
  for (const [field, blob] of [
    ['input', 'input_blob_key'],
    ['output_preview', 'output_blob_key'],
  ] as const) {
    const admitted = row._new === 1 ? effect.newBodies?.[field] : undefined;
    if (admitted !== undefined) {
      logical[field] = admitted;
      continue;
    }
    if (field === 'input' && row.input_bundle_id !== null && row.input_bundle_id !== undefined) {
      if (
        !Number.isSafeInteger(row.input_bundle_id) ||
        !Number.isSafeInteger(row.input_bundle_entry) ||
        typeof row.token_id !== 'string'
      )
        throw new Error('material_bundle_locator_invalid');
      const guards: ContentPublicationGuard[] = [];
      logical.input = await readBundleEntry(
        env,
        {
          projectId: project,
          kind: 'tool-input',
          resourceId: effect.recordId,
          bundleId: Number(row.input_bundle_id),
          entry: Number(row.input_bundle_entry),
          tokenId: row.token_id,
        },
        guards,
      );
      evidence.push(
        ...guards.map((guard) => ({
          sql: guard.sql,
          params: [...(typeof guard.params === 'function' ? guard.params() : guard.params)],
        })),
      );
    } else if (typeof row[blob] === 'string') {
      logical[field] = await verifiedMaterialBlob(env, project, row[blob], evidence);
    }
    if (
      field === 'input' &&
      typeof logical.input === 'string' &&
      row.input_bytes !== null &&
      row.input_bytes !== undefined &&
      new TextEncoder().encode(logical.input).length !== row.input_bytes
    )
      throw new Error('material_input_size');
  }
  return logical;
}

/** A fact snapshot carries exact row, tag and binding evidence into its mutation batch. */
async function factPlanSnapshot(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  scope: ReadScope,
  key: string,
): Promise<FactPlanSnapshot | null> {
  const db = env.db;
  const classification = authoritativeFactEvidence(scope.projectId, 'plans', key);
  const raw = await db
    .prepare(
      `SELECT p.*,${planTagsSql} fact_tags,(${classification.sql}) fact_admitted FROM plans p WHERE p.project_id=? AND p.plan_key=?`,
    )
    .bind(...classification.params, scope.projectId, key)
    .first<Record<string, unknown>>();
  if (raw === null) return null;
  if (raw.fact_admitted !== 1) throw new Error('material_promotion_required');
  if (typeof raw.session_id !== 'string') throw new Error('material_session_absent');
  const bodyEvidence: Fragment[] = [];
  const body = await completeMaterialBody(env, scope.projectId, raw, bodyEvidence);
  const columns = Object.keys(raw).filter((column) => column !== 'fact_tags' && column !== 'fact_admitted');
  if (columns.some((column) => !IDENTIFIER.test(column))) throw new Error('material_column_invalid');
  const current = await readFactVersion(db, scope.projectId, raw.session_id, 'plan', key);
  const rowEvidence = {
    isolated: true,
    sql: `EXISTS(WITH expected AS(SELECT ? doc) SELECT 1 FROM plans p WHERE p.project_id=? AND p.plan_key=?
   AND (${classification.sql})
   AND ${balancedAnd(columns.map((column) => `p.${column} IS json_extract((SELECT doc FROM expected),'$.${column}')`))}
   AND ${planTagsSql} IS json_extract((SELECT doc FROM expected),'$.fact_tags'))`,
    params: [JSON.stringify(raw), scope.projectId, key, ...classification.params],
  };
  const bindingEvidence = current.evidence;
  return {
    logical: { ...raw, content: body, tags: JSON.parse(String(raw.fact_tags)) },
    session: raw.session_id,
    identity: current.identity,
    evidence: [rowEvidence, bindingEvidence, ...bodyEvidence],
  };
}

/** The canonical status mutation and its material version commit as one guarded operation. */
export async function setPublishedPlanStatus(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  scope: ReadScope,
  key: string,
  status: string,
  by: string,
  now: number,
): Promise<boolean> {
  return retryMaterialWrite(env, async (env) => {
    const snapshot = await factPlanSnapshot(env, scope, key);
    if (snapshot === null) return { evidence: [], commit: async () => false };
    const planned = preparePlanStatusWrite(env.db, scope, key, status, by, now);
    const logical = { ...snapshot.logical, ...planned.effect.patch };
    const hash = await viewContentHash(planned.effect.kind, logical),
      token = crypto.randomUUID();
    const guards = materialGuards(env.db, snapshot.evidence);
    return {
      evidence: snapshot.evidence,
      commit: async () => {
        const result = await env.db.batch([
          ...guards,
          planned.statement,
          ...publicationVersionStatements(
            env.db,
            scope.projectId,
            snapshot.session,
            token,
            [{ kind: 'plan', identity: snapshot.identity, recordId: key, hash, owner: 'fact' }],
            false,
          ),
          ...finishVersionStatements(env.db, scope.projectId, snapshot.session, token),
        ]);
        return result[guards.length]!.results.length > 0;
      },
    };
  });
}

/** Every canonical material operation shares postimage, ownership, binding and allocation admission. */
async function prepareFactPublication(
  env: { db: RelationalStore; blobs?: ServerEnv['blobs'] },
  project: string,
  material: ContextWrite['material'],
  statements = env.db,
) {
  const admitted = await env.db
    .prepare(`SELECT (${material.admission.sql}) admitted`)
    .bind(...material.admission.params)
    .first<{ admitted: number }>();
  const accepted = admitted?.admitted === 1;
  const opportunity = await env.db
    .prepare(`SELECT (${material.opportunity.sql}) admitted`)
    .bind(...material.opportunity.params)
    .first<{ admitted: number }>();
  const canApply = opportunity?.admitted === 1;
  const evidence: MaterialEvidence[] = [
    {
      isolated: true,
      sql: `(${material.admission.sql}) IS ?`,
      params: [...material.admission.params, accepted ? 1 : 0],
    },
    {
      isolated: true,
      sql: `(${material.opportunity.sql}) IS ?`,
      params: [...material.opportunity.params, canApply ? 1 : 0],
    },
  ];
  const publications: PreparedStatement[] = [];
  if (accepted && canApply)
    for (const effect of material.effects) {
      const selected = await env.db
        .prepare(`SELECT (${effect.postimage.sql}) doc`)
        .bind(...effect.postimage.params)
        .first<{ doc: string | null }>();
      const doc = selected?.doc ?? null;
      evidence.push({
        isolated: true,
        sql: `(${effect.postimage.sql}) IS ?`,
        params: [...effect.postimage.params, doc],
      });
      if (doc === null) continue;
      const raw = JSON.parse(doc) as Record<string, unknown>;
      if (raw.project_id !== project || typeof raw.session_id !== 'string')
        throw new Error('material_destination_invalid');
      const classification = authoritativeFactEvidence(project, effect.table, effect.recordId);
      const visible =
        (
          await env.db
            .prepare(`SELECT (${classification.sql}) admitted`)
            .bind(...classification.params)
            .first<{ admitted: number }>()
        )?.admitted === 1;
      evidence.push({ sql: `(${classification.sql}) IS ?`, params: [...classification.params, visible ? 1 : 0] });
      if (!visible) {
        if (effect.skipLegacy) continue;
        throw new Error('material_promotion_required');
      }
      const field = effect.kind === 'plan' ? 'content' : 'text';
      let logical = raw;
      if (effect.kind === 'tool' || effect.kind === 'prompt' || effect.kind === 'response' || effect.kind === 'plan') {
        if (env.blobs === undefined) throw new Error('material_body_store_required');
        const bodies = { db: env.db, blobs: env.blobs };
        logical =
          effect.kind === 'tool'
            ? await completeToolBody(bodies, project, raw, effect, evidence)
            : { ...raw, [field]: await completeMaterialBody(bodies, project, raw, evidence, field) };
      }
      const version = await readFactVersion(env.db, project, raw.session_id, effect.kind, effect.recordId);
      evidence.push(version.evidence);
      const hash = await materialContentHash(effect.kind, logical),
        attempt = crypto.randomUUID();
      publications.push(
        ...publicationVersionStatements(
          statements,
          project,
          raw.session_id,
          attempt,
          {
            items: [{ kind: effect.kind, identity: version.identity, recordId: effect.recordId, hash, owner: 'fact' }],
            when: material.admission,
          },
          false,
        ),
        ...finishVersionStatements(statements, project, raw.session_id, attempt),
      );
    }
  return {
    evidence: material.effects.some((effect) => effect.kind === 'plan')
      ? evidence.map((proof) => ({ ...proof, isolated: true }))
      : evidence,
    publications,
  };
}

/** Context records retain their canonical commit results while their versions join the same batch. */
export const commitPublishedContextWrite: ContextCommit = async (db, write) => {
  return retryMaterialWrite({ db }, async (measured, batch) => {
    const { evidence, publications } = await prepareFactPublication(
      measured,
      write.material.project,
      write.material,
      db,
    );
    const guards = materialGuards(db, evidence);
    return {
      evidence,
      commit: async () => {
        const result = await batch([...guards, ...write.statements, ...publications]);
        return result.slice(guards.length, guards.length + write.statements.length);
      },
    };
  });
};

type PublishedMaterialWrite = { ok: true; write: EventWrite; evidence: readonly Fragment[] };

/** Canonical event operations publish their complete material postimages under exact merge evidence. */
export async function planPublishedMaterialEvent(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  ctx: IngestContext,
  body: unknown,
): Promise<PublishedMaterialWrite | Refused> {
  const started = Date.now(),
    limits = remainingContentBudget(env.db),
    measured = measuredContentEnv(env, { ...limits, enforceWall: true });
  const planned = await planEventWrite(env.db, ctx, body, measured.env);
  if (!planned.ok) return planned;
  try {
    const material = planned.write.material;
    if (material === undefined || material.effects.length === 0) throw new Error('published_material_event_required');
    const { evidence, publications } = await prepareFactPublication(measured.env, ctx.projectId, material, env.db);
    const guards = materialGuards(env.db, evidence);
    const statements = [...guards, ...planned.write.statements, ...publications];
    if (statements.length + measured.usage.statements > limits.statements)
      throw new Error('content_statement_budget_exhausted');
    if (Date.now() - started > Math.min(CONTENT_WALL_MS, limits.wallMs))
      throw new Error('content_wall_budget_exhausted');
    return {
      ok: true,
      evidence,
      write: {
        ...planned.write,
        statements,
        interpret: (results) =>
          planned.write.interpret(results.slice(guards.length, guards.length + planned.write.statements.length)),
        preparationCalls: (planned.write.preparationCalls ?? 0) + measured.usage.statements + measured.usage.blobCalls,
      },
    };
  } catch (error) {
    await planned.write.releaseUnlinked?.();
    throw error;
  }
}

/** Per-identity contention re-derives the canonical operation before another publication attempt. */
export async function ingestPublishedMaterialEvent(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  ctx: IngestContext,
  body: unknown,
): Promise<IngestResult> {
  return retryMaterialWrite(env, async (env) => {
    const planned = await planPublishedMaterialEvent(env, ctx, body);
    if (!planned.ok) return { evidence: [], commit: async () => refused(ctx, planned) };
    return {
      evidence: planned.evidence,
      commit: async () => planned.write.interpret(await env.db.batch(planned.write.statements)),
      release: planned.write.releaseUnlinked,
    };
  });
}

export const planPublishedPlanEvent = planPublishedMaterialEvent;
export const ingestPublishedPlanEvent = ingestPublishedMaterialEvent;

export const savePublishedPlan = createPlanSave(ingestPublishedPlanEvent);

/** The plan status operation answers a fresh row after its versioned mutation. */
export async function changePublishedPlanStatus(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  scope: ReadScope,
  key: string,
  status: string,
  by: string,
  now: number,
) {
  await setPublishedPlanStatus(env, scope, key, status, by, now);
  return getPlan(env.db, scope, key);
}

/** Restored authoritative rows use their canonical additive operation and exact resolved body evidence. */
export async function restorePublishedMaterial(
  env: Pick<ServerEnv, 'db' | 'blobs'>,
  table: string,
  row: Record<string, unknown>,
  when: Fragment = { sql: '1', params: [] },
) {
  return retryMaterialWrite(env, async (env) => {
    const restored = await prepareMaterialRestore(env.db, table, row, when);
    if (restored.write === null) throw new Error('material_restore_not_session_material');
    const { evidence, publications } = await prepareFactPublication(
      env,
      restored.write.material.project,
      restored.write.material,
    );
    const guards = materialGuards(env.db, evidence);
    return {
      evidence,
      commit: async () => (await env.db.batch([...guards, restored.statement, ...publications]))[guards.length]!,
    };
  });
}
