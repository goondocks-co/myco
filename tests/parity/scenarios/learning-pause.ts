import { expect } from 'bun:test';
import { type ParityScenario } from '../harness.ts';

export const learningPause: ParityScenario = {
  name: 'learning dispatch needs no pause or resume marker',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    const owner = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    const response = await fetch(`${target.url}/api/harness/dispatch`, {
      method: 'POST', headers: owner, body: JSON.stringify({ task: 'extract-curate', projectId: target.projectId }),
    });
    expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200, body: { queued: true, task: 'extract-curate' } });
  },
};
