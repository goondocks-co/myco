import { sendEvent } from './send-event.js';

export async function main() {
  await sendEvent('post-tool-use-failure', (input) => ({
    type: 'tool_failure',
    tool_name: input.toolName,
    tool_input: input.toolInput,
    error: input.raw.error,
    is_interrupt: input.raw.is_interrupt,
  }));
}
