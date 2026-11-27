export const DEFAULT_MMKV_ID = 'mmkv.default';

/**
 * Unified Mode enum compatible with BOTH:
 * - react-native-mmkv v3 (`Mode.SINGLE_PROCESS`, `Mode.MULTI_PROCESS`)
 * - react-native-mmkv v4 (`'single-process' | 'multi-process'`)
 */
export enum Mode {
  SINGLE_PROCESS = 'single-process',
  MULTI_PROCESS = 'multi-process',
}

export type MMKVMode = Mode | 'single-process' | 'multi-process';

export type EncryptionType = 'AES-128' | 'AES-256';

export type RecoveryStrategy = 'discard-on-error' | 'recover-on-error';

export interface Configuration {
  /** Instance identifier. Defaults to `'mmkv.default'`. */
  id?: string;
  /** Accepted for drop-in parity; ignored (zero disk I/O). */
  path?: string;
  /** Accepted for drop-in parity; tracked in-memory via `isEncrypted` (zero disk I/O). */
  encryptionKey?: string;
  /** v4 option. Defaults to `'AES-128'`. */
  encryptionType?: EncryptionType;
  /** Processing mode (v3 `Mode` enum or v4 string literal). Defaults to `Mode.SINGLE_PROCESS`. */
  mode?: MMKVMode;
  /** If `true`, all mutating operations throw an Error. Defaults to `false`. */
  readOnly?: boolean;
  /** v4 optimization flag: when `true`, skips write & listener dispatch if new value equals stored value. Defaults to `false`. */
  compareBeforeSet?: boolean;
  /** v4 option; accepted for parity, no-op in memory. */
  recoveryStrategy?: RecoveryStrategy;
}

export interface Listener {
  remove: () => void;
}

export type MMKVSettableValue =
  | boolean
  | string
  | number
  | ArrayBuffer
  | Uint8Array;

export interface MMKVInterface {
  readonly id: string;
  /** Total byte size of all stored keys (UTF-8) + values (UTF-8 / 8B / 1B / byteLength). */
  readonly size: number;
  /** v4 alias for `size`. */
  readonly byteSize: number;
  /** v4 number of stored key/value pairs (`Map.size`). */
  readonly length: number;
  readonly isReadOnly: boolean;
  readonly isEncrypted: boolean;

  set(key: string, value: MMKVSettableValue): void;
  getString(key: string): string | undefined;
  getNumber(key: string): number | undefined;
  getBoolean(key: string): boolean | undefined;
  /** Returns a freshly copied ArrayBuffer (v3 + v4 upstream parity), or undefined. */
  getBuffer(key: string): ArrayBuffer | undefined;
  contains(key: string): boolean;
  /** v3 deletion method. Fires listeners only if key existed. */
  delete(key: string): void;
  /** v4 deletion method. Returns true if key existed and was removed, false otherwise. */
  remove(key: string): boolean;
  getAllKeys(): string[];
  clearAll(): void;
  /** v3/v4 in-memory encryption key update (preserves all data; throws if isReadOnly). */
  recrypt(key: string | undefined): void;
  /** v4 encryption helper (preserves all data; throws if isReadOnly). */
  encrypt(key: string, encryptionType?: EncryptionType): void;
  /** v4 decryption helper (preserves all data; throws if isReadOnly). */
  decrypt(): void;
  /** No-op in memory. */
  trim(): void;
  /** v4 no-op in single-process memory. */
  checkContentChanged(): void;
  /** v4 bulk import of all key/value types from another MMKV instance. Returns count imported. */
  importAllFrom(other: MMKVInterface): number;
  addOnValueChangedListener(listener: (key: string) => void): Listener;
  toString(): string;
  toJSON(): Record<string, string[]>;
  dispose(): void;
  equals(other: unknown): boolean;
}

export interface MMKVConstructor {
  new (configuration?: Configuration): MMKVInterface;
}

/** Structural subset of React hooks — zero `@types/react` dependency! */
export interface ReactHooksAdapter {
  useRef<T>(initialValue: T): { current: T };
  useState<S>(
    initialState: S | (() => S),
  ): [S, (action: S | ((prev: S) => S)) => void];
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useCallback<T extends (...args: never[]) => unknown>(
    callback: T,
    deps: readonly unknown[],
  ): T;
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  useSyncExternalStore?: <T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ) => T;
}

export interface MMKVRuntimeOptions {
  /**
   * Optional React hooks implementation.
   * - If omitted (`undefined`), lazily attempts `require('react')` ONLY when a `useMMKV*` hook is invoked.
   * - If explicitly `null`, disables dynamic `require('react')` lookup (useful for testing pure-Node error paths).
   * - If provided as an object, uses the adapter for deterministic React hook testing in Node.
   */
  reactAdapter?: ReactHooksAdapter | null;
}

export type MMKVSetAction<T> =
  | T
  | undefined
  | ((current: T | undefined) => T | undefined);

export interface MMKVRuntime {
  readonly MMKV: MMKVConstructor;
  readonly createMMKV: (configuration?: Configuration) => MMKVInterface;
  readonly Mode: typeof Mode;
  readonly existsMMKV: (id: string) => boolean;
  readonly deleteMMKV: (id: string) => boolean;
  readonly useMMKV: {
    (): MMKVInterface;
    (configuration: Configuration): MMKVInterface;
  };
  readonly useMMKVString: (
    key: string,
    instance?: MMKVInterface,
  ) => [string | undefined, (value: MMKVSetAction<string>) => void];
  readonly useMMKVNumber: (
    key: string,
    instance?: MMKVInterface,
  ) => [number | undefined, (value: MMKVSetAction<number>) => void];
  readonly useMMKVBoolean: (
    key: string,
    instance?: MMKVInterface,
  ) => [boolean | undefined, (value: MMKVSetAction<boolean>) => void];
  readonly useMMKVBuffer: (
    key: string,
    instance?: MMKVInterface,
  ) => [
    ArrayBuffer | undefined,
    (
      value:
        | ArrayBuffer
        | Uint8Array
        | undefined
        | ((
            current: ArrayBuffer | undefined,
          ) => ArrayBuffer | Uint8Array | undefined),
    ) => void,
  ];
  readonly useMMKVObject: <T>(
    key: string,
    instance?: MMKVInterface,
  ) => [T | undefined, (value: MMKVSetAction<T>) => void];
  readonly useMMKVListener: (
    valueChangedListener: (key: string) => void,
    instance?: MMKVInterface,
  ) => void;
  readonly useMMKVKeys: (instance?: MMKVInterface) => string[];
  reset(): void;
  dispose(): void;
  readonly isDisposed: boolean;
}

type StoredEntry =
  | {
      readonly type: 'string';
      readonly value: string;
      readonly byteLength: number;
    }
  | { readonly type: 'number'; readonly value: number; readonly byteLength: 8 }
  | {
      readonly type: 'boolean';
      readonly value: boolean;
      readonly byteLength: 1;
    }
  | {
      readonly type: 'buffer';
      readonly value: Uint8Array;
      readonly byteLength: number;
    };

interface MMKVBucket {
  readonly id: string;
  readonly generation: number;
  readonly data: Map<string, StoredEntry>;
  readonly keyRevisions: Map<string, number>;
  clearRevision: number;
  encryptionKey: string | undefined;
  encryptionType: EncryptionType;
  totalByteSize: number;
}

interface MMKVRuntimeState {
  readonly buckets: Map<string, MMKVBucket>;
  readonly listenersById: Map<string, Map<symbol, (key: string) => void>>;
  defaultInstance: MMKVInterface | null;
  disposed: boolean;
  nextBucketGeneration: number;
  resetEpoch: number;
  readonly reactAdapterOption: ReactHooksAdapter | null | undefined;
}

const MMKV_BUCKET_SYMBOL = Symbol.for(
  '@internal/kiosk-host/memory-storage/mmkv-bucket',
);

interface InternalMMKVHandle {
  [MMKV_BUCKET_SYMBOL]?: () => MMKVBucket | null;
}

/**
 * Pure-JS UTF-8 byte length calculation (zero Node Buffer / zero TextEncoder assumption).
 */
function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < str.length) {
        const next = str.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          i++;
          continue;
        }
      }
      bytes += 3;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function cloneUint8Array(source: Uint8Array): Uint8Array {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

function cloneArrayBufferToUint8Array(source: ArrayBuffer): Uint8Array {
  const copy = new Uint8Array(source.byteLength);
  copy.set(new Uint8Array(source));
  return copy;
}

function cloneUint8ArrayToArrayBuffer(source: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer;
}

function entriesEqual(a: StoredEntry, b: StoredEntry): boolean {
  if (a.type !== b.type) {
    return false;
  }
  if (a.type === 'buffer' && b.type === 'buffer') {
    if (a.byteLength !== b.byteLength) {
      return false;
    }
    for (let i = 0; i < a.byteLength; i++) {
      if (a.value[i] !== b.value[i]) {
        return false;
      }
    }
    return true;
  }
  return Object.is(a.value, b.value);
}

function makeStoredEntry(value: MMKVSettableValue): StoredEntry {
  if (typeof value === 'string') {
    return {
      type: 'string',
      value,
      byteLength: utf8ByteLength(value),
    };
  }
  if (typeof value === 'number') {
    return {
      type: 'number',
      value,
      byteLength: 8,
    };
  }
  if (typeof value === 'boolean') {
    return {
      type: 'boolean',
      value,
      byteLength: 1,
    };
  }
  if (value instanceof ArrayBuffer) {
    const copy = cloneArrayBufferToUint8Array(value);
    return {
      type: 'buffer',
      value: copy,
      byteLength: copy.byteLength,
    };
  }
  if (value instanceof Uint8Array) {
    // Copy strictly [byteOffset, byteOffset + byteLength), never the whole backing buffer.
    const copy = cloneUint8Array(value);
    return {
      type: 'buffer',
      value: copy,
      byteLength: copy.byteLength,
    };
  }
  throw new TypeError(
    `[MMKV] Unsupported value type: expected string, number, boolean, ArrayBuffer, or Uint8Array.`,
  );
}

function cloneStoredEntry(entry: StoredEntry): StoredEntry {
  if (entry.type === 'buffer') {
    const copy = cloneUint8Array(entry.value);
    return {
      type: 'buffer',
      value: copy,
      byteLength: copy.byteLength,
    };
  }
  return entry;
}

function assertKeyString(key: unknown): asserts key is string {
  if (typeof key !== 'string') {
    throw new TypeError('[MMKV] Key must be a string.');
  }
}

function bumpKeyRevision(bucket: MMKVBucket, key: string): void {
  const prev = bucket.keyRevisions.get(key) ?? 0;
  bucket.keyRevisions.set(key, prev + 1);
}

function getKeyRevisionToken(bucket: MMKVBucket, key: string): string {
  return `${bucket.generation}:${bucket.clearRevision}:${bucket.keyRevisions.get(key) ?? 0}`;
}

function notifyKeyChanged(
  runtimeState: MMKVRuntimeState,
  id: string,
  key: string,
): void {
  const listeners = runtimeState.listenersById.get(id);
  if (!listeners || listeners.size === 0) {
    return;
  }
  const snapshot = Array.from(listeners.entries());
  for (const [token, cb] of snapshot) {
    const currentListeners = runtimeState.listenersById.get(id);
    if (!currentListeners || !currentListeners.has(token)) {
      continue;
    }
    try {
      cb(key);
    } catch {
      // Isolate per-listener exceptions so subsequent listeners and remaining
      // keys in clearAll()/deleteMMKV()/importAllFrom() are never starved.
    }
  }
}

function writeEntryToBucket(
  bucket: MMKVBucket,
  key: string,
  nextEntry: StoredEntry,
  compareBeforeSet: boolean,
): boolean {
  const existing = bucket.data.get(key);
  if (
    compareBeforeSet &&
    existing !== undefined &&
    entriesEqual(existing, nextEntry)
  ) {
    return false;
  }

  const keyBytes = utf8ByteLength(key);
  if (existing !== undefined) {
    bucket.totalByteSize -= keyBytes + existing.byteLength;
  }
  bucket.data.set(key, nextEntry);
  bucket.totalByteSize += keyBytes + nextEntry.byteLength;
  bumpKeyRevision(bucket, key);
  return true;
}

function configsEqual(
  a: Configuration | undefined,
  b: Configuration | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.id === b.id &&
    a.path === b.path &&
    a.encryptionKey === b.encryptionKey &&
    a.encryptionType === b.encryptionType &&
    a.mode === b.mode &&
    a.readOnly === b.readOnly &&
    a.compareBeforeSet === b.compareBeforeSet &&
    a.recoveryStrategy === b.recoveryStrategy
  );
}

function resolveReactHooks(
  runtimeState: MMKVRuntimeState,
  hookName: string,
): ReactHooksAdapter {
  if (runtimeState.reactAdapterOption !== undefined) {
    if (runtimeState.reactAdapterOption === null) {
      throw new Error(
        `[MMKV] ${hookName}() requires React (reactAdapter was explicitly disabled).`,
      );
    }
    return runtimeState.reactAdapterOption;
  }

  try {
    if (typeof require === 'function') {
      // Static literal 'react' enables Metro bundling in RN apps while failing
      // gracefully in pure Node environments without React installed.
      const mod = require('react') as Partial<ReactHooksAdapter> | undefined;
      if (
        mod &&
        typeof mod.useRef === 'function' &&
        typeof mod.useState === 'function' &&
        typeof mod.useEffect === 'function' &&
        typeof mod.useCallback === 'function' &&
        typeof mod.useMemo === 'function'
      ) {
        return mod as ReactHooksAdapter;
      }
    }
  } catch {
    // Fall through to descriptive error below.
  }

  throw new Error(
    `[MMKV] ${hookName}() requires "react" to be installed or a ReactHooksAdapter to be passed to createMMKVRuntime()/createMemoryStorageRuntime().`,
  );
}

function getBucketFromInstance(instance: MMKVInterface): MMKVBucket | null {
  const getter = (instance as unknown as InternalMMKVHandle)[
    MMKV_BUCKET_SYMBOL
  ];
  return typeof getter === 'function' ? getter() : null;
}

export function createMMKVRuntime(options?: MMKVRuntimeOptions): MMKVRuntime {
  const runtimeState: MMKVRuntimeState = {
    buckets: new Map<string, MMKVBucket>(),
    listenersById: new Map<string, Map<symbol, (key: string) => void>>(),
    defaultInstance: null,
    disposed: false,
    nextBucketGeneration: 1,
    resetEpoch: 0,
    reactAdapterOption: options?.reactAdapter,
  };

  function getOrCreateBucket(config?: Configuration): MMKVBucket {
    if (runtimeState.disposed) {
      throw new Error('[MMKV] Memory storage runtime has been disposed.');
    }

    const rawId = config?.id;
    let id = DEFAULT_MMKV_ID;
    if (rawId !== undefined) {
      if (typeof rawId !== 'string' || rawId.length === 0) {
        throw new Error(
          '[MMKV] Invalid instance id: must be a non-empty string.',
        );
      }
      id = rawId;
    }

    let bucket = runtimeState.buckets.get(id);
    if (!bucket) {
      bucket = {
        id,
        generation: runtimeState.nextBucketGeneration++,
        data: new Map<string, StoredEntry>(),
        keyRevisions: new Map<string, number>(),
        clearRevision: 0,
        encryptionKey:
          config?.encryptionKey && config.encryptionKey.length > 0
            ? config.encryptionKey
            : undefined,
        encryptionType: config?.encryptionType ?? 'AES-128',
        totalByteSize: 0,
      };
      runtimeState.buckets.set(id, bucket);
    }
    return bucket;
  }

  class InMemoryMMKV implements MMKVInterface {
    readonly id: string;
    readonly isReadOnly: boolean;
    private readonly compareBeforeSet: boolean;
    private currentEncryptionKey: string | undefined;
    private currentEncryptionType: EncryptionType;
    private instanceDisposed = false;
    private readonly ownedListeners = new Map<symbol, () => void>();

    constructor(configuration?: Configuration) {
      const initialBucket = getOrCreateBucket(configuration);
      this.id = initialBucket.id;
      this.isReadOnly = Boolean(configuration?.readOnly);
      this.compareBeforeSet = Boolean(configuration?.compareBeforeSet);
      this.currentEncryptionKey =
        configuration?.encryptionKey && configuration.encryptionKey.length > 0
          ? configuration.encryptionKey
          : undefined;
      this.currentEncryptionType = configuration?.encryptionType ?? 'AES-128';

      Object.defineProperty(this, MMKV_BUCKET_SYMBOL, {
        value: (): MMKVBucket | null => this.getLiveBucket() ?? null,
        enumerable: false,
        configurable: false,
      });
    }

    private isEffectivelyDisposed(): boolean {
      return runtimeState.disposed || this.instanceDisposed;
    }

    private getLiveBucket(): MMKVBucket | undefined {
      if (this.isEffectivelyDisposed()) {
        return undefined;
      }
      return runtimeState.buckets.get(this.id);
    }

    private getOrCreateLiveBucket(): MMKVBucket {
      if (this.isEffectivelyDisposed()) {
        throw new Error('[MMKV] Memory storage runtime has been disposed.');
      }
      return getOrCreateBucket({
        id: this.id,
        encryptionKey: this.currentEncryptionKey,
        encryptionType: this.currentEncryptionType,
      });
    }

    private assertWritable(operation: string): void {
      if (this.isEffectivelyDisposed()) {
        throw new Error('[MMKV] Memory storage runtime has been disposed.');
      }
      if (this.isReadOnly) {
        throw new Error(
          `[MMKV] Cannot call ${operation}() on read-only instance "${this.id}".`,
        );
      }
    }

    get size(): number {
      const bucket = this.getLiveBucket();
      return bucket ? bucket.totalByteSize : 0;
    }

    get byteSize(): number {
      return this.size;
    }

    get length(): number {
      const bucket = this.getLiveBucket();
      return bucket ? bucket.data.size : 0;
    }

    get isEncrypted(): boolean {
      const bucket = this.getLiveBucket();
      if (!bucket) {
        return false;
      }
      return (
        bucket.encryptionKey !== undefined && bucket.encryptionKey.length > 0
      );
    }

    set(key: string, value: MMKVSettableValue): void {
      this.assertWritable('set');
      assertKeyString(key);
      if (key.length === 0) {
        throw new Error('[MMKV] Key must not be empty.');
      }
      const nextEntry = makeStoredEntry(value);
      const bucket = this.getOrCreateLiveBucket();
      const changed = writeEntryToBucket(
        bucket,
        key,
        nextEntry,
        this.compareBeforeSet,
      );
      if (changed) {
        notifyKeyChanged(runtimeState, this.id, key);
      }
    }

    getString(key: string): string | undefined {
      assertKeyString(key);
      const bucket = this.getLiveBucket();
      if (!bucket) {
        return undefined;
      }
      const entry = bucket.data.get(key);
      return entry !== undefined && entry.type === 'string'
        ? entry.value
        : undefined;
    }

    getNumber(key: string): number | undefined {
      assertKeyString(key);
      const bucket = this.getLiveBucket();
      if (!bucket) {
        return undefined;
      }
      const entry = bucket.data.get(key);
      return entry !== undefined && entry.type === 'number'
        ? entry.value
        : undefined;
    }

    getBoolean(key: string): boolean | undefined {
      assertKeyString(key);
      const bucket = this.getLiveBucket();
      if (!bucket) {
        return undefined;
      }
      const entry = bucket.data.get(key);
      return entry !== undefined && entry.type === 'boolean'
        ? entry.value
        : undefined;
    }

    getBuffer(key: string): ArrayBuffer | undefined {
      assertKeyString(key);
      const bucket = this.getLiveBucket();
      if (!bucket) {
        return undefined;
      }
      const entry = bucket.data.get(key);
      if (entry === undefined || entry.type !== 'buffer') {
        return undefined;
      }
      return cloneUint8ArrayToArrayBuffer(entry.value);
    }

    contains(key: string): boolean {
      assertKeyString(key);
      const bucket = this.getLiveBucket();
      if (!bucket) {
        return false;
      }
      return bucket.data.has(key);
    }

    delete(key: string): void {
      this.assertWritable('delete');
      assertKeyString(key);
      const bucket = this.getLiveBucket();
      if (!bucket) {
        return;
      }
      const existing = bucket.data.get(key);
      if (existing === undefined) {
        return;
      }
      bucket.data.delete(key);
      bucket.totalByteSize -= utf8ByteLength(key) + existing.byteLength;
      bumpKeyRevision(bucket, key);
      notifyKeyChanged(runtimeState, this.id, key);
    }

    remove(key: string): boolean {
      this.assertWritable('remove');
      assertKeyString(key);
      const bucket = this.getLiveBucket();
      if (!bucket) {
        return false;
      }
      const existing = bucket.data.get(key);
      if (existing === undefined) {
        return false;
      }
      bucket.data.delete(key);
      bucket.totalByteSize -= utf8ByteLength(key) + existing.byteLength;
      bumpKeyRevision(bucket, key);
      notifyKeyChanged(runtimeState, this.id, key);
      return true;
    }

    getAllKeys(): string[] {
      const bucket = this.getLiveBucket();
      if (!bucket) {
        return [];
      }
      return Array.from(bucket.data.keys());
    }

    clearAll(): void {
      this.assertWritable('clearAll');
      const bucket = this.getLiveBucket();
      if (!bucket || bucket.data.size === 0) {
        return;
      }
      const removedKeys = Array.from(bucket.data.keys());
      bucket.data.clear();
      bucket.keyRevisions.clear();
      bucket.clearRevision += 1;
      bucket.totalByteSize = 0;
      const epoch = runtimeState.resetEpoch;
      for (const key of removedKeys) {
        if (runtimeState.resetEpoch !== epoch) {
          break;
        }
        notifyKeyChanged(runtimeState, this.id, key);
      }
    }

    recrypt(key: string | undefined): void {
      this.assertWritable('recrypt');
      if (key !== undefined && typeof key !== 'string') {
        throw new TypeError(
          '[MMKV] recrypt() expected a string or undefined encryption key.',
        );
      }
      const normalizedKey =
        key !== undefined && key.length > 0 ? key : undefined;
      this.currentEncryptionKey = normalizedKey;
      if (normalizedKey === undefined) {
        const bucket = this.getLiveBucket();
        if (bucket) {
          bucket.encryptionKey = undefined;
        }
        return;
      }
      const bucket = this.getOrCreateLiveBucket();
      bucket.encryptionKey = normalizedKey;
    }

    encrypt(key: string, encryptionType?: EncryptionType): void {
      this.assertWritable('encrypt');
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error(
          '[MMKV] encrypt() requires a non-empty encryption key.',
        );
      }
      this.currentEncryptionKey = key;
      if (encryptionType !== undefined) {
        this.currentEncryptionType = encryptionType;
      }
      const bucket = this.getOrCreateLiveBucket();
      bucket.encryptionKey = key;
      if (encryptionType !== undefined) {
        bucket.encryptionType = encryptionType;
      }
    }

    decrypt(): void {
      this.assertWritable('decrypt');
      this.currentEncryptionKey = undefined;
      const bucket = this.getLiveBucket();
      if (bucket) {
        bucket.encryptionKey = undefined;
      }
    }

    trim(): void {
      // Pure in-memory Map requires no compaction.
    }

    checkContentChanged(): void {
      // Pure in-memory single-process Map is always synchronized.
    }

    importAllFrom(other: MMKVInterface): number {
      this.assertWritable('importAllFrom');
      if (!other || typeof other !== 'object') {
        throw new TypeError(
          '[MMKV] importAllFrom() expected a valid MMKV instance.',
        );
      }

      const importedEntries: Array<[string, StoredEntry]> = [];
      const otherBucket = getBucketFromInstance(other);

      if (otherBucket !== null) {
        for (const [k, entry] of otherBucket.data.entries()) {
          assertKeyString(k);
          if (k.length === 0) {
            throw new Error('[MMKV] Key must not be empty.');
          }
          importedEntries.push([k, cloneStoredEntry(entry)]);
        }
      } else {
        const keys = other.getAllKeys();
        for (const k of keys) {
          assertKeyString(k);
          if (k.length === 0) {
            throw new Error('[MMKV] Key must not be empty.');
          }
          const strVal = other.getString(k);
          if (strVal !== undefined) {
            importedEntries.push([k, makeStoredEntry(strVal)]);
            continue;
          }
          const numVal = other.getNumber(k);
          if (numVal !== undefined) {
            importedEntries.push([k, makeStoredEntry(numVal)]);
            continue;
          }
          const boolVal = other.getBoolean(k);
          if (boolVal !== undefined) {
            importedEntries.push([k, makeStoredEntry(boolVal)]);
            continue;
          }
          const bufVal = other.getBuffer(k);
          if (bufVal !== undefined) {
            importedEntries.push([k, makeStoredEntry(bufVal)]);
          }
        }
      }

      if (importedEntries.length === 0) {
        return 0;
      }

      const bucket = this.getOrCreateLiveBucket();
      const changedKeys: string[] = [];
      for (const [k, entry] of importedEntries) {
        const changed = writeEntryToBucket(
          bucket,
          k,
          entry,
          this.compareBeforeSet,
        );
        if (changed) {
          changedKeys.push(k);
        }
      }

      const epoch = runtimeState.resetEpoch;
      for (const k of changedKeys) {
        if (runtimeState.resetEpoch !== epoch) {
          break;
        }
        notifyKeyChanged(runtimeState, this.id, k);
      }

      return importedEntries.length;
    }

    addOnValueChangedListener(listener: (key: string) => void): Listener {
      if (typeof listener !== 'function') {
        throw new TypeError('[MMKV] Listener must be a function.');
      }
      if (this.isEffectivelyDisposed()) {
        return {
          remove: () => {
            // No-op for disposed runtime/instance
          },
        };
      }
      let listeners = runtimeState.listenersById.get(this.id);
      if (!listeners) {
        listeners = new Map<symbol, (key: string) => void>();
        runtimeState.listenersById.set(this.id, listeners);
      }
      const token = Symbol('mmkv-listener');
      listeners.set(token, listener);

      const cleanup = (): void => {
        const current = runtimeState.listenersById.get(this.id);
        if (current) {
          current.delete(token);
          if (current.size === 0) {
            runtimeState.listenersById.delete(this.id);
          }
        }
        this.ownedListeners.delete(token);
      };
      this.ownedListeners.set(token, cleanup);

      let removed = false;
      return {
        remove: () => {
          if (removed) {
            return;
          }
          removed = true;
          cleanup();
        },
      };
    }

    toString(): string {
      return `MMKV (${this.id})`;
    }

    toJSON(): Record<string, string[]> {
      return {
        [this.id]: this.getAllKeys(),
      };
    }

    dispose(): void {
      if (this.instanceDisposed) {
        return;
      }
      this.instanceDisposed = true;
      if (runtimeState.defaultInstance === this) {
        runtimeState.defaultInstance = null;
      }
      for (const cleanup of Array.from(this.ownedListeners.values())) {
        cleanup();
      }
      this.ownedListeners.clear();
    }

    equals(other: unknown): boolean {
      return other === this;
    }
  }

  const createMMKV = (configuration?: Configuration): MMKVInterface => {
    return new InMemoryMMKV(configuration);
  };

  function getDefaultInstance(): MMKVInterface {
    if (runtimeState.disposed) {
      throw new Error('[MMKV] Memory storage runtime has been disposed.');
    }
    if (runtimeState.defaultInstance === null) {
      runtimeState.defaultInstance = new InMemoryMMKV({ id: DEFAULT_MMKV_ID });
    }
    return runtimeState.defaultInstance;
  }

  const existsMMKV = (id: string): boolean => {
    if (runtimeState.disposed || typeof id !== 'string' || id.length === 0) {
      return false;
    }
    return runtimeState.buckets.has(id);
  };

  const deleteMMKV = (id: string): boolean => {
    if (runtimeState.disposed) {
      throw new Error('[MMKV] Memory storage runtime has been disposed.');
    }
    if (typeof id !== 'string' || id.length === 0) {
      return false;
    }
    const bucket = runtimeState.buckets.get(id);
    if (!bucket) {
      return false;
    }
    const removedKeys = Array.from(bucket.data.keys());
    bucket.data.clear();
    bucket.keyRevisions.clear();
    bucket.clearRevision += 1;
    bucket.totalByteSize = 0;
    runtimeState.buckets.delete(id);
    const epoch = runtimeState.resetEpoch;
    for (const key of removedKeys) {
      if (runtimeState.resetEpoch !== epoch) {
        break;
      }
      notifyKeyChanged(runtimeState, id, key);
    }
    return true;
  };

  function useMMKV(): MMKVInterface;
  function useMMKV(configuration: Configuration): MMKVInterface;
  function useMMKV(configuration?: Configuration): MMKVInterface {
    const react = resolveReactHooks(runtimeState, 'useMMKV');
    const cacheRef = react.useRef<{
      initialized: boolean;
      config: Configuration | undefined;
      instance: MMKVInterface | null;
    }>({
      initialized: false,
      config: undefined,
      instance: null,
    });

    if (
      !cacheRef.current.initialized ||
      !configsEqual(cacheRef.current.config, configuration)
    ) {
      cacheRef.current.initialized = true;
      cacheRef.current.config =
        configuration !== undefined ? { ...configuration } : undefined;
      cacheRef.current.instance =
        configuration === undefined
          ? getDefaultInstance()
          : new InMemoryMMKV(configuration);
    }

    return cacheRef.current.instance!;
  }

  function createPrimitiveValueHook<T extends string | number | boolean>(
    hookName: string,
    getter: (mmkv: MMKVInterface, key: string) => T | undefined,
  ): (
    key: string,
    instance?: MMKVInterface,
  ) => [T | undefined, (value: MMKVSetAction<T>) => void] {
    return function useMMKVValue(
      key: string,
      instance?: MMKVInterface,
    ): [T | undefined, (value: MMKVSetAction<T>) => void] {
      const react = resolveReactHooks(runtimeState, hookName);
      const mmkv = instance ?? getDefaultInstance();

      const subscribe = react.useCallback(
        (onStoreChange: () => void) => {
          const listener = mmkv.addOnValueChangedListener((changedKey) => {
            if (changedKey === key) {
              onStoreChange();
            }
          });
          return () => {
            listener.remove();
          };
        },
        [mmkv, key],
      );

      const getSnapshot = react.useCallback(
        () => getter(mmkv, key),
        [mmkv, key],
      );

      let value: T | undefined;
      if (typeof react.useSyncExternalStore === 'function') {
        value = react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      } else {
        const [, setTick] = react.useState(0);
        react.useEffect(() => {
          return subscribe(() => {
            setTick((t) => t + 1);
          });
        }, [subscribe]);
        value = getSnapshot();
      }

      const set = react.useCallback(
        (v: MMKVSetAction<T>) => {
          const next =
            typeof v === 'function'
              ? (v as (current: T | undefined) => T | undefined)(
                  getter(mmkv, key),
                )
              : v;
          if (next === undefined) {
            mmkv.remove(key);
          } else if (
            typeof next === 'string' ||
            typeof next === 'number' ||
            typeof next === 'boolean'
          ) {
            mmkv.set(key, next);
          } else {
            throw new TypeError(
              `[MMKV] Unsupported value type in ${hookName} setter: ${typeof next}`,
            );
          }
        },
        [mmkv, key],
      );

      return [value, set];
    };
  }

  const useMMKVString = createPrimitiveValueHook<string>(
    'useMMKVString',
    (mmkv, key) => mmkv.getString(key),
  );

  const useMMKVNumber = createPrimitiveValueHook<number>(
    'useMMKVNumber',
    (mmkv, key) => mmkv.getNumber(key),
  );

  const useMMKVBoolean = createPrimitiveValueHook<boolean>(
    'useMMKVBoolean',
    (mmkv, key) => mmkv.getBoolean(key),
  );

  const useMMKVBuffer: MMKVRuntime['useMMKVBuffer'] = (
    key: string,
    instance?: MMKVInterface,
  ) => {
    const react = resolveReactHooks(runtimeState, 'useMMKVBuffer');
    const mmkv = instance ?? getDefaultInstance();

    const fallbackVersionRef = react.useRef(0);
    const cacheRef = react.useRef<{
      initialized: boolean;
      mmkv: MMKVInterface | null;
      key: string;
      token: string;
      value: ArrayBuffer | undefined;
    }>({
      initialized: false,
      mmkv: null,
      key: '',
      token: '',
      value: undefined,
    });

    const subscribe = react.useCallback(
      (onStoreChange: () => void) => {
        const listener = mmkv.addOnValueChangedListener((changedKey) => {
          if (changedKey === key) {
            fallbackVersionRef.current += 1;
            onStoreChange();
          }
        });
        return () => {
          listener.remove();
        };
      },
      [mmkv, key],
    );

    // Cache buffer snapshot per (instance, key, bucket key revision) so
    // React 18/19 useSyncExternalStore receives referentially stable snapshots
    // between mutations while still picking up any mutation immediately.
    const getSnapshot = react.useCallback((): ArrayBuffer | undefined => {
      const bucket = getBucketFromInstance(mmkv);
      const token = bucket
        ? getKeyRevisionToken(bucket, key)
        : `ext:${fallbackVersionRef.current}`;

      if (
        cacheRef.current.initialized &&
        cacheRef.current.mmkv === mmkv &&
        cacheRef.current.key === key &&
        cacheRef.current.token === token
      ) {
        return cacheRef.current.value;
      }

      const nextValue = mmkv.getBuffer(key);
      cacheRef.current = {
        initialized: true,
        mmkv,
        key,
        token,
        value: nextValue,
      };
      return nextValue;
    }, [mmkv, key]);

    let value: ArrayBuffer | undefined;
    if (typeof react.useSyncExternalStore === 'function') {
      value = react.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    } else {
      const [, setTick] = react.useState(0);
      react.useEffect(() => {
        return subscribe(() => {
          setTick((t) => t + 1);
        });
      }, [subscribe]);
      value = getSnapshot();
    }

    const set = react.useCallback(
      (
        v:
          | ArrayBuffer
          | Uint8Array
          | undefined
          | ((
              current: ArrayBuffer | undefined,
            ) => ArrayBuffer | Uint8Array | undefined),
      ) => {
        const next = typeof v === 'function' ? v(mmkv.getBuffer(key)) : v;
        if (next === undefined) {
          mmkv.remove(key);
        } else if (next instanceof ArrayBuffer || next instanceof Uint8Array) {
          mmkv.set(key, next);
        } else {
          throw new TypeError(
            `[MMKV] Unsupported value type in useMMKVBuffer setter: ${typeof next}`,
          );
        }
      },
      [mmkv, key],
    );

    return [value, set];
  };

  function useMMKVObject<T>(
    key: string,
    instance?: MMKVInterface,
  ): [T | undefined, (value: MMKVSetAction<T>) => void] {
    const react = resolveReactHooks(runtimeState, 'useMMKVObject');
    const mmkv = instance ?? getDefaultInstance();
    const [json, setJson] = useMMKVString(key, mmkv);

    const value = react.useMemo((): T | undefined => {
      if (json === undefined) {
        return undefined;
      }
      return JSON.parse(json) as T;
    }, [json]);

    const setObject = react.useCallback(
      (v: MMKVSetAction<T>) => {
        let next: T | undefined;
        if (typeof v === 'function') {
          const currentRaw = mmkv.getString(key);
          const currentParsed =
            currentRaw === undefined
              ? undefined
              : (JSON.parse(currentRaw) as T);
          next = (v as (current: T | undefined) => T | undefined)(
            currentParsed,
          );
        } else {
          next = v;
        }

        if (next === undefined || next === null) {
          setJson(undefined);
        } else {
          setJson(JSON.stringify(next));
        }
      },
      [mmkv, key, setJson],
    );

    return [value, setObject];
  }

  const useMMKVListener = (
    valueChangedListener: (key: string) => void,
    instance?: MMKVInterface,
  ): void => {
    const react = resolveReactHooks(runtimeState, 'useMMKVListener');
    const mmkv = instance ?? getDefaultInstance();
    const callbackRef = react.useRef(valueChangedListener);
    callbackRef.current = valueChangedListener;

    react.useEffect(() => {
      const listener = mmkv.addOnValueChangedListener((changedKey) => {
        callbackRef.current(changedKey);
      });
      return () => {
        listener.remove();
      };
    }, [mmkv]);
  };

  const useMMKVKeys = (instance?: MMKVInterface): string[] => {
    const react = resolveReactHooks(runtimeState, 'useMMKVKeys');
    const mmkv = instance ?? getDefaultInstance();
    const [keys, setKeys] = react.useState<string[]>(() => mmkv.getAllKeys());

    react.useEffect(() => {
      const syncKeys = (): void => {
        const nextKeys = mmkv.getAllKeys();
        setKeys((prev) => {
          if (prev.length === nextKeys.length) {
            let same = true;
            for (let i = 0; i < prev.length; i++) {
              if (prev[i] !== nextKeys[i]) {
                same = false;
                break;
              }
            }
            if (same) {
              return prev;
            }
          }
          return nextKeys;
        });
      };

      // Sync once on mount/instance change so mutations between initial render
      // and effect subscription are never missed (returns prev with zero re-render if unchanged).
      syncKeys();

      const listener = mmkv.addOnValueChangedListener(syncKeys);
      return () => {
        listener.remove();
      };
    }, [mmkv]);

    return keys;
  };

  return {
    MMKV: InMemoryMMKV,
    createMMKV,
    Mode,
    existsMMKV,
    deleteMMKV,
    useMMKV,
    useMMKVString,
    useMMKVNumber,
    useMMKVBoolean,
    useMMKVBuffer,
    useMMKVObject,
    useMMKVListener,
    useMMKVKeys,
    reset() {
      if (runtimeState.disposed) {
        throw new Error('[MMKV] Cannot reset a disposed runtime.');
      }
      for (const bucket of runtimeState.buckets.values()) {
        bucket.data.clear();
        bucket.keyRevisions.clear();
        bucket.clearRevision += 1;
        bucket.totalByteSize = 0;
      }
      runtimeState.buckets.clear();
      for (const listeners of runtimeState.listenersById.values()) {
        listeners.clear();
      }
      runtimeState.listenersById.clear();
      runtimeState.defaultInstance = null;
      runtimeState.resetEpoch += 1;
    },
    dispose() {
      if (runtimeState.disposed) {
        return;
      }
      runtimeState.disposed = true;
      for (const bucket of runtimeState.buckets.values()) {
        bucket.data.clear();
        bucket.keyRevisions.clear();
        bucket.clearRevision += 1;
        bucket.totalByteSize = 0;
      }
      runtimeState.buckets.clear();
      for (const listeners of runtimeState.listenersById.values()) {
        listeners.clear();
      }
      runtimeState.listenersById.clear();
      runtimeState.defaultInstance = null;
      runtimeState.resetEpoch += 1;
    },
    get isDisposed(): boolean {
      return runtimeState.disposed;
    },
  };
}

// Anchor ONLY the module-level default MMKV runtime on globalThis[Symbol.for(...)] to prevent
// Dual-Package Hazard across ESM/CJS while keeping createMMKVRuntime() &
// createMemoryStorageRuntime() 100% detached.
const DEFAULT_MMKV_RUNTIME_SYMBOL = Symbol.for(
  '@internal/kiosk-host/memory-storage/default-mmkv-runtime',
);

function getDefaultMMKVRuntime(): MMKVRuntime {
  const host = globalThis as Record<symbol, unknown>;
  const existing = host[DEFAULT_MMKV_RUNTIME_SYMBOL] as MMKVRuntime | undefined;
  if (existing !== undefined) {
    return existing;
  }
  const created = createMMKVRuntime();
  host[DEFAULT_MMKV_RUNTIME_SYMBOL] = created;
  return created;
}

const defaultMMKVRuntime = getDefaultMMKVRuntime();

export const MMKV: MMKVConstructor = defaultMMKVRuntime.MMKV;
export type MMKV = MMKVInterface;

export const createMMKV: (configuration?: Configuration) => MMKVInterface =
  defaultMMKVRuntime.createMMKV;

export const existsMMKV: (id: string) => boolean =
  defaultMMKVRuntime.existsMMKV;

export const deleteMMKV: (id: string) => boolean =
  defaultMMKVRuntime.deleteMMKV;

export const useMMKV: MMKVRuntime['useMMKV'] = defaultMMKVRuntime.useMMKV;
export const useMMKVString: MMKVRuntime['useMMKVString'] =
  defaultMMKVRuntime.useMMKVString;
export const useMMKVNumber: MMKVRuntime['useMMKVNumber'] =
  defaultMMKVRuntime.useMMKVNumber;
export const useMMKVBoolean: MMKVRuntime['useMMKVBoolean'] =
  defaultMMKVRuntime.useMMKVBoolean;
export const useMMKVBuffer: MMKVRuntime['useMMKVBuffer'] =
  defaultMMKVRuntime.useMMKVBuffer;
export const useMMKVObject: MMKVRuntime['useMMKVObject'] =
  defaultMMKVRuntime.useMMKVObject;
export const useMMKVListener: MMKVRuntime['useMMKVListener'] =
  defaultMMKVRuntime.useMMKVListener;
export const useMMKVKeys: MMKVRuntime['useMMKVKeys'] =
  defaultMMKVRuntime.useMMKVKeys;
