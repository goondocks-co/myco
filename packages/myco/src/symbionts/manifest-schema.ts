import { z } from 'zod';

/** Per-symbiont capture rules that filter or rewrite events. Scope and event
 *  keys are documented in docs/symbiont-manifests.md. */
const CaptureRuleSchema = z.object({
  event: z.enum(['session_start', 'user_prompt']),
  scope: z.enum(['this_agent', 'any_agent']).default('this_agent'),
  when: z.object({
    prompt_starts_with: z.string().optional(),
    prompt_contains: z.string().optional(),
    /** Fires when transcript_path is absent or empty. */
    transcript_path_missing: z.boolean().optional(),
    /** Fires when a dot-path field in session_meta exists and is truthy. */
    transcript_meta_field_exists: z.string().optional(),
    /** Fires when a dot-path field in session_meta equals a scalar value. */
    transcript_meta_field_equals: z.object({
      path: z.string(),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    }).optional(),
    /** Fires when the prompt begins with a `<tag …>` open for one of these tag names (attribute-robust). */
    prompt_envelope_tag_in: z.array(z.string()).optional(),
    /** Fires when the entire prompt is a single balanced/self-closing XML envelope (fail-safe classifier). */
    prompt_is_enclosing_envelope: z.boolean().optional(),
  }),
  action: z.enum(['drop', 'rewrite_prompt', 'classify']),
  /** Audit string logged when the rule matches. */
  reason: z.string().optional(),
  /** For rewrite_prompt: keep the substring after this marker. */
  extract_after: z.string().optional(),
  /**
   * For rewrite_prompt: strip a single enclosing tag envelope. Fires only
   * when the prompt starts with `open` AND ends with `close`; the inner
   * text is kept verbatim (boundary whitespace adjacent to the tags is
   * consumed as part of the envelope). When only one side is present the
   * rule falls through to `pass` unchanged — same fail-safe stance as
   * `extract_after`. Evaluated before `extract_after` when both are set.
   */
  strip_envelope: z.object({
    open: z.string().min(1),
    close: z.string().min(1),
  }).optional(),
  /** For rewrite_prompt: trim whitespace from the extracted substring. */
  trim: z.boolean().default(true),
  /**
   * For `action: 'classify'` (and optionally rewrite_prompt): mark the
   * resulting batch with a non-default `origin`. Records WHO issued the
   * prompt — orthogonal to `kind` (initial/steering/interrupt), which
   * records WHERE the batch sits in conversation flow.
   *
   *   human         — user-typed (default; rules don't need to set this)
   *   system        — transcript-synthesized continuation event
   *                   (e.g. <task-notification>, <environment_context>,
   *                   <skill> envelope expansion)
   *   agent_dispatch— prompts emitted by sub-agents back to the parent
   *   hook_injected — reserved
   */
  set_origin: z.enum(['human', 'system', 'agent_dispatch', 'hook_injected']).optional(),
});

export type CaptureRule = z.infer<typeof CaptureRuleSchema>;

/** Schema describing where user prompts live in an agent's transcript. */
const MatchExpressionSchema = z.object({
  /** Event's `type` field must equal this value. */
  type: z.string(),
  /** Event must have this dot-path field present and truthy. */
  hasField: z.string().optional(),
  /**
   * Dot-path → value pairs that must all match the event. Scalars are
   * compared with ===. Use for disambiguating sub-shapes (e.g. a Codex
   * `response_item` with `payload.role: "user"`).
   */
  fieldEquals: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  /**
   * Dot-path → value pairs that must all NOT match the event. Used to exclude
   * structurally-similar synthesized entries (e.g. Claude Code's `isMeta: true`
   * transcript entries for local-command caveats and skill injections) from
   * matching a shape meant for real user prompts.
   */
  fieldNotEquals: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

const PromptShapeSchema = z.object({
  /** Informational label used in audit logs. */
  name: z.string().optional(),
  match: MatchExpressionSchema,
  /**
   * Dot-path identifying the user-authored text. If the resolved value is
   * a string it is used as-is; if it's an array of typed blocks (the
   * Claude Code tool_result shape), the first `{type:"text"}` block's
   * `text` field is used.
   */
  textAt: z.string(),
  /**
   * How text is derived when the `textAt` value resolves to an ARRAY of
   * content blocks (strings always pass through unchanged):
   *
   *   first_text        — (default) the first `{type:"text"}` block's `text`
   *                       field. Matches the Claude Code typed-block shape.
   *   joined_text_parts — all text-bearing parts cleaned and joined via the
   *                       canonical Codex routine (`extractCodexPromptText`),
   *                       which strips `<image …>` wrapper tags. Required for
   *                       Codex multipart image prompts, where the user's
   *                       real text is the LAST part, not the first. `textAt`
   *                       must point at the content ARRAY itself.
   */
  textExtraction: z.enum(['first_text', 'joined_text_parts']).optional(),
  /**
   * Optional content-prefix guard. When set, the shape only matches when the
   * resolved `textAt` value starts with this literal. Use to disambiguate
   * entries that are STRUCTURALLY identical but semantically distinct — e.g.
   * Claude Code agent-team `<teammate-message …>` entries carry the exact same
   * top-level fields as the lead's own prompts and as `/exit` / `/model`
   * command artifacts (all gain `teamName` once a team exists in the session),
   * so the only reliable discriminator is the content itself. Evaluated after
   * the structural `match`, using the same string/typed-block resolution as
   * `textAt`.
   */
  textStartsWith: z.string().optional(),
  /**
   * Dot-path to a stable identifier for the prompt. Used to dedupe events
   * that appear more than once in the transcript (e.g. a `promptId` that
   * shows up on both the user prompt line and on tool_result entries for
   * the same turn).
   */
  dedupeBy: z.string().optional(),
});

const ResetBoundarySchema = z.object({
  match: MatchExpressionSchema,
  /**
   * Dot-path whose value change signals a new boundary. Useful for
   * events that fire throughout a turn but only mark a boundary when
   * a specific field (e.g. `payload.turn_id`) advances.
   */
  changeOn: z.string().optional(),
});

const CapturePromptsSchema = z.object({
  shapes: z.array(PromptShapeSchema).default([]),
  resetBoundaries: z.array(ResetBoundarySchema).default([]),
  /** Literal prefix that marks a user-initiated interrupt of the agent's turn. */
  interruptMarker: z.string().optional(),
});

export type PromptShape = z.infer<typeof PromptShapeSchema>;
export type ResetBoundary = z.infer<typeof ResetBoundarySchema>;
export type CapturePrompts = z.infer<typeof CapturePromptsSchema>;
export type MatchExpression = z.infer<typeof MatchExpressionSchema>;

/**
 * How this agent lays its transcripts out on disk.
 *
 * `hookFields.transcriptPath` only names the hook-payload field carrying a
 * path, so a transcript is discoverable only once a hook fires for it. This
 * block is the disk-side counterpart — the same role `planDirs` plays for
 * plans — letting a reader enumerate transcripts the hooks never reported.
 *
 * One template language covers every layout in use: a per-session file under a
 * project slug, a date-sharded rollout name, a per-session directory with the
 * transcript inside. Expressing all of them as path patterns rather than
 * discrete layout kinds keeps a single resolver serving both directions —
 * substitute `{sessionId}` to look one up, capture it to enumerate them all —
 * so lookup and enumeration cannot drift apart.
 */
const TranscriptDiscoverySchema = z.object({
  /**
   * Directory roots to search, `~` expanded. More than one when an agent
   * splits transcripts across surfaces (Antigravity's cli/ide/default).
   */
  roots: z.array(z.string()).min(1),
  /**
   * Path templates relative to each root, tried in order; first match wins.
   *
   * Two placeholders, which is all six agents' layouts need:
   *   `{sessionId}` — the session id, wherever it appears in the path
   *   `*`           — exactly one path segment (project slug, date shard)
   *
   * The same template serves both directions: substitute `{sessionId}` to
   * look a known session up, or turn it into a capture group to enumerate
   * every transcript on disk. Keeping one template for both is what stops
   * the lookup and enumeration paths from drifting apart.
   */
  patterns: z.array(z.string()).min(1),
  /**
   * Regex fragment constraining what `{sessionId}` may match, default
   * `[^/]+`. Required whenever a `*` sits next to `{sessionId}` with only a
   * separator between them, because the split is otherwise ambiguous: in
   * `rollout-*-{sessionId}.jsonl` no greediness rule recovers the right
   * boundary from `rollout-2025-11-23T08-39-26-<uuid>.jsonl` — both halves
   * are dash-delimited. Declaring the id's shape resolves it exactly.
   */
  sessionIdPattern: z.string().optional(),
  /**
   * Dot-path to the working directory recorded inside the transcript, used to
   * attribute a transcript found on disk to a project.
   *
   * Absent means this agent's transcripts carry no project hint. A reader must
   * then treat its orphan transcripts as unattributable and report the reduced
   * coverage, rather than assuming they belong to the project being audited.
   */
  transcriptCwdPath: z.string().optional(),
});

export type TranscriptDiscovery = z.infer<typeof TranscriptDiscoverySchema>;

const CaptureManifestSchema = z.object({
  planDirs: z.array(z.string()).default([]),
  planTags: z.array(z.string()).default([]),
  rules: z.array(CaptureRuleSchema).default([]),
  prompts: CapturePromptsSchema.optional(),
  /**
   * Absent means this agent's on-disk layout is undeclared: readers fall back
   * to whatever `sessions.transcript_path` recorded and must report the
   * reduced coverage rather than treating the result as complete.
   */
  transcriptDiscovery: TranscriptDiscoverySchema.optional(),
  /**
   * Dot-path (relative to the transcript's session_meta payload, the same
   * object `transcript_meta_field_exists` reads) to the sub-agent's PARENT
   * thread/session id. Present only on transcripts spawned as a sub-agent
   * thread. Absent (or resolving to a falsy/non-string value) means either
   * this agent has no sub-agent concept or this particular transcript is a
   * top-level session, not a spawned thread.
   */
  subagentParentPath: z.string().optional(),
  /**
   * Dot-path to the sub-agent thread's OWN stable id, distinct from the
   * daemon's internal session id. Used to correlate the same sub-agent
   * thread across re-mines of the same transcript.
   */
  subagentThreadIdPath: z.string().optional(),
  /**
   * Dot-path to the OBJECT that carries the sub-agent's human-friendly
   * label fields (e.g. Codex's `thread_spawn` object, which carries
   * `agent_nickname` and `agent_path`). The resolver derives the label as
   * `agent_nickname` when non-empty, else the last `/`-separated segment
   * of `agent_path`. A single dot-path can't express that fallback, so the
   * manifest declares only the OBJECT location and the derivation rule
   * lives in code (`resolveSubagentThread`) — keeping the manifest
   * agent-agnostic while the code stays shape-agnostic.
   */
  subagentLabelPath: z.string().optional(),
});

const RegistrationSchema = z.object({
  hooksTarget: z.string().optional(),
  /**
   * Absolute path (with `~` expansion) where Myco writes hook config when
   * installing under global scope. May point at a file the agent shares with
   * user content (e.g. `~/.claude/settings.json`) — settings-merge.ts owns
   * surgical, marker-bounded replacement of Myco's block. `null` declares that
   * the symbiont does not expose a global hook surface.
   */
  globalHooksTarget: z.string().nullable().optional(),
  /**
   * Absolute path(s) (with `~` expansion) where Myco writes MCP server
   * entries when installing under global scope. May share a file with hook
   * config (e.g. Codex's `~/.codex/config.toml`). `null` declares no global
   * MCP support (e.g. Pi, whose tools are wired via the extension itself).
   *
   * Accepts three shapes:
   *   - A single string: the common case (one MCP file per agent).
   *   - An array of strings: one agent, multiple surfaces with identical
   *     JSON shape (e.g. two MCP files that both use `mcpServers` as the
   *     top-level key).
   *   - An array of objects with `{ path, serversKey? }`: per-target
   *     server-key override. Required when surfaces of the same agent
   *     diverge on top-level key — Copilot is the canonical case: the
   *     terminal `copilot` CLI reads `~/.copilot/mcp-config.json` keyed
   *     under `mcpServers`, while the VS Code Copilot extension reads
   *     `~/Library/Application Support/Code/User/mcp.json` keyed under
   *     `servers`. The installer threads each target's `serversKey`
   *     into the JSON write so each surface gets the shape it expects.
   *
   * The schema normalizes every form into
   * `Array<{ path: string; serversKey?: string }> | null` so the
   * installer always iterates a uniform shape — single-target manifests
   * don't change behavior, and string entries inside an array inherit
   * `manifest.registration.mcpServersKey` at install time.
   */
  globalMcpTarget: z
    .union([
      z.string(),
      z.array(
        z.union([
          z.string(),
          z.object({
            path: z.string(),
            serversKey: z.string().optional(),
          }),
        ]),
      ).min(1),
    ])
    .nullable()
    .optional()
    .transform((value) => {
      if (value == null) return value;
      if (typeof value === 'string') return [{ path: value }];
      return value.map((entry) =>
        typeof entry === 'string' ? { path: entry } : entry,
      );
    }),
  /**
   * Absolute path (with `~` expansion) where Myco symlinks Myco-shipped
   * skills under global scope. Symlinks point back into the Myco install so
   * auto-update rewrites pick up new content. `null` declares no global
   * skills surface.
   */
  globalSkillsTarget: z.string().nullable().optional(),
  /**
   * Legacy global skill dirs for this agent — locations from before its
   * `globalSkillsTarget` moved (e.g. consolidating on the `~/.agents/skills`
   * cross-agent standard). Each entry is swept of Myco's own package-skill
   * symlinks on detection so stale/dangling links don't linger after a target
   * migration. Declarative + co-located: when an agent later adopts a new
   * standard dir, flip `globalSkillsTarget` and append the outgoing one here — no
   * separate legacy list in code. Only Myco-named symlinks are removed; real
   * user content and other sources' skills are untouched.
   */
  retiredGlobalSkillsTargets: z.array(z.string()).optional(),
  /**
   * Absolute path (with `~` expansion) where Myco writes the settings
   * template under global scope. When unset, settings under global scope
   * share the file with hooks (the historical Claude-Code-style merge:
   * one settings.json carries hooks + MCP + settings together).
   *
   * Required for symbionts whose `settingsFormat` doesn't match the file
   * shape `globalHooksTarget` expects — most notably Codex, whose hooks
   * file is JSON (`~/.codex/hooks.json`) but whose settings format is
   * TOML. Without an explicit `globalSettingsTarget`, the installer's
   * settings writer drops a `[features]` TOML section into the JSON
   * hooks file, producing a hybrid file Codex itself appends to on every
   * launch — and silently invalidating Codex's trust-hash on every
   * Myco bootstrap pass.
   */
  globalSettingsTarget: z.string().nullable().optional(),
  /**
   * Project-relative path of the agent's plugin-bundle manifest. Plugin-
   * file symbionts (Antigravity) require a bundle manifest at the root
   * of their plugin directory — without it, the agent's plugin loader
   * doesn't discover the bundle. The file is owned by Myco and copied
   * verbatim from `templates/<symbiont>/plugin.json`. `null`/absent
   * declares no bundle-manifest requirement (every JSON-merge symbiont).
   */
  pluginManifestTarget: z.string().nullable().optional(),
  /**
   * Absolute path (with `~` expansion) for the plugin-bundle manifest
   * under global scope. Mirrors `pluginManifestTarget` but at the user
   * home location. Plugin-file symbionts that install globally write
   * the bundle manifest here so the agent's user-home plugin discovery
   * sees the Myco bundle as a complete plugin.
   */
  globalPluginManifestTarget: z.string().nullable().optional(),
  /**
   * Format of the hooks target.
   * - 'json' (default): hooks template is merged into a JSON settings file.
   * - 'plugin-file': the hooks template is a verbatim file (e.g., an opencode TS plugin)
   *   copied to hooksTarget without JSON parsing. Used for agents with plugin-based hook
   *   systems rather than JSON hook entries.
   */
  hooksFormat: z.enum(['json', 'plugin-file']).default('json'),
  /**
   * For `hooksFormat: 'plugin-file'`, the basename of the template file
   * under `packages/myco/src/symbionts/templates/<symbiont>/`. Defaults to
   * `plugin.ts` (the opencode/pi convention). Antigravity ships a verbatim
   * `hooks.json` inside its plugin bundle and overrides this field.
   */
  hooksTemplateFile: z.string().optional(),
  /** Top-level `version` integer written alongside the `hooks` object. */
  hooksConfigVersion: z.number().optional(),
  /**
   * Hook stdout contract. `plain-text` writes `additionalContext` verbatim;
   * `json` emits a flat object with semantic HookResponse fields renamed
   * via `fieldNames` (unmapped fields are dropped).
   */
  hookResponse: z.object({
    // `antigravity-inject-steps` selects a per-event serializer that
    // wraps additionalContext in Antigravity's required shape
    // (`{ injectSteps: [{ ephemeralMessage }] }` for PreInvocation/
    // PostInvocation, `{}` for PostToolUse, `{ decision }` for Stop).
    // Distinct from `json` because the field-name mapping isn't a flat
    // rename — it's a structural wrap.
    format: z.enum(['plain-text', 'json', 'antigravity-inject-steps']),
    fieldNames: z.record(z.string(), z.string()).optional(),
  }).optional(),
  /**
   * Optional file path for a plugin deps package.json. When set, the installer writes
   * a package.json declaring the plugin SDK dependency so the agent's package manager
   * (e.g., opencode's Bun) can install it at startup. Preserved on uninstall so
   * contributors can keep their own deps.
   */
  pluginPackageTarget: z.string().optional(),
  mcpTarget: z.string().optional(),
  mcpFormat: z.enum(['json', 'toml']).default('json'),
  /**
   * JSON key under which MCP server entries are stored in the MCP config file.
   * Defaults to 'mcpServers' (used by Claude Code, Cursor, etc.). opencode uses 'mcp'.
   */
  mcpServersKey: z.string().default('mcpServers'),
  skillsTarget: z.string().optional(),
  /**
   * Legacy project-local skill dirs for this agent — locations from before its
   * `skillsTarget` moved (e.g. consolidating on the `.agents/skills` cross-agent
   * standard). Project-scope analog of `retiredGlobalSkillsTargets`: the
   * per-project skill-symlink reconcile sweeps Myco's own skill symlinks out of
   * each retired dir so stale links don't linger after a target migration. Only
   * Myco-owned symlinks (resolving under the canonical `.agents/skills/`) are
   * removed; real user content and user-added skills are untouched.
   */
  retiredSkillsTargets: z.array(z.string()).optional(),
  settingsTarget: z.string().optional(),
  /** Format of the settings file. TOML-format agents (e.g., Codex) emit top-level template keys as TOML sections. */
  settingsFormat: z.enum(['json', 'toml']).default('json'),
  /** Instruction file that stubs out to AGENTS.md. Only for agents that don't read AGENTS.md natively. */
  instructionsFile: z.string().optional(),
});

/**
 * Declarative description of a tool call that performs a file read, used by
 * Canopy's PreToolUse hook to recognize reads across heterogeneous agent tool
 * surfaces. Two variants:
 *
 *  - structured: the path lives at a top-level field on `tool_input` (e.g.
 *    Claude Code's `Read` tool puts the absolute path at `tool_input.file_path`).
 *  - shell-arg: the path is embedded in a shell command string and must be
 *    extracted via shlex; the entry's `readCommands` allowlist names the
 *    commands whose first non-flag argument is a path (e.g. Codex's `Bash`
 *    with `cat`, `head`, `tail`).
 *  - patch: the path is embedded in an apply_patch envelope string
 *    (`*** Begin Patch` … `*** End Patch`); the resolver scans the file
 *    headers (`*** Add File:` / `*** Update File:` / `*** Delete File:`)
 *    and returns the first one. Codex carries the envelope on `command`,
 *    opencode on `patchText`.
 *
 * `pathKind` is reserved for future image/URL support and defaults to `'file'`.
 */
const CanopyReadToolStructured = z.strictObject({
  tool: z.string().min(1),
  pathField: z.string().min(1),
  pathKind: z.literal('file').default('file'),
});

const CanopyReadToolShellArg = z.strictObject({
  tool: z.string().min(1),
  pathField: z.string().min(1),
  extract: z.literal('shell-arg'),
  readCommands: z.array(z.string().min(1)).min(1),
});

const CanopyReadToolPatch = z.strictObject({
  tool: z.string().min(1),
  pathField: z.string().min(1),
  extract: z.literal('patch'),
});

const CanopyReadToolSchema = z.union([
  // More-specific first — z.union picks the first matching variant.
  CanopyReadToolShellArg,
  CanopyReadToolPatch,
  CanopyReadToolStructured,
]);

/**
 * Optional capability flags that gate Myco features per symbiont. All
 * capabilities default to `false` when the field is absent so adding a new
 * capability never silently activates it for existing symbionts.
 */
const CapabilitiesSchema = z.object({
  /**
   * Whether this symbiont can carry context injected from a PreToolUse hook
   * response. Claude Code supports this via hookSpecificOutput.additionalContext;
   * other symbionts flip this on as their hook surfaces mature.
   */
  preToolUseInjection: z.boolean().default(false),
  /**
   * Whether this symbiont's hook template wires a session-start hook that
   * fetches Cortex context. Source of truth for the inline-vs-session-start
   * delivery decision in `cortex-brief.ts`. The legacy template-scan in
   * `injection-support.ts` is retained as a drift check.
   */
  sessionStartInjection: z.boolean().default(false),
  /**
   * Whether this symbiont has a subagent-start lifecycle hook whose
   * response can place model-visible context into the child agent before
   * its first prompt. This is distinct from merely observing or gating
   * subagent lifecycle events.
   */
  subagentStartInjection: z.boolean().default(false),
  /**
   * The transport on which this symbiont can make FULL-TENANCY Myco tool calls.
   *  - 'mcp' (default): the daemon's MCP endpoint, with project tenancy injected
   *    by the stdio bridge (claude-code) — the Myco-controlled default.
   *  - 'cli': the `myco tool call` CLI on the symbiont's shell. Used by hosts
   *    whose HTTP MCP cannot carry per-project tenancy (Codex: global config, no
   *    per-request project signal, MCP child cwd=/). Their shell runs in the
   *    workspace, so `myco tool call` resolves tenancy from cwd. The installer
   *    writes no MCP server for these; session-start adds a CLI directive.
   */
  toolTransport: z.enum(['mcp', 'cli']).default('mcp'),
  /**
   * Declarations of tool calls that Canopy should treat as file reads. The
   * PreToolUse resolver consults this list to decide whether to inject context
   * for a given tool call and where the path lives. See `CanopyReadToolSchema`.
   */
  canopyReadTools: z.array(CanopyReadToolSchema).default([]),
  /**
   * Declarations of tool calls that carry a file path on `tool_input`. Broader
   * superset of `canopyReadTools` — used by capture (PostToolUse activity
   * insert) to populate `activities.file_path` for write-side tools too
   * (Write, Edit, MultiEdit), so the FTS index and per-activity file column
   * stay accurate. Reuses the same entry shape (structured / shell-arg).
   *
   * Every `canopyReadTools` entry SHOULD also appear here — a refine() on the
   * outer manifest verifies the invariant: if `canopyReadTools` is non-empty,
   * `pathBearingTools` must be non-empty too.
   */
  pathBearingTools: z.array(CanopyReadToolSchema).default([]),
}).default(() => ({
  preToolUseInjection: false,
  sessionStartInjection: false,
  subagentStartInjection: false,
  toolTransport: 'mcp' as const,
  canopyReadTools: [],
  pathBearingTools: [],
}));

export type SymbiontCapabilities = z.infer<typeof CapabilitiesSchema>;
export type SymbiontCanopyReadTool = z.infer<typeof CanopyReadToolSchema>;

/**
 * Phases a stop-style hook event can carry data for. Manifests declare
 * which phases each agent event covers so the daemon's stop dispatcher
 * runs only the work that has data to act on.
 *
 *   response   — inline assistant response text + per-turn close-out
 *                (set response_summary on the latest batch, close open
 *                batches, set title from first prompt if missing)
 *   transcript — transcript file finalized; mine it for turns, reconcile
 *                batch kinds, populate batch responses, extract plan
 *                tags, capture images, materialize canopy aggregates
 *
 * Single-phase symbionts (Claude Code, Codex, Copilot) declare both
 * phases on their `Stop` event — the daemon runs both in sequence in
 * one invocation, matching pre-refactor behavior. Multi-phase symbionts
 * (Windsurf) declare one phase per event; each event fires its own
 * stop hook and the dispatcher runs only that phase's work, leaving
 * the other phase's processing to its own event.
 */
const StopPhaseSchema = z.enum(['response', 'transcript']);

const HookEventDeclarationSchema = z.object({
  /**
   * Lifecycle phases this event carries data for. The daemon's stop
   * dispatcher reads this list to decide which phase processors to
   * invoke for a given (symbiont, event_name) pair. Empty list means
   * the event is observed but contributes to no stop phase.
   */
  phases: z.array(StopPhaseSchema).default([]),
});

const HooksManifestSchema = z.record(z.string(), HookEventDeclarationSchema).default({});

export type StopPhase = z.infer<typeof StopPhaseSchema>;
export type HookEventDeclaration = z.infer<typeof HookEventDeclarationSchema>;
export type HooksManifest = z.infer<typeof HooksManifestSchema>;

const HookFieldPathSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

export const SymbiontManifestSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  binary: z.string(),
  configDir: z.string(),
  /**
   * User-global directory whose existence signals that this agent is
   * installed on the machine. The detection function walks the manifest
   * registry and checks each declared `detectionDir`. Use the canonical
   * user-home location (e.g. `~/.claude`, `~/.codex`); `~` is expanded by
   * the consumer. Manifests that have no global surface (or that should be
   * detected by a different signal) may omit this field. An explicit `null`
   * means "intentionally no global detection" — used during the Gemini→
   * Antigravity transition where two manifests share `~/.gemini` but only
   * Antigravity should claim detection.
   */
  detectionDir: z.string().nullable().optional(),
  pluginRootEnvVar: z.string(),
  settingsPath: z.string().optional(),
  hookFields: z.object({
    sessionId: HookFieldPathSchema,
    transcriptPath: HookFieldPathSchema,
    /** Symbiont's hook payload key for the final assistant response text.
     * Defaults to `last_assistant_message`. Symbionts that deliver the response
     * only through the transcript file (e.g., Antigravity) can keep the default
     * — the payload won't carry that field and the normalized value stays
     * undefined. */
    lastResponse: HookFieldPathSchema.default('last_assistant_message'),
    prompt: HookFieldPathSchema.default('prompt'),
    toolName: HookFieldPathSchema.default('tool_name'),
    toolInput: HookFieldPathSchema.default('tool_input'),
    /** Symbiont's hook payload key for tool output. Defaults to `tool_output`.
     * Same transcript-only caveat applies as `lastResponse`. */
    toolOutput: HookFieldPathSchema.default('tool_output'),
    /** Env var fallback for session ID (e.g., GEMINI_SESSION_ID). */
    sessionIdEnv: z.string().optional(),
  }),
  /** Resume command template with {sessionId} placeholder. Omit for IDE-based agents. */
  resumeCommand: z.string().optional(),
  capture: CaptureManifestSchema.optional(),
  registration: RegistrationSchema.optional(),
  capabilities: CapabilitiesSchema.optional(),
  /**
   * Per-agent-event lifecycle declarations. Keyed by the agent's hook
   * event name (e.g., `Stop`, `post_cascade_response`,
   * `post_cascade_response_with_transcript`). The daemon's stop
   * dispatcher reads `hooks[event_name].phases` to decide which
   * phase processors to invoke. See `HookEventDeclarationSchema`.
   *
   * Symbionts without a hooks block (or with an empty one) keep the
   * pre-refactor behavior: every stop event runs both phases in
   * sequence. That guarantees Cursor / Pi / Opencode / Antigravity
   * don't need migration when this block is added for the agents
   * that need phase-aware dispatch.
   */
  hooks: HooksManifestSchema.optional(),
}).refine(
  (m) => {
    const reads = m.capabilities?.canopyReadTools ?? [];
    const paths = m.capabilities?.pathBearingTools ?? [];
    // A canopy read is always path-bearing — if we declared canopy reads but
    // forgot to declare any path-bearing tools, that's a config error.
    return reads.length === 0 || paths.length > 0;
  },
  {
    message: 'capabilities.pathBearingTools must be non-empty when canopyReadTools is non-empty',
    path: ['capabilities', 'pathBearingTools'],
  },
).refine(
  (m) => {
    // TOML settings cannot share a JSON hooks file. Without an explicit
    // `globalSettingsTarget`, the installer's settings writer falls back
    // to `globalHooksTarget` — dropping a `[features]` TOML section into
    // a JSON hooks file produces a hybrid file the consuming agent
    // appends to (Codex), invalidating its trust-hash on every Myco
    // bootstrap pass. The schema-level check makes the bug class
    // structurally impossible for any new symbiont.
    const reg = m.registration;
    if (!reg) return true;
    if ((reg.settingsFormat ?? 'json') !== 'toml') return true;
    const hooksTarget = reg.globalHooksTarget;
    if (!hooksTarget) return true;
    if (!hooksTarget.endsWith('.json')) return true;
    const settingsTarget = reg.globalSettingsTarget;
    return (
      settingsTarget !== undefined &&
      settingsTarget !== null &&
      settingsTarget !== hooksTarget &&
      !settingsTarget.endsWith('.json')
    );
  },
  {
    message:
      'registration.globalSettingsTarget must be set to a non-JSON path when settingsFormat is "toml" and globalHooksTarget is a .json file',
    path: ['registration', 'globalSettingsTarget'],
  },
);

export type SymbiontManifest = z.infer<typeof SymbiontManifestSchema>;
export type SymbiontRegistration = z.infer<typeof RegistrationSchema>;
