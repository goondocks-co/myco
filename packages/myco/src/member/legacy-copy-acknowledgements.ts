import path from 'node:path';
import { withRegistryLock } from '@myco/member/registry.js';
import { ensureMemberDir, memberRoot, readPrivateJson, writePrivateFileAtomic } from '@myco/member/store.js';

const ACKNOWLEDGEMENTS_VERSION = 1;
interface AcceptedHistory { count: number; digest: string }
export interface EarlierCopyCount extends AcceptedHistory { projectId: string; key: string }
interface Acknowledgements { version: typeof ACKNOWLEDGEMENTS_VERSION; projects: Record<string, Record<string, AcceptedHistory>> }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const acceptedHistory = (value: unknown): value is AcceptedHistory => record(value) && typeof value.count === 'number' && Number.isSafeInteger(value.count) && value.count > 0
  && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest);

/** Acknowledgements bind the accepted-history count and fingerprint, separately from import ledgers and confirmation receipts. */
export class LegacyCopyAcknowledgements {
  readonly file: string;
  constructor(private readonly home: string) { this.file = path.join(memberRoot(home), 'legacy-earlier-copies.json'); }

  read(): Acknowledgements {
    const read = readPrivateJson<unknown>(this.file);
    if (!read.ok) {
      if (read.reason === 'missing') return { version: ACKNOWLEDGEMENTS_VERSION, projects: {} };
      throw new Error(`Earlier-copy acknowledgements could not be read: ${this.file} (${read.reason})`);
    }
    const value = read.value;
    if (!record(value) || value.version !== ACKNOWLEDGEMENTS_VERSION || !record(value.projects)
      || !Object.values(value.projects).every(project => record(project) && Object.entries(project).every(([key, history]) => /^[a-f0-9]{16}$/.test(key) && acceptedHistory(history)))) {
      throw new Error(`Earlier-copy acknowledgements are malformed: ${this.file}`);
    }
    return value as unknown as Acknowledgements;
  }

  /** Observe current copies and acknowledge their counts under the member registry lease. */
  dismiss<T extends EarlierCopyCount>(observe: () => T[]): T[] {
    return withRegistryLock(() => {
      const copies = observe();
      if (copies.length === 0) return copies;
      const state = this.read();
      for (const copy of copies) {
        if (!/^[a-f0-9]{16}$/.test(copy.key) || !acceptedHistory(copy)) throw new Error('Earlier-copy acknowledgement requires a Deployment key and a positive accepted-history count');
        state.projects = { ...state.projects, [copy.projectId]: { ...state.projects[copy.projectId], [copy.key]: { count: copy.count, digest: copy.digest } } };
      }
      ensureMemberDir(memberRoot(this.home), this.home);
      writePrivateFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
      return copies;
    }, this.home);
  }
}
