import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  getConstants(): {
    readonly sessionId: string;
  };
  getSessionId(): string;
  endSession(reason: string): void;
  setHoldTeardown(active: boolean): void;
  notifyActivity(): void;
  reportFatalError(message: string, isFatal: boolean): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('KioskSession');
