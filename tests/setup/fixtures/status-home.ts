import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeRegistryEntry } from '@myco/member/registry.js';
import { MemberSpool } from '@myco/member/spool.js';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { recordProvision } from '@myco/symbionts/member-provision-record.js';

export const STATUS_URL = 'https://status.example';
export const STATUS_NOW = Date.UTC(2026, 9, 11);

/** One joined Deployment, twelve repositories, and current and historical capture problems. */
export function statusHome(scratch: string) {
  const home = path.join(scratch, 'myco');
  const repositories = Array.from({ length: 12 }, (_, index) => path.join(scratch, `repository-${index + 1}`));
  for (const [index, root] of repositories.entries()) {
    fs.mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', root]);
    const entry = { version: 2, root, projectId: `proj_status_${index + 1}`, serverUrl: STATUS_URL, token: 'S'.repeat(43), machineId: 'synthetic-machine', joinedAt: 1, updatedAt: 1 };
    writeRegistryEntry(entry, { mycoHome: home });
    const spool = new MemberSpool(entry, { mycoHome: home });
    if (index === 0) {
      const sessionId = 'status-backlog';
      spool.append(sessionId, promptEvent({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: '2.0.0-test' }, { promptId: mintId(), text: 'synthetic prompt' }));
      fs.writeFileSync(path.join(spool.dir, 'offline.json'), JSON.stringify({ since: STATUS_NOW, nextProbeAt: STATUS_NOW + 60_000, backoffMs: 60_000 }), { mode: 0o600 });
    }
    if (index === 1 || index === 2) spool.appendRefused({ eventId: mintId(), sessionId: 'status-refusals', kind: 'prompt', code: 'clock_skew', reason: 'Synthetic refusal', at: index === 1 ? STATUS_NOW : STATUS_NOW - 8 * 86400_000 });
  }
  recordProvision(home, { serverUrl: STATUS_URL, agents: ['claude-code'], version: 'stale-version', at: 1 });
  return { home, repositories };
}
