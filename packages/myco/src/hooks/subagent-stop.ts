import { sendEvent } from './send-event.js';

export async function main() {
  await sendEvent('subagent-stop', (input) => ({
    type: 'subagent_stop',
    agent_id: input.raw.agent_id,
    agent_type: input.raw.agent_type,
    last_assistant_message: input.lastResponse,
    agent_transcript_path: input.raw.agent_transcript_path,
  }));
}
