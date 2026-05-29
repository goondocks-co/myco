/**
 * Pure Myco tool-name identity resolution — NO database imports.
 *
 * This module is intentionally free of `bun:sqlite` / `client.ts` so it can be
 * imported from the migration runner and the activity write path (and bundled
 * by the Node/esbuild-built `myco-team` worker, which reaches `migrations.ts`
 * via `schema.ts`) without dragging the SQLite runtime into the bundle. The
 * DB-querying aggregates live in `myco-tool-usage.ts`, which re-exports these.
 *
 * The prefix/family tokens are the single source of truth shared with the SQL
 * canonicalization CASE in `myco-tool-usage.ts`, so the two paths can never
 * drift on a literal.
 */

// ---------------------------------------------------------------------------
// Myco tool-name structure (single source of truth)
// ---------------------------------------------------------------------------
/** MCP-routed names arrive prefixed, e.g. `mcp__myco__myco_search`. */
export const MCP_TOOL_PREFIX = 'mcp__myco__';
/** Legacy artifact: a pre-fix daemon double-applied the family prefix. */
export const LEGACY_DOUBLED_PREFIX = 'myco_myco_';
export const MYCO_TOOL_FAMILY = 'myco_';
export const COLLECTIVE_TOOL_FAMILY = 'collective_';
/** A canonical Myco tool name starts with one of these. */
export const MYCO_TOOL_FAMILIES = [MYCO_TOOL_FAMILY, COLLECTIVE_TOOL_FAMILY] as const;
/** The op dimension's JSON key + json_extract path on a tool_input payload. */
export const TOOL_OP_KEY = 'op';
export const TOOL_OP_JSON_PATH = `$.${TOOL_OP_KEY}`;

/**
 * Collapse an MCP-prefixed or legacy-doubled Myco tool name to its canonical
 * `myco_*` / `collective_*` form. Returns null when `name` is not a Myco tool
 * name at all (e.g. `Bash`), which is how the resolver distinguishes a direct
 * Myco tool call from a shell tool that merely *wraps* a CLI Myco call. Mirrors
 * the SQL `CANONICAL_TOOL_NAME_CASE` in `myco-tool-usage.ts`.
 */
function canonicalizeMycoToolName(name: string): string | null {
  let n = name;
  if (n.startsWith(MCP_TOOL_PREFIX + LEGACY_DOUBLED_PREFIX)) n = n.slice(MCP_TOOL_PREFIX.length + MYCO_TOOL_FAMILY.length);
  else if (n.startsWith(MCP_TOOL_PREFIX)) n = n.slice(MCP_TOOL_PREFIX.length);
  else if (n.startsWith(LEGACY_DOUBLED_PREFIX)) n = n.slice(MYCO_TOOL_FAMILY.length);
  return MYCO_TOOL_FAMILIES.some((family) => n.startsWith(family)) ? n : null;
}

/** Capture group matching a canonical Myco tool name, built from the families. */
const MYCO_TOOL_NAME_GROUP = MYCO_TOOL_FAMILIES.map((family) => `${family}[a-z_]+`).join('|');
/**
 * Recognizes Myco tool calls routed through the CLI rather than MCP. The myco
 * skill instructs agents to call tools via the project launcher
 * (`node .agents/myco-cli.cjs tool call <tool> --input '{"op":"…"}'`, also
 * `myco-run`, `dist/src/cli.js`, or a bare `myco` / `myco-dev`). Those execute
 * as the agent's shell tool, so the tool identity is embedded in the command.
 * We require a launcher token immediately before `tool call <name>` and
 * constrain `<name>` to the Myco families so prose can't false-match.
 */
const CLI_TOOL_CALL_RE = new RegExp(
  String.raw`(?:myco-cli\.cjs|myco-run(?:\.cjs)?|cli\.js|\bmyco(?:-dev)?)\s+tool\s+call\s+(${MYCO_TOOL_NAME_GROUP})`,
  'g',
);
/** Inline `--input '{"op":"…"}'` op extractor (keyed on the shared op key). */
const CLI_OP_RE = new RegExp(String.raw`"${TOOL_OP_KEY}"\s*:\s*"([^"]+)"`);
/** Shell separators that bound a single command segment (newline, `;`, `|`, `&`). */
const SHELL_SEPARATOR_RE = /[\n;|&]/;

/** Parse zero or more CLI-routed Myco tool calls out of one shell command. */
export function parseCliMycoToolCalls(command: string): Array<{ tool_name: string; op: string }> {
  const out: Array<{ tool_name: string; op: string }> = [];
  const matches = [...command.matchAll(CLI_TOOL_CALL_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const tool_name = m[1]!;
    const segStart = m.index! + m[0].length;
    let segEnd = i + 1 < matches.length ? matches[i + 1]!.index! : command.length;
    // Bound the op scan to THIS call's own command segment. Without this, an
    // op-less call (e.g. `--input @file`) followed by an unrelated command,
    // argument, or piped stage containing an `"op":"…"` JSON fragment would
    // mis-attribute that op to the call — most acutely the LAST call, whose
    // segment otherwise runs to the end of the whole command. Cut at the first
    // shell separator after the tool name; this call's inline `--input` carries
    // op before any such separator.
    const sepMatch = SHELL_SEPARATOR_RE.exec(command.slice(segStart, segEnd));
    if (sepMatch) segEnd = segStart + sepMatch.index;
    const opMatch = CLI_OP_RE.exec(command.slice(segStart, segEnd));
    out.push({ tool_name, op: opMatch ? opMatch[1]! : '' });
  }
  return out;
}

/**
 * Resolve the canonical Myco tool identity (tool + op) a raw activity
 * represents, regardless of entry point — the single source of truth
 * materialized onto `activities.myco_tool` / `myco_op` at the capture write
 * boundary.
 *
 *   - MCP / HTTP / agent-internal → the activity's own (canonicalized) tool name.
 *   - CLI → the FIRST Myco call parsed from the shell command. A single command
 *     can chain several Myco calls (~3% of CLI rows); the activity row carries
 *     the primary one for display, while the per-session count aggregate
 *     (`aggregateSessionMycoToolCalls`) parses the full command so the
 *     "Map calls" metric stays exact.
 *
 * Returns null for non-Myco activities (plain Bash, Read, …) and malformed JSON.
 */
export function resolveMycoToolIdentity(
  toolName: string | null | undefined,
  toolInput: string | null | undefined,
): { tool: string; op: string } | null {
  if (!toolName) return null;

  // 1) Direct Myco tool name (MCP-routed or bare).
  const canonical = canonicalizeMycoToolName(toolName);
  if (canonical) {
    let op = '';
    if (toolInput) {
      try {
        op = String((JSON.parse(toolInput) as Record<string, unknown>)?.[TOOL_OP_KEY] ?? '');
      } catch { /* op stays '' */ }
    }
    return { tool: canonical, op };
  }

  // 2) Shell tool wrapping a CLI Myco call — recover identity from the command.
  if (toolInput) {
    let command: unknown;
    try { command = (JSON.parse(toolInput) as { command?: unknown })?.command; } catch { return null; }
    if (typeof command === 'string') {
      const calls = parseCliMycoToolCalls(command);
      if (calls.length > 0) return { tool: calls[0]!.tool_name, op: calls[0]!.op };
    }
  }
  return null;
}
