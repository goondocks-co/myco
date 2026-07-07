import type { DaemonClient } from '@myco/hooks/client.js';
import { requestContextHeaders, type MycoRequestContext } from '@myco/grove/request-context.js';
import { projectScopeFromRequestContext } from '@myco/grove/request-context.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { OkfBundle } from '@myco/okf/bundle.js';
import { OkfError } from '@myco/okf/errors.js';
import { type ToolFailure } from './error.js';

/**
 * `myco_okf` — the constrained symbiont surface over the OKF capability.
 *
 * Deliberately editorial-only: status / validate / list / get plus
 * save_concept / supersede_concept. There is NO maintain, output-root, or
 * publish-acknowledgement op — regenerating or relocating the bundle is a
 * user/admin action. That omission from the schema IS the authorization
 * boundary (recorded spec deviation #8: daemon authorize() is allow-all, so
 * the surface is constrained by what the schema exposes, not route roles).
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

function buildBundle(requestContext: MycoRequestContext): OkfBundle {
  const vaultDir = requestContext.projectVaultDir;
  const projectRoot = resolveProjectRoot(vaultDir);
  const config = loadMergedConfig(vaultDir, { groveId: requestContext.groveId ?? undefined });
  return new OkfBundle({
    projectRoot,
    vault: new ProjectVault(projectRoot),
    scope: projectScopeFromRequestContext(requestContext),
    projectId: requestContext.projectId ?? '',
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
  const bundle = buildBundle(requestContext);
  const op = input.op ?? 'status';

  try {
    switch (op) {
      case 'status':
        return bundle.status();
      case 'validate':
        return bundle.validate();
      case 'list':
        return { pages: bundle.listPages() };
      case 'get': {
        if (!input.id) return fail('op "get" requires an id (bundle-relative page path)');
        return { page: bundle.getPage(input.id) };
      }
      case 'save_concept': {
        if (!input.concept_id || !input.markdown) return fail('op "save_concept" requires concept_id and markdown');
        return await bundle.saveConcept({
          id: input.concept_id,
          markdown: input.markdown,
          expectedGeneration: input.expected_generation,
          provenance: { actor: 'symbiont', sessionRef: requestContext.sessionId ?? undefined },
        });
      }
      case 'supersede_concept': {
        if (!input.old_id || !input.new_id || !input.reason) {
          return fail('op "supersede_concept" requires old_id, new_id, and reason');
        }
        return await bundle.supersedeConcept({
          oldId: input.old_id,
          newId: input.new_id,
          reason: input.reason,
          provenance: { actor: 'symbiont', sessionRef: requestContext.sessionId ?? undefined },
        });
      }
      default:
        return fail(`unknown op: ${String(op)}`);
    }
  } catch (err) {
    if (err instanceof OkfError) return { ok: false, error: `${err.code}: ${err.message}` };
    throw err;
  }
}
