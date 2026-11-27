import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface KioskDeviceConfigNative {
  readonly storeId: string;
  readonly kioskId: string;
  readonly terminalId: string;
  readonly environment: string;
}

export interface Spec extends TurboModule {
  getDeviceConfig(): KioskDeviceConfigNative;
}

export default TurboModuleRegistry.getEnforcing<Spec>('KioskConfig');
