import { sendEvent } from './send-event.js';

export async function main() {
  await sendEvent('task-completed', (input) => ({
    type: 'task_completed',
    task_id: input.raw.task_id,
    task_subject: input.raw.task_subject,
    task_description: input.raw.task_description,
  }));
}
