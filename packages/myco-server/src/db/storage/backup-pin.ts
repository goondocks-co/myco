import type { RelationalStore } from '../../core/adapters.js';
import { commit, write } from '../index.js';
const pin = write<[pinned: number, id: string], { id: string }>({ name: 'storage.pinBackup', sql:
  'UPDATE backups SET pinned=? WHERE id=? RETURNING id' });
export async function pinBackup(db: RelationalStore, id: string, pinned: boolean) {
  const [result] = await commit(db,pin.bind(pinned?1:0,id)); return result.results.length===1;
}
