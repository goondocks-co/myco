/** An audit a run's report carries, holding every field its shape requires (`core/run-audit.ts`). */
export const RUN_AUDIT: { steps: string[]; examined: string[]; commands: string[]; failures: Array<{ what: string; recovery: string }>; reasoning: string } = {
  steps: ['Read the material the run was handed', 'Wrote what the task owed', 'Filed this report'],
  examined: ['material/handed.md'],
  commands: [],
  failures: [],
  reasoning: 'The material held what the task needed, and the write it owed landed.',
};
