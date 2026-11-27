export type {
  AssociateProfile,
  KioskAssociateSpec,
  KioskConfigSpec,
  KioskDeviceConfig,
  KioskEnvironment,
  KioskErrorGuardHandle,
  KioskErrorGuardOptions,
  KioskHostConfig,
  KioskSessionSpec,
  SessionEndReason,
} from './types.js';

export { KioskAssociate } from './KioskAssociate.js';
export { KioskConfig } from './KioskConfig.js';
export { KioskSession } from './KioskSession.js';
export {
  DEFAULT_MAX_ERROR_MESSAGE_LENGTH,
  installKioskErrorGuards,
  sanitizeErrorMessage,
} from './errorGuards.js';
export type {
  KioskNativeModulesOverride,
  KioskSessionNativeModule,
} from './internal/nativeBridge.js';
export {
  __resetKioskNativeModulesForTesting,
  __setKioskNativeModulesForTesting,
} from './internal/nativeBridge.js';
