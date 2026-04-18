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

interface ToolOneOfRequirement {
  required: string[];
}

interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  oneOf?: ToolOneOfRequirement[];
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
export const TOOL_TEAM = 'myco_team';
export const TOOL_GRAPH = 'myco_graph';
export const TOOL_SUPERSEDE = 'myco_supersede';
export const TOOL_CONSOLIDATE = 'myco_consolidate';
export const TOOL_CONTEXT = 'myco_context';
export const TOOL_SKILLS = 'myco_skills';
export const TOOL_SKILL_CANDIDATES = 'myco_skill_candidates';
export const TOOL_COLLECTIVE_SEARCH = 'collective_search';
export const TOOL_COLLECTIVE_PROJECTS = 'collective_projects';
export const TOOL_COLLECTIVE_PROJECT = 'collective_project';
export const TOOL_CORTEX = 'myco_cortex';
export const TOOL_RUNS = 'myco_runs';

// --- Shared property descriptions (used by multiple tools) ---
const PROP_BRANCH = 'Git branch name to find related sessions and plans';
const PROP_SINCE = 'ISO timestamp — entries after this date';
const PROP_TAGS = 'Tags for discoverability — component names, technologies, concepts';

// --- Tool definitions ---
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: TOOL_SEARCH,
    description: 'Search the vault for prior sessions, spores, plans, and artifacts. Use before making design decisions, when debugging non-obvious issues, or when wondering why code is structured a certain way.',
    cortex: {
      guidance: 'Use for prior decisions, bugs, and rationale when you know the topic but not the exact note.',
      priority: 20,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language search query — describe what you are looking for' },
        type: { type: 'string', enum: ['session', 'plan', 'spore', 'all'], description: 'Filter by note type (default: all)' },
        limit: { type: 'number', description: `Max results (default: ${MCP_SEARCH_DEFAULT_LIMIT})` },
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
    description: 'Persist a plan directly into Myco for a session. Use this when you generated or revised a plan and want it captured reliably. If the plan is also being written to disk, pass the same source_path so direct persistence and file capture reconcile to one logical plan. Note: plan_key creates a stable namespace (session:<id>:key:<name>) distinct from transcript <tag> capture (session:<id>:tag:<name>) — the two do not merge. Dropping the transcript tag while also calling myco_save_plan with plan_key=tag will produce two separate rows.',
    cortex: {
      guidance: 'Use when you create or materially revise a plan and want it persisted to Myco. Pass `source_path` when the plan is also written to disk; otherwise use a stable `plan_key`. Note: `plan_key` rows are a separate namespace from transcript `<tag>` capture — reusing the same name in both channels creates two rows, not one.',
      priority: 60,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string', description: 'Session id the plan belongs to' },
        content: { type: 'string', description: 'Markdown plan content to persist' },
        source_path: { type: 'string', description: 'Path to the plan file when the plan is also written to disk' },
        plan_key: { type: 'string', description: 'Stable key for non-file-backed plans (for example: primary)' },
        title: { type: 'string', description: 'Optional explicit title. Defaults to the first Markdown H1, then file name or humanized plan_key.' },
        status: { type: 'string', enum: PLAN_STATUSES, description: `Plan status: ${PLAN_STATUSES.join(', ')}` },
        tags: { type: 'array', items: { type: 'string' }, description: PROP_TAGS },
      },
      required: ['session_id', 'content'],
      oneOf: [
        { required: ['source_path'] },
        { required: ['plan_key'] },
      ],
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
    name: TOOL_TEAM,
    description: 'List team members registered in the vault. Returns id, user, role, joined, and tags per member. Phase-1 scope: no filters.',
    cortex: {
      guidance: 'Use for current team topology and shared project context.',
      priority: 70,
      requiresTeam: true,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: TOOL_GRAPH,
    description: 'Traverse connections between records via graph edges — explore how sessions, spores, and plans relate to each other.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        note_id: { type: 'string', description: 'Note ID to start from (e.g., "session-abc123" or "decision-xyz789")' },
        direction: { type: 'string', enum: ['incoming', 'outgoing', 'both'], description: 'Link direction to follow (default: both)' },
        depth: { type: 'number', description: 'How many hops to traverse, 1-3 (default: 1)' },
      },
      required: ['note_id'],
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
    name: TOOL_SKILL_CANDIDATES,
    description: 'List and manage skill candidates — observations identified as potential skills. Use to see pending candidates, approve, or dismiss them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Get a specific candidate by ID' },
        action: { type: 'string', enum: ['list', 'approve', 'dismiss'], description: "Action to perform (default: 'list')" },
        status: { type: 'string', description: 'Filter by status: identified, approved, generated, dismissed' },
        limit: { type: 'number', description: `Max results (default: ${MCP_SKILLS_DEFAULT_LIMIT})` },
      },
    },
  },
  {
    name: TOOL_CORTEX,
    description: 'Cortex instruction + prompt-builder surface. op: "get" returns the current session-start instructions snapshot. op: "refresh" triggers the cortex-instructions task to regenerate them. op: "build_prompt" starts the cortex-prompt-builder task for a goal (required) and optional symbiont. op: "get_prompt_result" polls a prompt-builder run by run_id. Refresh and build_prompt are not read-only — they start background runs.',
    annotations: {
      // Mixed: get/get_prompt_result are read-only, refresh/build_prompt kick
      // off background work. Mark conservatively — consumers should not silently
      // auto-run this tool.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    cortex: {
      guidance: 'Use op: "get" to read your own session-start Cortex instructions; use op: "build_prompt" + "get_prompt_result" when you need the prompt-builder to draft a prompt for a specific goal.',
      priority: 95,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        op: { type: 'string', enum: ['get', 'refresh', 'build_prompt', 'get_prompt_result'], description: 'Cortex operation' },
        run_id: { type: 'string', description: 'Required for op: "get_prompt_result"' },
        goal: { type: 'string', description: 'Required for op: "build_prompt" — the task the prompt will be built for' },
        symbiont: { type: 'string', description: 'Optional symbiont/agent name the prompt should be tuned for; defaults to the first enabled symbiont' },
      },
      required: ['op'],
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
] as const;
