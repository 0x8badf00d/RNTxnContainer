import {
  AsyncStorage,
  createAsyncStorageShim,
  createUseAsyncStorage,
  useAsyncStorage,
} from './asyncStorageShim.js';
import type {
  AsyncStorageHook,
  AsyncStorageKeyError,
  AsyncStorageStatic,
  Callback,
  CallbackWithResult,
  CreateAsyncStorageShimOptions,
  KeyValuePair,
  MultiCallback,
  MultiGetCallback,
} from './asyncStorageShim.js';
import {
  DEFAULT_MMKV_ID,
  MMKV,
  Mode,
  createMMKV,
  createMMKVRuntime,
  deleteMMKV,
  existsMMKV,
  useMMKV,
  useMMKVBoolean,
  useMMKVBuffer,
  useMMKVKeys,
  useMMKVListener,
  useMMKVNumber,
  useMMKVObject,
  useMMKVString,
} from './mmkvShim.js';
import type {
  Configuration,
  EncryptionType,
  Listener,
  MMKVConstructor,
  MMKVInterface,
  MMKVMode,
  MMKVRuntime,
  MMKVRuntimeOptions,
  MMKVSetAction,
  MMKVSettableValue,
  ReactHooksAdapter,
  RecoveryStrategy,
} from './mmkvShim.js';

export type {
  AsyncStorageHook,
  AsyncStorageKeyError,
  AsyncStorageStatic,
  Callback,
  CallbackWithResult,
  CreateAsyncStorageShimOptions,
  KeyValuePair,
  MultiCallback,
  MultiGetCallback,
  Configuration,
  EncryptionType,
  Listener,
  MMKVConstructor,
  MMKVInterface,
  MMKVMode,
  MMKVRuntime,
  MMKVRuntimeOptions,
  MMKVSetAction,
  MMKVSettableValue,
  ReactHooksAdapter,
  RecoveryStrategy,
};

export {
  AsyncStorage,
  createAsyncStorageShim,
  createUseAsyncStorage,
  useAsyncStorage,
  DEFAULT_MMKV_ID,
  MMKV,
  Mode,
  createMMKV,
  createMMKVRuntime,
  deleteMMKV,
  existsMMKV,
  useMMKV,
  useMMKVBoolean,
  useMMKVBuffer,
  useMMKVKeys,
  useMMKVListener,
  useMMKVNumber,
  useMMKVObject,
  useMMKVString,
};

export interface MemoryStorageRuntimeOptions {
  /** Optional React hooks adapter forwarded to the runtime's MMKV hooks. */
  reactAdapter?: ReactHooksAdapter | null;
}

export interface MemoryStorageRuntime {
  readonly AsyncStorage: AsyncStorageStatic;
  readonly useAsyncStorage: (key: string) => AsyncStorageHook;
  readonly MMKV: MMKVConstructor;
  readonly createMMKV: (configuration?: Configuration) => MMKVInterface;
  readonly Mode: typeof Mode;
  readonly existsMMKV: (id: string) => boolean;
  readonly deleteMMKV: (id: string) => boolean;
  readonly useMMKV: MMKVRuntime['useMMKV'];
  readonly useMMKVString: MMKVRuntime['useMMKVString'];
  readonly useMMKVNumber: MMKVRuntime['useMMKVNumber'];
  readonly useMMKVBoolean: MMKVRuntime['useMMKVBoolean'];
  readonly useMMKVBuffer: MMKVRuntime['useMMKVBuffer'];
  readonly useMMKVObject: MMKVRuntime['useMMKVObject'];
  readonly useMMKVListener: MMKVRuntime['useMMKVListener'];
  readonly useMMKVKeys: MMKVRuntime['useMMKVKeys'];
  /** Wipes all AsyncStorage keys and all MMKV stores/listeners while keeping runtime usable. */
  reset(): void;
  /** Wipes all state & listeners and permanently marks runtime disposed (simulates Hermes VM destruction). Idempotent. */
  dispose(): void;
  readonly isDisposed: boolean;
}

/**
 * Creates a completely isolated in-memory storage runtime representing a single
 * ephemeral customer Hermes VM. Calling dispose() clears all state & listeners
 * and prevents further mutations.
 */
export function createMemoryStorageRuntime(
  options?: MemoryStorageRuntimeOptions,
): MemoryStorageRuntime {
  let disposed = false;
  const asyncBackingMap = new Map<string, string>();
  const scopedAsyncStorage = createAsyncStorageShim(asyncBackingMap, {
    isDisposed: () => disposed,
  });
  const scopedUseAsyncStorage = createUseAsyncStorage(scopedAsyncStorage);
  const mmkvRuntime = createMMKVRuntime({
    reactAdapter: options?.reactAdapter,
  });

  return {
    AsyncStorage: scopedAsyncStorage,
    useAsyncStorage: scopedUseAsyncStorage,
    MMKV: mmkvRuntime.MMKV,
    createMMKV: mmkvRuntime.createMMKV,
    Mode: mmkvRuntime.Mode,
    existsMMKV: mmkvRuntime.existsMMKV,
    deleteMMKV: mmkvRuntime.deleteMMKV,
    useMMKV: mmkvRuntime.useMMKV,
    useMMKVString: mmkvRuntime.useMMKVString,
    useMMKVNumber: mmkvRuntime.useMMKVNumber,
    useMMKVBoolean: mmkvRuntime.useMMKVBoolean,
    useMMKVBuffer: mmkvRuntime.useMMKVBuffer,
    useMMKVObject: mmkvRuntime.useMMKVObject,
    useMMKVListener: mmkvRuntime.useMMKVListener,
    useMMKVKeys: mmkvRuntime.useMMKVKeys,
    reset() {
      if (disposed) {
        throw new Error(
          '[MemoryStorageRuntime] Cannot reset a disposed runtime.',
        );
      }
      asyncBackingMap.clear();
      mmkvRuntime.reset();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      asyncBackingMap.clear();
      mmkvRuntime.dispose();
    },
    get isDisposed(): boolean {
      return disposed;
    },
  };
}

const memoryStorage = {
  AsyncStorage,
  useAsyncStorage,
  MMKV,
  createMMKV,
  Mode,
  createMemoryStorageRuntime,
};

export default memoryStorage;
