export interface AsyncStorageKeyError extends Error {
  key?: string;
}

export type Callback = (error?: Error | null) => void;

export type CallbackWithResult<T> = (
  error?: Error | null,
  result?: T | null,
) => void;

export type KeyValuePair = [string, string | null];

export type MultiCallback = (
  errors?: readonly (Error | null)[] | null,
) => void;

export type MultiGetCallback = (
  errors?: readonly (Error | null)[] | null,
  result?: readonly KeyValuePair[],
) => void;

export interface AsyncStorageHook {
  getItem: (callback?: CallbackWithResult<string>) => Promise<string | null>;
  setItem: (value: string, callback?: Callback) => Promise<void>;
  mergeItem: (value: string, callback?: Callback) => Promise<void>;
  removeItem: (callback?: Callback) => Promise<void>;
}

export interface AsyncStorageStatic {
  getItem(
    key: string,
    callback?: CallbackWithResult<string>,
  ): Promise<string | null>;

  setItem(key: string, value: string, callback?: Callback): Promise<void>;

  removeItem(key: string, callback?: Callback): Promise<void>;

  mergeItem(key: string, value: string, callback?: Callback): Promise<void>;

  clear(callback?: Callback): Promise<void>;

  getAllKeys(
    callback?: CallbackWithResult<readonly string[]>,
  ): Promise<readonly string[]>;

  flushGetRequests(): void;

  multiGet(
    keys: readonly string[],
    callback?: MultiGetCallback,
  ): Promise<readonly KeyValuePair[]>;

  multiSet(
    keyValuePairs: ReadonlyArray<readonly [string, string]>,
    callback?: MultiCallback,
  ): Promise<void>;

  multiRemove(
    keys: readonly string[],
    callback?: MultiCallback,
  ): Promise<void>;

  multiMerge(
    keyValuePairs: ReadonlyArray<readonly [string, string]>,
    callback?: MultiCallback,
  ): Promise<void>;
}

export interface CreateAsyncStorageShimOptions {
  /** Optional disposal predicate used by createMemoryStorageRuntime(). */
  isDisposed?: () => boolean;
}

const FORBIDDEN_MERGE_KEYS: ReadonlySet<string> = new Set<string>([
  '__proto__',
  'constructor',
  'prototype',
]);

function makeKeyError(message: string, key?: string): AsyncStorageKeyError {
  const err = new Error(message) as AsyncStorageKeyError;
  if (key !== undefined) {
    err.key = key;
  }
  return err;
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }
  if (isPlainObject(value)) {
    const clean = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_MERGE_KEYS.has(key)) {
        continue;
      }
      clean[key] = sanitizeJsonValue(value[key]);
    }
    return clean;
  }
  return value;
}

function deepMergePlainObjects(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  // Null-prototype accumulator makes Object.prototype mutation structurally impossible.
  const result = Object.create(null) as Record<string, unknown>;

  for (const key of Object.keys(target)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    result[key] = sanitizeJsonValue(target[key]);
  }

  for (const key of Object.keys(source)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    const sourceVal = source[key];
    const targetVal = result[key];
    if (isPlainObject(targetVal) && isPlainObject(sourceVal)) {
      result[key] = deepMergePlainObjects(targetVal, sourceVal);
    } else {
      // Native iOS RCTMergeRecursive parity: arrays, primitives, null, and type transitions replace targetVal.
      result[key] = sanitizeJsonValue(sourceVal);
    }
  }

  return result;
}

function deepMergeJson(
  existingRaw: string | undefined,
  incomingRaw: string,
  key: string,
): string {
  let incomingParsed: unknown;
  try {
    incomingParsed = JSON.parse(incomingRaw);
  } catch (err) {
    throw makeKeyError(
      `[AsyncStorage] Invalid incoming JSON for key "${key}": ${
        err instanceof Error ? err.message : String(err)
      }`,
      key,
    );
  }

  if (existingRaw === undefined) {
    return JSON.stringify(sanitizeJsonValue(incomingParsed));
  }

  let existingParsed: unknown;
  try {
    existingParsed = JSON.parse(existingRaw);
  } catch (err) {
    throw makeKeyError(
      `[AsyncStorage] Invalid existing JSON for key "${key}": ${
        err instanceof Error ? err.message : String(err)
      }`,
      key,
    );
  }

  if (isPlainObject(existingParsed) && isPlainObject(incomingParsed)) {
    return JSON.stringify(
      deepMergePlainObjects(existingParsed, incomingParsed),
    );
  }

  return JSON.stringify(sanitizeJsonValue(incomingParsed));
}

function assertValidCallback(callback: unknown): void {
  if (callback !== undefined && typeof callback !== 'function') {
    throw new TypeError('[AsyncStorage] Expected callback to be a function.');
  }
}

function assertStringKey(key: unknown): asserts key is string {
  if (typeof key !== 'string') {
    throw makeKeyError('[AsyncStorage] Invalid key: expected a string.');
  }
}

function assertStringValue(
  value: unknown,
  key: string,
): asserts value is string {
  if (value === null || value === undefined) {
    throw makeKeyError(
      `[AsyncStorage] Passing null/undefined as value for key "${key}" is not supported. Use removeItem() instead.`,
      key,
    );
  }
  if (typeof value !== 'string') {
    throw makeKeyError(
      `[AsyncStorage] Invalid value for key "${key}": expected a string.`,
      key,
    );
  }
}

export function createAsyncStorageShim(
  backingMap: Map<string, string> = new Map<string, string>(),
  options?: CreateAsyncStorageShimOptions,
): AsyncStorageStatic {
  const isDisposed = (): boolean => options?.isDisposed?.() === true;

  // FIFO microtask queue so pipelined unawaited calls execute in strict invocation order.
  let queue: Promise<void> = Promise.resolve();

  function enqueue<T>(task: () => T): Promise<T> {
    const resultPromise = queue.then(() => task());
    queue = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    return resultPromise;
  }

  function assertNotDisposed(): void {
    if (isDisposed()) {
      throw new Error(
        '[AsyncStorage] Memory storage runtime has been disposed.',
      );
    }
  }

  return {
    getItem(
      key: string,
      callback?: CallbackWithResult<string>,
    ): Promise<string | null> {
      return enqueue(() => {
        assertValidCallback(callback);
        let value: string | null = null;
        let storageError: Error | null = null;

        try {
          assertStringKey(key);
          if (isDisposed()) {
            value = null;
          } else {
            value = backingMap.has(key) ? (backingMap.get(key) ?? null) : null;
          }
        } catch (err) {
          storageError = toError(err);
        }

        if (callback) {
          if (storageError) {
            callback(storageError, null);
          } else {
            callback(null, value);
          }
        }

        if (storageError) {
          throw storageError;
        }
        return value;
      });
    },

    setItem(key: string, value: string, callback?: Callback): Promise<void> {
      return enqueue(() => {
        assertValidCallback(callback);
        let storageError: Error | null = null;

        try {
          assertNotDisposed();
          assertStringKey(key);
          assertStringValue(value, key);
          backingMap.set(key, value);
        } catch (err) {
          storageError = toError(err);
        }

        if (callback) {
          callback(storageError);
        }

        if (storageError) {
          throw storageError;
        }
      });
    },

    removeItem(key: string, callback?: Callback): Promise<void> {
      return enqueue(() => {
        assertValidCallback(callback);
        let storageError: Error | null = null;

        try {
          assertNotDisposed();
          assertStringKey(key);
          backingMap.delete(key);
        } catch (err) {
          storageError = toError(err);
        }

        if (callback) {
          callback(storageError);
        }

        if (storageError) {
          throw storageError;
        }
      });
    },

    mergeItem(key: string, value: string, callback?: Callback): Promise<void> {
      return enqueue(() => {
        assertValidCallback(callback);
        let storageError: Error | null = null;

        try {
          assertNotDisposed();
          assertStringKey(key);
          assertStringValue(value, key);
          const existing = backingMap.get(key);
          const merged = deepMergeJson(existing, value, key);
          backingMap.set(key, merged);
        } catch (err) {
          storageError = toError(err);
        }

        if (callback) {
          callback(storageError);
        }

        if (storageError) {
          throw storageError;
        }
      });
    },

    clear(callback?: Callback): Promise<void> {
      return enqueue(() => {
        assertValidCallback(callback);
        let storageError: Error | null = null;

        try {
          assertNotDisposed();
          backingMap.clear();
        } catch (err) {
          storageError = toError(err);
        }

        if (callback) {
          callback(storageError);
        }

        if (storageError) {
          throw storageError;
        }
      });
    },

    getAllKeys(
      callback?: CallbackWithResult<readonly string[]>,
    ): Promise<readonly string[]> {
      return enqueue(() => {
        assertValidCallback(callback);
        let keys: readonly string[] = [];
        let storageError: Error | null = null;

        try {
          keys = isDisposed() ? [] : Array.from(backingMap.keys());
        } catch (err) {
          storageError = toError(err);
        }

        if (callback) {
          if (storageError) {
            callback(storageError, null);
          } else {
            callback(null, keys);
          }
        }

        if (storageError) {
          throw storageError;
        }
        return keys;
      });
    },

    flushGetRequests(): void {
      // Pure in-memory Map shim executes reads immediately on microtask queue; synchronous no-op.
    },

    multiGet(
      keys: readonly string[],
      callback?: MultiGetCallback,
    ): Promise<readonly KeyValuePair[]> {
      return enqueue(() => {
        assertValidCallback(callback);
        let result: KeyValuePair[] = [];
        const errors: Error[] = [];

        if (!Array.isArray(keys)) {
          errors.push(
            new TypeError(
              '[AsyncStorage] multiGet expected an array of string keys.',
            ),
          );
        } else {
          const disposedNow = isDisposed();
          for (let i = 0; i < keys.length; i++) {
            const key: unknown = keys[i];
            if (typeof key !== 'string') {
              errors.push(
                makeKeyError(
                  `[AsyncStorage] Invalid key at index ${i}: expected a string.`,
                ),
              );
            }
          }
          if (errors.length === 0) {
            result = keys.map((k): KeyValuePair => [
              k,
              disposedNow
                ? null
                : backingMap.has(k)
                  ? (backingMap.get(k) ?? null)
                  : null,
            ]);
          }
        }

        if (callback) {
          if (errors.length > 0) {
            callback(errors);
          } else {
            callback(null, result);
          }
        }

        if (errors.length > 0) {
          throw errors[0];
        }
        return result;
      });
    },

    multiSet(
      keyValuePairs: ReadonlyArray<readonly [string, string]>,
      callback?: MultiCallback,
    ): Promise<void> {
      return enqueue(() => {
        assertValidCallback(callback);
        let topLevelError: Error | null = null;
        const errors: Error[] = [];

        try {
          assertNotDisposed();
          if (!Array.isArray(keyValuePairs)) {
            throw new TypeError(
              '[AsyncStorage] multiSet expected an array of [key, value] pairs.',
            );
          }
        } catch (err) {
          topLevelError = toError(err);
        }

        if (topLevelError) {
          if (callback) {
            callback([topLevelError]);
          }
          throw topLevelError;
        }

        for (let i = 0; i < keyValuePairs.length; i++) {
          const pair: unknown = keyValuePairs[i];
          if (!Array.isArray(pair) || pair.length < 2) {
            errors.push(
              makeKeyError(
                `[AsyncStorage] Invalid key-value pair at index ${i}: expected [string, string].`,
              ),
            );
            continue;
          }
          const key: unknown = pair[0];
          const value: unknown = pair[1];
          try {
            assertStringKey(key);
            assertStringValue(value, key);
            backingMap.set(key, value);
          } catch (err) {
            errors.push(toError(err));
          }
        }

        if (callback) {
          callback(errors.length > 0 ? errors : null);
        }

        if (errors.length > 0) {
          throw errors;
        }
      });
    },

    multiRemove(
      keys: readonly string[],
      callback?: MultiCallback,
    ): Promise<void> {
      return enqueue(() => {
        assertValidCallback(callback);
        let topLevelError: Error | null = null;
        const errors: Error[] = [];

        try {
          assertNotDisposed();
          if (!Array.isArray(keys)) {
            throw new TypeError(
              '[AsyncStorage] multiRemove expected an array of string keys.',
            );
          }
        } catch (err) {
          topLevelError = toError(err);
        }

        if (topLevelError) {
          if (callback) {
            callback([topLevelError]);
          }
          throw topLevelError;
        }

        for (let i = 0; i < keys.length; i++) {
          const key: unknown = keys[i];
          if (typeof key !== 'string') {
            errors.push(
              makeKeyError(
                `[AsyncStorage] Invalid key at index ${i}: expected a string.`,
              ),
            );
            continue;
          }
          backingMap.delete(key);
        }

        if (callback) {
          callback(errors.length > 0 ? errors : null);
        }

        if (errors.length > 0) {
          throw errors;
        }
      });
    },

    multiMerge(
      keyValuePairs: ReadonlyArray<readonly [string, string]>,
      callback?: MultiCallback,
    ): Promise<void> {
      return enqueue(() => {
        assertValidCallback(callback);
        let topLevelError: Error | null = null;
        const errors: Error[] = [];

        try {
          assertNotDisposed();
          if (!Array.isArray(keyValuePairs)) {
            throw new TypeError(
              '[AsyncStorage] multiMerge expected an array of [key, value] pairs.',
            );
          }
        } catch (err) {
          topLevelError = toError(err);
        }

        if (topLevelError) {
          if (callback) {
            callback([topLevelError]);
          }
          throw topLevelError;
        }

        for (let i = 0; i < keyValuePairs.length; i++) {
          const pair: unknown = keyValuePairs[i];
          if (!Array.isArray(pair) || pair.length < 2) {
            errors.push(
              makeKeyError(
                `[AsyncStorage] Invalid key-value pair at index ${i}: expected [string, string].`,
              ),
            );
            continue;
          }
          const key: unknown = pair[0];
          const value: unknown = pair[1];
          try {
            assertStringKey(key);
            assertStringValue(value, key);
            const existing = backingMap.get(key);
            const merged = deepMergeJson(existing, value, key);
            backingMap.set(key, merged);
          } catch (err) {
            errors.push(toError(err));
          }
        }

        if (callback) {
          callback(errors.length > 0 ? errors : null);
        }

        if (errors.length > 0) {
          throw errors;
        }
      });
    },
  };
}

export function createUseAsyncStorage(
  storage: AsyncStorageStatic,
): (key: string) => AsyncStorageHook {
  return function useAsyncStorage(key: string): AsyncStorageHook {
    return {
      getItem: (callback?: CallbackWithResult<string>) =>
        storage.getItem(key, callback),
      setItem: (value: string, callback?: Callback) =>
        storage.setItem(key, value, callback),
      mergeItem: (value: string, callback?: Callback) =>
        storage.mergeItem(key, value, callback),
      removeItem: (callback?: Callback) => storage.removeItem(key, callback),
    };
  };
}

// Anchor ONLY the module-level default singleton on globalThis[Symbol.for(...)] to prevent
// Dual-Package Hazard across ESM/CJS while keeping createAsyncStorageShim() &
// createMemoryStorageRuntime() 100% detached.
const DEFAULT_ASYNC_STORAGE_SYMBOL = Symbol.for(
  '@internal/kiosk-host/memory-storage/default-async-storage',
);

function getDefaultAsyncStorage(): AsyncStorageStatic {
  const host = globalThis as Record<symbol, unknown>;
  const existing = host[DEFAULT_ASYNC_STORAGE_SYMBOL] as
    | AsyncStorageStatic
    | undefined;
  if (existing !== undefined) {
    return existing;
  }
  const created = createAsyncStorageShim(new Map<string, string>());
  host[DEFAULT_ASYNC_STORAGE_SYMBOL] = created;
  return created;
}

export const AsyncStorage: AsyncStorageStatic = getDefaultAsyncStorage();

export const useAsyncStorage: (key: string) => AsyncStorageHook =
  createUseAsyncStorage(AsyncStorage);

export default AsyncStorage;
