import { expect, it } from 'bun:test';
import type { TaskDescription as ServerDescription } from '@myco-server-worker/read/task-descriptions.js';
import type { TaskDescription as DashboardDescription } from '../../packages/myco-server/ui/src/features/tasks/wire';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const equal: Equal<ServerDescription, DashboardDescription> = true;

it('holds dashboard task facts to the server registry wire', () => expect(equal).toBe(true));
