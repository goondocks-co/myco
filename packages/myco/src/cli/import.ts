/**
 * `myco import` — bring this machine's existing agent history to its Deployment.
 *
 * The same pass runs once automatically when a machine joins. This is the
 * repeatable form, and the reason it exists is that the automatic bound is
 * deliberately narrow: a harness keeps its transcripts for weeks, so the
 * default window is close to the floor on some of them, and a machine whose
 * archive survived longer has history the join-time pass will not reach.
 *
 * What it reports is measured rather than declared: per agent, how many
 * transcripts were found on disk and how many were imported, plus what could
 * not be placed. A store that holds three sessions and a store that was pruned
 * to three both report three found, which is the truth in each case.
 */
import { getMachineId } from '../machine-id.js';
import { runImport, type ImportOptions, type ImportReport } from '../member/import.js';
import type { FetchLike } from '../member/transport.js';

export const IMPORT_HELP = `Usage: myco import [options]

Bring this machine's existing agent transcripts to its Deployment. Runs once
automatically when you join; run it again with a wider window to reach further
back.

Options:
  --days <n>       How far back to look, in days (default: the Deployment's)
  --max <n>        Most sessions per agent (default: the Deployment's)
  --agent <name>   Only this agent's transcripts
  --project <id>   Only this project's
  --server <url>   Which Deployment, when this machine belongs to several
  --dry-run        Report what would be imported, and import nothing
  --help           Show this message
`;

interface Parsed {
  error?: string;
  help?: true;
  options: ImportOptions;
}

const POSITIVE = /^[1-9][0-9]{0,6}$/;

export function parseArgs(args: readonly string[]): Parsed {
  const options: ImportOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = (): string | undefined => args[i + 1];
    switch (arg) {
      case '--help': case '-h':
        return { help: true, options };
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--days': case '--max': {
        const raw = value();
        if (raw === undefined || !POSITIVE.test(raw)) return { error: `${arg} needs a whole number of at least 1`, options };
        if (arg === '--days') options.windowDays = Number(raw); else options.maxPerAgent = Number(raw);
        i += 1;
        break;
      }
      case '--agent': case '--project': case '--server': {
        const raw = value();
        // The value is never echoed back: a mistyped flag should not print
        // whatever followed it into a shell history or a log.
        if (raw === undefined || raw.startsWith('--')) return { error: `${arg} needs a value`, options };
        if (arg === '--agent') options.agent = raw;
        else if (arg === '--project') options.project = raw;
        else options.serverUrl = raw;
        i += 1;
        break;
      }
      default:
        return { error: `unknown option ${arg}`, options };
    }
  }
  return { options };
}

export interface ImportCliDeps {
  fetch?: FetchLike;
  now?: () => number;
  cwd?: string;
  mycoHome?: string;
  machineId?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/**
 * What a person is told about each transcript that was not imported.
 *
 * The Deployment answers stable names, which are the right shape for a wire
 * and the wrong one for a screen: "session_held" and "cap" describe the rule
 * that fired rather than what happened to the person's history. An unmapped
 * name is deliberately not printed raw — it is counted as skipped, so a new
 * reason added on the server reads as vague rather than as jargon until
 * somebody gives it words.
 */
const SKIP_WORDS: Readonly<Record<string, string>> = {
  held: 'already here',
  session_held: 'already here under another name',
  tombstoned: 'deleted from this Deployment',
  replaced: 'the file changed since it was written',
  window: 'older than this Deployment reaches back',
  cap: 'past the per-agent limit',
  quota: 'no storage room left',
};

/** What a person is told about a pass that stopped early, in the same vocabulary. */
const STOPPED_WORDS: Readonly<Record<string, string>> = {
  parked: 'the Deployment has no storage room left',
  unauthorized: 'this machine is not signed in to that Deployment',
  route_missing: 'that Deployment does not offer import',
  protocol: 'that Deployment expects a different version of Myco',
  retry: 'the Deployment could not be reached',
  refused: 'the Deployment refused the write',
};

const skipWords = (reason: string, n: number): string => `${n} ${SKIP_WORDS[reason] ?? 'skipped'}`;

/** Every line the report is worth printing as, in the order a person reads them. */
export function reportLines(report: ImportReport, dryRun: boolean): string[] {
  const lines: string[] = [];
  const verb = dryRun ? 'would import' : 'imported';
  for (const project of report.projects) {
    lines.push(`${project.projectId} (${project.root})`);
    for (const agent of project.agents) {
      const notes = Object.entries(agent.skipped).map(([reason, n]) => skipWords(reason, n));
      if (agent.vanished > 0) notes.push(`${agent.vanished} removed before they could be sent`);
      if (agent.trimmed > 0) notes.push(`${agent.trimmed} past the offer limit`);
      lines.push(`  ${agent.agent}: ${agent.found} found, ${agent.imported} ${verb}${notes.length === 0 ? '' : ` (${notes.join(', ')})`}`);
    }
    if (project.endedBy !== undefined) lines.push(`  stopped — ${STOPPED_WORDS[project.endedBy] ?? 'the Deployment could not be reached'}`);
  }
  if (report.active > 0) lines.push(`${report.active} transcripts are still being written and were left to the agent writing them.`);
  if (report.unattributable > 0) lines.push(`${report.unattributable} transcripts name no project and were left alone.`);
  if (report.unbound > 0) lines.push(`${report.unbound} transcripts belong to projects this Deployment does not hold.`);
  if (report.narrowed !== undefined) lines.push(`Skipped by --project: ${report.narrowed.join(', ')}.`);
  if (lines.length === 0) lines.push('Nothing to import.');
  return lines;
}

/**
 * Run the import and report it.
 *
 * The outcome is RETURNED, never written to `process.exitCode` here: a verb
 * that stamps the process it runs in cannot be called twice in one process, and
 * `cli.ts` is the one place that knows this invocation is the whole purpose.
 */
export async function run(args: readonly string[], deps: ImportCliDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));

  const parsed = parseArgs(args);
  if (parsed.error !== undefined) { err(`myco import: ${parsed.error}`); return false; }
  if (parsed.help === true) { out(IMPORT_HELP.trimEnd()); return true; }

  const report = await runImport(parsed.options, {
    fetch: deps.fetch, now: deps.now, cwd: deps.cwd, mycoHome: deps.mycoHome,
    machineId: deps.machineId ?? getMachineId(),
  });
  if (report.refused !== undefined) { err(`myco import: ${report.refused}`); return false; }
  for (const line of reportLines(report, parsed.options.dryRun === true)) out(line);
  return true;
}
