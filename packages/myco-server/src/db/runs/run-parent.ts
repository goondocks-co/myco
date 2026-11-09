/**
 * The run row named by `alias` keeps its runner parent's authority: a member worker's run has none to lose, and a
 * runner's run holds only while its runner is not removed and the credential that leased it is of the runner's
 * current epoch. Run tokens, run reads and run writes all answer to this one predicate.
 */
export function runParentLive(alias = 'agent_runs'): string {
  return `(${alias}.leased_runner_id IS NULL OR EXISTS (SELECT 1 FROM runners parent_runner
    JOIN runner_credentials parent_credential ON parent_credential.runner_id = parent_runner.id
    WHERE parent_runner.id = ${alias}.leased_runner_id AND parent_credential.id = ${alias}.leased_runner_credential_id
      AND parent_runner.state <> 'removed' AND parent_credential.epoch = parent_runner.credential_epoch))`;
}
