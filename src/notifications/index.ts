/**
 * Notification system public API.
 *
 * Re-exports everything needed by consumers.
 */

export type {
  NotificationMode,
  NotificationLevel,
  NotificationStatus,
  NotificationTypeDescriptor,
  NotificationDomainDescriptor,
  Notification,
  CreateNotificationPayload,
} from './types.js';

export {
  register,
  getDomain,
  getAllDomains,
  getType,
  hasDomain,
  clearAll,
} from './registry.js';

export { registerBuiltinDomains } from './domains.js';
