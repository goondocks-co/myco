import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

export function writeRetainedLegacyVault(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.exec(fs.readFileSync(new URL('../fixtures/legacy/vault-v76.sql', import.meta.url), 'utf8'));
    db.run("INSERT INTO sessions (id, agent, started_at, created_at) VALUES ('retained', 'codex', 1, 1)");
  } finally { db.close(); }
}

export async function withLegacyBinaryTraps(mycoHome: string, userHome: string, run: (marker: string) => Promise<void>): Promise<void> {
  const marker = path.join(mycoHome, 'legacy-binary-executed');
  const binaries = [...new Set([path.join(mycoHome, 'bin', 'myco'), path.join(userHome, '.myco', 'bin', 'myco')])];
  const created: string[] = [];
  const previous = process.env.PATH;
  try {
    for (const binary of binaries) {
      if (fs.existsSync(binary)) throw new Error(`binary trap would overwrite ${binary}`);
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, `#!/bin/sh\nprintf 'executed\\n' >> '${marker.replaceAll("'", "'\\''")}'\n`, { mode: 0o755 });
      created.push(binary);
    }
    process.env.PATH = [...binaries.map((binary) => path.dirname(binary)), previous ?? ''].join(path.delimiter);
    await run(marker);
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    for (const binary of created) fs.unlinkSync(binary);
  }
}
