import {
  claimSubsystem,
  releaseSubsystemClaim,
  listSubsystemClaims,
  readClaim,
  resolveClaimsHome,
  KNOWN_SUBSYSTEMS,
} from '../daemon/subsystem-claim.js';
import { resolveMycoHome, daemonIdentity } from '@myco/grove/paths.js';

const USAGE = `Usage: myco subsystem <command>

Declare which daemon owns a machine-global subsystem so a peer daemon defers.
Operator-driven and durable: run claim/release under the build whose daemon
should own the subsystem. The owner is that daemon's home (MYCO_HOME) and the
claim persists across restarts until explicitly released. A peer daemon reads
the claim and opts out of performing the subsystem's work.

Commands:
  claim <subsystem> [--force]   Take ownership for this daemon (its home)
  release <subsystem>           Relinquish a claim this daemon owns
  list                          Show active claims on this machine

Subsystems: ${KNOWN_SUBSYSTEMS.join(', ')}`;

function assertKnown(subsystem: string): void {
  if (!KNOWN_SUBSYSTEMS.includes(subsystem)) {
    throw new Error(
      `Unknown subsystem: ${subsystem}. Known subsystems: ${KNOWN_SUBSYSTEMS.join(', ')}`,
    );
  }
}

export async function run(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  const mycoHome = resolveMycoHome();
  const claimsHome = resolveClaimsHome();

  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE + '\n');
    return;
  }

  if (cmd === 'list') {
    const claims = listSubsystemClaims({ claimsHome });
    if (claims.length === 0) {
      console.log('No subsystem claims.');
      return;
    }
    for (const claim of claims) {
      console.log(
        `${claim.subsystem} → ${claim.owner} (pid ${claim.pid}, claimed ${new Date(claim.claimed_at).toISOString()})`,
      );
    }
    return;
  }

  if (cmd === 'claim') {
    const subsystem = rest[0];
    if (!subsystem) throw new Error('Subsystem name is required');
    assertKnown(subsystem);
    const self = daemonIdentity(mycoHome);
    const existing = readClaim(subsystem, claimsHome);
    if (existing && existing.owner !== self && !rest.includes('--force')) {
      throw new Error(
        `${subsystem} is already claimed by ${existing.owner}. Release it from that `
        + `build (\`myco subsystem release ${subsystem}\`), or pass --force to take it over.`,
      );
    }
    claimSubsystem(subsystem, self, { claimsHome });
    console.log(`Claimed ${subsystem} for ${self}.`);
    console.log(`A peer daemon (a different home) now defers ${subsystem} work to this daemon.`);
    console.log(`Run \`myco subsystem release ${subsystem}\` (under this build) when you're done.`);
    return;
  }

  if (cmd === 'release') {
    const subsystem = rest[0];
    if (!subsystem) throw new Error('Subsystem name is required');
    assertKnown(subsystem);
    const self = daemonIdentity(mycoHome);
    const existing = readClaim(subsystem, claimsHome);
    if (!existing) {
      console.log(`${subsystem} is not claimed.`);
      return;
    }
    if (existing.owner !== self) {
      throw new Error(
        `${subsystem} is claimed by ${existing.owner}, not ${self}. Release it from the `
        + `owning build.`,
      );
    }
    releaseSubsystemClaim(subsystem, self, { claimsHome });
    console.log(`Released ${subsystem} (was owned by ${self}).`);
    return;
  }

  throw new Error(`Unknown subsystem command: ${cmd}\n\n${USAGE}`);
}
