/** The path from retained local history to a Deployment. */
export const LEGACY_MIGRATION_GUIDANCE = 'To move your Myco 1.4 data to Myco 2.0, run `myco login <invite link>`, '
  + 'then `myco cutover --dry-run` to preview the move, then `myco cutover`. '
  + 'After the move, run `myco member provision <agent>` to set up your agent, '
  + 'and use `--credential registry` for MCP and tool commands.';
