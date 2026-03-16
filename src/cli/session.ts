import { MycoIndex } from '../index/sqlite.js';
import fs from 'node:fs';
import path from 'node:path';

export function run(args: string[], vaultDir: string): void {
  const idOrLatest = args[0];
  const index = new MycoIndex(path.join(vaultDir, 'index.db'));
  const sessions = index.query({ type: 'session' });

  if (sessions.length === 0) {
    console.log('No sessions found');
    index.close();
    return;
  }

  let target;
  if (!idOrLatest || idOrLatest === 'latest') {
    target = sessions[sessions.length - 1];
  } else {
    target = sessions.find((s) => s.id.includes(idOrLatest));
  }

  if (!target) {
    console.error(`Session not found: ${idOrLatest}`);
    console.log('Available:', sessions.map((s) => s.id).join(', '));
    index.close();
    return;
  }

  // Read the raw markdown file
  const fullPath = path.join(vaultDir, target.path);
  if (fs.existsSync(fullPath)) {
    console.log(fs.readFileSync(fullPath, 'utf-8'));
  } else {
    console.log(`Title: ${target.title}`);
    console.log(`Content:\n${target.content?.slice(0, 2000)}`);
  }

  index.close();
}
