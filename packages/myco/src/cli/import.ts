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
import { importUntilSettled, IMPORT_PACE_PER_MINUTE, type ImportOptions, type ImportReport } from '../member/import.js';
import { runLegacyImport, type LegacyImportReport } from '../member/legacy-import.js';
import { parseDirectoryMapping, type DirectoryMapping } from '../symbionts/transcript-attribution.js';
import type { FetchLike } from '../member/transport.js';

export const IMPORT_HELP = `Usage: myco import [options]

Bring this machine's existing agent transcripts to its Deployment. Runs once
automatically when you join; run it again with a wider window to reach further
back.

Options:
  --days <n>         How far back to look, in days (default: the Deployment's)
  --max <n>          Most sessions per agent (default: the Deployment's)
  --agent <name>     Only this agent's transcripts
  --project <id>     Only this project's
  --server <url>     Which Deployment, when this machine belongs to several
  --legacy <path>    Also bring a Myco 1.4 vault: its sessions, their titles,
                     prompts, plans, spores and spore history, each into the
                     project of the same id. <path> is a 1.4 home (~/.myco), a
                     grove directory, or a myco.db file; repeat for several.
                     The vault is read, never written.
  --map <dir>=<root> Import transcripts recorded in <dir> (or, with a trailing
                     *, in every sibling directory named like it) into the
                     project connected at <root>. For worktrees that no longer
                     exist; repeat for several.
  --dry-run          Report what would be imported, and import nothing
  --help             Show this message
`;

interface Parsed {
  error?: string;
  help?: true;
  options: ImportOptions;
  legacy?: string[];
}

const POSITIVE = /^[1-9][0-9]{0,6}$/;

export function parseArgs(args: readonly string[]): Parsed {
  const options: ImportOptions = {};
  const legacy: string[] = [];
  const mappings: DirectoryMapping[] = [];
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
      case '--legacy': {
        const raw = value();
        if (raw === undefined || raw.startsWith('--')) return { error: `${arg} needs a path`, options };
        legacy.push(raw);
        i += 1;
        break;
      }
      case '--map': {
        const raw = value();
        const mapping = raw === undefined ? null : parseDirectoryMapping(raw);
        if (mapping === null) return { error: `${arg} needs <dir>=<root>, both absolute`, options };
        mappings.push(mapping);
        i += 1;
        break;
      }
      default:
        return { error: `unknown option ${arg}`, options };
    }
  }
  if (mappings.length > 0) options.mappings = mappings;
  return legacy.length > 0 ? { options, legacy } : { options };
}

export interface ImportCliDeps {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
  vault_sourced: 'already brought from Myco 1.4',
  replaced: 'the file changed since it was written',
  window: 'older than this Deployment reaches back',
  cap: 'past the per-agent limit',
  quota: 'refused for the Deployment\'s storage quota; update the Deployment',
};

/** What a person is told about a pass that stopped early, in the same vocabulary. */
const STOPPED_WORDS: Readonly<Record<string, string>> = {
  parked: 'the Deployment refused it for its storage quota; update the Deployment',
  unauthorized: 'this machine is not signed in to that Deployment',
  route_missing: 'that Deployment does not offer import',
  protocol: 'that Deployment expects a different version of Myco',
  retry: 'the Deployment could not be reached',
  refused: 'the Deployment refused the write',
  unreachable: 'the Deployment could not be reached for too long; nothing after that was attempted',
  failed: 'a step failed (above); nothing after it was attempted',
};

const skipWords = (reason: string, n: number): string => `${n} ${SKIP_WORDS[reason] ?? 'skipped'}`;

/** The unbound directories a report names, busiest first. */
const UNBOUND_DIRECTORIES_SHOWN = 20;

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
  if (report.dropped > 0) lines.push(`${report.dropped} transcripts are sub-agent or automation runs that capture leaves out, and were left out here too.`);
  if (report.excluded > 0) lines.push(`${report.excluded} transcripts belong to sessions deleted in Myco 1.4 and were left out.`);
  if (report.unbound > 0) {
    lines.push(`${report.unbound} transcripts belong to projects this Deployment does not hold:`);
    const dirs = Object.entries(report.unboundDirectories).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [dir, n] of dirs.slice(0, UNBOUND_DIRECTORIES_SHOWN)) lines.push(`  ${n} in ${dir}`);
    if (dirs.length > UNBOUND_DIRECTORIES_SHOWN) lines.push(`  and ${dirs.length - UNBOUND_DIRECTORIES_SHOWN} more directories`);
  }
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

  const machineId = deps.machineId ?? getMachineId();
  const dryRun = parsed.options.dryRun === true;
  let exclude: ReadonlySet<string> | undefined;
  let legacyComplete = true;
  if (parsed.legacy !== undefined) {
    const legacy = await runLegacyImport(
      { sources: parsed.legacy, serverUrl: parsed.options.serverUrl, dryRun, project: parsed.options.project },
      { fetch: deps.fetch, now: deps.now, mycoHome: deps.mycoHome, machineId, sleep: deps.sleep, pace: IMPORT_PACE_PER_MINUTE, progress: (l) => err(`myco import: ${l}`) },
    );
    if (legacy.refused !== undefined) { err(`myco import: ${legacy.refused}`); return false; }
    for (const line of legacyReportLines(legacy, dryRun)) out(line);
    legacyComplete = legacyImportComplete(legacy);
    exclude = new Set(legacy.deleted);
  }

  const report = await importUntilSettled({ ...parsed.options, ...(exclude === undefined ? {} : { exclude }) }, {
    fetch: deps.fetch, now: deps.now, cwd: deps.cwd, mycoHome: deps.mycoHome, machineId, sleep: deps.sleep, pace: IMPORT_PACE_PER_MINUTE,
    onRetry: (attempt, waitMs) => err(`myco import: the Deployment asked to wait; pass ${attempt + 1} in ${Math.round(waitMs / 1000)} s`),
  });
  if (report.refused !== undefined) { err(`myco import: ${report.refused}`); return false; }
  for (const line of reportLines(report, dryRun)) out(line);
  return legacyComplete && transcriptImportComplete(report);
}

/**
 * Whether a 1.4 vault import finished with nothing refused, failed, stopped
 * short, or deleted in 1.4 yet already on the Deployment.
 */
export const legacyImportComplete = (report: LegacyImportReport): boolean =>
  report.projects.every((p) => p.endedBy === undefined && p.refusals.length === 0 && p.failures.length === 0 && p.deletedButHeld.length === 0);

/** Whether a transcript import finished every Project it started, with nothing refused. */
export const transcriptImportComplete = (report: ImportReport): boolean =>
  report.refused === undefined && report.projects.every((p) => p.endedBy === undefined);

/** What a 1.4 vault import came to, per project, in the order a person reads it. */
export function legacyReportLines(report: LegacyImportReport, dryRun: boolean): string[] {
  const lines: string[] = [];
  for (const p of report.projects) {
    lines.push(`${p.projectId} (${p.root ?? 'no project root recorded'}) from 1.4: ${p.vault.sessions} sessions, ${p.vault.prompts} prompts, ${p.vault.plans} plans, ${p.vault.spores} spores, ${p.vault.lineage} spore history events`);
    if (dryRun) {
      lines.push(`  would bring ${p.sessions.distinct} sessions (${p.sessions.deleted} deleted in 1.4 left out, unless the Deployment already holds them)`);
      if (p.unmatchedDeletes.length > 0) lines.push(`  ${p.unmatchedDeletes.length} sessions deleted in 1.4 could not be matched to a transcript: ${p.unmatchedDeletes.join(', ')}`);
      for (const [machine, n] of Object.entries(p.otherMachines)) lines.push(`  would leave ${n} sessions captured on ${machine} to that machine`);
      for (const alias of p.aliases) lines.push(`  matched by time: ${alias}`);
      for (const stored of p.unaliased) lines.push(`  no transcript matched: ${stored}`);
      if (p.lineage.malformed > 0) lines.push(`  would skip ${p.lineage.malformed} spore history events in a shape no Deployment takes`);
      continue;
    }
    const s = p.sessions;
    lines.push(`  sessions: ${s.distinct} distinct, ${s.deleted} deleted; ${s.transcriptsShipped} transcripts sent, ${s.transcriptsHeld} already here, ${s.fromVault} from the vault; ${s.alreadyHeld} were already here and kept what was captured; ${s.resumed} finished by an earlier run`);
    if (p.sessions.deleted > 0) lines.push(`  ${p.sessions.deleted} sessions deleted in 1.4 were left out, from the vault and from your agents' transcripts`);
    if (p.deletedButHeld.length > 0) lines.push(`  ${p.deletedButHeld.length} sessions deleted in 1.4 are already on the Deployment; delete them from the dashboard: ${p.deletedButHeld.join(', ')}`);
    if (p.stillWriting.length > 0) lines.push(`  ${p.stillWriting.length} sessions are still being written; run the import again later to bring them: ${p.stillWriting.join(', ')}`);
    if (p.unmatchedDeletes.length > 0) lines.push(`  ${p.unmatchedDeletes.length} sessions deleted in 1.4 could not be matched to a transcript; delete them from the dashboard if they reappear: ${p.unmatchedDeletes.join(', ')}`);
    for (const [machine, n] of Object.entries(p.otherMachines)) lines.push(`  ${n} sessions were captured on ${machine}, not this machine; run \`myco import --legacy <this vault>\` on ${machine} to bring them`);
    lines.push(`  sent ${p.prompts} prompts, ${p.responses} responses, ${p.plans.sent} plans (${p.plans.empty} empty, ${p.plans.unsent} of deleted or unknown sessions)`);
    lines.push(`  spores: ${p.spores.saved} saved, ${p.spores.duplicate} already here, ${p.spores.refused} refused; history: ${p.lineage.recorded} recorded, ${p.lineage.duplicate} already here, ${p.lineage.refused} refused`);
    for (const alias of p.aliases) lines.push(`  matched by time: ${alias}`);
    for (const stored of p.unaliased) lines.push(`  no transcript matched, imported under its 1.4 id: ${stored}`);
    for (const malformed of p.malformed) lines.push(`  skipped ${malformed}`);
    for (const refusal of p.refusals) lines.push(`  refused ${refusal}`);
    for (const failure of p.failures) lines.push(`  failed ${failure}; run the import again to retry it`);
    if (p.endedBy !== undefined) lines.push(`  stopped — ${STOPPED_WORDS[p.endedBy] ?? 'the Deployment could not be reached'}`);
    if (p.notAttempted !== undefined) lines.push(`  not attempted: ${p.notAttempted.sessions} sessions, ${p.notAttempted.spores} spores, ${p.notAttempted.lineage} spore history events; run the import again to bring them`);
  }
  if (report.projects.length === 0) lines.push('The 1.4 vault holds nothing to import.');
  return lines;
}
