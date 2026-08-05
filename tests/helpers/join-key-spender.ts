/**
 * Spend a join key from a SEPARATE process.
 *
 * The single-use property cannot be tested inside one process: the consume path
 * is synchronous, so it can never interleave with itself there. The race that
 * matters is between DAEMONS — the store lives under the machine-global team
 * home, which every daemon on the box shares — so proving it needs real
 * processes.
 */
import { consumeJoinKey } from '@myco/team-host/join-keys.js';

const [teamHome, key, worker] = process.argv.slice(2);
if (!teamHome || !key) {
  process.stderr.write('join-key spender: required args missing\n');
  process.exit(64);
}
process.env.MYCO_TEAM_HOME = teamHome;

const result = consumeJoinKey(key, { machineId: worker ?? 'worker' });
process.stdout.write(JSON.stringify({ ok: result.ok }));
