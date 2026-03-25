import { sendEvent } from './send-event.js';

export async function main() {
  await sendEvent('post-tool-use-failure', (input) => ({
    type: 'tool_failure',
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    error: input.error,
    is_interrupt: input.is_interrupt,
  }));
}
