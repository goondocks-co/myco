/**
 * MCP tool names, descriptions, and schema definitions.
 * Single source of truth for all tool metadata — referenced by the MCP server
 * and available to tests, logging, and documentation generators.
 */
import { OBSERVATION_TYPES, PLAN_STATUSES } from '../vault/types.js';
import { MCP_SEARCH_DEFAULT_LIMIT, MCP_SESSIONS_DEFAULT_LIMIT, MCP_SKILLS_DEFAULT_LIMIT } from '../constants.js';

/** Plan statuses plus 'all' for filtering. */
const PLAN_STATUS_FILTER = [...PLAN_STATUSES, 'all'] as const;
const DEFAULT_CORTEX_PRIORITY = 100;

interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolCortexMetadata {
  guidance: string;
  priority?: number;
  requiresTeam?: boolean;
  requiresCollective?: boolean;
}

/**
 * MCP tool annotations. These follow the MCP spec's `annotations` envelope
 * so clients can show the right UI affordances (confirm-before-run for
 * destructive tools, quiet auto-run for read-only ones, etc.). Bundle D
 * makes these mandatory for every Myco-registered tool.
 */
export interface ToolAnnotations {
  /** True if the tool never mutates state. */
  readOnlyHint: boolean;
  /**
   * True if the tool can destroy data or start work that's hard to undo.
   * For multi-op tools, set true if ANY op is destructive and describe
   * the op matrix in the tool description.
   */
  destructiveHint: boolean;
  /** True if calling the tool twice with the same input is safe. */
  idempotentHint: boolean;
  /** True if the tool reaches outside the local vault (network, other machines). */
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  cortex?: ToolCortexMetadata;
}

export function getToolCortexPriority(tool: Pick<ToolDefinition, 'cortex'>): number {
  return tool.cortex?.priority ?? DEFAULT_CORTEX_PRIORITY;
}

// --- Tool names ---
export const TOOL_SEARCH = 'myco_search';
export const TOOL_RECALL = 'myco_recall';
export const TOOL_REMEMBER = 'myco_remember';
export const TOOL_PLANS = 'myco_plans';
export const TOOL_SAVE_PLAN = 'myco_save_plan';
export const TOOL_SESSIONS = 'myco_sessions';
export const TOOL_SUPERSEDE = 'myco_supersede';
export const TOOL_CONSOLIDATE = 'myco_consolidate';
export const TOOL_CONTEXT = 'myco_context';
export const TOOL_SKILLS = 'myco_skills';
export const TOOL_COLLECTIVE_SEARCH = 'collective_search';
export const TOOL_COLLECTIVE_PROJECTS = 'collective_projects';
export const TOOL_COLLECTIVE_PROJECT = 'collective_project';
export const TOOL_COLLECTIVE_SETTINGS = 'collective_settings';
export const TOOL_RUNS = 'myco_runs';

// --- Shared property descriptions (used by multiple tools) ---
const PROP_BRANCH = 'Git branch name to find related sessions and plans';
const PROP_SINCE = 'ISO timestamp — entries after this date';
const PROP_TAGS = 'Tags for discoverability — component names, technologies, concepts';

// --- Tool definitions ---
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: TOOL_SEARCH,
    description: 'Search the vault for prior sessions, spores, plans, and artifacts. Use before making design decisions, when debugging non-obvious issues, or when wondering why code is structured a certain way. Pass type="canopy" to search the project canopy index — file-level llm_description summaries — when you need to find relevant source files by what they DO, not by keyword; canopy results return one row per file as `{project_id, path, llm_description, language, score}` and are local-only (not synced to team).',
    cortex: {
      guidance: 'Use for prior decisions, bugs, and rationale when you know the topic but not the exact note. Pass type="canopy" when you need to find source files by behavior rather than keyword.',
      priority: 20,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language search query — describe what you are looking for' },
        type: { type: 'string', enum: ['session', 'plan', 'spore', 'canopy', 'all'], description: 'Filter by note type (default: all). "canopy" searches per-file llm_description summaries and returns {project_id, path, llm_description, language, score}.' },
        limit: { type: 'number', description: `Max results (default: ${MCP_SEARCH_DEFAULT_LIMIT})` },
        observation_type: { type: 'string', description: 'Optional semantic filter for spore observation type (decision, gotcha, discovery, etc.)' },
        status: { type: 'string', description: 'Optional semantic filter for record status (for example active)' },
        since: { type: 'number', description: 'Optional created_at lower bound in epoch seconds' },
        until: { type: 'number', description: 'Optional created_at upper bound in epoch seconds' },
        language: { type: 'string', description: 'Canopy-only: optional language filter (e.g. "typescript")' },
        path_prefix: { type: 'string', description: 'Canopy-only: optional repo-relative path prefix filter (e.g. "src/auth/")' },
      },
      required: ['query'],
    },
  },
  {
    name: TOOL_RECALL,
    description: 'Look up a specific vault note by ID — returns the full content of a session, spore, or plan. Use when you have a note ID from search results or graph traversal and need the complete details.',
    cortex: {
      guidance: 'Use after search finds a promising result and you need the full note.',
      priority: 30,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        note_id: { type: 'string', description: 'Note ID to look up (e.g., "session-abc123", "decision-xyz789", "plan-feature-x")' },
      },
      required: ['note_id'],
    },
  },
  {
    name: TOOL_REMEMBER,
    description: 'Save a decision, gotcha, bug fix, discovery, or trade-off as a permanent spore. Use after making a key decision, fixing a tricky bug, discovering something non-obvious, or encountering a gotcha. Session association is derived by the daemon — the MCP client does not pass it.',
    cortex: {
      guidance: 'Use to save durable decisions, gotchas, discoveries, or bug fixes from this work.',
      priority: 90,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The observation — include context, reasoning, and what someone encountering this in the future needs to know' },
        type: { type: 'string', enum: OBSERVATION_TYPES, description: `Observation type: ${OBSERVATION_TYPES.join(', ')}` },
        tags: { type: 'array', items: { type: 'string' }, description: PROP_TAGS },
      },
      required: ['content', 'type'],
    },
  },
  {
    name: TOOL_PLANS,
    description: 'List or delete implementation plans. op: "list" (default) returns plan summaries — filter by status, session, or a single id. op: "delete" removes a plan by id; cross-machine rows require force_remote: true. Use list to check what work is in flight before starting new tasks; use delete when retiring obsolete plans.',
    annotations: {
      // Destructive because op: "delete" removes a plan and enqueues a tombstone.
      // Consumers should confirm before running this tool with op: "delete".
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    cortex: {
      guidance: 'Use op: "list" before implementation when approved plans or specs may already exist; pass session to scope to the current work, or id to fetch a single plan with content.',
      priority: 50,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        op: { type: 'string', enum: ['list', 'delete'], description: 'Operation (default: "list")' },
        status: { type: 'string', enum: PLAN_STATUS_FILTER, description: 'Filter by status (default: all statuses); ignored for op: "delete"' },
        id: { type: 'string', description: 'Plan id. Required for op: "delete". For op: "list" returns that plan with content.' },
        session: { type: 'string', description: 'Filter list to plans belonging to this session; mutually exclusive with id.' },
        limit: { type: 'number', description: 'Max results for op: "list"' },
        force_remote: { type: 'boolean', description: 'Allow op: "delete" to remove a plan belonging to another machine. Enqueues a tombstone for team sync.' },
      },
    },
  },
  {
    name: TOOL_SAVE_PLAN,
    description: 'Persist a plan directly into Myco for a session. Use this when you generated or revised a plan and want it captured reliably. Pass exactly one of `source_path` or `plan_key` — `source_path` when the plan is also written to disk (so direct persistence and file capture reconcile to one logical plan), or `plan_key` for non-file-backed plans. The daemon rejects requests that set neither or both. Note: plan_key creates a stable namespace (session:<id>:key:<name>) distinct from transcript <tag> capture (session:<id>:tag:<name>) — the two do not merge. Dropping the transcript tag while also calling myco_save_plan with plan_key=tag will produce two separate rows.',
    cortex: {
      guidance: 'Use when you create or materially revise a plan and want it persisted to Myco. Pass `source_path` when the plan is also written to disk; otherwise use a stable `plan_key`. Note: `plan_key` rows are a separate namespace from transcript `<tag>` capture — reusing the same name in both channels creates two rows, not one.',
      priority: 60,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string', description: 'Session id the plan belongs to' },
        content: { type: 'string', description: 'Markdown plan content to persist' },
        source_path: { type: 'string', description: 'Path to the plan file when the plan is also written to disk. Pass this OR plan_key, never both.' },
        plan_key: { type: 'string', description: 'Stable key for non-file-backed plans (for example: primary). Pass this OR source_path, never both.' },
        title: { type: 'string', description: 'Optional explicit title. Defaults to the first Markdown H1, then file name or humanized plan_key.' },
        status: { type: 'string', enum: PLAN_STATUSES, description: `Plan status: ${PLAN_STATUSES.join(', ')}` },
        tags: { type: 'array', items: { type: 'string' }, description: PROP_TAGS },
      },
      required: ['session_id', 'content'],
    },
  },
  {
    name: TOOL_SESSIONS,
    description: 'Browse past coding sessions with summaries, tools used, and linked spores. Use to understand what work has been done on a feature or branch.',
    cortex: {
      guidance: 'Use when continuing related work or recovering recent implementation context.',
      priority: 40,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan: { type: 'string', description: 'Filter to the session linked to this plan id' },
        branch: { type: 'string', description: PROP_BRANCH },
        user: { type: 'string', description: 'Filter sessions by user' },
        since: { type: 'string', description: PROP_SINCE },
        status: { type: 'string', description: 'Filter by session status (e.g., active, completed)' },
        limit: { type: 'number', description: `Max results (default: ${MCP_SESSIONS_DEFAULT_LIMIT})` },
      },
    },
  },
  {
    name: TOOL_SUPERSEDE,
    description: 'Mark a spore as outdated and replaced by a newer one. Use when a decision was reversed, a gotcha was fixed, a discovery was wrong, or the codebase changed and an observation no longer applies. The old spore is preserved but marked superseded.',
    cortex: {
      guidance: 'Use when existing knowledge is outdated and should stop guiding future runs.',
      priority: 100,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        old_spore_id: { type: 'string', description: 'ID of the outdated spore (e.g., "decision-abc123")' },
        new_spore_id: { type: 'string', description: 'ID of the replacement spore' },
        reason: { type: 'string', description: 'Why the old spore is being superseded' },
      },
      required: ['old_spore_id', 'new_spore_id'],
    },
  },
  {
    name: TOOL_CONSOLIDATE,
    description: 'Merge 2+ related spores into a single comprehensive wisdom note. Inserts a new spore with the consolidated content; each source spore is marked superseded with a resolution_events row linking it to the new wisdom spore. Use when multiple observations describe aspects of the same insight, share a root cause, or would be more useful as one reference.',
    cortex: {
      guidance: 'Use when several related learnings should become one durable wisdom artifact.',
      priority: 110,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_spore_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of the spores to merge (minimum 2)' },
        consolidated_content: { type: 'string', description: 'The merged, comprehensive content — synthesize, do not just concatenate' },
        observation_type: { type: 'string', enum: OBSERVATION_TYPES, description: `Type for the consolidated wisdom note: ${OBSERVATION_TYPES.join(', ')}` },
        tags: { type: 'array', items: { type: 'string' }, description: PROP_TAGS },
        reason: { type: 'string', description: 'Optional reason recorded on each resolution event' },
      },
      required: ['source_spore_ids', 'consolidated_content', 'observation_type'],
    },
  },
  {
    name: TOOL_CONTEXT,
    description: "Retrieve Myco's pre-computed project digest — a rich, always-current synthesis of project history, decisions, patterns, active work, and institutional knowledge. Call this at the start of a new task or session to orient yourself on the project before taking action; call it again after long interruptions or when switching contexts. This is NOT a search — it's the project's accumulated understanding, served instantly. Available tiers: 1500 (executive briefing, one-screen overview), 5000 (deep onboarding, default), 10000 (comprehensive institutional knowledge). Prefer this over myco_search when you need broad project orientation; use myco_search when you need to find specific prior decisions or bug fixes.",
    cortex: {
      guidance: 'Use for broad project orientation or when you want the current digest before planning changes.',
      priority: 10,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        tier: {
          type: 'number',
          enum: [1500, 5000, 10000],
          description: 'Token budget tier. Larger tiers include more detail. Default: 5000.',
        },
      },
    },
  },
  {
    name: TOOL_SKILLS,
    description: 'List and inspect skills generated by Myco. Use to see what skills are active, check skill details, or find skills by status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Get a specific skill by ID or name' },
        status: { type: 'string', description: 'Filter by status: active, stale, retired' },
        limit: { type: 'number', description: `Max results (default: ${MCP_SKILLS_DEFAULT_LIMIT})` },
      },
    },
  },
  {
    name: TOOL_RUNS,
    description: 'Read agent run history. op: "list" (default) returns recent runs with runtime/provider/model/token/cost/reasoning fields — filter by task, agent_id, limit. op: "get" with id returns a single run including write_intents totals and duration_ms. Use after a run completes to check your own token budget, cost, and reasoning level — particularly useful when debugging a run that exhausted context.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    cortex: {
      guidance: 'Use op: "get" with your run id to check your own token budget, cost, and reasoning level — especially after a run that exhausted context or failed. Use op: "list" to browse recent runs for a task.',
      priority: 85,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        op: { type: 'string', enum: ['list', 'get'], description: 'Operation (default: "list")' },
        id: { type: 'string', description: 'Required for op: "get" — the run id' },
        task: { type: 'string', description: 'Filter op: "list" by task name' },
        agent_id: { type: 'string', description: 'Filter op: "list" by agent id' },
        limit: { type: 'number', description: 'Max results for op: "list" (default: 50)' },
      },
    },
  },
];

export const COLLECTIVE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: TOOL_COLLECTIVE_SEARCH,
    description: 'Search across connected projects in the active Myco Collective. Results include project attribution.',
    cortex: {
      guidance: 'Use for cross-project knowledge across the connected collective.',
      priority: 80,
      requiresCollective: true,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language search query across the connected Collective projects' },
        project: { type: 'string', description: 'Optional project id or project name filter' },
        limit: { type: 'number', description: `Max results (default: ${MCP_SEARCH_DEFAULT_LIMIT})` },
        types: { type: 'array', items: { type: 'string' }, description: 'Optional content type filter for remote semantic search' },
        observation_type: { type: 'string', description: 'Optional spore observation type filter for remote semantic search' },
        status: { type: 'string', description: 'Optional record status filter for remote semantic search' },
        since: { type: 'number', description: 'Optional created_at lower bound in epoch seconds' },
        until: { type: 'number', description: 'Optional created_at upper bound in epoch seconds' },
        session_id: { type: 'string', description: 'Optional session id metadata filter' },
        source_path: { type: 'string', description: 'Optional source path metadata filter' },
        name: { type: 'string', description: 'Optional name metadata filter' },
      },
      required: ['query'],
    },
  },
  {
    name: TOOL_COLLECTIVE_PROJECTS,
    description: 'List the projects connected to the active Myco Collective.',
    cortex: {
      guidance: 'Use to discover relevant collective projects before drilling deeper.',
      priority: 81,
      requiresCollective: true,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: TOOL_COLLECTIVE_PROJECT,
    description: 'Get metadata for a single project connected to the active Myco Collective.',
    cortex: {
      guidance: 'Use when you know the collective project and need its focused context.',
      priority: 82,
      requiresCollective: true,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project id or project name' },
        include_digest: { type: 'boolean', description: 'Request digest information when available' },
      },
      required: ['project'],
    },
  },
  {
    name: TOOL_COLLECTIVE_SETTINGS,
    description: 'Inspect the active Collective setting overrides applied to this project.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    cortex: {
      guidance: 'Use to inspect active Collective setting overrides for this project.',
      priority: 83,
      requiresCollective: true,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
] as const;
