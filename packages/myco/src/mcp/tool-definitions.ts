/**
 * MCP tool names, descriptions, and schema definitions.
 * Single source of truth for all tool metadata — referenced by the MCP server
 * and available to tests, logging, and documentation generators.
 */
import { OBSERVATION_TYPES, PLAN_STATUSES } from '../vault/types.js';
import { MCP_SEARCH_DEFAULT_LIMIT, MCP_SESSIONS_DEFAULT_LIMIT, MCP_SKILLS_DEFAULT_LIMIT } from '../constants.js';

/** Plan statuses plus 'all' for filtering. */
const PLAN_STATUS_FILTER = [...PLAN_STATUSES, 'all'] as const;

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

// --- Shared property descriptions (used by multiple tools) ---
const PROP_BRANCH = 'Git branch name to find related sessions and plans';
const PROP_SINCE = 'ISO timestamp — entries after this date';
const PROP_TAGS = 'Tags for discoverability — component names, technologies, concepts';

// --- Tool definitions ---
export const TOOL_DEFINITIONS = [
  {
    name: TOOL_SEARCH,
    description: 'Search the vault for prior sessions, spores, plans, and artifacts. Use before making design decisions, when debugging non-obvious issues, or when wondering why code is structured a certain way.',
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
    description: 'List active implementation plans and their status. Use to check what work is in flight before starting new tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: PLAN_STATUS_FILTER, description: 'Filter by status (default: all statuses)' },
        id: { type: 'string', description: 'Get a specific plan by ID' },
      },
    },
  },
  {
    name: TOOL_SAVE_PLAN,
    description: 'Persist a plan directly into Myco for a session. Use this when you generated or revised a plan and want it captured reliably. If the plan is also being written to disk, pass the same source_path so direct persistence and file capture reconcile to one logical plan.',
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
];

export const COLLECTIVE_TOOL_DEFINITIONS = [
  {
    name: TOOL_COLLECTIVE_SEARCH,
    description: 'Search across connected projects in the active Myco Collective. Results include project attribution.',
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
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: TOOL_COLLECTIVE_PROJECT,
    description: 'Get metadata for a single project connected to the active Myco Collective.',
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
