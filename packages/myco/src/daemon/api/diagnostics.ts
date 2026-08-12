/**
 * Diagnostic export bundle API — build, list, and download per-Grove
 * diagnostic zips.
 *
 * A bundle is always scoped to exactly one Grove (it joins `groveId` into
 * on-disk paths and the Grove's own DB handle supplies every row), so this
 * mirrors backup's grove-only scope handling (`backup.ts`): `kind: 'project'`
 * and `kind: 'all-groves'` are both rejected rather than silently narrowed
 * or fanned out.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { GroveRuntimeCache } from '../grove-runtime-cache.js';
import { assertOwnedGrove, type GroveRecord } from '../../grove/registry.js';
import { resolveGroveDbPath, resolveMycoHome } from '../../grove/paths.js';
import {
  resolveActionScope,
  InvalidActionScopeError,
  type ActionScope,
} from './action-scope.js';
import {
  buildDiagnosticBundle,
  EmptyWindowError,
  resolveDiagnosticsRoot,
} from '../../capture/diagnostics/index.js';
import { safePathSegment } from '../../capture/diagnostics/safe-path.js';
import type { DiagnosticWindow } from '../../capture/diagnostics/types.js';

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

const DiagnosticWindowSchema = z.object({
  since: z.number(),
  until: z.number(),
});

const ExportBodySchema = z.object({
  // Parsed separately via `resolveActionScope` (needs the raw body, not the
  // narrowed-by-zod one) — accepted here only so `.strict()`-free parsing
  // doesn't choke on it.
  scope: z.unknown().optional(),
  window: DiagnosticWindowSchema.optional(),
  session_id: z.string().min(1).optional(),
  include_content: z.boolean().optional(),
  narrative: z.string().optional(),
});

const EXPORT_FILE_NAME_RE = /^myco-diagnostic-[A-Za-z0-9._-]+\.zip$/;

const GROVE_REQUIRED: RouteResponse = {
  status: 400,
  body: {
    error: 'grove_required',
    message: 'A Grove context is required (x-myco-grove-id). Select a project/Grove first.',
  },
};

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface DiagnosticsDeps {
  /** Per-Grove runtime cache — source of the Grove's DB handle. */
  cache: GroveRuntimeCache;
  /** Override Myco home (tests); production resolves via env/HOME. */
  mycoHome?: string;
  /** The daemon's BOOTSTRAP vault dir — passed through to the doctor collector. */
  vaultDir: string;
  /** resolveDaemonLogDir(bootstrapVaultDir) output — the machine-global daemon.log dir. */
  logDir: string;
  /** Merged config; redacted inside the engine's environment collector. */
  config: unknown;
  mycoVersion: string;
  /** Override the export root (tests); production defaults to resolveDiagnosticsRoot(). */
  diagnosticsDir?: string;
}

export function createDiagnosticsHandlers(deps: DiagnosticsDeps) {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();

  function databaseForGrove(groveId: string) {
    return deps.cache.getDatabase(resolveGroveDbPath(groveId, mycoHome));
  }

  function exportsRoot(): string {
    return resolveDiagnosticsRoot(deps.diagnosticsDir);
  }

  /** POST /api/diagnostics/export — build a diagnostic bundle for one Grove. */
  async function handleExport(req: RouteRequest): Promise<RouteResponse> {
    const parsedBody = ExportBodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return {
        status: 400,
        body: {
          error: 'invalid_window',
          message: parsedBody.error.issues.map((i) => i.message).join('; '),
        },
      };
    }
    const body = parsedBody.data;

    // Scope resolution copied verbatim from backup's handleCreateBackup
    // (backup.ts:134-151): body scope takes precedence, missing body scope
    // falls back to the request-context Grove, and a malformed body scope
    // is distinguished from "no scope at all" so the latter fails loud as
    // grove_required rather than a generic invalid_scope.
    let scope: ActionScope;
    try {
      scope = resolveActionScope({
        body: req.body,
        requestContext: req.requestContext,
        defaultKind: 'grove',
      });
    } catch (err) {
      if (err instanceof InvalidActionScopeError) {
        const raw = (req.body as { scope?: unknown } | null | undefined)?.scope;
        return raw !== undefined
          ? { status: 400, body: { error: 'invalid_scope', message: err.message } }
          : GROVE_REQUIRED;
      }
      throw err;
    }

    if (scope.kind === 'project' || scope.kind === 'all-groves') {
      return {
        status: 400,
        body: {
          error: 'invalid_scope',
          message: `Diagnostic bundles are built per-Grove; pass kind: "grove" instead of "${scope.kind}"`,
        },
      };
    }

    const hasSessionId = typeof body.session_id === 'string' && body.session_id.length > 0;
    const hasWindow = body.window !== undefined;
    if (hasSessionId === hasWindow) {
      return {
        status: 400,
        body: {
          error: 'invalid_window',
          message: 'Provide exactly one of session_id or window.',
        },
      };
    }

    // Body-scope grove ids arrive outside the request-context funnel, so
    // existence and home-ownership gate here before the engine joins the
    // id into fs paths — mirrors backup's grove-kind arm (backup.ts:179).
    const grove: GroveRecord = assertOwnedGrove(scope.grove_id, mycoHome);
    const window: { sessionId: string } | DiagnosticWindow = hasSessionId
      ? { sessionId: body.session_id! }
      : (body.window as DiagnosticWindow);

    try {
      const result = await buildDiagnosticBundle({
        groveId: grove.id,
        db: databaseForGrove(grove.id),
        vaultDir: deps.vaultDir,
        dbPath: resolveGroveDbPath(grove.id, mycoHome),
        mycoHome,
        logDir: deps.logDir,
        config: deps.config,
        mycoVersion: deps.mycoVersion,
        window,
        includeContent: body.include_content ?? false,
        narrative: body.narrative,
        outDir: deps.diagnosticsDir,
      });
      return {
        body: {
          file_path: result.filePath,
          file_name: path.basename(result.filePath),
          size_bytes: result.sizeBytes,
          manifest: result.manifest,
        },
      };
    } catch (err) {
      if (err instanceof EmptyWindowError) {
        return {
          status: 404,
          body: { error: 'empty_window', nearest_sessions: err.nearestSessions },
        };
      }
      throw err;
    }
  }

  /** GET /api/diagnostics/exports — list the active Grove's diagnostic bundles. */
  async function handleListExports(req: RouteRequest): Promise<RouteResponse> {
    const groveId = req.requestContext?.groveId;
    if (!groveId) return GROVE_REQUIRED;

    const root = exportsRoot();
    const prefix = `myco-diagnostic-${safePathSegment(groveId).segment}-`;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      names = [];
    }
    const exports = names
      .filter((name) => name.startsWith(prefix) && name.endsWith('.zip'))
      .map((name) => {
        const full = path.join(root, name);
        let mtimeMs = 0;
        let size = 0;
        try {
          const stat = statSync(full);
          mtimeMs = stat.mtimeMs;
          size = stat.size;
        } catch {
          // Vanished between readdir and stat (a concurrent sweep/export
          // raced us) — falls to the bottom of the sort, harmless.
        }
        return { file_name: name, size_bytes: size, modified_at: Math.floor(mtimeMs / 1000) };
      })
      .sort((a, b) => b.modified_at - a.modified_at);

    return { body: { exports } };
  }

  /** GET /api/diagnostics/export/:file/download — serve a bundle's raw zip bytes. */
  async function handleDownload(req: RouteRequest): Promise<RouteResponse> {
    const file = req.params.file;
    // No path separators are legal in a bundle file name, so a traversal
    // attempt (`..%2Fdaemon.log`, `../daemon.log`) fails the character-class
    // regex before any fs call — the same "reject, don't sanitize" posture
    // as attachments.ts.
    if (!file || !EXPORT_FILE_NAME_RE.test(file)) {
      return { status: 404, body: { error: 'not_found' } };
    }

    const root = path.resolve(exportsRoot());
    const filePath = path.resolve(root, file);
    // Defense in depth: the regex above already forbids '/'/'\\', so
    // `filePath` can only ever land directly inside `root`, but this keeps
    // the invariant explicit rather than implicit in the regex.
    if (path.dirname(filePath) !== root) {
      return { status: 404, body: { error: 'not_found' } };
    }
    if (!existsSync(filePath)) {
      return { status: 404, body: { error: 'not_found' } };
    }

    const data = readFileSync(filePath);
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${file}"`,
      },
      body: data,
    };
  }

  return { handleExport, handleListExports, handleDownload };
}
