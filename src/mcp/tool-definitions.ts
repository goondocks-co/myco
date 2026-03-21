/**
 * MCP tool names, descriptions, and schema definitions.
 * Single source of truth for all tool metadata — referenced by the MCP server
 * and available to tests, logging, and documentation generators.
 */
import { OBSERVATION_TYPES, PLAN_STATUSES } from '../vault/types.js';
import { MCP_SEARCH_DEFAULT_LIMIT, MCP_SESSIONS_DEFAULT_LIMIT, MCP_LOGS_DEFAULT_LIMIT } from '../constants.js';

/** Plan statuses plus 'all' for filtering. */
const PLAN_STATUS_FILTER = [...PLAN_STATUSES, 'all'] as const;

// --- Tool names ---
export const TOOL_SEARCH = 'myco_search';
export const TOOL_RECALL = 'myco_recall';
export const TOOL_REMEMBER = 'myco_remember';
export const TOOL_PLANS = 'myco_plans';
export const TOOL_SESSIONS = 'myco_sessions';
export const TOOL_TEAM = 'myco_team';
export const TOOL_GRAPH = 'myco_graph';
export const TOOL_ORPHANS = 'myco_orphans';
export const TOOL_LOGS = 'myco_logs';
export const TOOL_SUPERSEDE = 'myco_supersede';
export const TOOL_CONSOLIDATE = 'myco_consolidate';
export const TOOL_CONTEXT = 'myco_context';

// --- Shared property descriptions (used by multiple tools) ---
const PROP_BRANCH = 'Git branch name to find related sessions and plans';
const PROP_SINCE = 'ISO timestamp — entries after this date';
const PROP_TAGS = 'Tags for discoverability — component names, technologies, concepts';

// --- Tool definitions ---
export const TOOL_DEFINITIONS = [
  {
    name: TOOL_SEARCH,
    description: 'Search the vault for prior decisions, gotchas, bug fixes, and session history. Use before making design decisions, when debugging non-obvious issues, or when wondering why code is structured a certain way.',
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
    description: 'Get context relevant to your current work — spores, sessions, and plans related to the branch and files you are working on. Use at the start of a task or when you need background on a component.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        branch: { type: 'string', description: PROP_BRANCH },
        files: { type: 'array', items: { type: 'string' }, description: 'File paths you are working on — finds spores tagged with these files' },
      },
    },
  },
  {
    name: TOOL_REMEMBER,
    description: 'Save a decision, gotcha, bug fix, discovery, or trade-off as a permanent spore. Use after making a key decision, fixing a tricky bug, discovering something non-obvious, or encountering a gotcha.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The observation — include context, reasoning, and what someone encountering this in the future needs to know' },
        type: { type: 'string', enum: OBSERVATION_TYPES, description: `Observation type: ${OBSERVATION_TYPES.join(', ')}` },
        tags: { type: 'array', items: { type: 'string' }, description: PROP_TAGS },
        session: { type: 'string', description: 'Your current session ID — auto-detected if omitted' },
        related_plan: { type: 'string', description: 'Plan ID if this observation relates to an active plan' },
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
    name: TOOL_SESSIONS,
    description: 'Browse past coding sessions with summaries, tools used, and linked spores. Use to understand what work has been done on a feature or branch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan: { type: 'string', description: 'Filter sessions linked to a specific plan' },
        branch: { type: 'string', description: PROP_BRANCH },
        user: { type: 'string', description: 'Filter sessions by user' },
        since: { type: 'string', description: PROP_SINCE },
        limit: { type: 'number', description: `Max results (default: ${MCP_SESSIONS_DEFAULT_LIMIT})` },
      },
    },
  },
  {
    name: TOOL_TEAM,
    description: 'See what teammates have been working on — filter by shared files or plan to understand who has context on a component.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'File paths to find teammates who worked on them' },
        plan: { type: 'string', description: 'Plan ID to find teammates collaborating on it' },
        since: { type: 'string', description: PROP_SINCE },
      },
    },
  },
  {
    name: TOOL_GRAPH,
    description: 'Traverse connections between vault notes via wikilinks — explore how sessions, spores, and plans relate to each other.',
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
    name: TOOL_ORPHANS,
    description: 'Find vault notes with no connections — potentially stale or unlinked knowledge that may need review or cleanup.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: TOOL_LOGS,
    description: 'View daemon logs for debugging when sessions are not being captured, observations are missing, or embeddings fail. Filter by level, component, or time range.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: `Max entries to return (default: ${MCP_LOGS_DEFAULT_LIMIT})` },
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: 'Minimum log level filter' },
        component: { type: 'string', description: 'Component filter: daemon, processor, hooks, lifecycle, embeddings, mcp, lineage, watcher' },
        since: { type: 'string', description: PROP_SINCE },
        until: { type: 'string', description: 'ISO timestamp — entries before this time' },
      },
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
    description: 'Merge 3+ related spores into a single comprehensive wisdom note. Use when multiple observations describe aspects of the same insight, share a root cause, or would be more useful as one reference. Source spores are marked superseded.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_spore_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of the spores to merge (minimum 2)' },
        consolidated_content: { type: 'string', description: 'The merged, comprehensive content — synthesize, do not just concatenate' },
        observation_type: { type: 'string', enum: OBSERVATION_TYPES, description: `Type for the consolidated wisdom note: ${OBSERVATION_TYPES.join(', ')}` },
        tags: { type: 'array', items: { type: 'string' }, description: PROP_TAGS },
      },
      required: ['source_spore_ids', 'consolidated_content', 'observation_type'],
    },
  },
  {
    name: TOOL_CONTEXT,
    description: "Retrieve Myco's synthesized understanding of this project. Returns a pre-computed context extract at the requested token tier. Available tiers: 1500 (executive briefing), 3000 (team standup), 5000 (deep onboarding), 10000 (institutional knowledge). This is a rich, always-current synthesis of project history, decisions, patterns, and active work — not a search result.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        tier: {
          type: 'number',
          enum: [1500, 3000, 5000, 7500, 10000],
          description: 'Token budget tier. Larger tiers include more detail. Default: 3000.',
        },
      },
    },
  },
];
