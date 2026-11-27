// Minimal non-published ambient stub matching React Native's RCTExport.d.ts / TurboModuleRegistry.d.ts.
// Excluded from package.json "files" and never emitted into dist/.
declare module 'react-native' {
  export interface TurboModule {
    getConstants?: () => {};
  }

  export const TurboModuleRegistry: {
    get<T extends TurboModule>(name: string): T | null;
    getEnforcing<T extends TurboModule>(name: string): T;
  };
}
