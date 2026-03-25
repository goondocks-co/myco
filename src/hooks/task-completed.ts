import { sendEvent } from './send-event.js';

export async function main() {
  await sendEvent('task-completed', (input) => ({
    type: 'task_completed',
    task_id: input.task_id,
    task_subject: input.task_subject,
    task_description: input.task_description,
  }));
}
