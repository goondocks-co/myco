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

const TOOL_OUTPUT_PREVIEW_CHARS = 500;

/** Preferred context tier (matches Myco's default in src/mcp/tools/context.ts). */
const MYCO_CONTEXT_TIER = 5000;

/** Timeout for daemon HTTP calls — must be short so we never block opencode. */
const MYCO_FETCH_TIMEOUT_MS = 3000;

/** Heading prefixes for injected context so the model can recognize the source. */
const DIGEST_HEADING = "## Myco — Project Context\n\n";
const COMPACTION_HEADING = "## Myco — Project Context (preserved across compaction)\n\n";

// ---------------------------------------------------------------------------
// Daemon HTTP transport — all communication with the local Myco daemon.
// Every function is best-effort: failures are logged to stderr and swallowed.
// ---------------------------------------------------------------------------

/** Read the Myco daemon port from .myco/daemon.json in the project directory. */
function readDaemonPort(directory: string): number | null {
  try {
    const raw = readFileSync(join(directory, ".myco", "daemon.json"), "utf-8");
    const info = JSON.parse(raw) as { port?: number };
    return typeof info.port === "number" ? info.port : null;
  } catch {
    return null;
  }
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

/** Build a daemon URL using the port read from .myco/daemon.json. Returns null if unreachable. */
function daemonUrl(directory: string, path: string): string | null {
  const port = readDaemonPort(directory);
  return port ? `http://localhost:${port}${path}` : null;
}

/** POST JSON to a daemon endpoint. Returns the parsed response body or null. */
async function postJson(
  directory: string,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = daemonUrl(directory, path);
  if (!url) return null;
  const res = await fetchWithTimeout(url, {
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

/** Fetch the project digest at the preferred tier. Returns the text or null. */
async function fetchMycoDigest(directory: string): Promise<string | null> {
  const url = daemonUrl(directory, "/api/digest");
  if (!url) return null;
  const res = await fetchWithTimeout(url);
  if (!res) return null;

  try {
    const data = (await res.json()) as { tiers?: Array<{ tier: number; content: string }> };
    if (!data.tiers?.length) return null;

    const exact = data.tiers.find((t) => t.tier === MYCO_CONTEXT_TIER);
    if (exact?.content) return exact.content;

    // Fall back to nearest available tier
    const sorted = [...data.tiers].sort(
      (a, b) => Math.abs(a.tier - MYCO_CONTEXT_TIER) - Math.abs(b.tier - MYCO_CONTEXT_TIER),
    );
    return sorted[0]?.content ?? null;
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

        // 1) Capture: register the session with the Myco daemon.
        await mycoRegisterSession(directory, sessionId, info.parentID || undefined);

        // 2) Inject: push the project digest into the new session as a synthetic turn
        //    before the user types anything. Skip on resume — the parent session
        //    already has whatever context was relevant.
        //
        // Re-entrancy: the synthetic text part carries `synthetic: true`; if opencode
        // fires chat.message for it, our handler's synthetic-flag check skips it.
        if (!info.parentID) {
          const digest = await fetchMycoDigest(directory);
          if (digest) {
            await injectSyntheticContext(client, sessionId, DIGEST_HEADING + digest);
          }
        }
        return;
      }

      if (event.type === "session.deleted") {
        const info = event.properties?.info ?? {};
        if (info.id) await mycoUnregisterSession(directory, info.id);
        return;
      }

      if (event.type === "session.idle") {
        const sessionId = event.properties?.sessionID;
        if (!sessionId) return;

        // Fetch the last assistant message for a response summary.
        let responseSummary = "";
        try {
          const result = await client.session.messages({
            path: { id: sessionId },
            query: { directory },
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const messages = ((result as any)?.data ?? []) as any[];
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg?.info?.role === "assistant") {
              const textParts = (msg.parts ?? [])
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .filter((p: any) => p.type === "text" && p.text)
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .map((p: any) => p.text);
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
     * during session compaction. Pushing the digest into output.context ensures
     * Myco's project knowledge survives compaction rather than being dropped.
     *
     * See https://opencode.ai/docs/plugins/#compaction-hooks
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "experimental.session.compacting": async (_input: any, output: any) => {
      const digest = await fetchMycoDigest(directory);
      if (!digest) return;

      if (Array.isArray(output?.context)) {
        output.context.push(COMPACTION_HEADING + digest);
      }
    },
  };
};

export default MycoPlugin;
