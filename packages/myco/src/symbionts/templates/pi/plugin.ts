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

// ---------------------------------------------------------------------------
// Buffer fallback — identical pattern to opencode plugin
// ---------------------------------------------------------------------------

function bufferEvent(
  directory: string,
  sessionId: string,
  event: Record<string, unknown>,
): void {
  try {
    const bufferDir = join(directory, ".myco", "buffer");
    mkdirSync(bufferDir, { recursive: true });
    const filePath = join(bufferDir, `${sessionId}.jsonl`);
    const { session_id: _sid, ...payload } = event;
    const line = JSON.stringify({
      ...payload,
      timestamp: payload.timestamp ?? new Date().toISOString(),
    });
    appendFileSync(filePath, line + "\n");
  } catch {
    // Best-effort — swallow to never crash pi
  }
}

async function postEventWithBuffer(
  directory: string,
  sessionId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const result = await postJson(directory, "/events", event);
  if (!result.ok) {
    bufferEvent(directory, sessionId, event);
  }
}

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
): Promise<void> {
  await postEventWithBuffer(directory, sessionId, {
    type: "user_prompt",
    session_id: sessionId,
    agent: "pi",
    prompt,
    ...(images.length > 0 ? { images } : {}),
  });
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

async function mycoPostStop(
  directory: string,
  sessionId: string,
  lastAssistantMessage: string | undefined,
): Promise<void> {
  await postJson(directory, "/events/stop", {
    session_id: sessionId,
    agent: "pi",
    last_assistant_message: lastAssistantMessage,
  });
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

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let currentSessionId: string | null = null;
  let currentCwd: string = process.cwd();
  let lastAssistantMessage: string = "";

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

  // ── User prompt capture + context injection ────────────────────────────
  //
  // Single before_agent_start handler: captures the user prompt AND
  // augments the system prompt with Myco context. This avoids registering
  // two handlers for the same event (pi chains them, but the second
  // handler's return value would overwrite the first).

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!currentSessionId) return;

    // 1. Capture the user prompt
    const prompt = event.prompt ?? "";
    const images = extractImagesFromContent(event.images);
    if (prompt) {
      // Fire-and-forget capture — don't block the agent start
      mycoPostUserPrompt(currentCwd, currentSessionId, prompt, images);
    }

    // 2. Augment system prompt with Myco context
    const contextText = await fetchMycoSessionContext(currentCwd, currentSessionId);
    if (contextText) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + contextText,
      };
    }
    return undefined;
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
    await mycoPostStop(currentCwd, currentSessionId, lastAssistantMessage || undefined);
  });

  // ── Compaction hook — notify daemon of context compaction ──────────────

  pi.on("session_before_compact", async () => {
    if (!currentSessionId) return;
    await mycoPostCompact(currentCwd, currentSessionId);
    return undefined;
  });

  // ── MCP tool proxies — expose Myco's intelligence to the LLM ──────────
  //
  // Pi has no native MCP support. Instead, we register Myco's core tools
  // directly via pi.registerTool() so the LLM can query the knowledge vault.

  pi.registerTool({
    name: "myco_context",
    label: "Myco Context",
    description:
      "Get project context, observations, and intelligence from Myco's knowledge vault. " +
      "Use this to understand the project's history, prior decisions, gotchas, and patterns.",
    promptSnippet: "Query Myco vault for project intelligence, prior decisions, and observations",
    promptGuidelines: [
      "Use myco_context at the start of complex tasks to understand project history and prior decisions.",
      "Use myco_context when you encounter unfamiliar code patterns or architecture choices.",
    ],
    parameters: Type.Object({}),
    async execute() {
      if (!currentSessionId) {
        return { content: [{ type: "text" as const, text: "No active session" }], details: {} };
      }
      const result = await fetchMycoSessionContext(currentCwd, currentSessionId);
      return {
        content: [{ type: "text" as const, text: result ?? "No context available from Myco vault." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "myco_search",
    label: "Myco Search",
    description:
      "Search Myco's knowledge vault for specific topics, patterns, or prior observations. " +
      "Returns relevant spores (observations), session summaries, and related intelligence.",
    promptSnippet: "Search Myco vault for specific topics, patterns, or observations",
    promptGuidelines: [
      "Use myco_search when you need specific information about a topic, pattern, or past decision.",
      "Prefer myco_search over myco_context when you have a focused query.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query — topic, pattern, or question" }),
      type: Type.Optional(Type.String({ description: "Optional note type filter: session, plan, spore, or all" })),
      observation_type: Type.Optional(Type.String({ description: "Optional spore observation type filter" })),
      status: Type.Optional(Type.String({ description: "Optional semantic status filter" })),
      since: Type.Optional(Type.Number({ description: "Optional created_at lower bound in epoch seconds" })),
      until: Type.Optional(Type.Number({ description: "Optional created_at upper bound in epoch seconds" })),
    }),
    async execute(_toolCallId, params) {
      if (!currentSessionId) {
        return { content: [{ type: "text" as const, text: "No active session" }], details: {} };
      }
      const query = new URLSearchParams({ q: params.query });
      if (params.type) query.set("type", params.type);
      if (params.observation_type) query.set("observation_type", params.observation_type);
      if (params.status) query.set("status", params.status);
      if (params.since !== undefined) query.set("since", String(params.since));
      if (params.until !== undefined) query.set("until", String(params.until));
      const result = await getJson(currentCwd, `/api/search?${query.toString()}`);
      if (!result.ok || !result.data) {
        return { content: [{ type: "text" as const, text: "Search unavailable — Myco daemon may not be running." }], details: {} };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "myco_observe",
    label: "Myco Observe",
    description:
      "Record an observation (gotcha, decision, discovery, trade-off, bug fix) in Myco's knowledge vault. " +
      "Use this when you discover something important about the codebase that future sessions should know.",
    promptSnippet: "Record an observation in Myco vault for future sessions",
    promptGuidelines: [
      "Use myco_observe to record important discoveries, gotchas, decisions, and trade-offs.",
      "Include enough context that a future session can understand the observation without seeing this conversation.",
    ],
    parameters: Type.Object({
      observation_type: Type.String({
        description: "Type: gotcha, decision, discovery, trade-off, bug_fix, pattern, or any descriptive string",
      }),
      title: Type.String({ description: "Short title for the observation" }),
      content: Type.String({ description: "Detailed observation with context" }),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags for categorization" })),
    }),
    async execute(_toolCallId, params) {
      if (!currentSessionId) {
        return { content: [{ type: "text" as const, text: "No active session" }], details: {} };
      }
      const result = await postJson(currentCwd, "/api/spores", {
        session_id: currentSessionId,
        observation_type: params.observation_type,
        title: params.title,
        content: params.content,
        tags: params.tags ?? [],
      });
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: "Failed to record observation — Myco daemon may not be running." }], details: {} };
      }
      return {
        content: [{ type: "text" as const, text: `Observation recorded: ${params.title}` }],
        details: {},
      };
    },
  });
}
