import type { RelationalStore } from '../../core/adapters.js';
import { publicationPinsReady, requirePublicationPins } from './pins.js';
import { catchUpPhase } from '../projections/catchup.js';
import { restoreRecordSchemeDecisions as decideRecords } from './record-pins.js';
export { restoredPin, restoreSchemeDecisions } from './pins.js';
const RESTORE_PIN_PAGES=2;

/** Restore admits identities only after the existing pin registry has consumed its captured source frontier. */
export async function restoreRecordSchemeDecisions(db:RelationalStore,rows:readonly Record<string,unknown>[]):Promise<void> {
  await decideRecords(db,rows);
  for(let page=0;page<RESTORE_PIN_PAGES&&!await publicationPinsReady(db);page++)await catchUpPhase(db,'publicationPinGroups');
  await requirePublicationPins(db);
}
