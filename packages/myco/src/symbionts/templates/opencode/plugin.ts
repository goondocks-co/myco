/**
 * Myco plugin for opencode.
 *
 * opencode stores a session as one JSON file per message and per part, so
 * there is no append-only byte stream to ship a delta against. This plugin
 * writes one instead: every in-process event becomes a line in
 * `<MYCO_HOME>/member/transcripts/opencode/<sessionId>.jsonl`, and the Myco
 * binary ships that transcript exactly as it ships Claude Code's or Codex's.
 *
 * The plugin makes no network call. It writes lines and it runs `myco hook
 * <verb>`; the binary owns the credential, the write-ahead spool, the
 * server-held offset and every refusal. With no binary installed the plugin is
 * inert and the harness is unaffected.
 *
 * Zero runtime dependencies: the opencode plugin API is duck-typed rather than
 * imported so the file loads in a clone with nothing installed.
 */
// myco:plugin-marker — Myco owns this file; `myco remove` deletes it while it carries this line.
import { execFileSync } from "node:child_process";
import { accessSync, appendFileSync, closeSync, constants as fsConstants, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// <myco:shared-helpers>
// ---------------------------------------------------------------------------
// Shared plugin helpers — the whole of a native plugin's contact with Myco.
//
// This block is maintained in
//   src/symbionts/templates/_shared/plugin-helpers.ts.snippet
// and injected into each plugin file at install time by SymbiontInstaller.
// The plugin files on disk also carry an inline copy between the
// `// <myco:shared-helpers>` markers so they stay valid TypeScript for
// Vitest imports; a unit test enforces the inline copy matches the snippet.
//
// A plugin makes NO network call. It writes transcript lines and it runs the
// Myco binary's hook verbs. The binary owns credential resolution, the
// write-ahead spool, the offline latch, blob spill, the server-held offset and
// every refusal code; a second implementation of those inside a harness
// runtime would be a second member, and the wire contract only has one.
//
// Contract: the containing file has already defined imports for
//   `readFileSync`, `appendFileSync`, `mkdirSync`, `statSync`, `accessSync`,
//   `openSync`, `closeSync`, `writeSync`, `unlinkSync`,
//   `constants as fsConstants`, `join`, `dirname`, `resolve`, `homedir`,
//   `execFileSync`
// and nothing else from the outer file.
//
// Export discipline: opencode's legacy-plugin loader throws on any module
// export that isn't a function, killing the whole plugin at load. Only
// FUNCTION exports may be added to this snippet (or to the plugin files).
//
// DO NOT edit this block inside a plugin file directly — edit the snippet
// and run the installer (or rerun the template-sync test to update the
// inlined copy). Changes here apply to every plugin the next time it
// installs/updates.
// ---------------------------------------------------------------------------

/** Version of the transcript line format. A parser meeting an unknown value fails the segment. */
const MYCO_TRANSCRIPT_FORMAT = 1;

/** Ceiling on a hook subprocess, so a stalled binary never blocks the harness. */
const MYCO_HOOK_TIMEOUT_MS = 5000;

/**
 * Where the binary reads this install's credential, substituted at install
 * time exactly as a hook command's `--credential` flag is.
 *
 * Declared, never inferred from the environment: a plugin that guessed would
 * let an unrelated variable redirect capture to another Deployment. `registry`
 * is the installed default; a sandbox image renders `env`, which is the only
 * source that admits a loopback `http://` Deployment.
 */
const MYCO_CREDENTIAL_SOURCE = "{{mycoCredentialSource}}";

const RUNTIME_PIN_INSECURE_MODE_MASK = 0o022;

/**
 * Read a `runtime.home` or `runtime.command` pin only when it passes the same
 * trust check the CLI shim uses: a group/other-writable or foreign-owned pin is
 * refused, so a hostile local user cannot redirect capture to a runtime they
 * control. Returns the trimmed value or null.
 */
function readTrustedPin(filePath: string): string | null {
  try {
    if (process.platform !== "win32") {
      const stat = statSync(filePath);
      const myUid = typeof process.getuid === "function" ? process.getuid() : null;
      if (myUid !== null && stat.uid !== myUid) return null;
      if ((stat.mode & 0o777) & RUNTIME_PIN_INSECURE_MODE_MASK) return null;
    }
    const raw = readFileSync(filePath, "utf-8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/**
 * The `runtime.home` pin for a project: a project pin found by walking up from
 * `directory`, then the machine pin. Returns an absolute path or null.
 */
function readRuntimeHomePin(directory: string): string | null {
  let dir = resolve(directory);
  while (true) {
    const pin = readTrustedPin(join(dir, ".myco", "runtime.home"));
    if (pin) return expandTilde(pin);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const machine = readTrustedPin(join(homedir(), ".myco", "runtime.home"));
  return machine ? expandTilde(machine) : null;
}

/**
 * This project's Myco home. A trusted `runtime.home` pin wins so a dogfood
 * project pinned to `~/.myco-dev` writes and reads there; then `MYCO_HOME`;
 * then `~/.myco`. Identity is the home, never a path this file guesses.
 */
function resolveMycoHome(directory?: string): string {
  if (directory) {
    const pinned = readRuntimeHomePin(directory);
    if (pinned) return pinned;
  }
  const configured = process.env.MYCO_HOME?.trim();
  if (!configured) return join(homedir(), ".myco");
  return expandTilde(configured);
}

/**
 * Managed-binary layout; mirrors scripts/managed-paths.mjs, which a plugin
 * cannot import. Agreement is gated by tests/symbionts/pi-binary-resolution.test.ts.
 */
function managedBinaryPath(mycoHome: string): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "Myco", "bin", "myco.exe");
  }
  return join(mycoHome, "bin", "myco");
}

/** A file that exists and (on POSIX) is executable; mode-0644 binaries fail. */
function isRunnableBinary(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Myco binary, in the contract order: project-scope `runtime.command` pin
 * by upward walk, then the machine pin, then the runnable managed binary, then
 * the bare name. Every step uses one home — the directory-aware
 * `resolveMycoHome(directory)` — so a pinned project's fallbacks come from its
 * own home. The bare name is the last resort: a GUI-launched agent's PATH need
 * not contain it.
 */
function resolveMycoBinary(directory: string): string {
  let dir = resolve(directory);
  while (true) {
    const pin = readTrustedPin(join(dir, ".myco", "runtime.command"));
    if (pin) return pin;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = resolveMycoHome(directory);
  const machinePin = readTrustedPin(join(home, "runtime.command"));
  if (machinePin) return machinePin;
  const managed = managedBinaryPath(home);
  if (isRunnableBinary(managed)) return managed;
  return process.platform === "win32" ? "myco.exe" : "myco";
}

/**
 * Where this agent's plugin-written transcript lives. Must agree with the
 * agent's manifest `transcriptDiscovery` root, which declares the same
 * directory as `@memberHome/member/transcripts/<agent>`; a gate resolves both
 * and compares them.
 */
function transcriptPathFor(directory: string, agent: string, sessionId: string): string {
  return join(resolveMycoHome(directory), "member", "transcripts", agent, `${sessionId}.jsonl`);
}

/**
 * Where a session's writer records that it holds the session.
 *
 * Beside the transcripts rather than among them: a lock is not a transcript
 * and must not be discovered, parsed or aged as one.
 */
function claimPathFor(directory: string, agent: string, sessionId: string): string {
  return join(resolveMycoHome(directory), "member", "claims", `${agent}-${sessionId}.lock`);
}

/**
 * Whether this instance is the one that speaks for this session.
 *
 * A project-local plugin and a global one can both load for one session, and
 * both are legitimately Myco's. Two participants would mint two prompt ids,
 * append two lines per turn under one transcript identity and inject two
 * context blocks — the doubling this design removes, arriving by install
 * topology instead. One instance holds the session; the others stay silent.
 *
 * The claim names a LIVE writer, not a file that exists. Claiming by the
 * transcript's existence would hand every resumed session to nobody: the
 * runtime that reopens `--session`/`--resume` finds a file it did not create
 * and would fall silent for the whole session. So the holder records its pid
 * in a sidecar taken with `wx`, and an instance finding a pid that is gone
 * takes the session over.
 *
 * Decided once per session per process: a claim that changed hands mid-session
 * would interleave two writers into one transcript.
 */
const claimedSessions = new Map<string, boolean>();

function livePid(raw: string): boolean {
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means a live process this user may not signal; only ESRCH is gone.
    return (error as { code?: string })?.code === "EPERM";
  }
}

function takeClaim(claimPath: string): boolean {
  try {
    const handle = openSync(claimPath, "wx");
    writeSync(handle, String(process.pid));
    closeSync(handle);
    return true;
  } catch {
    return false;
  }
}

function holdsSessionClaim(directory: string, agent: string, sessionId: string): boolean {
  const held = claimedSessions.get(sessionId);
  if (held !== undefined) return held;
  const claimPath = claimPathFor(directory, agent, sessionId);
  let claimed = false;
  try {
    mkdirSync(dirname(claimPath), { recursive: true });
    claimed = takeClaim(claimPath);
    if (!claimed && !livePid(readFileSync(claimPath, "utf-8"))) {
      // The holder is gone: a resumed session, or one whose runtime was killed.
      unlinkSync(claimPath);
      claimed = takeClaim(claimPath);
    }
  } catch {
    // An unreadable or unwritable claim directory means this instance does not
    // speak for the session; capture is degraded rather than duplicated.
    claimed = false;
  }
  claimedSessions.set(sessionId, claimed);
  return claimed;
}

/**
 * Append one record to the transcript.
 *
 * The `session` record must be written first and stay small: project
 * attribution reads the working directory from a bounded head of the file
 * (64 KiB, then its first 40 lines) and takes the first line where the
 * declared dot-path hits. A large or late first record makes every transcript
 * for this agent unattributable, and nothing announces it.
 */
function appendTranscriptLine(
  directory: string,
  agent: string,
  sessionId: string,
  record: Record<string, unknown>,
): void {
  if (!holdsSessionClaim(directory, agent, sessionId)) return;
  const filePath = transcriptPathFor(directory, agent, sessionId);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify({ v: MYCO_TRANSCRIPT_FORMAT, ...record })}\n`, "utf-8");
  } catch {
    // A transcript that cannot be written loses capture for this turn. It must
    // never take the harness down with it.
  }
}

/**
 * Run one Myco hook verb, handing it `payload` on stdin.
 *
 * The resolved home travels to the binary as `MYCO_HOME`. A spawned binary
 * resolves its own home from the environment and never walks the project's
 * `runtime.home` pin, so a pinned project would otherwise write its transcript
 * to the pinned home while the hook's spool, registry and retention used the
 * default one. One side resolves the home and tells the other. This mirrors
 * the same injection the installer makes for an MCP server entry, and for the
 * same reason.
 *
 * Returns the hook's parsed response, or null when Myco is not installed, the
 * binary fails, or the output is not the expected shape. Never throws and
 * never rejects: a capture path that breaks the host is worse than one that
 * captures nothing, and a plugin-only install legitimately has no binary.
 */
function runMycoHook(
  directory: string,
  agent: string,
  sessionId: string,
  verb: string,
  payload: Record<string, unknown>,
): { additionalContext?: string; promptId?: string } | null {
  // The instance that does not speak for this session runs nothing: a second
  // participant would spawn a second hook per turn, mint an id nothing uses
  // and place a second context block in front of the model.
  if (!holdsSessionClaim(directory, agent, sessionId)) return null;
  try {
    const stdout = execFileSync(
      resolveMycoBinary(directory),
      ["hook", verb, "--symbiont", agent, "--credential", MYCO_CREDENTIAL_SOURCE],
      {
        cwd: directory,
        env: { ...process.env, MYCO_HOME: resolveMycoHome(directory) },
        input: JSON.stringify(payload),
        timeout: MYCO_HOOK_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const trimmed = typeof stdout === "string" ? stdout.trim() : "";
    if (!trimmed) return {};
    if (!trimmed.startsWith("{")) return { additionalContext: trimmed };
    return JSON.parse(trimmed) as { additionalContext?: string; promptId?: string };
  } catch {
    return null;
  }
}
// </myco:shared-helpers>

const AGENT = "opencode";

/**
 * Marks a part this plugin injected. opencode replays injected parts through
 * `chat.message`, so without the marker our own context would be captured as
 * the user's next prompt.
 */
const MYCO_METADATA_MARKER = "myco";

/** Heading placed above injected context so the model sees a labelled block. */
const CONTEXT_HEADING = "## Myco - Project Context\n\n";

/** The prompt id the binary minted for the turn in flight, per session. */
const promptIds = new Map<string, string>();
/** Sessions whose start line has been written, so a replayed event writes one session record. */
const started = new Set<string>();

function nowIso(): string {
  return new Date().toISOString();
}

function textOfParts(parts: Array<{ type?: string; text?: string; synthetic?: boolean; metadata?: Record<string, unknown> }>): string {
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .filter((p) => p.synthetic !== true)
    .filter((p) => p.metadata?.[MYCO_METADATA_MARKER] !== true)
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

/**
 * Open a session: write the `session` record first — attribution reads the
 * working directory from the head of the file — then register and inject.
 */
function openSession(directory: string, sessionId: string): string | undefined {
  if (started.has(sessionId)) return undefined;
  started.add(sessionId);
  appendTranscriptLine(directory, AGENT, sessionId, {
    type: "session",
    sessionId,
    agent: AGENT,
    cwd: directory,
    at: nowIso(),
  });
  const answer = runMycoHook(directory, AGENT, sessionId, "session-start", {
    session_id: sessionId,
    transcript_path: transcriptPathFor(directory, AGENT, sessionId),
    cwd: directory,
  });
  return answer?.additionalContext;
}

export const MycoPlugin = async ({
  client,
  directory,
  worktree,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  directory: string;
  worktree?: string;
}) => {
  const root = worktree ?? directory;

  /** Place a block in the session out of band, used at session start and resume. */
  const injectSynthetic = async (sessionId: string, text: string): Promise<void> => {
    try {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text, synthetic: true, metadata: { [MYCO_METADATA_MARKER]: true } }],
          noReply: true,
        },
      });
    } catch {
      // Injection is best effort; a session that refuses it still captures.
    }
  };

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: async ({ event }: { event: any }) => {
      const type = event?.type;

      if (type === "session.created") {
        const sessionId = event?.properties?.info?.id;
        if (!sessionId) return;
        const context = openSession(root, sessionId);
        if (context) await injectSynthetic(sessionId, `${CONTEXT_HEADING}${context}`);
        return;
      }

      if (type === "session.idle") {
        const sessionId = event?.properties?.sessionID;
        if (!sessionId) return;
        promptIds.delete(sessionId);
        runMycoHook(root, AGENT, sessionId, "stop", {
          session_id: sessionId,
          transcript_path: transcriptPathFor(root, AGENT, sessionId),
          cwd: root,
        });
        return;
      }

      if (type === "session.deleted" || type === "server.instance.disposed") {
        const sessionId = event?.properties?.info?.id ?? event?.properties?.sessionID;
        if (!sessionId) return;
        started.delete(sessionId);
        promptIds.delete(sessionId);
        runMycoHook(root, AGENT, sessionId, "session-end", {
          session_id: sessionId,
          transcript_path: transcriptPathFor(root, AGENT, sessionId),
          cwd: root,
        });
      }
    },

    /**
     * A turn's user message: register the session if this is the first thing
     * seen, mint the prompt id through the hook, write the prompt line, and
     * push the served context onto this message's parts.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "chat.message": async (_input: any, output: any) => {
      const sessionId = output?.message?.sessionID ?? output?.parts?.[0]?.sessionID;
      if (!sessionId) return;

      const parts = (output?.parts ?? []) as Array<{
        id?: string;
        messageID?: string;
        sessionID?: string;
        type?: string;
        text?: string;
        synthetic?: boolean;
        metadata?: Record<string, unknown>;
      }>;

      if (output?.message?.role === "assistant") {
        const text = textOfParts(parts);
        if (text) {
          appendTranscriptLine(root, AGENT, sessionId, {
            type: "response",
            sessionId,
            promptId: promptIds.get(sessionId),
            text,
            at: nowIso(),
          });
        }
        return;
      }

      const text = textOfParts(parts);
      if (!text) return;

      const startContext = openSession(root, sessionId);
      if (startContext) await injectSynthetic(sessionId, `${CONTEXT_HEADING}${startContext}`);

      const answer = runMycoHook(root, AGENT, sessionId, "user-prompt-submit", {
        session_id: sessionId,
        transcript_path: transcriptPathFor(root, AGENT, sessionId),
        prompt: text,
        cwd: root,
      });
      // A hook that did not answer leaves this turn with no id. Keeping the
      // previous turn's would file this turn's tool and response lines under
      // the prompt before it.
      const promptId = answer?.promptId;
      if (promptId) promptIds.set(sessionId, promptId);
      else promptIds.delete(sessionId);

      appendTranscriptLine(root, AGENT, sessionId, {
        type: "prompt",
        sessionId,
        promptId,
        text,
        origin: "human",
        at: nowIso(),
      });

      const context = answer?.additionalContext;
      if (!context) return;
      // Mirror the user part's identity so opencode renders the block in place
      // rather than as a message of its own.
      const template = parts.find((p) => p?.type === "text");
      const idPrefix =
        typeof template?.id === "string" && template.id.includes("_")
          ? template.id.slice(0, template.id.indexOf("_") + 1)
          : "prt_";
      output.parts.push({
        id: `${idPrefix}myco${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
        ...(template?.messageID !== undefined ? { messageID: template.messageID } : {}),
        ...(template?.sessionID !== undefined ? { sessionID: template.sessionID } : {}),
        type: "text",
        text: `${CONTEXT_HEADING}${context}`,
        synthetic: true,
        metadata: { [MYCO_METADATA_MARKER]: true },
      });
    },

    /** A finished tool call becomes a transcript line; no subprocess runs here. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "tool.execute.after": async (input: any, output: any) => {
      const sessionId = input?.sessionID;
      if (!sessionId) return;
      appendTranscriptLine(root, AGENT, sessionId, {
        type: "tool",
        sessionId,
        promptId: promptIds.get(sessionId),
        name: input?.tool,
        input: input?.args,
        output: typeof output?.output === "string" ? output.output : undefined,
        failed: output?.error !== undefined,
        at: nowIso(),
      });
    },

    /** Compaction drops the earlier turns, so the served block is placed again. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "experimental.session.compacting": async (input: any, output: any) => {
      const sessionId = input?.sessionID;
      if (!sessionId) return;
      const answer = runMycoHook(root, AGENT, sessionId, "post-compact", {
        session_id: sessionId,
        transcript_path: transcriptPathFor(root, AGENT, sessionId),
        cwd: root,
      });
      if (answer?.additionalContext && Array.isArray(output?.context)) {
        output.context.push(`${CONTEXT_HEADING}${answer.additionalContext}`);
      }
    },
  };
};

export default MycoPlugin;
