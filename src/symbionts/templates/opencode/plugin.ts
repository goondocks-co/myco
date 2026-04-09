// Managed by Myco. Regenerated on `myco update`. Edit src/symbionts/templates/opencode/plugin.ts in the Myco repo instead.
// myco:plugin-marker:opencode
//
// Myco Codebase Intelligence Plugin for OpenCode.
//
// This plugin runs inside opencode's Bun runtime and communicates with the local
// Myco daemon over HTTP — no subprocess spawns, no hook CLI, no stdin piping.
//
//   Capture: POST /sessions/register, /sessions/unregister, /events, /events/stop
//   Context: GET  /api/digest
//   Inject:  client.session.prompt({ noReply: true, parts: [{ synthetic: true }] })
//
// See https://opencode.ai/docs/plugins/
//
// Degraded-mode safety: this plugin ships committed inside any project that has
// run `myco init` — the file lives at .opencode/plugins/myco.ts in that project's
// repo. When a teammate clones such a project WITHOUT having Myco installed
// locally, opencode will still load this plugin (the file is right there in the
// cloned repo). To stay invisible in that case, the plugin has NO external
// runtime imports — only node:fs and node:path, which are always available in
// Bun's runtime. Every path that would contact the Myco daemon gracefully no-ops
// when `.myco/daemon.json` is absent or the daemon is unreachable, so the plugin
// becomes invisible rather than throwing. Do NOT add runtime imports from
// @opencode-ai/plugin or any other package — that would break this guarantee.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Keep in sync with `TOOL_OUTPUT_PREVIEW_CHARS` in src/constants.ts (currently 200).
 * The plugin file is standalone and cannot import from Myco — this value is copied
 * so every symbiont records tool_output previews at the same length.
 */
const TOOL_OUTPUT_PREVIEW_CHARS = 200;

/** Timeout for daemon HTTP calls — must be short so we never block opencode. */
const MYCO_FETCH_TIMEOUT_MS = 3000;

/** Heading prefix for compaction context — makes Myco's contribution recognizable in the compacted summary. */
const COMPACTION_HEADING = "## Myco — Project Context (preserved across compaction)\n\n";

// ---------------------------------------------------------------------------
// Daemon HTTP transport — all communication with the local Myco daemon.
// Every function is best-effort: failures are swallowed so the plugin cannot
// interfere with opencode when Myco is absent or the daemon is unreachable.
// ---------------------------------------------------------------------------

/**
 * Port cache for `.myco/daemon.json`. Read once on first access; refreshed on
 * the next call that follows a failed HTTP request (handles daemon restarts
 * mid-session). `undefined` = never loaded, `null` = loaded but absent.
 */
let cachedDaemonPort: number | null | undefined = undefined;

/**
 * Active opencode sessions tracked by this plugin instance. Populated on
 * `session.created` and drained on `session.deleted` / `server.instance.disposed`.
 *
 * Opencode has no `session.end` event — when the TUI exits normally (Ctrl+C,
 * close terminal), the session stays "active" from the daemon's perspective
 * until the session-maintenance job sweeps it (1-hour threshold). To close
 * sessions cleanly on TUI exit, we track them locally and call unregister
 * for each one when `server.instance.disposed` fires.
 */
const activeOpencodeSessions = new Set<string>();

/** Read the Myco daemon port from .myco/daemon.json in the project directory. */
function readDaemonPortFromDisk(directory: string): number | null {
  try {
    const raw = readFileSync(join(directory, ".myco", "daemon.json"), "utf-8");
    const info = JSON.parse(raw) as { port?: number };
    return typeof info.port === "number" ? info.port : null;
  } catch {
    return null;
  }
}

/** Get the cached daemon port, loading from disk on first access. */
function getDaemonPort(directory: string): number | null {
  if (cachedDaemonPort === undefined) cachedDaemonPort = readDaemonPortFromDisk(directory);
  return cachedDaemonPort;
}

/** Force-refresh the daemon port from disk — used after a fetch failure in case the daemon restarted. */
function refreshDaemonPort(directory: string): number | null {
  cachedDaemonPort = readDaemonPortFromDisk(directory);
  return cachedDaemonPort;
}

/** Fetch with a short timeout. Returns the Response on success, null on failure. */
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

/**
 * Fetch from a daemon endpoint with a single retry after refreshing the port.
 * The retry handles the case where the daemon restarted on a different port
 * mid-session; the cache hot-path avoids a sync disk read on every HTTP call.
 */
async function fetchFromDaemon(
  directory: string,
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const port = getDaemonPort(directory);
  if (!port) return null;

  const first = await fetchWithTimeout(`http://localhost:${port}${path}`, init);
  if (first) return first;

  // Retry once with a refreshed port — the daemon may have restarted.
  const freshPort = refreshDaemonPort(directory);
  if (!freshPort || freshPort === port) return null;
  return fetchWithTimeout(`http://localhost:${freshPort}${path}`, init);
}

/** POST JSON to a daemon endpoint. Returns the parsed response body or null. */
async function postJson(
  directory: string,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetchFromDaemon(directory, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Register an opencode session with the daemon. */
async function mycoRegisterSession(
  directory: string,
  sessionId: string,
  parentSessionId: string | undefined,
): Promise<void> {
  await postJson(directory, "/sessions/register", {
    session_id: sessionId,
    agent: "opencode",
    parent_session_id: parentSessionId,
    started_at: new Date().toISOString(),
  });
}

/** Unregister an opencode session. */
async function mycoUnregisterSession(directory: string, sessionId: string): Promise<void> {
  await postJson(directory, "/sessions/unregister", { session_id: sessionId });
}

/** Post a user prompt event. */
async function mycoPostUserPrompt(
  directory: string,
  sessionId: string,
  prompt: string,
): Promise<void> {
  await postJson(directory, "/events", {
    type: "user_prompt",
    session_id: sessionId,
    agent: "opencode",
    prompt,
  });
}

/** Post a tool use event. */
async function mycoPostToolUse(
  directory: string,
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  toolOutput: string,
): Promise<void> {
  await postJson(directory, "/events", {
    type: "tool_use",
    session_id: sessionId,
    agent: "opencode",
    tool_name: toolName,
    tool_input: toolInput,
    output_preview: toolOutput,
  });
}

/** Post a stop event with the last assistant message as the response summary. */
async function mycoPostStop(
  directory: string,
  sessionId: string,
  lastAssistantMessage: string | undefined,
): Promise<void> {
  await postJson(directory, "/events/stop", {
    session_id: sessionId,
    agent: "opencode",
    last_assistant_message: lastAssistantMessage,
  });
}

/**
 * Fetch the session-start context for a new opencode session. Hits the daemon's
 * config-aware `POST /context` endpoint, which selects the digest tier the user
 * has configured (`config.context.digest_tier`, default 5000) and returns the
 * full session context (digest + branch + session ID lines).
 *
 * This is the same endpoint Claude Code's session-start hook uses, so opencode
 * sessions receive the same context the user has configured for every other agent.
 */
async function fetchMycoSessionContext(
  directory: string,
  sessionId: string,
): Promise<string | null> {
  const res = await fetchFromDaemon(directory, "/context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  });
  if (!res) return null;
  try {
    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim() ?? "";
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Opencode session injection — push synthetic context into session history.
// ---------------------------------------------------------------------------

/**
 * Inject text into an opencode session as a synthetic (plugin-authored) user turn
 * without triggering an AI response. Used for session-start and per-prompt context
 * injection. Errors are swallowed — injection is best-effort.
 */
async function injectSyntheticContext(
  client: unknown,
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = client as any;
    await c.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text, synthetic: true }],
        noReply: true,
      },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[myco] Failed to inject synthetic context:", error);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Flatten todo items into a newline-separated summary. */
function formatTodos(
  todos: Array<{ id?: string; content?: string; status?: string }>,
): string {
  if (!todos || todos.length === 0) return "";
  return todos
    .map((t) => `[${t.status || "pending"}] ${t.content || ""}`)
    .join("\n");
}

/** Truncate tool output for storage. */
function summarizeToolOutput(output: unknown): string {
  if (typeof output !== "string") return "";
  return output.length > TOOL_OUTPUT_PREVIEW_CHARS
    ? output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) + "..."
    : output;
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Opencode plugin entry. The function signature matches opencode's Plugin type
 * via duck typing — we deliberately do NOT import the Plugin type from
 * @opencode-ai/plugin so this file has zero external runtime dependencies.
 * That guarantee lets teammates who clone a project that uses Myco still run
 * opencode cleanly even when they don't have Myco installed locally.
 *
 * @param {{ client: any, directory: string, worktree: string }} ctx
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const MycoPlugin = async ({ client, directory, worktree }: { client: any; directory: string; worktree: string }) => {
  // Best-effort init log. Wrapped in try-catch so a future SDK shape change in
  // opencode (e.g. client.app.log moving) cannot prevent the plugin from
  // registering its handlers.
  try {
    await client.app.log({
      service: "myco",
      level: "info",
      message: "Myco plugin initialized",
      extra: { directory, worktree },
    });
  } catch {
    // Swallow — init log is diagnostic only.
  }

  return {
    /**
     * Generic event handler: session lifecycle, todos.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: async ({ event }: { event: any }) => {
      if (event.type === "session.created") {
        const info = event.properties?.info ?? {};
        const sessionId: string | undefined = info.id;
        if (!sessionId) return;

        activeOpencodeSessions.add(sessionId);

        // Run the capture (register session with Myco daemon) and context fetch
        // concurrently — they don't depend on each other, and parallelizing saves
        // one round-trip of latency before the user's first turn lands. Context
        // is fetched only for fresh sessions; resume sessions inherit the parent's
        // history and don't need another injection.
        //
        // Re-entrancy: the synthetic text part carries `synthetic: true`; if opencode
        // fires chat.message for it, our handler's synthetic-flag check skips it.
        const [, sessionContext] = await Promise.all([
          mycoRegisterSession(directory, sessionId, info.parentID || undefined),
          info.parentID ? Promise.resolve(null) : fetchMycoSessionContext(directory, sessionId),
        ]);

        if (sessionContext) {
          await injectSyntheticContext(client, sessionId, sessionContext);
        }
        return;
      }

      if (event.type === "session.deleted") {
        const info = event.properties?.info ?? {};
        if (info.id) {
          activeOpencodeSessions.delete(info.id);
          await mycoUnregisterSession(directory, info.id);
        }
        return;
      }

      if (event.type === "server.instance.disposed") {
        // Opencode TUI is shutting down. Flush all tracked sessions so the
        // daemon can mark them completed immediately rather than waiting for
        // the stale-session maintenance sweep (1-hour threshold).
        //
        // Fire-and-forget-parallel: the Bun process is about to exit, so we
        // can't rely on awaited fetches completing. Promise.all gives the
        // unregister calls their best shot at landing before teardown; any
        // that don't make it fall back to the session-maintenance job.
        if (activeOpencodeSessions.size === 0) return;
        const toClose = Array.from(activeOpencodeSessions);
        activeOpencodeSessions.clear();
        await Promise.all(toClose.map((id) => mycoUnregisterSession(directory, id)));
        return;
      }

      if (event.type === "session.idle") {
        const sessionId = event.properties?.sessionID;
        if (!sessionId) return;

        // Fetch the last assistant message for a response summary.
        // Narrow local types for walking the messages response — avoids scattered
        // `any` casts inside the loop while keeping the SDK boundary cast isolated.
        type MessagePart = { type?: string; text?: string };
        type SessionMessage = { info?: { role?: string }; parts?: MessagePart[] };

        let responseSummary = "";
        try {
          const result = await client.session.messages({
            path: { id: sessionId },
            query: { directory },
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const messages = ((result as any)?.data ?? []) as SessionMessage[];
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg?.info?.role === "assistant") {
              const textParts = (msg.parts ?? [])
                .filter((p) => p.type === "text" && p.text)
                .map((p) => p.text as string);
              responseSummary = textParts.join("\n");
              break;
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[myco] Failed to fetch messages for summary:", err);
        }

        await mycoPostStop(directory, sessionId, responseSummary || undefined);
        return;
      }

      if (event.type === "todo.updated") {
        const sessionId = event.properties?.sessionID;
        if (!sessionId) return;
        const todos = event.properties?.todos ?? [];
        await mycoPostToolUse(
          directory,
          sessionId,
          "TodoUpdate",
          { todos, count: todos.length },
          formatTodos(todos),
        );
      }
    },

    /**
     * Chat message: capture the user prompt.
     *
     * Per-turn spore injection is intentionally not done here. A previous iteration
     * injected spores via session.prompt({ noReply: true }) inside this handler, but
     * opencode re-fires chat.message for the synthetic turn and the first real user
     * message landed during the re-entrancy window. Agents can fetch context on
     * demand via the myco_context and myco_search MCP tools.
     *
     * The `synthetic` flag check is kept as a cheap guard against re-entry from
     * the session-start digest injection.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "chat.message": async (input: any, output: any) => {
      const sessionId = input?.sessionID;
      if (!sessionId) return;

      const allParts = (output?.parts ?? []) as Array<{
        type?: string;
        text?: string;
        synthetic?: boolean;
      }>;
      // Skip our own injected synthetic turns — they're not real user prompts.
      if (allParts.some((p) => p.synthetic === true)) return;

      const textParts = allParts
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text as string);
      const prompt = textParts.join("\n");
      if (!prompt) return;

      await mycoPostUserPrompt(directory, sessionId, prompt);
    },

    /**
     * Post-tool execution: ship tool usage to Myco.
     *
     * We forward `input.args` as `tool_input` — NOT `output.metadata` — because
     * `args` carries the tool invocation arguments (including `filePath` for
     * write/edit/patch tools), which Myco's plan-capture matcher needs to detect
     * writes to .opencode/plans/*.md.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "tool.execute.after": async (input: any, output: any) => {
      const sessionId = input?.sessionID;
      if (!sessionId) return;

      const toolName = input?.tool ?? "unknown";
      const toolInput = input?.args ?? output?.metadata ?? {};
      const toolOutput = summarizeToolOutput(output?.output);

      await mycoPostToolUse(directory, sessionId, toolName, toolInput, toolOutput);
    },

    /**
     * Compaction hook: fires BEFORE opencode generates a continuation summary
     * during session compaction. Pushing the session context into output.context
     * ensures Myco's project knowledge survives compaction rather than being
     * dropped. The fetched context respects the user's configured digest tier.
     *
     * See https://opencode.ai/docs/plugins/#compaction-hooks
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "experimental.session.compacting": async (input: any, output: any) => {
      const sessionId = input?.sessionID;
      if (!sessionId) return;

      const sessionContext = await fetchMycoSessionContext(directory, sessionId);
      if (!sessionContext) return;

      if (Array.isArray(output?.context)) {
        output.context.push(COMPACTION_HEADING + sessionContext);
      }
    },
  };
};

export default MycoPlugin;
