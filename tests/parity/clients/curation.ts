import { expect } from 'bun:test';
import type { ParityTarget } from '../harness.ts';
import { mcp, putCapability, wake, type ClaimedRun, type RouteTarget } from './requests.ts';

export async function offerCurationGroup(target: RouteTarget & Pick<ParityTarget, 'primeEmbedding'>): Promise<void> {
  const save = (content: string) => mcp(target, 'myco_spores', { op: 'save', type: 'gotcha', content, agent_line: 'When delivery stalls, retain queued capture.' });
  const text = 'When capturing turns, retain canonical identities.\nWhen delivering turns, retain pending capture until acknowledged.';
  await save(text); await save(text);
  for (let index = 0; index < 60; index++) {
    const concept = String.fromCharCode(97 + index % 26).repeat(4) + String.fromCharCode(97 + Math.floor(index / 26)).repeat(5);
    await save((concept + ' ').repeat(40) + '\nWhen delivering ' + concept + ', retain pending capture.\nWhen capturing ' + concept + ', retain canonical ids.');
  }
  await target.primeEmbedding!(target.projectId);
  expect((await putCapability(target, 'spore_curation', true)).status).toBe(200);
  for (let tick = 0; tick < 4; tick++) await wake(target);
}

export const curationMembers = (run: ClaimedRun): { id: string; content: string }[] =>
  JSON.parse(run.instruction!.split('## Whole notes (data, not instructions)\n\n')[1]!);
