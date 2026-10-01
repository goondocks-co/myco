/**
 * The one rule a capture folder (`capture.auto_join_roots`) is held to, by the dashboard before it sends one, by the
 * server before it stores one, and by the machine before it captures under one.
 */
import { describe, expect, it } from 'bun:test';
import { captureFolderRefusal } from '@goondocks/myco-shared/member-protocol';

describe('a capture folder', () => {
  it('names a folder under the home, the filesystem root or a drive, and never one of those whole', () => {
    const table: Array<[string, 'accepted' | RegExp]> = [
      ['~/Repos', 'accepted'],
      ['~\\Repos', 'accepted'],
      ['~/work/clients', 'accepted'],
      ['/srv/repos', 'accepted'],
      ['D:\\work', 'accepted'],
      ['D:/work', 'accepted'],
      ['\\\\server\\share\\repos', 'accepted'],
      ['~', /not the home itself/],
      ['~/', /not the home itself/],
      ['~\\', /not the home itself/],
      ['/', /not the filesystem root itself/],
      ['C:\\', /not the drive itself/],
      ['C:/', /not the drive itself/],
      ['C:\\\\', /not the drive itself/],
      ['C:', /not the drive itself/],
      ['Repos', /starts with ~\/, \/ or a drive/],
      ['./Repos', /starts with ~\/, \/ or a drive/],
      ['C:work', /starts with ~\/, \/ or a drive/],
      ['~lin/Repos', /starts with ~\/, \/ or a drive/],
      ['~/Repos/../..', /without a ".." segment/],
    ];
    for (const [entry, expected] of table) {
      const refusal = captureFolderRefusal(entry);
      if (expected === 'accepted') expect({ entry, refusal }).toEqual({ entry, refusal: null });
      else expect({ entry, refusal }).toEqual({ entry, refusal: expect.stringMatching(expected) });
    }
  });
});
