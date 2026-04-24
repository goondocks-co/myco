// Thin re-export of the myco-team bundle surface that the daemon depends on.
//
// NB: `myco team init` / `myco team upgrade` were retired in favor of the
// standalone `myco-team` binary (`npm install -g @goondocks/myco-team`). The
// only remaining bundled consumer is the daemon's POST /api/team/upgrade-worker
// handler, which needs in-process access to `upgradeWorker` so that the
// one-click Worker upgrade from the UI works without requiring the user to
// have `myco-team` on their PATH. See `daemon/api/team-connect.ts`.
export {
  getTeamPackageVersion,
  upgradeWorker,
  type UpgradeResult,
} from '@myco-team/cli';
