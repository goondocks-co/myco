/**
 * Shared project-context resolution for member-side, `localhost-only`
 * content-claim routes: host-served guard → `project_root` (request body)
 * → Grove project manifest → `resolveAttach` → reconciling the resolved
 * (attached or locally-registered) root against the current checkout.
 *
 * Used by the content-claim materialize handler
 * (`content-claims-materialize.ts`) and the file-status route.
 */
import path from 'node:path';

import { loadProjectManifest } from '@myco/config/project-manifest.js';
import { pathsEquivalent, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { isHostServedRequest } from '@myco/grove/request-context.js';
import { findRegisteredProject, type ResolvedRegisteredProject } from '@myco/grove/registry.js';
import { resolveAttach } from '@myco/host/registry.js';

import type { RouteRequest } from '../router.js';
import { errorBody } from './error-envelope.js';

/** Non-null shape of {@link resolveAttach}'s return value. */
export type ResolveAttachResult = NonNullable<ReturnType<typeof resolveAttach>>;

export interface AttachedMemberProjectContext {
  source: 'attached';
  currentRoot: string;
  projectId: string;
  attach: ResolveAttachResult;
}

export interface LocalMemberProjectContext {
  source: 'local';
  currentRoot: string;
  projectId: string;
  registered: ResolvedRegisteredProject;
}

export type MemberProjectContext = AttachedMemberProjectContext | LocalMemberProjectContext;

/** A resolution failure — the exact `status`/`body` the caller must return as-is. */
export interface MemberProjectContextError {
  status: number;
  body: unknown;
}

/**
 * Resolves which Grove project a member-side request is for, its current
 * checkout root, and whether that project is attached to a host or
 * registered locally. Returns a `MemberProjectContextError` — to be
 * returned verbatim by the caller — when: the request is host-served, the
 * body is missing a non-empty `project_root`, no Grove project manifest
 * exists at that root, the resolved (attached or registered) root doesn't
 * match the current root, or the project is neither attached nor
 * registered locally.
 */
export async function resolveMemberProjectContext(
  req: RouteRequest,
  body: Record<string, unknown>,
  mycoHome?: string,
): Promise<MemberProjectContext | MemberProjectContextError> {
  // Defense in depth: `localhost-only` (host/routing.ts) already refuses an
  // overlay-origin request before any localhost-only handler runs, and every
  // loopback request stamps `hostServed: false` — this can never actually be
  // true. Repeating the check here means the never-writes-a-member-tree
  // invariant does not rest on the routing stamp alone (`skill-tools.ts`
  // 166-182 documents the same layered posture for the agent tool surface).
  if (isHostServedRequest(req.requestContext)) {
    return { status: 404, body: errorBody('not_found', 'This route is served on localhost only.') };
  }

  const projectRootInput = body.project_root;
  if (typeof projectRootInput !== 'string' || projectRootInput.length === 0) {
    return { status: 400, body: errorBody('invalid_request', 'project_root is required') };
  }
  const currentRoot = path.resolve(projectRootInput);

  const manifest = loadProjectManifest(resolveProjectVaultDir(currentRoot));
  const projectId = manifest?.project?.id;
  if (!projectId) {
    return {
      status: 404,
      body: errorBody('project_not_registered', `No Grove project manifest at ${currentRoot}`),
    };
  }

  const attach = resolveAttach(projectId);
  if (attach) {
    if (attach.ref.root && !pathsEquivalent(attach.ref.root, currentRoot)) {
      return {
        status: 409,
        body: {
          ...errorBody(
            'root_mismatch',
            'The attached checkout root does not match the current project root.',
          ),
          attached_root: attach.ref.root,
          current_root: currentRoot,
        },
      };
    }
    return { source: 'attached', currentRoot, projectId, attach };
  }

  const registered = findRegisteredProject({ projectId }, mycoHome);
  if (!registered) {
    return {
      status: 404,
      body: errorBody(
        'project_not_registered',
        `Project ${projectId} is not registered locally and is not attached to a host`,
      ),
    };
  }
  if (!pathsEquivalent(registered.project.root, currentRoot)) {
    return {
      status: 409,
      body: {
        ...errorBody(
          'root_mismatch',
          'The registered project root does not match the current project root.',
        ),
        registered_root: registered.project.root,
        current_root: currentRoot,
      },
    };
  }

  return { source: 'local', currentRoot, projectId, registered };
}
