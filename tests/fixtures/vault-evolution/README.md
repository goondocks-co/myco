# Pre-pause fixtures

These fixtures hold behavior from commit `eab20e683387fb747b72cf8c723c2e8202603acc` for the migration-before-Worker cutover model.

- `pre-pause-settings.ts`: complete `packages/myco-server/src/core/settings.ts`, with imports redirected to current unchanged dependencies and the frozen schedule declarations.
- `pre-pause-schedule.ts`: `ScheduleState`, `TaskSchedule` and `TASK_SCHEDULE` from `core/jobs.ts`, plus `scheduleOverride`, `scheduledTasks` and `resolveSchedule` from `core/schedule-rules.ts`. The count validator comes from the frozen settings module.
- `pre-pause-archive.ts`: the old archive implementation, with imports redirected to the server modules.
- `pre-pause-lease.ts`: the old lapsed-lease requeue write.
- `pre-pause-claim.ts`: the unfenced queued-to-running write model.

`learning-cutover.test.ts` combines the exact old settings writer and schedule admission with a clock queue model that admits all later dispatch gates. It does not reproduce an entire old Worker or prove that hosted invocations have drained. Operator deployment ordering and drain completion remain external to this test.
