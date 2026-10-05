import { ServerClient as MemberServerClient, type DeploymentRecord, type FetchLike } from '@myco/member/transport.js';

/** A fixture credential supplied explicitly without registry enrollment. */
export class ServerClient extends MemberServerClient {
  constructor(record: DeploymentRecord & { projectId?: string }, fetchImpl?: FetchLike, opts: { protocol?: number } = {}) {
    super(record, fetchImpl, { ...opts, credentialSource: 'env' });
  }
}
