/**
 * Which agent, profile and login a worker's offer resolves a task to, as a
 * claim decides it.
 *
 * The claim (`harness.ts`) and the preview of a start by hand
 * (`read/task-start.ts`) both select through here, so they can never disagree
 * about the agent or the model. The selection never opens a stored login
 * itself: the caller hands it the step that checks one. The claim's step opens
 * the agent's slot to hand the run its key; the preview's only asks whether a
 * usable one is stored. Nothing this module imports reaches the secret store,
 * which `tests/meta/read-layer-credential-blind.test.ts` holds for every read.
 */
import { capabilitiesRequiredBy, REPOSITORY_TASKS } from '@goondocks/myco-shared/repository';
import { CAPABILITY_HOLDS, credentialUnavailable, profileUnsupported, sourceReadUnavailable } from '@goondocks/myco-shared/run-holds';
import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';
import { PROFILE_HARNESSES, HARNESS_ASKING, canReadSource, type ExecutionProfile, type ProfileCapability } from '@goondocks/myco-shared/execution-profile';
import type { SecretSlotName } from '@goondocks/myco-shared/secret-slots';
import type { ServerEnv } from './adapters.js';
import { PROFILE_SETTING_LEAVES, profileSetting, resolveExecutionProfile, taskOverride, taskTierRefusal } from './execution-profile.js';
import { enabledCapabilities, settingTexts, type ProjectCapability } from './settings.js';
import { admissionForTask } from './task-catalogue.js';

/**
 * The tasks the launch seam serves, which a worker cannot.
 *
 * One declares no tool: its whole surface is a server-side step loop over a
 * run route — `/runs/embedding-step` — rather than the MCP surface a worker's
 * harness speaks. The other is the containerized runtime's own end-to-end
 * proof, so serving it anywhere else would leave the path it exists to
 * exercise untested.
 *
 * These two are why the seam survives, and both retire with it.
 */
export const RUNTIME_SERVED_TASKS: readonly string[] = ['embedding-reconcile', 'container-smoke'];

export { DEFAULT_DISPATCH_TIMEOUT_SECONDS } from './run-deadline.js';

/** The capability a task needs turned on in a Project, or null for a task no capability gates. */
export function capabilityOf(task: string): ProjectCapability | null {
  const gate = admissionForTask(task);
  return gate?.kind === 'capability' ? gate.capability as ProjectCapability : null;
}

/** Whether a Project has turned a capability on. */
export async function capabilityOn(db: ServerEnv['db'], projectId: string, capability: ProjectCapability): Promise<boolean> {
  const read = enabledCapabilities(db, [capability], projectId);
  return read.read((await read.statement.all<Record<string, unknown>>()).results).length > 0;
}

/** A harness a worker has, and whether it is logged in. A worker offers these; the Deployment chooses among them. */
export interface OfferedHarness {
  id: string;
  authenticated: boolean;
  profile?: ProfileCapability;
}

export const parseLeaf = (value: string | undefined): unknown => {
  if (value === undefined) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
};
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * Which harness runs this task: the Deployment's preference and fallback order,
 * intersected with what the worker actually has logged in. A per-task override
 * is read out of the `agent.tasks` document, the same way a provider override
 * is; there is no dotted-path leaf for it.
 *
 * A Deployment that names nothing takes whatever the worker offers. Settings
 * narrow the choice; their absence is not a refusal, so a machine with a
 * logged-in harness runs work the moment it attaches and an operator configures
 * a preference only to override that.
 *
 * Ids are matched against what the worker offers. A matching harness must also
 * carry a profile this Deployment can resolve and the worker can apply.
 * A preference nobody offers yields no run rather than a substitute, so an operator who
 * misspells a preference reads an unrun queue instead of work quietly sent to
 * another vendor on another vendor's key.
 */
export function chooseHarness(preferred: string | null, fallback: readonly string[], override: string | null, offered: readonly OfferedHarness[]): string | null {
  const ready = offered.filter((h) => h.authenticated).map((h) => h.id);
  const wanted = [override ?? preferred, ...fallback].filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (wanted.length === 0) return ready[0] ?? null;
  for (const id of wanted) if (ready.includes(id)) return id;
  return null;
}

export function harnessPreference(byLeaf: ReadonlyMap<string, string>, task: string): { preferred: string | null; fallback: string[]; override: string | null } {
  const fallbackLeaf = parseLeaf(byLeaf.get('worker.harness_fallback'));
  return {
    preferred: str(parseLeaf(byLeaf.get('worker.harness'))),
    fallback: Array.isArray(fallbackLeaf) ? fallbackLeaf.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [],
    override: str(taskOverride(byLeaf, task).harness),
  };
}

/** The leaves a claim resolves its worker, profile and credential through. */
export const CLAIM_SETTING_LEAVES: readonly string[] = ['worker.harness', 'worker.harness_fallback', 'agent.tasks', ...PROFILE_SETTING_LEAVES];

/** The leaves a claim resolves its worker, profile and credential through, as they stand now. */
export function claimSettings(env: Pick<ServerEnv, 'db'>): Promise<Map<string, string>> {
  return settingTexts(env.db, CLAIM_SETTING_LEAVES);
}

/** The worker preference every claim resolves, as the Deployment's leaves hold it now. */
export async function workerPreference(env: Pick<ServerEnv, 'db'>): Promise<{ preferred: string | null; fallback: string[] }> {
  const { preferred, fallback } = harnessPreference(await settingTexts(env.db, ['worker.harness', 'worker.harness_fallback']), '');
  return { preferred, fallback };
}

/**
 * Where the chosen agent's login comes from: the worker's own sign-in, the
 * agent's one slot in this server's store, or nowhere usable. Worker login
 * leaves the run's environment unchanged; a server login reads only the
 * selected agent's own slot.
 */
export type LoginPlan = { kind: 'worker-login' } | { kind: 'deployment'; slot: SecretSlotName } | { reason: string };

export function loginPlan(env: Pick<ServerEnv, 'harnessCredentialSource'>, harness: string, settings: ReadonlyMap<string, string>): LoginPlan {
  const configured = profileSetting(settings.get(`agent.harnesses.${harness}.credential`));
  const source = configured === undefined ? env.harnessCredentialSource : configured;
  const unavailable = { reason: credentialUnavailable(harness) };
  if (source === 'worker-login') return { kind: 'worker-login' };
  if (source !== 'deployment') return unavailable;
  const declared = HARNESS_CREDENTIALS[harness];
  // Only the chosen harness's own slot is ever read. A claim answering every
  // key the Deployment holds would widen what one answer discloses to every
  // provider at once, for keys the run cannot use; and a slot another use reads
  // (the embedding provider's) is never a run's login.
  if (declared === undefined || declared.slot === null || declared.variables.length === 0) return unavailable;
  return { kind: 'deployment', slot: declared.slot };
}

/** The step that turns a login plan into what a run is handed, or the holder that keeps it from running. */
export type LoginStep<L> = (harness: string, plan: Exclude<LoginPlan, { reason: string }>) => Promise<{ login: L } | { reason: string }>;

export type Selected<L> = { harness: string; profile: ExecutionProfile; login: L };

/** Resolve a task against one worker's offers in preference order. */
export async function selectExecution<L>(env: Pick<ServerEnv, 'harnessCredentialSource'>, task: string, offers: readonly OfferedHarness[], settings: ReadonlyMap<string, string>, login: LoginStep<L>): Promise<{ selected: Selected<L> | null; reason: string | null }> {
  const preference = harnessPreference(settings, task);
  let remaining = [...offers];
  let reason: string | null = null;
  for (;;) {
    const harness = chooseHarness(preference.preferred, preference.fallback, preference.override, remaining);
    if (harness === null) return { selected: null, reason: reason ?? (preference.override !== null && !Object.hasOwn(PROFILE_HARNESSES, preference.override) ? profileUnsupported(preference.override) : null) };
    if (REPOSITORY_TASKS.includes(task) && !canReadSource(HARNESS_ASKING[harness])) {
      reason ??= sourceReadUnavailable(harness);
      remaining = remaining.filter((entry) => entry.id !== harness);
      continue;
    }
    const offer = remaining.find((entry) => entry.id === harness)!;
    const resolved = resolveExecutionProfile(task, harness, offer.profile, settings);
    if ('profile' in resolved) {
      const plan = loginPlan(env, harness, settings);
      const opened = 'reason' in plan ? plan : await login(harness, plan);
      if ('login' in opened) return { selected: { harness, profile: resolved.profile, login: opened.login }, reason: null };
      reason ??= opened.reason;
    } else reason ??= resolved.reason;
    remaining = remaining.filter((entry) => entry.id !== harness);
  }
}

/** One worker's latest report: the agents it offers and the capabilities it carries, and whether a runner made it. */
export interface FleetReport { offers: readonly OfferedHarness[]; capabilities: readonly string[]; runner?: boolean }

/** The login step each report resolves its selection through: a runner's report never opens a stored login. */
export type ReportLogin<L> = (report: FleetReport) => LoginStep<L>;

/**
 * What `reports` would run `task` under at a claim now: the execution the first
 * report able to take it resolves, else null with the holder a queued run of it
 * waits under, the alphabetically first refusal among the reports that carry
 * the task's capabilities, or the ordinary wait for a worker when none refused.
 */
export async function fleetSelection<L>(env: Pick<ServerEnv, 'harnessCredentialSource'>, task: string, reports: readonly FleetReport[], settings: ReadonlyMap<string, string>, login: ReportLogin<L>): Promise<{ selected: Selected<L> | null; holder: string }> {
  const tierRefusal = taskTierRefusal(task, settings);
  if (tierRefusal !== null) return { selected: null, holder: tierRefusal };
  const required = capabilitiesRequiredBy(task);
  const reasons: string[] = [];
  for (const report of reports) {
    if (!required.every((capability) => report.capabilities.includes(capability))) continue;
    const result = await selectExecution(env, task, report.offers, settings, login(report));
    if (result.selected !== null) return { selected: result.selected, holder: 'worker' };
    if (result.reason !== null) reasons.push(result.reason);
  }
  return { selected: null, holder: reasons.sort()[0] ?? 'worker' };
}

/** One worker heard from lately, as a preview reads it: its report, and which credential it reported under. */
export interface PreviewReport extends FleetReport { credentialId: string }

/** One way a start now could run: the agent and profile, and the workers heard from lately that would run it so. */
export interface PreviewExecution { harness: string; profile: ExecutionProfile; credentialIds: string[] }

/**
 * What a run of `task` started now would run under, judged worker by worker:
 * every distinct agent and profile a worker heard from lately resolves it to,
 * through the same selection a claim makes: whichever of them asks next takes
 * it. Empty, with what a queued run would wait under, when none could take it
 * now.
 */
export async function previewSelection(env: Pick<ServerEnv, 'harnessCredentialSource'>, task: string, reports: readonly PreviewReport[], settings: ReadonlyMap<string, string>, login: ReportLogin<true>): Promise<{ executions: PreviewExecution[]; heldBy: string | null }> {
  const tierRefusal = taskTierRefusal(task, settings);
  if (tierRefusal !== null) return { executions: [], heldBy: tierRefusal };
  if (reports.length === 0) return { executions: [], heldBy: 'worker' };
  const required = capabilitiesRequiredBy(task);
  const able = reports.filter((report) => required.every((capability) => report.capabilities.includes(capability)));
  if (able.length === 0) {
    const missing = CAPABILITY_HOLDS.find((hold) => required.includes(hold) && !reports.some((report) => report.capabilities.includes(hold)));
    return { executions: [], heldBy: missing ?? 'worker' };
  }
  const executions = new Map<string, PreviewExecution>();
  const reasons: string[] = [];
  for (const report of able) {
    const { selected, reason } = await selectExecution(env, task, report.offers, settings, login(report));
    if (selected === null) { if (reason !== null) reasons.push(reason); continue; }
    const { tier, model, effort } = selected.profile;
    const key = JSON.stringify([selected.harness, tier, model, effort]);
    const known = executions.get(key);
    if (known === undefined) executions.set(key, { harness: selected.harness, profile: selected.profile, credentialIds: [report.credentialId] });
    else known.credentialIds.push(report.credentialId);
  }
  return executions.size > 0 ? { executions: [...executions.values()], heldBy: null } : { executions: [], heldBy: reasons.sort()[0] ?? 'worker' };
}
