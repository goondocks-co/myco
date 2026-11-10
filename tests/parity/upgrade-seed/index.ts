import { observeKnowledge, seedKnowledge, type KnowledgeSeed } from './knowledge.ts';
import { observeMachines, seedMachines, type MachinesSeed } from './machines.ts';
import { mcp, owner, pick, type RouteTarget, type SeedTarget } from './requests.ts';
import { observeRuns, seedRuns, type RunsSeed } from './runs.ts';
import { observeSessions, seedSessions, type SessionsSeed } from './sessions.ts';

/**
 * What a Deployment's users write before an upgrade, through the routes and tools they use, and what they read back.
 * A table the upgrade changes must hold rows: when the carry names one this seed leaves empty, add its route here.
 */

interface Seeded { sessions: SessionsSeed; knowledge: KnowledgeSeed; machines: MachinesSeed; runs: RunsSeed }
export interface SeededDeployment extends Seeded { observed: Record<string, unknown> }

/** The seeded Deployments, by Deployment id, for the scenario that reads them back after the upgrade. */
const SEEDED = new Map<string, SeededDeployment>();

export function seededDeployment(deploymentId: string): SeededDeployment {
  const seeded = SEEDED.get(deploymentId);
  if (seeded === undefined) throw new Error(`Deployment ${deploymentId} was not seeded before an upgrade; boot it with dedicated.latestSchemaUpgrade`);
  return seeded;
}

export async function seedDeployment(target: SeedTarget): Promise<SeededDeployment> {
  const stamp = Date.now();
  const sessions = await seedSessions(target, stamp);
  const knowledge = await seedKnowledge(target, sessions.captured.sessionId, sessions.word, stamp);
  const machines = await seedMachines(target, stamp);
  const runs = await seedRuns(target, stamp, sessions.sibling.sessionId);
  const seeded = { sessions, knowledge, machines, runs };
  const result = { ...seeded, observed: await observe(target, seeded) };
  SEEDED.set(target.deploymentId, result);
  return result;
}

/** What the seeded Deployment's users read and the refusals they meet, in a form two reads of the same records compare equal. */
export async function observe(target: RouteTarget, seeded: Seeded): Promise<Record<string, unknown>> {
  const status = await owner(target, '/api/status');
  return {
    status: [status.status, (status.body.projects ?? []).map((row: unknown) => pick(row, ['projectId', 'sessionCount', 'archivedAt']))],
    // The harness states a machine reported, as the status page lists them.
    harnesses: (status.body.harnesses ?? []).filter((fact: { machineId: string }) => fact.machineId === seeded.machines.machine.machineId)
      .map((fact: unknown) => pick(fact, ['machineId', 'id', 'harness', 'state', 'action', 'ranAt'])),
    sessions: await observeSessions(target, seeded.sessions),
    knowledge: await observeKnowledge(target, seeded.knowledge, seeded.sessions.captured.sessionId, seeded.sessions.word),
    machines: await observeMachines(target, seeded.machines),
    runs: await observeRuns(target, seeded.runs),
    unknownSession: await mcp(target, 'myco_spores', { op: 'save', type: 'decision', content: 'nowhere', agent_line: 'When citing evidence, name the session that holds it.', session_id: 'upgrade-no-such-session', project: target.projectId }),
  };
}

