import { sendEvent } from './send-event.js';

export async function main() {
  await sendEvent('subagent-start', (input) => ({
    type: 'subagent_start',
    agent_id: input.agent_id,
    agent_type: input.agent_type,
  }));
}
