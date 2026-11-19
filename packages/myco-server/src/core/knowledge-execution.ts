import { capabilitiesRequiredBy, knowledgeOnlyInstruction, KNOWLEDGE_REPOSITORY_TASKS } from '@goondocks/myco-shared/repository';
import { canReadSourceFiles, HARNESS_ASKING } from '@goondocks/myco-shared/execution-profile';
import type { ServerEnv } from './adapters.js';
import type { ClaimedInput } from './runs.js';
import { repositoryIdentity } from './repositories.js';
import { githubAppConfigured } from './github-app.js';

/** Optional code access never gates knowledge work; the selected execution determines whether it can carry a checkout. */
export async function knowledgeInputForExecution(env: Pick<ServerEnv,'db'|'secrets'>, projectId: string, task: string, input: ClaimedInput,
  harness: string, capabilities: readonly string[]): Promise<ClaimedInput> {
  if (!KNOWLEDGE_REPOSITORY_TASKS.includes(task) || input.repository === undefined) return input;
  if (githubAppConfigured(env) && canReadSourceFiles(HARNESS_ASKING[harness]) && capabilitiesRequiredBy(task, true).every(capability => capabilities.includes(capability))) {
    const connection = await repositoryIdentity(env.db,{projectId});
    if (connection !== null && connection.url === input.repository.url && connection.branch === input.repository.branch) return input;
  }
  return { ...input, repository: undefined, instruction: knowledgeOnlyInstruction(input.instruction) };
}
