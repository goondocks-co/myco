import { sendEvent } from './send-event.js';

export async function main() {
  await sendEvent('subagent-start', (input) => ({
    type: 'subagent_start',
    agent_id: input.raw.agent_id,
    agent_type: input.raw.agent_type,
  }));
}
