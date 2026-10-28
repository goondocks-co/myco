import worker, { DeploymentClock, RecoveryProducer } from '../../../packages/myco-server/src/index.ts';
import { installPulledStages } from '../../../packages/myco-server/src/core/pulled-stages.ts';
import { PARITY_PULLED_STAGES } from '../../helpers/pulled-test-stage.ts';
export { DeploymentClock, RecoveryProducer };

installPulledStages(PARITY_PULLED_STAGES);

/** The shipped Worker with the test-only pulled stages installed for its isolate. */
export default { fetch: worker.fetch, scheduled: worker.scheduled };
