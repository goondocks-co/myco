#!/usr/bin/env bun
/**
 * One-way OAK → Myco migration.
 *
 * Reads either a live OAK SQLite database (`<project>/.oak/ci/activities.db`)
 * or a SQL backup file from `<project>/oak/history/*.sql`, and seeds a Myco
 * vault DB with sessions, prompt batches, and tool-call activities. Imported
 * rows are flagged unprocessed so Vault Evolve regenerates Myco-quality spores.
 *
 * See: docs/migrating-from-oak.md (user guide)
 *      Myco plan: migrate-from-oak-to-myco-implementation
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ----- supported OAK schema -----
const SUPPORTED_OAK_SCHEMA_VERSIONS = new Set([6, 7, 8, 9, 10]);

/**
 * Schemas embedded for SQL backup restore. OAK backup files contain INSERT
 * statements only — no CREATE TABLE — so we materialize the temp DB with the
 * v10 OAK schema (a superset of older versions for the columns we read).
 * FK constraints are intentionally omitted from the temp DB so backup row order
 * doesn't matter; we don't query orphan integrity from the temp DB anyway.
 */
const OAK_SCHEMA_FOR_RESTORE = `
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  project_root TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  status TEXT,
  prompt_count INTEGER,
  tool_count INTEGER,
  processed INTEGER,
  summary TEXT,
  title TEXT,
  created_at_epoch INTEGER,
  parent_session_id TEXT,
  parent_session_reason TEXT,
  source_machine_id TEXT,
  transcript_path TEXT,
  title_manually_edited INTEGER,
  summary_updated_at INTEGER,
  summary_embedded INTEGER
);
CREATE TABLE prompt_batches (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  prompt_number INTEGER,
  user_prompt TEXT,
  started_at TEXT,
  ended_at TEXT,
  status TEXT,
  activity_count INTEGER,
  processed INTEGER,
  classification TEXT,
  source_type TEXT,
  plan_file_path TEXT,
  plan_content TEXT,
  plan_embedded INTEGER,
  created_at_epoch INTEGER,
  content_hash TEXT,
  source_plan_batch_id INTEGER,
  source_machine_id TEXT,
  response_summary TEXT
);
CREATE TABLE activities (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  prompt_batch_id INTEGER,
  tool_name TEXT,
  tool_input TEXT,
  tool_output_summary TEXT,
  file_path TEXT,
  files_affected TEXT,
  duration_ms INTEGER,
  success INTEGER,
  error_message TEXT,
  timestamp TEXT,
  timestamp_epoch INTEGER,
  processed INTEGER,
  observation_id TEXT,
  content_hash TEXT,
  source_machine_id TEXT
);
CREATE TABLE memory_observations (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  prompt_batch_id INTEGER,
  observation TEXT,
  memory_type TEXT,
  context TEXT,
  tags TEXT,
  importance INTEGER,
  file_path TEXT,
  created_at TEXT,
  created_at_epoch INTEGER,
  embedded INTEGER,
  content_hash TEXT,
  source_machine_id TEXT,
  status TEXT,
  resolved_by_session_id TEXT,
  resolved_at TEXT,
  superseded_by TEXT,
  session_origin_type TEXT,
  origin_type TEXT
);
CREATE TABLE agent_schedules (
  task_name TEXT PRIMARY KEY,
  enabled INTEGER,
  cron_expression TEXT,
  description TEXT,
  trigger_type TEXT,
  last_run_at TEXT,
  last_run_at_epoch INTEGER,
  last_run_id TEXT,
  next_run_at TEXT,
  next_run_at_epoch INTEGER,
  created_at TEXT,
  created_at_epoch INTEGER,
  updated_at TEXT,
  updated_at_epoch INTEGER,
  source_machine_id TEXT,
  additional_prompt TEXT
);
CREATE TABLE resolution_events (
  id TEXT PRIMARY KEY,
  observation_id TEXT,
  action TEXT,
  resolved_by_session_id TEXT,
  superseded_by TEXT,
  reason TEXT,
  created_at TEXT,
  created_at_epoch INTEGER,
  source_machine_id TEXT,
  content_hash TEXT,
  applied INTEGER
);
CREATE TABLE governance_audit_events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  event_type TEXT,
  details TEXT,
  created_at TEXT,
  created_at_epoch INTEGER,
  source_machine_id TEXT
);
`;

// ----- agent translation -----
const AGENT_TRANSLATIONS: Record<string, string> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  cursor: "cursor",
  windsurf: "windsurf",
  codex: "codex-cli",
  "codex-cli": "codex-cli",
  "gpt-5.2-codex": "codex-cli",
  opencode: "opencode",
  gemini: "gemini-cli",
  "gemini-cli": "gemini-cli",
  "vscode-copilot": "vscode-copilot",
};

// ----- prompt-batch source_type → kind -----
const KIND_FROM_SOURCE_TYPE: Record<string, "initial" | "steering"> = {
  user: "initial",
  plan: "initial",
  derived_plan: "initial",
  system: "steering",
  agent_notification: "steering",
};

type Args = {
  source?: string;
  backup?: string;
  target?: string;
  dryRun: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--source":
        args.source = argv[++i];
        break;
      case "--backup":
        args.backup = argv[++i];
        break;
      case "--target":
        args.target = argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

const HELP = `
Usage: bun scripts/migrate-from-oak-to-myco.ts [options]

  --target <path>   Path to Myco vault DB (.myco/myco.db). Required.
  --source <path>   Path to live OAK SQLite DB (.oak/ci/activities.db).
  --backup <path>   Path to OAK SQL backup file (oak/history/*.sql).
  --dry-run         Read source, report row counts, write nothing.
  -h, --help        Show this help.

If neither --source nor --backup is given, the script auto-detects:
  1. <target-project>/.oak/ci/activities.db
  2. Most recent *.sql under <target-project>/oak/history/
`.trim();

type ResolvedSource = {
  kind: "live" | "backup";
  originalPath: string;
  dbPath: string;
  cleanup: () => void;
};

function projectRootFromTarget(targetDb: string): string {
  // .myco/myco.db → project root is two dirs up
  return dirname(dirname(resolve(targetDb)));
}

function resolveSource(args: Args): ResolvedSource {
  if (args.source && args.backup) {
    throw new Error("Pass --source or --backup, not both.");
  }
  if (args.source) {
    if (!existsSync(args.source)) throw new Error(`--source not found: ${args.source}`);
    return liveSource(args.source);
  }
  if (args.backup) {
    if (!existsSync(args.backup)) throw new Error(`--backup not found: ${args.backup}`);
    return backupSource(args.backup);
  }
  if (!args.target) throw new Error("--target is required for auto source resolution");
  const projectRoot = projectRootFromTarget(args.target);
  const liveDb = join(projectRoot, ".oak", "ci", "activities.db");
  if (existsSync(liveDb)) return liveSource(liveDb);

  const historyDir = join(projectRoot, "oak", "history");
  if (existsSync(historyDir)) {
    const files = readdirSync(historyDir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => join(historyDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (files.length > 0) return backupSource(files[0]);
  }
  throw new Error(
    `No OAK source found. Looked for ${liveDb} and ${historyDir}/*.sql. Pass --source or --backup explicitly.`,
  );
}

function liveSource(path: string): ResolvedSource {
  return {
    kind: "live",
    originalPath: resolve(path),
    dbPath: resolve(path),
    cleanup: () => {},
  };
}

function backupSource(path: string): ResolvedSource {
  const tmpDir = mkdtempSync(join(tmpdir(), "oak-migrate-"));
  const tmpDb = join(tmpDir, "restored.db");
  const sql = readFileSync(path, "utf-8");

  // OAK backup files are INSERT-only — pre-create the schema before sourcing.
  const versionMatch = sql.match(/^--\s*Schema version:\s*(\d+)/m);
  const detectedVersion = versionMatch ? Number(versionMatch[1]) : 0;

  const setup =
    OAK_SCHEMA_FOR_RESTORE +
    (detectedVersion > 0
      ? `\nINSERT INTO schema_version (version) VALUES (${detectedVersion});\n`
      : "");

  const combined = setup + "\n" + sql;
  const proc = Bun.spawnSync({
    cmd: ["sqlite3", tmpDb],
    stdin: Buffer.from(combined),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    rmSync(tmpDir, { recursive: true, force: true });
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "unknown error";
    if (stderr.includes("not found") || stderr.includes("No such file")) {
      throw new Error("`sqlite3` CLI not found on PATH; required for SQL backup restore.");
    }
    throw new Error(`Failed to restore SQL backup: ${stderr}`);
  }
  return {
    kind: "backup",
    originalPath: resolve(path),
    dbPath: tmpDb,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function sha256(...parts: (string | number | null | undefined)[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(String(p ?? ""));
  return h.digest("hex");
}

function parseIsoToEpochSec(s: string | null | undefined): number | null {
  if (!s) return null;
  const withTz = /[Zz]|[+-]\d{2}:\d{2}$/.test(s) ? s : s + "Z";
  const ms = Date.parse(withTz);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

function translateAgent(oakAgent: string, unmapped: Set<string>): string {
  const mapped = AGENT_TRANSLATIONS[oakAgent];
  if (mapped) return mapped;
  unmapped.add(oakAgent);
  return oakAgent;
}

function mapKind(sourceType: string | null | undefined): "initial" | "steering" {
  if (!sourceType) return "initial";
  return KIND_FROM_SOURCE_TYPE[sourceType] ?? "initial";
}

type LogEntry = {
  started_at: string;
  completed_at: string;
  source_kind: "live" | "backup";
  source_path: string;
  target_db: string;
  oak_schema_version: number;
  dry_run: boolean;
  row_counts: Record<string, number>;
  agent_translations: Record<string, string>;
  unmapped_agents: string[];
  warnings: string[];
  errors: string[];
};

function appendLog(targetDb: string, entry: LogEntry): string {
  const logPath = join(dirname(targetDb), "oak_import_log.json");
  let existing: LogEntry[] = [];
  if (existsSync(logPath)) {
    try {
      const parsed = JSON.parse(readFileSync(logPath, "utf-8"));
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      existing = [];
    }
  }
  existing.push(entry);
  writeFileSync(logPath, JSON.stringify(existing, null, 2));
  return logPath;
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!args.target) throw new Error("--target is required. Pass -h for usage.");
  const targetDb = resolve(args.target);
  if (!existsSync(targetDb)) throw new Error(`Target DB not found: ${targetDb}`);

  const source = resolveSource(args);
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  const errors: string[] = [];
  const unmappedAgents = new Set<string>();
  const agentTranslations: Record<string, string> = {};

  console.log(
    `Source: ${source.kind} @ ${source.originalPath}\nTarget: ${targetDb}\nDry run: ${args.dryRun}\n`,
  );

  let oakDb: Database | null = null;
  let mycoDb: Database | null = null;
  const counts = {
    sessions_in: 0,
    sessions_inserted: 0,
    prompt_batches_in: 0,
    prompt_batches_inserted: 0,
    activities_in: 0,
    activities_inserted: 0,
  };
  let oakSchemaVersion = 0;

  try {
    oakDb = new Database(source.dbPath, { readonly: true });
    mycoDb = new Database(targetDb);
    mycoDb.exec("PRAGMA busy_timeout = 30000");
    mycoDb.exec("PRAGMA foreign_keys = ON");

    const sv = oakDb
      .query("SELECT version FROM schema_version LIMIT 1")
      .get() as { version: number } | null;
    oakSchemaVersion = sv?.version ?? 0;
    if (!SUPPORTED_OAK_SCHEMA_VERSIONS.has(oakSchemaVersion)) {
      warnings.push(
        `OAK schema_version ${oakSchemaVersion} not in supported set ${[...SUPPORTED_OAK_SCHEMA_VERSIONS].join(", ")}. Proceeding anyway.`,
      );
    }

    const agentRows = oakDb
      .query("SELECT DISTINCT agent FROM sessions WHERE agent IS NOT NULL")
      .all() as { agent: string }[];
    for (const { agent } of agentRows) {
      const mapped = AGENT_TRANSLATIONS[agent];
      if (mapped) agentTranslations[agent] = mapped;
      else unmappedAgents.add(agent);
    }
    if (unmappedAgents.size > 0) {
      warnings.push(
        `Unmapped OAK agent values (passed through verbatim): ${[...unmappedAgents].join(", ")}`,
      );
    }

    counts.sessions_in = (
      oakDb.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }
    ).n;
    counts.prompt_batches_in = (
      oakDb.query("SELECT COUNT(*) AS n FROM prompt_batches").get() as { n: number }
    ).n;
    counts.activities_in = (
      oakDb.query("SELECT COUNT(*) AS n FROM activities").get() as { n: number }
    ).n;

    if (args.dryRun) {
      // Skip the import block; finally writes the log and prints summary.
      return;
    }

    mycoDb.exec("BEGIN IMMEDIATE");
    try {
      const insertSession = mycoDb.prepare(`
        INSERT OR IGNORE INTO sessions (
          id, agent, project_root, branch, "user",
          started_at, ended_at, status, prompt_count, tool_count,
          title, summary, transcript_path,
          parent_session_id, parent_session_reason,
          processed, embedded, content_hash, created_at, machine_id
        ) VALUES (
          $id, $agent, $project_root, NULL, NULL,
          $started_at, $ended_at, $status, $prompt_count, $tool_count,
          $title, $summary, $transcript_path,
          $parent_session_id, $parent_session_reason,
          0, 0, $content_hash, $created_at, $machine_id
        )
      `);

      const oakSessions = oakDb
        .query(
          `SELECT id, agent, project_root, status, prompt_count, tool_count,
                  title, summary, transcript_path,
                  parent_session_id, parent_session_reason,
                  source_machine_id,
                  created_at_epoch, ended_at
           FROM sessions`,
        )
        .all() as Array<{
          id: string;
          agent: string;
          project_root: string;
          status: string | null;
          prompt_count: number | null;
          tool_count: number | null;
          title: string | null;
          summary: string | null;
          transcript_path: string | null;
          parent_session_id: string | null;
          parent_session_reason: string | null;
          source_machine_id: string | null;
          created_at_epoch: number;
          ended_at: string | null;
        }>;

      for (const row of oakSessions) {
        const result = insertSession.run({
          $id: row.id,
          $agent: translateAgent(row.agent, unmappedAgents),
          $project_root: row.project_root,
          $started_at: row.created_at_epoch,
          $ended_at: parseIsoToEpochSec(row.ended_at),
          $status: row.status ?? "completed",
          $prompt_count: row.prompt_count ?? 0,
          $tool_count: row.tool_count ?? 0,
          $title: row.title,
          $summary: row.summary,
          $transcript_path: row.transcript_path,
          $parent_session_id: row.parent_session_id,
          $parent_session_reason: row.parent_session_reason,
          $content_hash: sha256("oak-session", row.id),
          $created_at: row.created_at_epoch,
          $machine_id: row.source_machine_id ?? "local",
        });
        if (result.changes > 0) counts.sessions_inserted++;
      }

      const insertPb = mycoDb.prepare(`
        INSERT OR IGNORE INTO prompt_batches (
          session_id, prompt_number, user_prompt, response_summary,
          classification, started_at, ended_at, status, activity_count,
          processed, content_hash, created_at, machine_id, kind, parent_prompt_batch_id
        ) VALUES (
          $session_id, $prompt_number, $user_prompt, $response_summary,
          $classification, $started_at, $ended_at, $status, $activity_count,
          0, $content_hash, $created_at, $machine_id, $kind, NULL
        )
      `);
      const findPb = mycoDb.prepare(
        `SELECT id FROM prompt_batches WHERE session_id = $sid AND prompt_number = $n`,
      );
      const updatePbParent = mycoDb.prepare(
        `UPDATE prompt_batches SET parent_prompt_batch_id = $parent WHERE id = $id`,
      );

      const oakPbs = oakDb
        .query(
          `SELECT id, session_id, prompt_number, user_prompt, response_summary,
                  classification, started_at, ended_at, status, activity_count,
                  source_type, source_machine_id, source_plan_batch_id,
                  created_at_epoch
           FROM prompt_batches
           ORDER BY id`,
        )
        .all() as Array<{
          id: number;
          session_id: string;
          prompt_number: number | null;
          user_prompt: string | null;
          response_summary: string | null;
          classification: string | null;
          started_at: string | null;
          ended_at: string | null;
          status: string | null;
          activity_count: number | null;
          source_type: string | null;
          source_machine_id: string | null;
          source_plan_batch_id: number | null;
          created_at_epoch: number;
        }>;

      const pbIdMap = new Map<number, number>();
      for (const row of oakPbs) {
        const result = insertPb.run({
          $session_id: row.session_id,
          $prompt_number: row.prompt_number,
          $user_prompt: row.user_prompt,
          $response_summary: row.response_summary,
          $classification: row.classification,
          $started_at: parseIsoToEpochSec(row.started_at),
          $ended_at: parseIsoToEpochSec(row.ended_at),
          $status: row.status ?? "completed",
          $activity_count: row.activity_count ?? 0,
          $content_hash: sha256("oak-pb", row.session_id, row.id),
          $created_at: row.created_at_epoch,
          $machine_id: row.source_machine_id ?? "local",
          $kind: mapKind(row.source_type),
        });
        if (result.changes > 0) counts.prompt_batches_inserted++;

        const found = findPb.get({
          $sid: row.session_id,
          $n: row.prompt_number,
        }) as { id: number } | null;
        if (found) pbIdMap.set(row.id, found.id);
      }

      for (const row of oakPbs) {
        if (!row.source_plan_batch_id) continue;
        const childMyco = pbIdMap.get(row.id);
        const parentMyco = pbIdMap.get(row.source_plan_batch_id);
        if (childMyco && parentMyco) {
          updatePbParent.run({ $id: childMyco, $parent: parentMyco });
        }
      }

      const insertActivity = mycoDb.prepare(`
        INSERT OR IGNORE INTO activities (
          session_id, prompt_batch_id, tool_name, tool_input,
          tool_output_summary, file_path, files_affected,
          duration_ms, success, error_message,
          timestamp, processed, content_hash, created_at
        ) VALUES (
          $session_id, $prompt_batch_id, $tool_name, $tool_input,
          $tool_output_summary, $file_path, $files_affected,
          $duration_ms, $success, $error_message,
          $timestamp, 0, $content_hash, $created_at
        )
      `);

      const oakActivities = oakDb.query(
        `SELECT id, session_id, prompt_batch_id, tool_name, tool_input,
                tool_output_summary, file_path, files_affected,
                duration_ms, success, error_message,
                timestamp_epoch, content_hash
         FROM activities`,
      );

      for (const row of oakActivities.iterate() as IterableIterator<{
        id: number;
        session_id: string;
        prompt_batch_id: number | null;
        tool_name: string;
        tool_input: string | null;
        tool_output_summary: string | null;
        file_path: string | null;
        files_affected: string | null;
        duration_ms: number | null;
        success: number | null;
        error_message: string | null;
        timestamp_epoch: number;
        content_hash: string | null;
      }>) {
        const mappedPb = row.prompt_batch_id ? pbIdMap.get(row.prompt_batch_id) ?? null : null;
        // Compute our own hash; OAK's content_hash is non-unique within a single DB
        // (it's a cross-machine dedup hash, not a row identity). Anchor on OAK's
        // autoinc id which is guaranteed unique in the source.
        const hash = sha256("oak-activity", row.session_id, row.id);
        const result = insertActivity.run({
          $session_id: row.session_id,
          $prompt_batch_id: mappedPb,
          $tool_name: row.tool_name,
          $tool_input: row.tool_input,
          $tool_output_summary: row.tool_output_summary,
          $file_path: row.file_path,
          $files_affected: row.files_affected,
          $duration_ms: row.duration_ms,
          $success: row.success ?? 1,
          $error_message: row.error_message,
          $timestamp: row.timestamp_epoch,
          $content_hash: hash,
          $created_at: row.timestamp_epoch,
        });
        if (result.changes > 0) counts.activities_inserted++;
      }

      mycoDb.exec("COMMIT");
    } catch (e) {
      mycoDb.exec("ROLLBACK");
      throw e;
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    oakDb?.close();
    mycoDb?.close();
    source.cleanup();

    const completedAt = new Date().toISOString();
    const logPath = appendLog(targetDb, {
      started_at: startedAt,
      completed_at: completedAt,
      source_kind: source.kind,
      source_path: source.originalPath,
      target_db: targetDb,
      oak_schema_version: oakSchemaVersion,
      dry_run: args.dryRun,
      row_counts: counts,
      agent_translations: agentTranslations,
      unmapped_agents: [...unmappedAgents],
      warnings,
      errors,
    });
    console.log("");
    if (args.dryRun) {
      console.log("Row counts (dry run, no writes):");
      console.log(`  sessions:       ${counts.sessions_in}`);
      console.log(`  prompt_batches: ${counts.prompt_batches_in}`);
      console.log(`  activities:     ${counts.activities_in}`);
    } else {
      console.log("Row counts (read → inserted):");
      console.log(`  sessions:       ${counts.sessions_in} → ${counts.sessions_inserted}`);
      console.log(`  prompt_batches: ${counts.prompt_batches_in} → ${counts.prompt_batches_inserted}`);
      console.log(`  activities:     ${counts.activities_in} → ${counts.activities_inserted}`);
    }
    if (warnings.length) {
      console.log("\nWarnings:");
      for (const w of warnings) console.log(`  - ${w}`);
    }
    console.log(`\nLog: ${logPath}`);
  }
}

main().catch((e) => {
  console.error("\nMigration failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
