export { DeploymentClock, RecoveryProducer } from '../../../packages/myco-server/src/index.ts';
import worker from '../../../packages/myco-server/src/index.ts';

/** The local parity fixture can withhold sign-in configuration from one request. */
export default {
  fetch(request: Request, env: Parameters<typeof worker.fetch>[1], ctx: Parameters<typeof worker.fetch>[2]) {
    return worker.fetch(request, request.headers.get('x-test-sign-in-unconfigured') === '1'
      ? { ...env, GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined } : env, ctx);
  },
};
