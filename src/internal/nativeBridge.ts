import type { Spec as NativeKioskAssociateSpec } from '../specs/NativeKioskAssociate.js';
import type { Spec as NativeKioskConfigSpec } from '../specs/NativeKioskConfig.js';
import type { Spec as NativeKioskSessionSpec } from '../specs/NativeKioskSession.js';

export type KioskSessionNativeModule = Partial<
  Pick<NativeKioskSessionSpec, 'getConstants' | 'getSessionId' | 'reportFatalError'>
> &
  Pick<NativeKioskSessionSpec, 'endSession' | 'setHoldTeardown' | 'notifyActivity'>;

export interface KioskNativeModulesOverride {
  KioskAssociate?: NativeKioskAssociateSpec;
  KioskConfig?: NativeKioskConfigSpec;
  KioskSession?: KioskSessionNativeModule;
}

type KioskModuleName = 'KioskAssociate' | 'KioskConfig' | 'KioskSession';

const NATIVE_MODULES_OVERRIDE_SYMBOL = Symbol.for(
  '@internal/kiosk-host/native-modules-override',
);

interface GlobalWithKioskInternals {
  [NATIVE_MODULES_OVERRIDE_SYMBOL]?: KioskNativeModulesOverride | null;
  __turboModuleProxy?: (name: string) => unknown;
}

function getGlobalHost(): GlobalWithKioskInternals {
  return globalThis as unknown as GlobalWithKioskInternals;
}

function unwrapDefaultExport<T>(loaded: unknown): T | undefined {
  if (loaded === null || loaded === undefined) {
    return undefined;
  }
  if (
    typeof loaded === 'object' &&
    Object.prototype.hasOwnProperty.call(loaded, 'default')
  ) {
    const def = (loaded as { default?: unknown }).default;
    if (def !== undefined && def !== null) {
      return def as T;
    }
  }
  return loaded as T;
}

function isMissingReactNativeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const err = error as { code?: unknown; message?: unknown };
  const code = typeof err.code === 'string' ? err.code : '';
  const message = typeof err.message === 'string' ? err.message : '';

  if (
    (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') &&
    message.includes('react-native')
  ) {
    return true;
  }

  if (
    message.includes("Cannot find module 'react-native'") ||
    message.includes('Cannot find module "react-native"') ||
    message.includes("Cannot find package 'react-native'")
  ) {
    return true;
  }

  return false;
}

function resolveNativeModule<T>(
  name: KioskModuleName,
  loadSpec: () => unknown,
): T {
  const host = getGlobalHost();

  // Tier 1: Explicit test override (shared across ESM/CJS via Symbol.for)
  const overrides = host[NATIVE_MODULES_OVERRIDE_SYMBOL];
  if (
    overrides &&
    Object.prototype.hasOwnProperty.call(overrides, name) &&
    overrides[name] !== undefined &&
    overrides[name] !== null
  ) {
    return overrides[name] as T;
  }

  // Tier 2: Production React Native Codegen spec via static require
  if (typeof require === 'function') {
    try {
      const mod = unwrapDefaultExport<T>(loadSpec());
      if (mod !== undefined && mod !== null) {
        return mod;
      }
    } catch (error) {
      if (!isMissingReactNativeError(error)) {
        throw error;
      }
    }
  }

  // Tier 3: Bridgeless JSI global __turboModuleProxy fallback (supports opaque-box Node ESM tests)
  if (typeof host.__turboModuleProxy === 'function') {
    const proxyModule = host.__turboModuleProxy(name);
    if (proxyModule !== undefined && proxyModule !== null) {
      return proxyModule as T;
    }
  }

  throw new Error(
    `[@internal/kiosk-host] Native TurboModule "${name}" could not be found. Ensure KioskHost is linked in the Native iOS shell or provide a test double via globalThis.__turboModuleProxy.`,
  );
}

export function __setKioskNativeModulesForTesting(
  overrides: KioskNativeModulesOverride | null,
): void {
  const host = getGlobalHost();
  if (overrides === null || overrides === undefined) {
    delete host[NATIVE_MODULES_OVERRIDE_SYMBOL];
    return;
  }
  const nullProtoOverrides = Object.create(null) as KioskNativeModulesOverride;
  if (Object.prototype.hasOwnProperty.call(overrides, 'KioskAssociate')) {
    nullProtoOverrides.KioskAssociate = overrides.KioskAssociate;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'KioskConfig')) {
    nullProtoOverrides.KioskConfig = overrides.KioskConfig;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'KioskSession')) {
    nullProtoOverrides.KioskSession = overrides.KioskSession;
  }
  host[NATIVE_MODULES_OVERRIDE_SYMBOL] = nullProtoOverrides;
}

export function __resetKioskNativeModulesForTesting(): void {
  const host = getGlobalHost();
  delete host[NATIVE_MODULES_OVERRIDE_SYMBOL];
}

export function getNativeKioskAssociate(): NativeKioskAssociateSpec {
  return resolveNativeModule<NativeKioskAssociateSpec>(
    'KioskAssociate',
    () => require('../specs/NativeKioskAssociate.js') as unknown,
  );
}

export function getNativeKioskConfig(): NativeKioskConfigSpec {
  return resolveNativeModule<NativeKioskConfigSpec>(
    'KioskConfig',
    () => require('../specs/NativeKioskConfig.js') as unknown,
  );
}

export function getNativeKioskSession(): KioskSessionNativeModule {
  return resolveNativeModule<KioskSessionNativeModule>(
    'KioskSession',
    () => require('../specs/NativeKioskSession.js') as unknown,
  );
}
