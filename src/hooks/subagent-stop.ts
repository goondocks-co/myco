import { sendEvent } from './send-event.js';

export async function main() {
  await sendEvent('subagent-stop', (input) => ({
    type: 'subagent_stop',
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    last_assistant_message: input.last_assistant_message,
    agent_transcript_path: input.agent_transcript_path,
  }));
}
