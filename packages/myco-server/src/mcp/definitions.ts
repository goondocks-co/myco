/**
 * The MCP tool definitions this Deployment serves.
 *
 * The seven tools of ledger §7.3, as `packages/myco/src/tools/definitions.ts`
 * declares them, with the retired Grove pivot removed: a Deployment has no
 * Grove, and the Project a call addresses is the request's Project header or
 * the `project_id` argument. `tests/myco-server/tool-parity.test.ts` holds
 * these equal to the member-side definitions, naming the one property whose
 * description differs.
 *
 * Served verbatim on `tools/list`; arguments are validated against
 * `inputSchema` by `validate.ts` before any handler runs.
 */
import type { ServedTool } from '../core/tool-catalogue.js';

export interface JsonSchemaProperty {
  type?: string | string[];
  enum?: readonly unknown[];
  items?: JsonSchemaProperty;
  description?: string;
}

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: ServedTool;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  cortex?: { guidance: string; priority?: number };
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    "name": "myco_search",
    "description": "Search the vault for prior sessions, spores, plans, skills, and Canopy file summaries. Results include stable IDs plus a `retrieve` hint naming the entity tool and input to fetch the full record. Use before making design decisions, debugging non-obvious issues, or locating source files by what they do. Pass type=\"canopy\" to search the project Canopy index — file-level llm_description summaries — when keyword search is too shallow.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "cortex": {
      "guidance": "Use to find prior decisions, bugs, plans, sessions, skills, or Canopy file summaries. Follow each result's `retrieve` hint to fetch the full entity with its owning tool.",
      "priority": 20
    },
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Natural language search query — describe what you are looking for"
        },
        "type": {
          "type": "string",
          "enum": [
            "session",
            "plan",
            "spore",
            "skill",
            "canopy",
            "all"
          ],
          "description": "Filter by entity type (default: all). \"canopy\" searches per-file llm_description summaries and returns canopy_entry results."
        },
        "limit": {
          "type": "number",
          "description": "Max results (default: 10)"
        },
        "observation_type": {
          "type": "string",
          "description": "Optional semantic filter for spore observation type (decision, gotcha, discovery, etc.)"
        },
        "status": {
          "type": "string",
          "description": "Optional semantic filter for record status (for example active)"
        },
        "release_state": {
          "type": "string",
          "enum": [
            "unreconciled",
            "released",
            "merged_unreleased",
            "not_on_release_line",
            "unknown"
          ],
          "description": "Optional semantic filter for release provenance state"
        },
        "release_confidence": {
          "type": "string",
          "enum": [
            "high",
            "medium",
            "low"
          ],
          "description": "Optional semantic filter for release provenance confidence"
        },
        "since": {
          "type": "number",
          "description": "Optional created_at lower bound in epoch seconds"
        },
        "until": {
          "type": "number",
          "description": "Optional created_at upper bound in epoch seconds"
        },
        "language": {
          "type": "string",
          "description": "Canopy-only: optional language filter (e.g. \"typescript\")"
        },
        "project_id": {
          "type": "string",
          "description": "The Project this call reads or writes, when it is not the request's own Project header. A member reads any Project of the Deployment; an unknown or archived Project answers not found."
        }
      },
      "required": [
        "query"
      ]
    }
  },
  {
    "name": "myco_cortex",
    "description": "Retrieve Cortex-produced project intelligence. op: \"digest\" returns the pre-computed project digest at tier 1500, 5000, or 10000. op: \"instructions\" returns the generated project instruction brief when available. op: \"canopy_map\" returns the rendered project Canopy map for the resolved request context. op: \"canopy_entry\" retrieves one Canopy file summary from the resolved request context by id (`project_id:path`) or path. op: \"notifications\" returns notifications for the request scope (use unread_only and limit to filter). op: \"maintenance_summary\" returns the per-Grove maintenance summary (db sizes, last backup/optimize, integrity status, and overdue flags). op: \"projects_activity\" returns the cross-Grove project activity feed (last activity, scheduled runs, active flag).",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "cortex": {
      "guidance": "Use op: \"digest\" for broad orientation, op: \"canopy_map\" as the default opener for project layout, op: \"canopy_entry\" to retrieve a Canopy result returned by search, op: \"notifications\" to read pending operator notifications, op: \"maintenance_summary\" to answer \"are any Groves overdue for backup/optimize/integrity?\", and op: \"projects_activity\" to see which projects are still active across the machine.",
      "priority": 10
    },
    "inputSchema": {
      "type": "object",
      "properties": {
        "op": {
          "type": "string",
          "enum": [
            "digest",
            "instructions",
            "canopy_map",
            "canopy_entry",
            "notifications",
            "maintenance_summary",
            "projects_activity"
          ],
          "description": "Operation (default: \"digest\")"
        },
        "tier": {
          "type": "number",
          "enum": [
            1500,
            5000,
            10000
          ],
          "description": "Digest token budget tier. Larger tiers include more detail. Default: 5000."
        },
        "id": {
          "type": "string",
          "description": "Canopy entry id for op: \"canopy_entry\" in the form project_id:path"
        },
        "project_id": {
          "type": "string",
          "description": "The Project this call reads or writes, when it is not the request's own Project header. A member reads any Project of the Deployment; an unknown or archived Project answers not found."
        },
        "path": {
          "type": "string",
          "description": "Canopy file path for op: \"canopy_entry\""
        },
        "unread_only": {
          "type": "boolean",
          "description": "op: \"notifications\" — return only unread entries (default: false)"
        },
        "limit": {
          "type": "number",
          "description": "op: \"notifications\" — max entries to return"
        }
      }
    }
  },
  {
    "name": "myco_plans",
    "description": "Manage implementation plans. op: \"list\" (default) returns plan summaries. op: \"get\" returns one plan with content by id. op: \"save\" creates a plan for a session with content and at least one of source_path or plan_key (both allowed — plan_key is the identity, source_path is metadata), or updates an existing plan when id is passed. On update, content is optional — omit it for a status-only transition (e.g. active → in_progress → completed). Status defaults to \"active\". op: \"delete\" removes a plan by id; cross-machine rows require force_remote: true.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "cortex": {
      "guidance": "Use op: \"list\" before creating a new plan or spec, or when existing plans may already cover the work. Use op: \"get\" with a plan id to read a specific plan in full — including picking up a plan created in an earlier session by its id. Use op: \"save\" when you create or materially revise a plan, and pass status: \"in_progress\" when you start working through it so the Sessions UI surfaces it as the active plan; mark it status: \"completed\" (or \"abandoned\") when the work concludes. To update an existing plan (status or content) from any session, call op: \"save\" with its id. Plans default to status: \"active\" — that means written-but-not-yet-executing; \"in_progress\" means execution has begun.",
      "priority": 50
    },
    "inputSchema": {
      "type": "object",
      "properties": {
        "op": {
          "type": "string",
          "enum": [
            "list",
            "get",
            "save",
            "delete"
          ],
          "description": "Operation (default: \"list\")"
        },
        "id": {
          "type": "string",
          "description": "Plan id. Required for op: \"get\" and op: \"delete\"; for op: \"save\", update this existing plan and preserve its logical key."
        },
        "session": {
          "type": "string",
          "description": "Filter list to plans belonging to this session; mutually exclusive with id."
        },
        "session_id": {
          "type": "string",
          "description": "Session id the plan belongs to for op: \"save\""
        },
        "content": {
          "type": "string",
          "description": "Markdown plan content to persist for op: \"save\""
        },
        "source_path": {
          "type": "string",
          "description": "Path to the plan file when the plan is also written to disk. Pass this OR plan_key, never both."
        },
        "plan_key": {
          "type": "string",
          "description": "Stable key for non-file-backed plans. Pass this OR source_path, never both."
        },
        "title": {
          "type": "string",
          "description": "Optional explicit title for op: \"save\""
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "in_progress",
            "completed",
            "abandoned",
            "all"
          ],
          "description": "Filter by status for op: \"list\" (\"all\" means unfiltered) or set writable plan status for op: \"save\" (active, in_progress, completed, abandoned only)"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Tags for discoverability — component names, technologies, concepts"
        },
        "limit": {
          "type": "number",
          "description": "Max results for op: \"list\""
        },
        "force_remote": {
          "type": "boolean",
          "description": "Allow op: \"delete\" to remove a plan belonging to another machine. Enqueues a tombstone for team sync."
        },
        "project_id": {
          "type": "string",
          "description": "The Project this call reads or writes, when it is not the request's own Project header. A member reads any Project of the Deployment; an unknown or archived Project answers not found."
        }
      }
    }
  },
  {
    "name": "myco_sessions",
    "description": "Browse and retrieve past coding sessions with summaries, tools used, and linked spores. op: \"list\" (default) returns summaries; op: \"get\" returns one session by id.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "cortex": {
      "guidance": "Use when continuing related work or recovering recent implementation context. Use op: \"get\" for full session content returned by search.",
      "priority": 40
    },
    "inputSchema": {
      "type": "object",
      "properties": {
        "op": {
          "type": "string",
          "enum": [
            "list",
            "get"
          ],
          "description": "Operation (default: \"list\")"
        },
        "id": {
          "type": "string",
          "description": "Session id for op: \"get\""
        },
        "plan": {
          "type": "string",
          "description": "Filter to the session linked to this plan id"
        },
        "branch": {
          "type": "string",
          "description": "Git branch name to find related sessions and plans"
        },
        "user": {
          "type": "string",
          "description": "Filter sessions by user"
        },
        "since": {
          "type": "string",
          "description": "ISO timestamp — entries after this date"
        },
        "status": {
          "type": "string",
          "description": "Filter by session status (e.g., active, completed)"
        },
        "limit": {
          "type": "number",
          "description": "Max results (default: 20)"
        },
        "project_id": {
          "type": "string",
          "description": "The Project this call reads or writes, when it is not the request's own Project header. A member reads any Project of the Deployment; an unknown or archived Project answers not found."
        }
      }
    }
  },
  {
    "name": "myco_skills",
    "description": "List and inspect skills generated by Myco. op: \"list\" (default) filters by status; op: \"get\" retrieves a specific skill by id or name.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "inputSchema": {
      "type": "object",
      "properties": {
        "op": {
          "type": "string",
          "enum": [
            "list",
            "get"
          ],
          "description": "Operation (default: \"list\")"
        },
        "id": {
          "type": "string",
          "description": "Skill id or name for op: \"get\""
        },
        "status": {
          "type": "string",
          "description": "Filter by status: active, stale, retired"
        },
        "limit": {
          "type": "number",
          "description": "Max results (default: 50)"
        },
        "project_id": {
          "type": "string",
          "description": "The Project this call reads or writes, when it is not the request's own Project header. A member reads any Project of the Deployment; an unknown or archived Project answers not found."
        }
      }
    }
  },
  {
    "name": "myco_spores",
    "description": "Manage durable knowledge spores. op: \"list\" returns spores by status/type/search. op: \"get\" retrieves one spore by id. op: \"save\" records a new decision, gotcha, bug fix, discovery, or trade-off. op: \"supersede\" marks an old spore as replaced by a newer one. op: \"consolidate\" merges related spores into one comprehensive wisdom note. op: \"obsolete\" retires a spore that is no longer relevant with no replacement (e.g. a dropped feature); requires a reason.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    },
    "cortex": {
      "guidance": "Use op: \"save\" to capture durable decisions, gotchas, discoveries, or bug fixes. Use op: \"get\" for full spore content returned by search. Retire stale knowledge yourself rather than leaving it for the Myco agent: op: \"supersede\" when a newer spore replaces it, op: \"consolidate\" to merge several into one wisdom note, and op: \"obsolete\" (with a reason) when it is simply no longer relevant and has no replacement.",
      "priority": 90
    },
    "inputSchema": {
      "type": "object",
      "properties": {
        "op": {
          "type": "string",
          "enum": [
            "list",
            "get",
            "save",
            "supersede",
            "consolidate",
            "obsolete"
          ],
          "description": "Operation (default: \"list\")"
        },
        "id": {
          "type": "string",
          "description": "Spore id for op: \"get\", or the spore to retire for op: \"obsolete\""
        },
        "content": {
          "type": "string",
          "description": "Observation content for op: \"save\""
        },
        "type": {
          "type": "string",
          "enum": [
            "gotcha",
            "bug_fix",
            "decision",
            "discovery",
            "trade_off",
            "cross-cutting",
            "wisdom",
            "pattern",
            "architecture"
          ],
          "description": "Observation type for op: \"save\": gotcha, bug_fix, decision, discovery, trade_off, cross-cutting, wisdom, pattern, architecture"
        },
        "observation_type": {
          "type": "string",
          "enum": [
            "gotcha",
            "bug_fix",
            "decision",
            "discovery",
            "trade_off",
            "cross-cutting",
            "wisdom",
            "pattern",
            "architecture"
          ],
          "description": "Observation type filter for op: \"list\" or consolidated note type for op: \"consolidate\": gotcha, bug_fix, decision, discovery, trade_off, cross-cutting, wisdom, pattern, architecture"
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "superseded",
            "consolidated",
            "obsolete",
            "all"
          ],
          "description": "Filter by status for op: \"list\""
        },
        "agent_id": {
          "type": "string",
          "description": "Filter op: \"list\" by agent id"
        },
        "search": {
          "type": "string",
          "description": "Text filter for op: \"list\""
        },
        "limit": {
          "type": "number",
          "description": "Max results for op: \"list\""
        },
        "offset": {
          "type": "number",
          "description": "Offset for op: \"list\""
        },
        "old_spore_id": {
          "type": "string",
          "description": "ID of the outdated spore for op: \"supersede\""
        },
        "new_spore_id": {
          "type": "string",
          "description": "ID of the replacement spore for op: \"supersede\""
        },
        "source_spore_ids": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "IDs of the spores to merge for op: \"consolidate\" (minimum 2)"
        },
        "consolidated_content": {
          "type": "string",
          "description": "Merged content for op: \"consolidate\" — synthesize, do not just concatenate"
        },
        "reason": {
          "type": "string",
          "description": "Reason for op: \"supersede\", \"consolidate\", or \"obsolete\" (required for \"obsolete\")"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Tags for discoverability — component names, technologies, concepts"
        },
        "project_id": {
          "type": "string",
          "description": "The Project this call reads or writes, when it is not the request's own Project header. A member reads any Project of the Deployment; an unknown or archived Project answers not found."
        }
      }
    }
  },
  {
    "name": "myco_agent",
    "description": "Read agent run history. op: \"runs\" (default) returns recent runs with harness/provider/model/token/cost/reasoning fields — filter by task, agent_id, limit. op: \"run\" with id returns a single run including write_intents totals and duration_ms.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "cortex": {
      "guidance": "Use op: \"run\" with your run id to check token budget, cost, reasoning level, or failure details. Use op: \"runs\" to browse recent runs for a task.",
      "priority": 85
    },
    "inputSchema": {
      "type": "object",
      "properties": {
        "op": {
          "type": "string",
          "enum": [
            "runs",
            "run"
          ],
          "description": "Operation (default: \"runs\")"
        },
        "id": {
          "type": "string",
          "description": "Required for op: \"run\" — the run id"
        },
        "task": {
          "type": "string",
          "description": "Filter op: \"runs\" by task name"
        },
        "agent_id": {
          "type": "string",
          "description": "Filter op: \"runs\" by agent id"
        },
        "limit": {
          "type": "number",
          "description": "Max results for op: \"runs\" (default: 50)"
        }
      }
    }
  }
];

/** The definition of a served tool by name, or undefined. */
export function definitionOf(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((d) => d.name === name);
}
