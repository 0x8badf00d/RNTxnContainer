import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface AssociateProfileNative {
  readonly associateId: string;
  readonly displayName: string;
  readonly roles: ReadonlyArray<string>;
  readonly permissions: ReadonlyArray<string>;
  readonly storeId: string;
}

export interface Spec extends TurboModule {
  getAssociateProfile(): AssociateProfileNative;
  requestAssociateLogout(): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('KioskAssociate');
