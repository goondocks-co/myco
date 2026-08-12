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
  actionScopeKey,
  InvalidActionScopeError,
  type ActionScope,
} from './action-scope.js';
import { ActionInflightRegistry } from './action-inflight.js';
import {
  buildDiagnosticBundle,
  EmptyWindowError,
  SessionNotFoundError,
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
  // Capped so a runaway narrative fails loud as a clean 400 invalid_body
  // instead of tripping the transport's own body-size limit (413) further
  // up the stack — the same shape of failure the UI can't render.
  narrative: z.string().max(20_000).optional(),
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
  /**
   * Fallback vault dir used only when a request arrives with no
   * `requestContext` — mirrors `BackupConfigDeps.bootstrapVaultDir`
   * (backup.ts) and `ConfigRouteDeps.bootstrapVaultDir`
   * (register-config-routes.ts). Every export handler resolves the
   * engine's `vaultDir` per-request from `req.requestContext.projectVaultDir`
   * first, falling back to this only for context-less callers, so doctor
   * runs against the caller's own project vault (which has a Grove project
   * id) instead of the Grove-less bootstrap dir doctor's `runChecks` can
   * never resolve a project for.
   */
  bootstrapVaultDir: string;
  /** resolveDaemonLogDir(bootstrapVaultDir) output — the machine-global daemon.log dir. */
  logDir: string;
  /**
   * Getter for the merged config (redacted inside the engine's environment
   * collector), dereferenced fresh on every export — NOT a snapshot captured
   * once at handler-construction time. `main.ts` registers routes once at
   * daemon boot, so a plain value here would freeze every bundle's
   * `environment.json` at the config as of that instant; production passes
   * `() => liveConfig.current`, the same live-updating ref other handlers
   * close over.
   */
  config: () => unknown;
  mycoVersion: string;
  /** Override the export root (tests); production defaults to resolveDiagnosticsRoot(). */
  diagnosticsDir?: string;
}

export function createDiagnosticsHandlers(deps: DiagnosticsDeps) {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  // Same coalescing shape as backup's create handler (backup.ts:90,164,180):
  // two near-simultaneous exports for the same scope share one build instead
  // of racing two full collector passes against the same Grove DB.
  const inflight = new ActionInflightRegistry();

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
      // Structural body-shape failures (e.g. `window` present but not
      // `{since,until}`) get their own code — `invalid_window` is reserved
      // for the session_id XOR window rule below, so a UI consumer can tell
      // "malformed request" apart from "ambiguous/missing window choice".
      return {
        status: 400,
        body: {
          error: 'invalid_body',
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

    // Doctor's `runChecks` is project-vault-oriented (it needs a Grove
    // project id to resolve against); the bootstrap dir has none, so a
    // request carrying a project-scoped context feeds the engine THAT vault
    // instead — the same `requestContext.projectVaultDir ?? bootstrap`
    // pattern as backup's config routes (backup.ts:333) and the config
    // routes themselves (register-config-routes.ts:53). The manifest
    // records whichever dir was actually used as `doctor_vault_dir`, so a
    // context-less export (doctor still absent) is distinguishable from one
    // that had a project vault to run against.
    const vaultDir = req.requestContext?.projectVaultDir ?? deps.bootstrapVaultDir;

    const key = `diagnostics:${actionScopeKey(scope)}`;
    try {
      return await inflight.run(key, async (): Promise<RouteResponse> => {
        const result = await buildDiagnosticBundle({
          groveId: grove.id,
          db: databaseForGrove(grove.id),
          vaultDir,
          dbPath: resolveGroveDbPath(grove.id, mycoHome),
          mycoHome,
          logDir: deps.logDir,
          config: deps.config(),
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
      });
    } catch (err) {
      if (err instanceof EmptyWindowError) {
        return {
          status: 404,
          body: { error: 'empty_window', nearest_sessions: err.nearestSessions },
        };
      }
      if (err instanceof SessionNotFoundError) {
        return {
          status: 404,
          body: { error: 'session_not_found', message: err.message },
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
        // ISO string, matching backup's list shape (`BackupMeta.modified_at`,
        // backup/engine.ts:386) — a UI consumer renders both lists uniformly.
        // Lexicographic sort on a fixed-width UTC ISO string sorts newest
        // first identically to sorting the raw epoch ms.
        return { file_name: name, size_bytes: size, modified_at: new Date(mtimeMs).toISOString() };
      })
      .sort((a, b) => (a.modified_at < b.modified_at ? 1 : a.modified_at > b.modified_at ? -1 : 0));

    return { body: { exports } };
  }

  /** GET /api/diagnostics/export/:file/download — serve a bundle's raw zip bytes. */
  async function handleDownload(req: RouteRequest): Promise<RouteResponse> {
    // Same Grove-required gate as the list route: a bundle carries session
    // content, transcripts, and prompt hashes for one Grove, so the request
    // must name a Grove before any file resolution happens.
    const groveId = req.requestContext?.groveId;
    if (!groveId) return GROVE_REQUIRED;

    const file = req.params.file;
    // No path separators are legal in a bundle file name, so a traversal
    // attempt (`..%2Fdaemon.log`, `../daemon.log`) fails the character-class
    // regex before any fs call — the same "reject, don't sanitize" posture
    // as attachments.ts.
    if (!file || !EXPORT_FILE_NAME_RE.test(file)) {
      return { status: 404, body: { error: 'not_found' } };
    }

    // The bundle's own file name encodes the Grove it was built for
    // (buildDiagnosticBundle's `myco-diagnostic-<safeGroveId>-<ts>.zip`) — a
    // context bound to Grove A must not be able to name Grove B's file and
    // download it. Same 404 as "not found" so this never distinguishes
    // "exists but wrong Grove" from "doesn't exist" to the caller.
    const requiredPrefix = `myco-diagnostic-${safePathSegment(groveId).segment}-`;
    if (!file.startsWith(requiredPrefix)) {
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
