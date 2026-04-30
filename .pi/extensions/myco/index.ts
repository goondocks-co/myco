// Managed by Myco. Regenerated on `myco update`. Edit src/symbionts/templates/pi/plugin.ts in the Myco repo instead.
// myco:plugin-marker:pi
//
// Myco Codebase Intelligence Extension for Pi.
//
// This extension runs inside pi's extension runtime (jiti) and communicates with
// the local Myco daemon over HTTP — no subprocess spawns, no hook CLI, no stdin piping.
//
//   Capture: POST /sessions/register, /sessions/unregister, /events, /events/stop
//   Context: POST /context, /context/resume
//   Inject:  before_agent_start → systemPrompt augmentation
//
// See https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
//
// Degraded-mode safety: this extension ships committed inside any project that has
// run `myco init` — the file lives at .pi/extensions/myco/index.ts in that project's
// repo. When a teammate clones such a project WITHOUT having Myco installed
// locally, pi will still load this extension. Every path that would contact the
// Myco daemon gracefully no-ops when `.myco/daemon.json` is absent or the daemon
// is unreachable, so the extension becomes invisible rather than throwing.
// Do NOT add runtime imports from Myco packages — only use pi's own exports
// and Node.js built-ins.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Keep in sync with `TOOL_OUTPUT_PREVIEW_CHARS` in src/constants.ts (currently 200).
 * The extension file is standalone and cannot import from Myco — this value is copied
 * so every symbiont records tool_output previews at the same length.
 */
const TOOL_OUTPUT_PREVIEW_CHARS = 200;

/** Timeout for daemon HTTP calls — must be short so we never block pi. */
const MYCO_FETCH_TIMEOUT_MS = 3000;

/** Max size of resume context injection to keep resumed sessions lean. */
const RESUME_CONTEXT_MAX_CHARS = 4000;

// ---------------------------------------------------------------------------
// Daemon HTTP transport
// ---------------------------------------------------------------------------

let cachedDaemonPort: number | null | undefined = undefined;

function readDaemonPortFromDisk(directory: string): number | null {
  try {
    const raw = readFileSync(join(directory, ".myco", "daemon.json"), "utf-8");
    const info = JSON.parse(raw) as { port?: number };
    return typeof info.port === "number" ? info.port : null;
  } catch {
    return null;
  }
}

function getDaemonPort(directory: string): number | null {
  if (cachedDaemonPort === undefined) cachedDaemonPort = readDaemonPortFromDisk(directory);
  return cachedDaemonPort;
}

function refreshDaemonPort(directory: string): number | null {
  cachedDaemonPort = readDaemonPortFromDisk(directory);
  return cachedDaemonPort;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MYCO_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromDaemon(
  directory: string,
  urlPath: string,
  init?: RequestInit,
): Promise<Response | null> {
  const port = getDaemonPort(directory);
  if (!port) return null;

  const first = await fetchWithTimeout(`http://localhost:${port}${urlPath}`, init);
  if (first) return first;

  // Retry once with a refreshed port — the daemon may have restarted.
  const freshPort = refreshDaemonPort(directory);
  if (!freshPort || freshPort === port) return null;
  return fetchWithTimeout(`http://localhost:${freshPort}${urlPath}`, init);
}

async function postJson(
  directory: string,
  urlPath: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown }> {
  const res = await fetchFromDaemon(directory, urlPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res) return { ok: false };
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: true };
  }
}

async function getJson(
  directory: string,
  urlPath: string,
): Promise<{ ok: boolean; data?: unknown }> {
  const res = await fetchFromDaemon(directory, urlPath);
  if (!res) return { ok: false };
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: true };
  }
}

async function deleteJson(
  directory: string,
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown }> {
  const res = await fetchFromDaemon(directory, urlPath, {
    method: "DELETE",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res) return { ok: false };
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: true };
  }
}

// <myco:shared-helpers>
// ---------------------------------------------------------------------------
// Shared plugin helpers — single source of truth for buffer/POST + batch kinds.
//
// This block is maintained in
//   src/symbionts/templates/_shared/plugin-helpers.ts.snippet
// and injected into each plugin file at install time by SymbiontInstaller.
// The plugin files on disk also carry an inline copy between the
// `// <myco:shared-helpers>` markers so they stay valid TypeScript for
// Vitest imports; a unit test enforces the inline copy matches the snippet.
//
// Contract: the snippet assumes the containing file has already defined
//   - `postJson(directory: string, path: string, body): Promise<{ok, data?}>`
//   - no other imports from the outer file
// and exposes
//   - `BATCH_KIND` constants + `BatchKind` type
//   - `bufferEvent(dir, sessionId, event)` — best-effort JSONL append
//   - `isIgnoredResponse(data)` — true when daemon returned an "ignored" drop
//   - `postEventWithBuffer(dir, sessionId, event)` — live POST with buffer fallback
//
// DO NOT edit this block inside a plugin file directly — edit the snippet
// and run the installer (or rerun the template-sync test to update the
// inlined copy). Changes here apply to every plugin the next time it
// installs/updates.
// ---------------------------------------------------------------------------

/**
 * Discriminated vocabulary for `prompt_batches.kind`. Mirrors
 * `BATCH_KIND` in src/db/queries/batches.ts — plugins can't import daemon
 * code, so the constants are inlined here and kept in sync via the shared
 * snippet + its sync test.
 */
const BATCH_KIND = {
  INITIAL: "initial",
  STEERING: "steering",
  INTERRUPT: "interrupt",
} as const;
type BatchKind = typeof BATCH_KIND[keyof typeof BATCH_KIND];

/**
 * Append an event to `.myco/buffer/<session-id>.jsonl` for replay by the
 * daemon's startup reconciler. On-disk shape intentionally matches
 * `src/capture/buffer.ts`'s EventBuffer — the plugin can't import it because
 * of the zero-runtime-dep constraint, so the protocol is the contract.
 */
function bufferEvent(
  directory: string,
  sessionId: string,
  event: Record<string, unknown>,
): void {
  try {
    const bufferDir = join(directory, ".myco", "buffer");
    mkdirSync(bufferDir, { recursive: true });
    const filePath = join(bufferDir, `${sessionId}.jsonl`);
    // Strip session_id from the entry — it's encoded in the filename
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { session_id: _sid, ...payload } = event;
    const line = JSON.stringify({
      ...payload,
      timestamp: payload.timestamp ?? new Date().toISOString(),
    });
    appendFileSync(filePath, line + "\n");
  } catch {
    // Best-effort — never crash the host agent.
  }
}

/** True when the daemon returned 200 but signalled it dropped the event. */
function isIgnoredResponse(data: unknown): boolean {
  if (data === null || typeof data !== "object") return false;
  const ignored = (data as { ignored?: unknown }).ignored;
  return typeof ignored === "string" && ignored.length > 0;
}

/**
 * POST a capture event to the daemon, buffering to disk on failure. Both
 * transport failures and server-side "ignored" responses route to the
 * buffer — rule bugs have silently dropped whole live sessions before, and
 * the buffer is the recovery path once the cause is fixed.
 */
async function postEventWithBuffer(
  directory: string,
  sessionId: string,
  event: Record<string, unknown>,
): Promise<unknown> {
  const result = await postJson(directory, "/events", event);
  if (!result.ok || isIgnoredResponse(result.data)) {
    bufferEvent(directory, sessionId, event);
    return undefined;
  }
  return result.data;
}
// </myco:shared-helpers>

// ---------------------------------------------------------------------------
// Daemon API wrappers
// ---------------------------------------------------------------------------

async function mycoRegisterSession(
  directory: string,
  sessionId: string,
): Promise<void> {
  await postJson(directory, "/sessions/register", {
    session_id: sessionId,
    agent: "pi",
    started_at: new Date().toISOString(),
  });
}

async function mycoUnregisterSession(directory: string, sessionId: string): Promise<void> {
  await postJson(directory, "/sessions/unregister", { session_id: sessionId });
}

async function mycoPostUserPrompt(
  directory: string,
  sessionId: string,
  prompt: string,
  images: Array<{ data: string; mediaType: string }>,
  options: { kind?: BatchKind; parentPromptBatchId?: number | null } = {},
): Promise<{ batchId?: number }> {
  const kind: BatchKind = options.kind ?? BATCH_KIND.INITIAL;
  const parentPromptBatchId = options.parentPromptBatchId ?? null;
  const result = await postEventWithBuffer(directory, sessionId, {
    type: "user_prompt",
    session_id: sessionId,
    agent: "pi",
    prompt,
    kind,
    parent_prompt_batch_id: parentPromptBatchId,
    ...(images.length > 0 ? { images } : {}),
  });
  const batchId = (result as { batchId?: number } | undefined)?.batchId;
  return { batchId };
}

async function mycoPostToolUse(
  directory: string,
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  toolOutput: string,
): Promise<void> {
  await postEventWithBuffer(directory, sessionId, {
    type: "tool_use",
    session_id: sessionId,
    agent: "pi",
    tool_name: toolName,
    tool_input: toolInput,
    output_preview: toolOutput,
  });
}

/**
 * Post a stop event, synchronously buffering to disk before the async POST.
 *
 * Two failure modes are mitigated here:
 *   1. Daemon unreachable — the buffered entry is replayed at the daemon's
 *      next startup reconcile (same as user_prompt / tool_use fallbacks).
 *   2. Pi process exits before the POST settles — `session_shutdown` fires
 *      on Ctrl+D/Ctrl+C/SIGHUP/SIGTERM, and Bun can tear the event loop
 *      down before awaited fetches complete. The buffered copy survives
 *      regardless.
 *
 * Duplicate work is harmless: the reconciler's setResponseSummary is
 * idempotent (writes only when the column is still NULL), so even if both
 * the live POST and the buffered replay succeed, the summary lands once.
 */
async function mycoPostStop(
  directory: string,
  sessionId: string,
  lastAssistantMessage: string | undefined,
): Promise<void> {
  const payload = {
    type: "stop" as const,
    session_id: sessionId,
    agent: "pi",
    last_assistant_message: lastAssistantMessage,
  };
  bufferEvent(directory, sessionId, payload);
  await postJson(directory, "/events/stop", payload);
}

async function fetchMycoSessionContext(
  directory: string,
  sessionId: string,
): Promise<string | null> {
  const result = await postJson(directory, "/context", { session_id: sessionId });
  if (!result.ok) return null;
  const data = result.data as { text?: string } | undefined;
  const text = data?.text?.trim() ?? "";
  return text.length > 0 ? text : null;
}

async function fetchMycoResumeContext(
  directory: string,
  sessionId: string,
  parentSessionId: string,
): Promise<string | null> {
  const result = await postJson(directory, "/context/resume", {
    session_id: sessionId,
    parent_session_id: parentSessionId,
  });
  if (!result.ok) return null;
  const data = result.data as { text?: string } | undefined;
  const text = data?.text?.trim() ?? "";
  if (!text || text.length > RESUME_CONTEXT_MAX_CHARS) return null;
  return text;
}

async function mycoPostCompact(
  directory: string,
  sessionId: string,
): Promise<void> {
  await postEventWithBuffer(directory, sessionId, {
    type: "pre_compact",
    session_id: sessionId,
    agent: "pi",
  });
}

async function mycoContext(
  directory: string,
  tier?: number,
): Promise<{ content: string; tier: number; fallback: boolean; generated_at?: number }> {
  const requestedTier = tier ?? 5000;
  const result = await getJson(directory, "/api/digest");
  if (!result.ok || !result.data) {
    return {
      content: "Digest context is not yet available. The first digest cycle has not completed.",
      tier: requestedTier,
      fallback: false,
    };
  }

  // Daemon contract: /api/digest responses carry a `tiers` array.
  const tiers = (result.data as {
    tiers: Array<{ tier: number; content: string; generated_at: number }>;
  }).tiers;
  const exact = tiers.find((entry) => entry.tier === requestedTier);
  if (exact) {
    return {
      content: exact.content,
      tier: exact.tier,
      fallback: false,
      generated_at: exact.generated_at,
    };
  }

  if (tiers.length > 0) {
    const nearest = [...tiers].sort(
      (left, right) => Math.abs(left.tier - requestedTier) - Math.abs(right.tier - requestedTier),
    )[0];
    return {
      content: nearest.content,
      tier: nearest.tier,
      fallback: true,
      generated_at: nearest.generated_at,
    };
  }

  return {
    content: "Digest context is not yet available. The first digest cycle has not completed.",
    tier: requestedTier,
    fallback: false,
  };
}

async function mycoSearch(
  directory: string,
  input: {
    query: string;
    type?: string;
    limit?: number;
    observation_type?: string;
    status?: string;
    since?: number;
    until?: number;
    language?: string;
  },
): Promise<{ ok: boolean; data?: unknown }> {
  const query = new URLSearchParams({ q: input.query });
  if (input.type) query.set("type", input.type);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.observation_type) query.set("observation_type", input.observation_type);
  if (input.status) query.set("status", input.status);
  if (input.since !== undefined) query.set("since", String(input.since));
  if (input.until !== undefined) query.set("until", String(input.until));
  if (input.language) query.set("language", input.language);
  return getJson(directory, `/api/search?${query.toString()}`);
}

async function mycoRecall(
  directory: string,
  noteId: string,
): Promise<Record<string, unknown> | null> {
  const encodedId = encodeURIComponent(noteId);
  const [sessionResult, sporeResult, plansResult] = await Promise.all([
    getJson(directory, `/api/sessions/${encodedId}`),
    getJson(directory, `/api/spores/${encodedId}`),
    getJson(directory, `/api/mcp/plans?id=${encodedId}`),
  ]);

  if (sessionResult.ok && sessionResult.data && typeof sessionResult.data === "object") {
    return { type: "session", ...(sessionResult.data as Record<string, unknown>) };
  }
  if (sporeResult.ok && sporeResult.data && typeof sporeResult.data === "object") {
    return { type: "spore", ...(sporeResult.data as Record<string, unknown>) };
  }

  const plans = (plansResult.data as { plans?: unknown } | undefined)?.plans;
  if (plansResult.ok && Array.isArray(plans) && plans[0] && typeof plans[0] === "object") {
    return { type: "plan", ...(plans[0] as Record<string, unknown>) };
  }

  return null;
}

async function mycoRemember(
  directory: string,
  input: { content: string; type?: string; tags?: string[] },
): Promise<{ ok: boolean; data?: unknown }> {
  return postJson(directory, "/api/mcp/remember", {
    content: input.content,
    type: input.type,
    tags: input.tags,
  });
}

async function mycoPlans(
  directory: string,
  input: {
    op?: string;
    id?: string;
    session?: string;
    status?: string;
    limit?: number;
    force_remote?: boolean;
  },
): Promise<{ ok: boolean; data?: unknown }> {
  const op = input.op ?? "list";
  if (op === "delete") {
    return deleteJson(
      directory,
      `/api/plans/${encodeURIComponent(input.id ?? "")}`,
      input.force_remote ? { force_remote: true } : undefined,
    );
  }

  const query = new URLSearchParams();
  if (input.id) query.set("id", input.id);
  if (input.session) query.set("session", input.session);
  if (input.status) query.set("status", input.status);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  return getJson(directory, `/api/mcp/plans?${query.toString()}`);
}

async function mycoSavePlan(
  directory: string,
  input: {
    session_id: string;
    content: string;
    source_path?: string;
    plan_key?: string;
    title?: string;
    status?: string;
    tags?: string[];
  },
): Promise<{ ok: boolean; data?: unknown }> {
  return postJson(directory, "/api/mcp/plans", input);
}

async function mycoSessions(
  directory: string,
  input: {
    plan?: string;
    branch?: string;
    user?: string;
    since?: string;
    status?: string;
    limit?: number;
  },
): Promise<{ ok: boolean; data?: unknown }> {
  const query = new URLSearchParams();
  if (input.plan) query.set("plan", input.plan);
  if (input.branch) query.set("branch", input.branch);
  if (input.user) query.set("user", input.user);
  if (input.since) query.set("since", input.since);
  if (input.status) query.set("status", input.status);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  return getJson(directory, `/api/mcp/sessions?${query.toString()}`);
}

async function fetchTeamStatus(directory: string): Promise<{ ok: boolean; data?: unknown }> {
  return getJson(directory, "/api/team/status");
}

async function mycoSupersede(
  directory: string,
  input: { old_spore_id: string; new_spore_id: string; reason?: string },
): Promise<{ ok: boolean; data?: unknown }> {
  return postJson(directory, "/api/mcp/supersede", input);
}

async function mycoConsolidate(
  directory: string,
  input: {
    source_spore_ids: string[];
    consolidated_content: string;
    observation_type: string;
    tags?: string[];
    reason?: string;
  },
): Promise<{ ok: boolean; data?: unknown }> {
  return postJson(directory, "/api/mcp/consolidate", input);
}

async function mycoSkills(
  directory: string,
  input: { id?: string; status?: string; limit?: number },
): Promise<{ ok: boolean; data?: unknown }> {
  if (input.id) return getJson(directory, `/api/skill-records/${encodeURIComponent(input.id)}`);
  const query = new URLSearchParams();
  if (input.status) query.set("status", input.status);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  return getJson(directory, `/api/skill-records?${query.toString()}`);
}

async function mycoRuns(
  directory: string,
  input: { op?: string; id?: string; task?: string; agent_id?: string; limit?: number },
): Promise<{ ok: boolean; data?: unknown }> {
  const op = input.op ?? "list";
  if (op === "get") return getJson(directory, `/api/agent/runs/${encodeURIComponent(input.id ?? "")}`);
  const query = new URLSearchParams();
  if (input.task) query.set("task", input.task);
  if (input.agent_id) query.set("agentId", input.agent_id);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  return getJson(directory, `/api/agent/runs?${query.toString()}`);
}

async function canopyMap(directory: string): Promise<{ ok: boolean; data?: unknown }> {
  return getJson(directory, "/api/canopy/map");
}

async function collectiveProjects(directory: string): Promise<{ ok: boolean; data?: unknown }> {
  return getJson(directory, "/api/collective/projects");
}

async function collectiveSettings(directory: string): Promise<{ ok: boolean; data?: unknown }> {
  return getJson(directory, "/api/collective/settings");
}

async function collectiveProject(
  directory: string,
  input: { project: string; include_digest?: boolean },
): Promise<{ ok: boolean; data?: unknown }> {
  const query = new URLSearchParams({ project: input.project });
  if (input.include_digest) query.set("include_digest", "true");
  return getJson(directory, `/api/collective/project?${query.toString()}`);
}

async function collectiveSearch(
  directory: string,
  input: {
    query: string;
    project?: string;
    limit?: number;
    types?: string[];
    status?: string;
    observation_type?: string;
    since?: number;
    until?: number;
    session_id?: string;
    source_path?: string;
    name?: string;
  },
): Promise<{ ok: boolean; data?: unknown }> {
  const query = new URLSearchParams({ q: input.query });
  if (input.project) query.set("project", input.project);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.types && input.types.length > 0) query.set("types", input.types.join(","));
  if (input.status) query.set("status", input.status);
  if (input.observation_type) query.set("observation_type", input.observation_type);
  if (input.since !== undefined) query.set("since", String(input.since));
  if (input.until !== undefined) query.set("until", String(input.until));
  if (input.session_id) query.set("session_id", input.session_id);
  if (input.source_path) query.set("source_path", input.source_path);
  if (input.name) query.set("name", input.name);
  return getJson(directory, `/api/collective/search?${query.toString()}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeToolOutput(output: unknown): string {
  if (typeof output !== "string") return "";
  return output.length > TOOL_OUTPUT_PREVIEW_CHARS
    ? output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) + "..."
    : output;
}

/**
 * Derive a stable session ID from pi's session file path.
 * Pi sessions are stored as JSONL files with UUID-based names
 * at ~/.pi/agent/sessions/<path-hash>/<timestamp>_<uuid>.jsonl.
 * We extract the filename (without extension) as the session ID.
 */
function deriveSessionId(sessionFile: string | null): string | null {
  if (!sessionFile) return null;
  const base = sessionFile.split("/").pop() ?? sessionFile;
  return base.replace(/\.jsonl$/, "");
}

/**
 * Extract text content from pi message content (string or content block array).
 */
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: { type?: string; text?: string }) => c.type === "text" && c.text)
    .map((c: { text: string }) => c.text)
    .join("\n");
}

/**
 * Extract images from a pi message content array.
 */
function extractImagesFromContent(content: unknown): Array<{ data: string; mediaType: string }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c: { type?: string; data?: string; mimeType?: string }) =>
      c.type === "image" && c.data && c.mimeType)
    .map((c: { data: string; mimeType: string }) => ({
      data: c.data,
      mediaType: c.mimeType,
    }));
}

function formatToolOutput(data: unknown): string {
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}

function extractErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object") {
    const error = (data as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let currentSessionId: string | null = null;
  let currentCwd: string = process.cwd();
  let lastAssistantMessage: string = "";
  // `currentParentBatchId` doubles as the in-flight signal: a non-null value
  // means the initial prompt of a turn has been captured and subsequent
  // `input` events are steering. `agent_end` resets it to null.
  let currentParentBatchId: number | null = null;

  // ── Session lifecycle ──────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    currentCwd = ctx.cwd;

    // Check if daemon is available — silent no-op if not
    if (!getDaemonPort(currentCwd)) return;

    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionId = deriveSessionId(sessionFile);
    if (!sessionId) return;

    currentSessionId = sessionId;
    lastAssistantMessage = "";

    const isResume = event.reason === "resume";
    const isFork = event.reason === "fork";

    // Register with the daemon
    await mycoRegisterSession(currentCwd, sessionId);

    // Fetch and inject context as a persistent custom message.
    // Pi's before_agent_start hook augments the system prompt each turn,
    // but this initial injection ensures context is visible in the session
    // history and survives compaction.
    let contextText: string | null = null;

    if (isResume && event.previousSessionFile) {
      const previousSessionId = deriveSessionId(event.previousSessionFile);
      if (previousSessionId) {
        contextText = await fetchMycoResumeContext(currentCwd, sessionId, previousSessionId);
      }
    } else if (!isFork) {
      contextText = await fetchMycoSessionContext(currentCwd, sessionId);
    }

    if (contextText) {
      pi.sendMessage({
        customType: "myco-context",
        content: contextText,
        display: false,
      }, {
        deliverAs: "nextTurn",
      });
    }
  });

  pi.on("session_shutdown", async () => {
    if (!currentSessionId) return;

    await mycoPostStop(currentCwd, currentSessionId, lastAssistantMessage || undefined);
    await mycoUnregisterSession(currentCwd, currentSessionId);
    currentSessionId = null;
    lastAssistantMessage = "";
  });

  // ── User prompt capture + context injection ───────────────────────────
  //
  // Pi's extension event vocabulary (verified against @mariozechner/pi-coding-agent
  // types.d.ts):
  //   - `before_agent_start` fires once per turn after the user submits their
  //     prompt, carries the resolved `prompt` + `images` and the assembled
  //     `systemPrompt`. This is the canonical initial-prompt hook.
  //   - `input` fires for EVERY user submission — initial and mid-turn
  //     steering alike — carrying `text` + `images` + `source`. We subscribe
  //     to it only for steering (source: "interactive"/"rpc") while a turn is
  //     already in flight; the initial prompt is already captured via
  //     before_agent_start with its expanded form.
  //   - `queue_update` is session-internal and NOT exposed to extensions; the
  //     internal-only `queue_update` must not be subscribed to here.

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!currentSessionId) return;

    const prompt = event.prompt ?? "";
    const images = extractImagesFromContent(event.images);
    if (prompt) {
      const result = await mycoPostUserPrompt(
        currentCwd,
        currentSessionId,
        prompt,
        images,
        { kind: BATCH_KIND.INITIAL },
      );
      if (result?.batchId != null) {
        currentParentBatchId = result.batchId;
      }
    }

    const contextText = await fetchMycoSessionContext(currentCwd, currentSessionId);
    if (contextText) {
      return { systemPrompt: event.systemPrompt + "\n\n" + contextText };
    }
    return undefined;
  });

  pi.on("input", async (event) => {
    if (!currentSessionId) return;
    // Skip when no turn is running — the initial prompt will be captured
    // via before_agent_start, which also carries the post-expansion text.
    // `currentParentBatchId !== null` means before_agent_start already ran
    // and the initial prompt is captured; any further `input` event during
    // this window is mid-turn steering.
    if (currentParentBatchId === null) return;
    // Ignore extension-synthesized inputs (ours or other extensions'). Only
    // capture user-originated steering coming from the interactive TUI or
    // the RPC surface.
    if (event.source === "extension") return;
    const text = event.text ?? "";
    if (!text) return;
    const images = extractImagesFromContent(event.images);
    await mycoPostUserPrompt(
      currentCwd,
      currentSessionId,
      text,
      images,
      { kind: BATCH_KIND.STEERING, parentPromptBatchId: currentParentBatchId },
    );
  });

  // ── Tool use capture ───────────────────────────────────────────────────

  pi.on("tool_result", async (event) => {
    if (!currentSessionId) return;

    const toolName = event.toolName ?? "unknown";
    const toolInput = event.input ?? {};
    const rawOutput = Array.isArray(event.content)
      ? event.content
          .filter((c: { type?: string; text?: string }) => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n")
      : "";
    const toolOutput = summarizeToolOutput(rawOutput);

    // Fire-and-forget — don't block tool result processing
    mycoPostToolUse(currentCwd, currentSessionId, toolName, toolInput, toolOutput);
    return undefined;
  });

  // ── Track last assistant message ───────────────────────────────────────

  pi.on("message_end", async (event) => {
    if (!currentSessionId) return;
    if (event.message?.role === "assistant") {
      const text = extractTextFromContent(event.message.content);
      if (text) {
        lastAssistantMessage = text;
      }
    }
  });

  // ── Agent end → post stop for agentic loop completion ──────────────────
  //
  // Pi fires agent_end after each user prompt's agentic loop completes.
  // We post a stop event so the daemon can process the turn. session_shutdown
  // handles the final cleanup on exit.

  pi.on("agent_end", async () => {
    if (!currentSessionId) return;
    // Clear the in-flight marker so subsequent `input` events are treated
    // as a fresh initial prompt, not continued steering. This replaces the
    // earlier `turnInFlight = false` toggle — the batch id already encodes
    // the turn state.
    currentParentBatchId = null;
    await mycoPostStop(currentCwd, currentSessionId, lastAssistantMessage || undefined);
  });

  // ── Compaction hook — notify daemon of context compaction ──────────────

  pi.on("session_before_compact", async () => {
    if (!currentSessionId) return;
    await mycoPostCompact(currentCwd, currentSessionId);
    return undefined;
  });

  // ── /exit command — parity with other symbionts ───────────────────────
  //
  // Pi has no built-in `/exit`; users have to press Ctrl+D to trigger the
  // shutdown flow. Most other CLI agents accept `/exit` directly, and a
  // typed `/exit` otherwise falls through to before_agent_start as a
  // literal prompt (polluting the session). Registering it as an extension
  // command intercepts before the input pipeline reaches the agent and
  // drives Pi's own graceful shutdown.
  pi.registerCommand("exit", {
    description: "Exit Pi (parity with other agents; equivalent to Ctrl+D).",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  // ── MCP tool proxies — expose the MCP-equivalent Myco surface in Pi ───
  //
  // Pi has no native MCP transport, so we mirror Myco's MCP tool names via
  // pi.registerTool() and proxy to the same daemon HTTP routes. This keeps
  // the injected Cortex guidance aligned with the tool names other symbionts
  // receive through the MCP server.

  let collectiveToolsRegistered = false;

  function registerCollectiveTools(): void {
    if (collectiveToolsRegistered) return;
    collectiveToolsRegistered = true;

    pi.registerTool({
      name: "collective_search",
      label: "Collective Search",
      description: "Search across collective-connected projects when Collective is available.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        project: Type.Optional(Type.String({ description: "Optional project filter" })),
        limit: Type.Optional(Type.Number({ description: "Optional max results" })),
        types: Type.Optional(Type.Array(Type.String(), { description: "Optional type filters" })),
        status: Type.Optional(Type.String({ description: "Optional status filter" })),
        observation_type: Type.Optional(Type.String({ description: "Optional observation type filter" })),
        since: Type.Optional(Type.Number({ description: "Optional created_at lower bound in epoch seconds" })),
        until: Type.Optional(Type.Number({ description: "Optional created_at upper bound in epoch seconds" })),
        session_id: Type.Optional(Type.String({ description: "Optional session filter" })),
        source_path: Type.Optional(Type.String({ description: "Optional source path filter" })),
        name: Type.Optional(Type.String({ description: "Optional record name filter" })),
      }),
      async execute(_toolCallId, params) {
        const result = await collectiveSearch(currentCwd, params);
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: "Collective search unavailable." }], details: {} };
        }
        return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? []) }], details: result.data ?? {} };
      },
    });

    pi.registerTool({
      name: "collective_projects",
      label: "Collective Projects",
      description: "List projects available through the connected Collective.",
      parameters: Type.Object({}),
      async execute() {
        const result = await collectiveProjects(currentCwd);
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: "Collective projects unavailable." }], details: {} };
        }
        return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? []) }], details: result.data ?? {} };
      },
    });

    pi.registerTool({
      name: "collective_project",
      label: "Collective Project",
      description: "Get metadata for one collective project.",
      parameters: Type.Object({
        project: Type.String({ description: "Project identifier" }),
        include_digest: Type.Optional(Type.Boolean({ description: "Include digest in the response" })),
      }),
      async execute(_toolCallId, params) {
        const result = await collectiveProject(currentCwd, params);
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: "Collective project lookup unavailable." }], details: {} };
        }
        return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? null) }], details: result.data ?? {} };
      },
    });

    pi.registerTool({
      name: "collective_settings",
      label: "Collective Settings",
      description: "Inspect active Collective setting overrides for this project.",
      parameters: Type.Object({}),
      async execute() {
        const result = await collectiveSettings(currentCwd);
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: "Collective settings unavailable." }], details: {} };
        }
        return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? {}) }], details: result.data ?? {} };
      },
    });
  }

  pi.registerTool({
    name: "myco_context",
    label: "Myco Context",
    description:
      "Retrieve Myco's pre-computed project digest. Prefer this for broad project orientation.",
    promptSnippet: "Retrieve the project digest for broad orientation before taking action",
    promptGuidelines: [
      "Use myco_context for broad project orientation or when you want the current digest before planning changes.",
    ],
    parameters: Type.Object({
      tier: Type.Optional(Type.Number({ description: "Optional digest tier: 1500, 5000, or 10000" })),
    }),
    async execute(_toolCallId, params) {
      const result = await mycoContext(currentCwd, params.tier);
      return {
        content: [{ type: "text" as const, text: result.content }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "myco_search",
    label: "Myco Search",
    description:
      "Search the vault for prior sessions, spores, plans, and related artifacts.",
    promptSnippet: "Search Myco for prior decisions, bugs, rationale, sessions, or plans on a topic",
    promptGuidelines: [
      "Use myco_search when you need specific information about a topic, pattern, or past decision.",
      "Prefer myco_search over myco_context when you have a focused query.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query — topic, pattern, or question" }),
      type: Type.Optional(Type.String({ description: "Optional note type filter: session, plan, spore, or all" })),
      limit: Type.Optional(Type.Number({ description: "Optional max results" })),
      observation_type: Type.Optional(Type.String({ description: "Optional spore observation type filter" })),
      status: Type.Optional(Type.String({ description: "Optional semantic status filter" })),
      since: Type.Optional(Type.Number({ description: "Optional created_at lower bound in epoch seconds" })),
      until: Type.Optional(Type.Number({ description: "Optional created_at upper bound in epoch seconds" })),
      language: Type.Optional(Type.String({ description: "Canopy-only optional language filter, e.g. typescript" })),
    }),
    async execute(_toolCallId, params) {
      const result = await mycoSearch(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: "Search unavailable — Myco daemon may not be running." }], details: {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? []) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_recall",
    label: "Myco Recall",
    description: "Look up a specific vault note by ID and return the full record.",
    promptSnippet: "Fetch a full vault note by ID after myco_search finds a promising result",
    promptGuidelines: [
      "Use myco_recall after myco_search identifies a promising result and you need the full note.",
    ],
    parameters: Type.Object({ note_id: Type.String({ description: "Note ID to look up" }) }),
    async execute(_toolCallId, params) {
      const result = await mycoRecall(currentCwd, params.note_id);
      if (!result) {
        return { content: [{ type: "text" as const, text: `Note not found: ${params.note_id}` }], details: {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "myco_remember",
    label: "Myco Remember",
    description: "Save a durable observation as a spore.",
    promptSnippet: "Save a durable decision, gotcha, discovery, or bug fix into the vault",
    promptGuidelines: [
      "Use myco_remember to save durable decisions, gotchas, discoveries, or bug fixes from this work.",
    ],
    parameters: Type.Object({
      content: Type.String({ description: "Observation content with enough future-facing context" }),
      type: Type.Optional(Type.String({ description: "Observation type" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
    }),
    async execute(_toolCallId, params) {
      const result = await mycoRemember(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: "Failed to save observation — Myco daemon may not be running." }], details: {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? { ok: true }) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_plans",
    label: "Myco Plans",
    description: "List plans, fetch one plan, or delete an obsolete plan.",
    promptSnippet: "List active plans, fetch a specific plan, or delete an obsolete one",
    promptGuidelines: [
      "Use myco_plans before implementation when approved plans or specs may already exist.",
      "Use id to fetch one plan with content, or session to scope the list to current work.",
    ],
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: 'Operation: "list" (default) or "delete"' })),
      status: Type.Optional(Type.String({ description: "Optional list filter" })),
      id: Type.Optional(Type.String({ description: "Plan id" })),
      session: Type.Optional(Type.String({ description: "Optional session id filter" })),
      limit: Type.Optional(Type.Number({ description: "Optional max results" })),
      force_remote: Type.Optional(Type.Boolean({ description: "Allow delete to remove a plan owned by another machine" })),
    }),
    async execute(_toolCallId, params) {
      const op = params.op ?? "list";
      if (op === "delete" && !params.id) {
        return { content: [{ type: "text" as const, text: "id is required for op: delete" }], details: {} };
      }
      if (op !== "delete" && params.id && params.session) {
        return { content: [{ type: "text" as const, text: "Pass either id or session, not both" }], details: {} };
      }
      const result = await mycoPlans(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: extractErrorMessage(result.data, "Plan operation failed") }], details: result.data ?? {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? (op === "delete" ? { ok: true } : [])) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_save_plan",
    label: "Myco Save Plan",
    description: "Persist a plan directly into Myco.",
    promptSnippet: "Persist a plan directly into Myco when you create or materially revise one",
    promptGuidelines: [
      "Use myco_save_plan when you create or materially revise a plan and want it persisted to Myco.",
      "Pass source_path when the plan is also written to disk; otherwise use a stable plan_key.",
    ],
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Session id; defaults to the active Pi session" })),
      content: Type.String({ description: "Markdown plan content" }),
      source_path: Type.Optional(Type.String({ description: "Plan file path when also written to disk" })),
      plan_key: Type.Optional(Type.String({ description: "Stable key for non-file-backed plans" })),
      title: Type.Optional(Type.String({ description: "Optional explicit title" })),
      status: Type.Optional(Type.String({ description: "Optional status" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
    }),
    async execute(_toolCallId, params) {
      const sessionId = params.session_id ?? currentSessionId;
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "No active session" }], details: {} };
      }
      const result = await mycoSavePlan(currentCwd, { ...params, session_id: sessionId });
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: extractErrorMessage(result.data, "Failed to save plan") }], details: result.data ?? {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? { ok: true }) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_sessions",
    label: "Myco Sessions",
    description: "Browse past coding sessions with summaries and metadata.",
    parameters: Type.Object({
      plan: Type.Optional(Type.String({ description: "Optional plan filter" })),
      branch: Type.Optional(Type.String({ description: "Optional branch filter" })),
      user: Type.Optional(Type.String({ description: "Optional user filter" })),
      since: Type.Optional(Type.String({ description: "Optional ISO timestamp lower bound" })),
      status: Type.Optional(Type.String({ description: "Optional status filter" })),
      limit: Type.Optional(Type.Number({ description: "Optional max results" })),
    }),
    async execute(_toolCallId, params) {
      const result = await mycoSessions(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: "Session query unavailable." }], details: {} };
      }
      const sessions = (result.data as { sessions?: unknown } | undefined)?.sessions ?? [];
      return { content: [{ type: "text" as const, text: formatToolOutput(sessions) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_supersede",
    label: "Myco Supersede",
    description: "Mark an outdated spore as superseded by a newer one.",
    promptSnippet: "Mark outdated vault knowledge as superseded by a newer spore",
    promptGuidelines: [
      "Use myco_supersede when existing knowledge is outdated and should stop guiding future runs.",
    ],
    parameters: Type.Object({
      old_spore_id: Type.String({ description: "ID of the outdated spore" }),
      new_spore_id: Type.String({ description: "ID of the replacement spore" }),
      reason: Type.Optional(Type.String({ description: "Optional reason" })),
    }),
    async execute(_toolCallId, params) {
      const result = await mycoSupersede(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: extractErrorMessage(result.data, "Failed to supersede spore") }], details: result.data ?? {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? { ok: true }) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_consolidate",
    label: "Myco Consolidate",
    description: "Merge related spores into a single durable wisdom note.",
    promptSnippet: "Merge several related Myco spores into one consolidated wisdom note",
    promptGuidelines: [
      "Use myco_consolidate when several related learnings should become one durable wisdom artifact.",
    ],
    parameters: Type.Object({
      source_spore_ids: Type.Array(Type.String(), { description: "IDs of the spores to merge" }),
      consolidated_content: Type.String({ description: "Merged comprehensive content" }),
      observation_type: Type.String({ description: "Observation type for the consolidated note" }),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
      reason: Type.Optional(Type.String({ description: "Optional reason" })),
    }),
    async execute(_toolCallId, params) {
      const result = await mycoConsolidate(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: extractErrorMessage(result.data, "Failed to consolidate spores") }], details: result.data ?? {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? { ok: true }) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_skills",
    label: "Myco Skills",
    description: "List or inspect skills generated by Myco.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Optional skill id or name" })),
      status: Type.Optional(Type.String({ description: "Optional status filter" })),
      limit: Type.Optional(Type.Number({ description: "Optional max results" })),
    }),
    async execute(_toolCallId, params) {
      const result = await mycoSkills(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: "Skill lookup unavailable." }], details: {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? []) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_runs",
    label: "Myco Runs",
    description: "List agent runs or fetch a single run.",
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "list (default) or get" })),
      id: Type.Optional(Type.String({ description: "Run id for op=get" })),
      task: Type.Optional(Type.String({ description: "Optional task filter" })),
      agent_id: Type.Optional(Type.String({ description: "Optional agent id filter" })),
      limit: Type.Optional(Type.Number({ description: "Optional max results" })),
    }),
    async execute(_toolCallId, params) {
      if ((params.op ?? "list") === "get" && !params.id) {
        return { content: [{ type: "text" as const, text: "id is required for op: get" }], details: {} };
      }
      const result = await mycoRuns(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: extractErrorMessage(result.data, "Run query failed") }], details: result.data ?? {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? {}) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "canopy_map",
    label: "Canopy Map",
    description: "Returns the project's architectural overview (directory skeleton + key files + golden paths) maintained by the canopy-map background task.",
    parameters: Type.Object({}),
    async execute() {
      const result = await canopyMap(currentCwd);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: "Canopy map unavailable." }], details: result.data ?? {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? {}) }], details: result.data ?? {} };
    },
  });

  void fetchTeamStatus(currentCwd).then((status) => {
    if ((status.data as { collective_connected?: boolean } | undefined)?.collective_connected) {
      registerCollectiveTools();
    }
  }).catch(() => undefined);
}
