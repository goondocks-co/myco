/**
 * The MCP tool definitions this Deployment serves.
 *
 * The seven tools of ledger §7.3, as `packages/myco/src/tools/definitions.ts`
 * declares them, with the retired Grove pivot removed: a Deployment has no
 * Grove, and the Project a call addresses is the request's Project header or
 * the `project` argument. `tests/myco-server/tool-parity.test.ts` holds
 * these equal to the member-side definitions, naming the one property whose
 * description differs.
 *
 * Served verbatim on `tools/list`; arguments are validated against
 * `inputSchema` by `validate.ts` before any handler runs.
 */
import { PROJECT_PIVOT, type ServedTool } from '../core/tool-catalogue.js';
import { AGENT_LINE_MAX_CHARS } from '../core/injection.js';

/**
 * What the tenancy argument means on the member surface.
 *
 * A read that names no Project reads the request's own Project header, which is
 * the Project the member's credential is bound to. A write names its Project or
 * is refused: a member credential reaches every Project of the Deployment, so an
 * unnamed write would land wherever the transport happened to point.
 */
export const PROJECT_DESCRIPTION = "The Project this call reads or writes: a project id, or the repository's git remote. Optional on a read, which falls back to this request's own Project; required on a write. An unknown Project answers not found.";

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
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations?: ToolAnnotations;
  cortex?: { guidance: string; priority?: number };
}

/** A definition of one of the catalogued tools; the run-only surface declares its own beside these. */
export type ServedToolDefinition = ToolDefinition & { name: ServedTool };

export const TOOL_DEFINITIONS: readonly ServedToolDefinition[] = [
  {
    "name": "myco_search",
    "description": "Search project sessions, spores, plans, skills, prompts and responses. Results include stable IDs and entity retrieval hints where available. Use before making design decisions or debugging non-obvious issues.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "cortex": {
      "guidance": "Use to find prior decisions, bugs, plans, sessions, skills and captured conversation text. Follow each result's retrieve hint to fetch its entity; prompt and response hits identify the session and prompt.",
      "priority": 20
    },
    "inputSchema": {
      "type": "object",
      "properties": {
        "mode": {
          "type": "string",
          "enum": ["auto", "semantic", "fts"],
          "description": "Auto uses semantic search and falls back to full text only when the provider is unavailable. Use fts to search captured prompt and response bodies."
        },
        "session_id": { "type": "string", "description": "Filter by session ID." },
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
            "prompt",
            "response",
            "all"
          ],
          "description": "Filter by entity type (default: all)."
        },
        "limit": {
          "type": "number",
          "description": "Max results (default: 10)"
        },
        "observation_type": {
          "type": "string",
          "description": "Optional filter for spore observation type (decision, gotcha, discovery, etc.)"
        },
        "status": {
          "type": "string",
          "description": "Optional filter for record status (for example active)"
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
          "description": "Optional filter for release provenance state"
        },
        "release_confidence": {
          "type": "string",
          "enum": [
            "high",
            "medium",
            "low"
          ],
          "description": "Optional filter for release provenance confidence"
        },
        "since": {
          "type": "number",
          "description": "Optional created_at lower bound in epoch seconds"
        },
        "until": {
          "type": "number",
          "description": "Optional created_at upper bound in epoch seconds"
        },
        [PROJECT_PIVOT]: {
          "type": "string",
          "description": PROJECT_DESCRIPTION
        }
      },
      "required": [
        "query"
      ]
    }
  },
  {
    "name": "myco_cortex",
    "description": "Retrieve project intelligence. op: \"instructions\" (default) returns the project's session-start instructions and its project id. op: \"notifications\" returns notifications for the request scope (use unread_only and limit to filter). op: \"maintenance_summary\" returns the per-Grove maintenance summary (db sizes, last backup/optimize, integrity status, and overdue flags). op: \"projects_activity\" returns the cross-project activity feed (last activity, scheduled runs, active flag). op: \"digest\", op: \"canopy_map\" and op: \"canopy_entry\" are served by the local runtime only; a Deployment answers them not_served.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    },
    "cortex": {
      "guidance": "Use op: \"instructions\" to read the project's standing guidance and learn its project id, op: \"notifications\" to read pending operator notifications, op: \"maintenance_summary\" to answer \"are any Groves overdue for backup/optimize/integrity?\", and op: \"projects_activity\" to see which projects are still active. Search with myco_search rather than pulling a project summary; there is no digest.",
      "priority": 10
    },
    "inputSchema": {
      "type": "object",
      "properties": {
        "op": {
          "type": "string",
          "enum": [
            "instructions",
            "digest",
            "canopy_map",
            "canopy_entry",
            "notifications",
            "maintenance_summary",
            "projects_activity"
          ],
          "description": "Operation (default: \"instructions\")"
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
          "description": "Canopy entry id for op: \"canopy_entry\" in the form <project>:path"
        },
        "path": {
          "type": "string",
          "description": "Canopy file path for op: \"canopy_entry\""
        },
        [PROJECT_PIVOT]: {
          "type": "string",
          "description": PROJECT_DESCRIPTION
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
        "prompt_id": {
          "type": "string",
          "description": "For op: \"save\" creating a plan: the prompt it came from, captured by this machine; defaults to the session's latest prompt. Ignored on update — the plan keeps the prompt it names."
        },
        "limit": {
          "type": "number",
          "description": "Max results for op: \"list\""
        },
        "force_remote": {
          "type": "boolean",
          "description": "Allow op: \"delete\" to remove a plan belonging to another machine. Enqueues a tombstone for team sync."
        },
        [PROJECT_PIVOT]: {
          "type": "string",
          "description": PROJECT_DESCRIPTION
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
      "guidance": "Use when continuing related work or recovering recent implementation context. Use op: \"get\" for full session content by id.",
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
        [PROJECT_PIVOT]: {
          "type": "string",
          "description": PROJECT_DESCRIPTION
        }
      }
    }
  },
  {
    "name": "myco_skills",
    "description": "List and inspect skills. op: \"list\" (default) lists them; op: \"get\" returns one with where its body ships. A Deployment serves the skills that ship with Myco; a local 1.4 runtime serves the records it generated.",
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
          "description": "Skill name, or a generated record id, for op: \"get\""
        },
        "status": {
          "type": "string",
          "description": "Filter by status: active, stale, retired. Generated records only; a Deployment refuses it."
        },
        "limit": {
          "type": "number",
          "description": "Max results (default: 50)"
        },
        [PROJECT_PIVOT]: {
          "type": "string",
          "description": PROJECT_DESCRIPTION
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
      "guidance": "Use op: \"save\" to capture durable decisions, gotchas, discoveries, or bug fixes. Use op: \"get\" for full spore content by id. Retire stale knowledge yourself rather than leaving it for the Myco agent: op: \"supersede\" when a newer spore replaces it, op: \"consolidate\" to merge several into one wisdom note, and op: \"obsolete\" (with a reason) when it is simply no longer relevant and has no replacement.",
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
        "session_id": {
          "type": "string",
          "description": "Session id the spore belongs to for op: \"save\" and \"consolidate\", or the session acting for op: \"supersede\" and \"obsolete\"; from the Session:: line when known"
        },
        "prompt_id": {
          "type": "string",
          "description": "For save and consolidate: the exact captured prompt supporting this finding. Required for extraction runs; the server derives its source session. Other callers may name a prompt within their permitted session."
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Tags for discoverability — component names, technologies, concepts"
        },
        "agent_line": {
          "type": "string",
          "description": `For op: "save" and "consolidate": one line an agent can act on — the situation that triggers the spore, then the guidance, with the file or symbol it anchors to. Rendered in place of the body wherever the spore is served; at most ${AGENT_LINE_MAX_CHARS} characters.`
        },
        "provenance_kind": {
          "type": "string",
          "enum": [
            "pr",
            "commit"
          ],
          "description": "What a write with no session cites instead, on any of op: \"save\", \"supersede\", \"consolidate\" and \"obsolete\". Give with provenance_ref."
        },
        "provenance_ref": {
          "type": "string",
          "description": "The pull request URL for provenance_kind: \"pr\", or the commit sha for \"commit\". Give with provenance_kind."
        },
        [PROJECT_PIVOT]: {
          "type": "string",
          "description": PROJECT_DESCRIPTION
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
        },
        [PROJECT_PIVOT]: {
          "type": "string",
          "description": PROJECT_DESCRIPTION
        }
      }
    }
  }
];

/** The definition of a served tool by name, or undefined. */
export function definitionOf(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((d) => d.name === name);
}
