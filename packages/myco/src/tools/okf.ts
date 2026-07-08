import type { DaemonClient } from '@myco/hooks/client.js';
import { projectScopeFromRequestContext, type MycoRequestContext } from '@myco/grove/request-context.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { OkfStore } from '@myco/okf/store.js';
import { OkfError } from '@myco/okf/errors.js';
import { validateWikiRows } from '@myco/okf/validate.js';
import { parseConceptDoc } from '@myco/okf/frontmatter.js';
import {
  latestOkfGeneration,
  latestRevisionForPage,
  listOkfPages,
} from '@myco/db/queries/okf.js';
import { type ToolFailure } from './error.js';

/**
 * `myco_okf` — the constrained symbiont surface over the DB-resident OKF
 * wiki.
 *
 * Deliberately editorial-only: status / validate / list / get plus
 * save_concept / supersede_concept. There is NO synthesize, output-root, or
 * publish-acknowledgement op — regenerating the wiki is the scheduled task's
 * job and acknowledging findings is a user/admin action. That omission from
 * the schema IS the authorization boundary (daemon authorize() is allow-all,
 * so the surface is constrained by what the schema exposes, not route roles).
 *
 * Tenancy is enforced globally by the tool dispatcher's requireCallerTenancy
 * gate before this handler runs; the handler resolves its project scope from
 * the caller-supplied requestContext, never cwd.
 */

export interface OkfToolInput {
  op?: 'status' | 'validate' | 'list' | 'get' | 'save_concept' | 'supersede_concept';
  id?: string;
  concept_id?: string;
  markdown?: string;
  expected_generation?: number;
  old_id?: string;
  new_id?: string;
  reason?: string;
}

function fail(message: string): ToolFailure {
  return { ok: false, error: message };
}

function buildStore(requestContext: MycoRequestContext): OkfStore {
  const vaultDir = requestContext.projectVaultDir;
  const config = loadMergedConfig(vaultDir, { groveId: requestContext.groveId ?? undefined });
  return new OkfStore({
    scope: projectScopeFromRequestContext(requestContext),
    projectId: requestContext.projectId ?? null,
    machineId: requestContext.machineId,
    config,
  });
}

export async function handleMycoOkf(
  input: OkfToolInput,
  _client: DaemonClient,
  requestContext?: MycoRequestContext,
): Promise<unknown | ToolFailure> {
  if (!requestContext) return fail('myco_okf requires a caller-supplied request context');
  const store = buildStore(requestContext);
  const scope = projectScopeFromRequestContext(requestContext);
  const op = input.op ?? 'status';

  try {
    switch (op) {
      case 'status': {
        const pages = listOkfPages(scope, 'active');
        const published = latestOkfGeneration(scope, ['published']);
        const latest = latestOkfGeneration(scope);
        return {
          bundleExists: pages.length > 0,
          bundleGeneration: published?.generation ?? null,
          pageCount: pages.length,
          lastResult: latest?.status ?? null,
          generatedAt: published ? new Date(published.updated_at * 1000).toISOString() : null,
        };
      }
      case 'validate': {
        const rows = listOkfPages(scope, 'active').map((head) => {
          const revision = latestRevisionForPage(head.id);
          let frontmatter: Record<string, unknown>;
          try {
            frontmatter = JSON.parse(revision?.frontmatter ?? '{}') as Record<string, unknown>;
          } catch {
            frontmatter = { type: head.type };
          }
          return { path: head.path, frontmatter, body: revision?.body ?? '' };
        });
        return validateWikiRows(rows);
      }
      case 'list':
        return {
          pages: listOkfPages(scope, 'active').map((p) => ({
            path: p.path,
            type: p.type,
            title: p.title,
            description: p.description,
            timestamp: new Date(p.updated_at * 1000).toISOString(),
          })),
        };
      case 'get': {
        if (!input.id) return fail('op "get" requires an id (bundle-relative page path)');
        return { page: store.readPage(input.id) };
      }
      case 'save_concept': {
        if (!input.concept_id || !input.markdown) return fail('op "save_concept" requires concept_id and markdown');
        if (typeof input.expected_generation === 'number') {
          const current = latestOkfGeneration(scope, ['published'])?.generation ?? null;
          if (current !== null && current !== input.expected_generation) {
            return fail(`okf_generation_conflict: wiki is at generation ${current}, caller expected ${input.expected_generation}`);
          }
        }
        const { frontmatter, body } = parseConceptDoc(input.markdown);
        const result = store.writeAuthoredPage({
          path: input.concept_id,
          type: typeof frontmatter.type === 'string' ? frontmatter.type : 'concept',
          title: typeof frontmatter.title === 'string' ? frontmatter.title : input.concept_id,
          description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
          body,
          tags: Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : undefined,
        });
        return {
          ok: true,
          status: result.status,
          generation: result.generation.generation,
          findings: result.findings,
        };
      }
      case 'supersede_concept': {
        if (!input.old_id || !input.new_id || !input.reason) {
          return fail('op "supersede_concept" requires old_id, new_id, and reason');
        }
        return { ok: true, ...store.supersedePage(input.old_id, input.new_id, input.reason) };
      }
      default:
        return fail(`unknown op: ${String(op)}`);
    }
  } catch (err) {
    if (err instanceof OkfError) return { ok: false, error: `${err.code}: ${err.message}` };
    throw err;
  }
}
