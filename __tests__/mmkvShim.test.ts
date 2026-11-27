import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MMKV_ID,
  MMKV,
  Mode,
  createMMKV,
  createMMKVRuntime,
  deleteMMKV,
  existsMMKV,
} from '../src/memory-storage/mmkvShim.js';
import type { ReactHooksAdapter } from '../src/memory-storage/mmkvShim.js';

/**
 * Minimal deterministic React hook execution harness for pure-Node testing of
 * all 8 MMKV React hooks (both with and without useSyncExternalStore).
 */
function createTestReactHarness(options?: {
  includeUseSyncExternalStore?: boolean;
}) {
  const includeSyncStore = options?.includeUseSyncExternalStore ?? true;
  let hookIndex = 0;
  const slots: unknown[] = [];
  const effectCleanups = new Map<number, (() => void) | undefined>();
  const syncStoreUnsubscribes = new Map<number, () => void>();
  let currentRenderFn: (() => unknown) | null = null;
  let renderCount = 0;

  function depsChanged(
    prev: readonly unknown[] | undefined,
    next: readonly unknown[] | undefined,
  ): boolean {
    if (prev === undefined || next === undefined) return true;
    if (prev.length !== next.length) return true;
    for (let i = 0; i < prev.length; i++) {
      if (!Object.is(prev[i], next[i])) return true;
    }
    return false;
  }

  function rerender(): unknown {
    if (!currentRenderFn) return undefined;
    hookIndex = 0;
    renderCount += 1;
    return currentRenderFn();
  }

  const adapter: ReactHooksAdapter = {
    useRef<T>(initialValue: T): { current: T } {
      const idx = hookIndex++;
      if (!(idx in slots)) {
        slots[idx] = { current: initialValue };
      }
      return slots[idx] as { current: T };
    },

    useState<S>(
      initialState: S | (() => S),
    ): [S, (action: S | ((prev: S) => S)) => void] {
      const idx = hookIndex++;
      if (!(idx in slots)) {
        slots[idx] =
          typeof initialState === 'function'
            ? (initialState as () => S)()
            : initialState;
      }
      const setState = (action: S | ((prev: S) => S)) => {
        const prev = slots[idx] as S;
        const next =
          typeof action === 'function'
            ? (action as (p: S) => S)(prev)
            : action;
        if (!Object.is(prev, next)) {
          slots[idx] = next;
          rerender();
        }
      };
      return [slots[idx] as S, setState];
    },

    useEffect(
      effect: () => void | (() => void),
      deps?: readonly unknown[],
    ): void {
      const idx = hookIndex++;
      const prev = slots[idx] as { deps?: readonly unknown[] } | undefined;
      if (!prev || depsChanged(prev.deps, deps)) {
        const prevCleanup = effectCleanups.get(idx);
        if (prevCleanup) prevCleanup();
        slots[idx] = { deps };
        const cleanup = effect();
        effectCleanups.set(idx, typeof cleanup === 'function' ? cleanup : undefined);
      }
    },

    useCallback<T extends (...args: never[]) => unknown>(
      callback: T,
      deps: readonly unknown[],
    ): T {
      const idx = hookIndex++;
      const prev = slots[idx] as
        | { callback: T; deps: readonly unknown[] }
        | undefined;
      if (!prev || depsChanged(prev.deps, deps)) {
        slots[idx] = { callback, deps };
        return callback;
      }
      return prev.callback;
    },

    useMemo<T>(factory: () => T, deps: readonly unknown[]): T {
      const idx = hookIndex++;
      const prev = slots[idx] as
        | { value: T; deps: readonly unknown[] }
        | undefined;
      if (!prev || depsChanged(prev.deps, deps)) {
        const value = factory();
        slots[idx] = { value, deps };
        return value;
      }
      return prev.value;
    },
  };

  if (includeSyncStore) {
    adapter.useSyncExternalStore = <T>(
      subscribe: (onStoreChange: () => void) => () => void,
      getSnapshot: () => T,
    ): T => {
      const idx = hookIndex++;
      const prev = slots[idx] as
        | { subscribe: typeof subscribe }
        | undefined;
      if (!prev || prev.subscribe !== subscribe) {
        syncStoreUnsubscribes.get(idx)?.();
        slots[idx] = { subscribe };
        const unsub = subscribe(() => {
          rerender();
        });
        syncStoreUnsubscribes.set(idx, unsub);
      }
      // Mimic React 18/19 dev-mode referential stability check: calling getSnapshot twice
      // back-to-back without mutation MUST return Object.is-equal values!
      const snap1 = getSnapshot();
      const snap2 = getSnapshot();
      if (!Object.is(snap1, snap2)) {
        throw new Error(
          'useSyncExternalStore getSnapshot() is not cached (infinite loop risk)!',
        );
      }
      return snap1;
    };
  }

  return {
    adapter,
    render<T>(fn: () => T): T {
      currentRenderFn = fn;
      return rerender() as T;
    },
    getRenderCount: () => renderCount,
    unmount() {
      for (const cleanup of effectCleanups.values()) {
        cleanup?.();
      }
      effectCleanups.clear();
      for (const unsub of syncStoreUnsubscribes.values()) {
        unsub();
      }
      syncStoreUnsubscribes.clear();
      slots.length = 0;
      currentRenderFn = null;
    },
  };
}

describe('MMKV Pure In-Memory JS Map Shim (v3 + v4 Unified)', () => {
  afterEach(() => {
    deleteMMKV(DEFAULT_MMKV_ID);
  });

  it('supports v3 (new MMKV, delete, Mode.SINGLE_PROCESS) and v4 (createMMKV, remove, string modes, existsMMKV, deleteMMKV)', () => {
    const runtime = createMMKVRuntime();

    expect(runtime.existsMMKV(DEFAULT_MMKV_ID)).toBe(false);
    const v3 = new runtime.MMKV({
      id: DEFAULT_MMKV_ID,
      mode: Mode.SINGLE_PROCESS,
    });
    const v4 = runtime.createMMKV({
      id: DEFAULT_MMKV_ID,
      mode: 'single-process',
    });

    expect(v3.id).toBe(DEFAULT_MMKV_ID);
    expect(v4.id).toBe(DEFAULT_MMKV_ID);
    expect(runtime.existsMMKV(DEFAULT_MMKV_ID)).toBe(true);
    expect(v3.toString()).toBe(`MMKV (${DEFAULT_MMKV_ID})`);
    expect(v3.equals(v3)).toBe(true);
    expect(v3.equals(v4)).toBe(false);

    // Same id shares data across v3 and v4 instances inside one runtime
    v3.set('greeting', 'hello');
    expect(v4.getString('greeting')).toBe('hello');
    expect(v4.contains('greeting')).toBe(true);
    expect(v4.length).toBe(1);
    expect(v4.toJSON()).toEqual({ [DEFAULT_MMKV_ID]: ['greeting'] });

    // v4 remove returns boolean; v3 delete returns void
    expect(v4.remove('missing')).toBe(false);
    expect(v4.remove('greeting')).toBe(true);
    expect(v4.contains('greeting')).toBe(false);

    v4.set('k', 42);
    v3.delete('k');
    expect(v4.contains('k')).toBe(false);

    // Cross-id isolation
    const cart = runtime.createMMKV({ id: 'cart' });
    cart.set('sku', 'ABC');
    expect(v3.getString('sku')).toBeUndefined();
    expect(runtime.existsMMKV('cart')).toBe(true);
    expect(runtime.deleteMMKV('cart')).toBe(true);
    expect(runtime.existsMMKV('cart')).toBe(false);
    expect(runtime.deleteMMKV('cart')).toBe(false);

    // Module-level default singletons work cleanly too
    const defaultStore = new MMKV();
    defaultStore.set('mod', 'val');
    expect(createMMKV().getString('mod')).toBe('val');
    expect(existsMMKV(DEFAULT_MMKV_ID)).toBe(true);
  });

  it('enforces strict type mismatches and preserves edge values (NaN, -0, Infinity, "", false, 0-byte buffer)', () => {
    const runtime = createMMKVRuntime();
    const mmkv = runtime.createMMKV();

    // String stored -> other getters return undefined
    mmkv.set('s', '123');
    expect(mmkv.getString('s')).toBe('123');
    expect(mmkv.getNumber('s')).toBeUndefined();
    expect(mmkv.getBoolean('s')).toBeUndefined();
    expect(mmkv.getBuffer('s')).toBeUndefined();

    // Empty string "" preserved
    mmkv.set('emptyStr', '');
    expect(mmkv.contains('emptyStr')).toBe(true);
    expect(mmkv.getString('emptyStr')).toBe('');

    // Number edge values: 0, -0, NaN, Infinity
    mmkv.set('zero', 0);
    expect(mmkv.getNumber('zero')).toBe(0);
    expect(mmkv.getString('zero')).toBeUndefined();
    expect(mmkv.getBoolean('zero')).toBeUndefined();

    mmkv.set('negZero', -0);
    expect(Object.is(mmkv.getNumber('negZero'), -0)).toBe(true);

    mmkv.set('nanVal', NaN);
    expect(mmkv.contains('nanVal')).toBe(true);
    expect(Number.isNaN(mmkv.getNumber('nanVal'))).toBe(true);

    mmkv.set('infVal', Infinity);
    expect(mmkv.getNumber('infVal')).toBe(Infinity);

    // Boolean false preserved
    mmkv.set('boolFalse', false);
    expect(mmkv.contains('boolFalse')).toBe(true);
    expect(mmkv.getBoolean('boolFalse')).toBe(false);
    expect(mmkv.getNumber('boolFalse')).toBeUndefined();

    // Empty 0-byte buffer preserved as ArrayBuffer
    mmkv.set('emptyBuf', new Uint8Array(0));
    expect(mmkv.contains('emptyBuf')).toBe(true);
    const emptyOut = mmkv.getBuffer('emptyBuf');
    expect(emptyOut).toBeInstanceOf(ArrayBuffer);
    expect(emptyOut?.byteLength).toBe(0);

    // Overwriting type replaces cleanly
    mmkv.set('s', true);
    expect(mmkv.getString('s')).toBeUndefined();
    expect(mmkv.getBoolean('s')).toBe(true);
  });

  it('defensively copies ArrayBuffer and Uint8Array subarrays on write AND read', () => {
    const runtime = createMMKVRuntime();
    const mmkv = runtime.createMMKV();

    // Subarray writes ONLY [byteOffset, byteOffset + byteLength)
    const parent = new Uint8Array([99, 10, 20, 30, 88]);
    const slice = parent.subarray(1, 4);
    mmkv.set('slice', slice);

    // Mutating caller's buffer after set() does not alter stored bytes
    parent[1] = 0;
    parent[2] = 0;
    const read1 = mmkv.getBuffer('slice');
    expect(read1).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(read1!))).toEqual([10, 20, 30]);

    // Mutating returned ArrayBuffer does not alter stored bytes
    new Uint8Array(read1!)[0] = 255;
    const read2 = mmkv.getBuffer('slice');
    expect(Array.from(new Uint8Array(read2!))).toEqual([10, 20, 30]);

    // ArrayBuffer write + DataView compatibility
    const ab = new ArrayBuffer(4);
    new DataView(ab).setUint32(0, 0xdeadbeef);
    mmkv.set('ab', ab);
    new DataView(ab).setUint32(0, 0);
    const abRead = mmkv.getBuffer('ab')!;
    expect(new DataView(abRead).getUint32(0)).toBe(0xdeadbeef);
  });

  it('tracks accurate O(1) UTF-8 size/byteSize across ASCII, multi-byte UTF-8, emojis, numbers, booleans, buffers, overwrites, and clearAll', () => {
    const runtime = createMMKVRuntime();
    const mmkv = runtime.createMMKV();

    expect(mmkv.size).toBe(0);
    expect(mmkv.byteSize).toBe(0);

    // key 'a' (1B) + '€' (3B UTF-8) = 4B
    mmkv.set('a', '€');
    expect(mmkv.size).toBe(4);
    expect(mmkv.byteSize).toBe(4);

    // key '😀' (4B UTF-8) + number (8B) = 12B -> total 16B
    mmkv.set('😀', 3.14);
    expect(mmkv.size).toBe(16);

    // key 'b' (1B) + boolean (1B) = 2B -> total 18B
    mmkv.set('b', true);
    expect(mmkv.size).toBe(18);

    // key 'c' (1B) + 5-byte buffer = 6B -> total 24B
    mmkv.set('c', new Uint8Array([1, 2, 3, 4, 5]));
    expect(mmkv.size).toBe(24);

    // Overwrite 'a' with 'hi' (2B): 1 + 2 = 3B (down by 1B -> 23B)
    mmkv.set('a', 'hi');
    expect(mmkv.size).toBe(23);

    // Remove 'b' (-2B -> 21B)
    mmkv.remove('b');
    expect(mmkv.size).toBe(21);

    mmkv.clearAll();
    expect(mmkv.size).toBe(0);
    expect(mmkv.length).toBe(0);
  });

  it('enforces readOnly on all 8 mutators while allowing reads and cross-instance listener observation', () => {
    const runtime = createMMKVRuntime();
    const writer = runtime.createMMKV({ id: 'shared' });
    const reader = runtime.createMMKV({ id: 'shared', readOnly: true });
    const other = runtime.createMMKV({ id: 'other' });
    other.set('x', '1');

    expect(reader.isReadOnly).toBe(true);
    const events: string[] = [];
    const sub = reader.addOnValueChangedListener((k) => events.push(k));

    writer.set('k', 'hello');
    expect(reader.getString('k')).toBe('hello');
    expect(events).toEqual(['k']);

    expect(() => reader.set('k', 'no')).toThrow(/read-only/);
    expect(() => reader.delete('k')).toThrow(/read-only/);
    expect(() => reader.remove('k')).toThrow(/read-only/);
    expect(() => reader.clearAll()).toThrow(/read-only/);
    expect(() => reader.recrypt('key')).toThrow(/read-only/);
    expect(() => reader.encrypt('key')).toThrow(/read-only/);
    expect(() => reader.decrypt()).toThrow(/read-only/);
    expect(() => reader.importAllFrom(other)).toThrow(/read-only/);

    // No mutation or extra listener fire occurred
    expect(reader.getString('k')).toBe('hello');
    expect(events).toEqual(['k']);
    sub.remove();
  });

  it('supports recrypt/encrypt/decrypt preserving data, compareBeforeSet, importAllFrom (all types), and input validation', () => {
    const runtime = createMMKVRuntime();
    const src = runtime.createMMKV({
      id: 'src',
      encryptionKey: 'init-key',
      compareBeforeSet: true,
    });
    expect(src.isEncrypted).toBe(true);

    const srcEvents: string[] = [];
    src.addOnValueChangedListener((k) => srcEvents.push(k));

    src.set('str', 'v1');
    src.set('str', 'v1'); // identical -> compareBeforeSet skips listener!
    expect(srcEvents).toEqual(['str']);

    src.set('num', -0);
    src.set('bool', false);
    src.set('buf', new Uint8Array([7, 8, 9]));

    src.recrypt(undefined);
    expect(src.isEncrypted).toBe(false);
    expect(src.getString('str')).toBe('v1');

    src.encrypt('new-key', 'AES-256');
    expect(src.isEncrypted).toBe(true);
    src.decrypt();
    expect(src.isEncrypted).toBe(false);
    expect(src.getString('str')).toBe('v1');

    // importAllFrom copies all 4 types accurately with defensive buffer copies
    const dest = runtime.createMMKV({ id: 'dest' });
    const destEvents: string[] = [];
    dest.addOnValueChangedListener((k) => destEvents.push(k));

    const count = dest.importAllFrom(src);
    expect(count).toBe(4);
    expect(dest.getString('str')).toBe('v1');
    expect(Object.is(dest.getNumber('num'), -0)).toBe(true);
    expect(dest.getBoolean('bool')).toBe(false);
    expect(Array.from(new Uint8Array(dest.getBuffer('buf')!))).toEqual([7, 8, 9]);
    expect(destEvents.sort()).toEqual(['bool', 'buf', 'num', 'str']);

    // Defensive getAllKeys copy
    const keys = dest.getAllKeys();
    keys.push('hack');
    expect(dest.getAllKeys()).not.toContain('hack');

    // Validation errors
    expect(() => src.set('', 'x')).toThrow(/must not be empty/);
    expect(() => src.set(123 as unknown as string, 'x')).toThrow(TypeError);
    expect(() => src.set('k', null as unknown as string)).toThrow(TypeError);
    expect(() => src.set('k', {} as unknown as string)).toThrow(TypeError);
    expect(() => runtime.createMMKV({ id: '' })).toThrow(/Invalid instance id/);
    expect(() => src.trim()).not.toThrow();
    expect(() => src.checkContentChanged()).not.toThrow();
  });

  it('dispatches addOnValueChangedListener synchronously, snapshot-safely, idempotently, and skips missing-key deletes', () => {
    const runtime = createMMKVRuntime();
    const mmkv = runtime.createMMKV();

    const log: string[] = [];
    let sub2: { remove: () => void } | null = null;
    const sub1 = mmkv.addOnValueChangedListener((k) => {
      log.push(`L1:${k}`);
      // Self-unsubscribe + unsubscribe L2 + register L3 during dispatch
      sub1.remove();
      sub1.remove(); // idempotent
      sub2?.remove();
      mmkv.addOnValueChangedListener((k3) => log.push(`L3:${k3}`));
    });
    sub2 = mmkv.addOnValueChangedListener((k) => log.push(`L2:${k}`));

    mmkv.set('first', '1');
    // L1 ran, removed itself and L2 before L2 executed; newly added L3 does not run for current event
    expect(log).toEqual(['L1:first']);

    mmkv.set('second', '2');
    expect(log).toEqual(['L1:first', 'L3:second']);

    // Deleting missing key fires 0 listeners
    mmkv.delete('nonexistent');
    mmkv.remove('nonexistent');
    expect(log).toEqual(['L1:first', 'L3:second']);

    // clearAll clears storage BEFORE firing listeners so listeners observe empty state
    const observedDuringClear: Array<{ key: string; len: number }> = [];
    mmkv.addOnValueChangedListener((k) => {
      observedDuringClear.push({ key: k, len: mmkv.length });
    });
    mmkv.clearAll();
    expect(observedDuringClear).toEqual([
      { key: 'first', len: 0 },
      { key: 'second', len: 0 },
    ]);

    // clearAll on empty store fires 0 listeners
    observedDuringClear.length = 0;
    mmkv.clearAll();
    expect(observedDuringClear).toEqual([]);
  });

  describe('All 8 React hooks via ReactHooksAdapter (and error without React)', () => {
    it('throws a clear descriptive error when hooks are called without React or adapter', () => {
      const noReactRuntime = createMMKVRuntime({ reactAdapter: null });
      expect(() => noReactRuntime.useMMKV()).toThrow(/requires React/);
      expect(() => noReactRuntime.useMMKVString('k')).toThrow(/requires React/);
      expect(() => noReactRuntime.useMMKVBuffer('k')).toThrow(/requires React/);
    });

    it('drives useMMKV, useMMKVString/Number/Boolean/Object/Buffer, useMMKVListener, and useMMKVKeys with useSyncExternalStore referential stability', () => {
      const harness = createTestReactHarness({
        includeUseSyncExternalStore: true,
      });
      const runtime = createMMKVRuntime({ reactAdapter: harness.adapter });

      const listenedKeys: string[] = [];
      let latestHookOutput!: {
        inst: ReturnType<typeof runtime.useMMKV>;
        str: [string | undefined, (v: string | undefined) => void];
        num: [number | undefined, (v: number | undefined | ((c: number | undefined) => number | undefined)) => void];
        bool: [boolean | undefined, (v: boolean | undefined) => void];
        obj: [{ count: number } | undefined, (v: { count: number } | undefined | ((c: { count: number } | undefined) => { count: number } | undefined)) => void];
        buf: [ArrayBuffer | undefined, (v: ArrayBuffer | Uint8Array | undefined) => void];
        keys: string[];
      };

      const renderComponent = () => {
        const inst = runtime.useMMKV({ id: 'hook-store' });
        const str = runtime.useMMKVString('name', inst);
        const num = runtime.useMMKVNumber('qty', inst);
        const bool = runtime.useMMKVBoolean('vip', inst);
        const obj = runtime.useMMKVObject<{ count: number }>('cart', inst);
        const buf = runtime.useMMKVBuffer('sig', inst);
        runtime.useMMKVListener((k) => listenedKeys.push(k), inst);
        const keys = runtime.useMMKVKeys(inst);
        latestHookOutput = { inst, str, num, bool, obj, buf, keys };
        return latestHookOutput;
      };

      harness.render(renderComponent);
      expect(latestHookOutput.str[0]).toBeUndefined();
      expect(latestHookOutput.keys).toEqual([]);

      latestHookOutput.str[1]('Ada');
      expect(latestHookOutput.str[0]).toBe('Ada');

      latestHookOutput.num[1](3);
      latestHookOutput.num[1]((prev) => (prev ?? 0) + 2);
      expect(latestHookOutput.num[0]).toBe(5);

      latestHookOutput.bool[1](false);
      expect(latestHookOutput.bool[0]).toBe(false);

      latestHookOutput.obj[1]({ count: 1 });
      latestHookOutput.obj[1]((prev) => ({ count: (prev?.count ?? 0) + 4 }));
      expect(latestHookOutput.obj[0]).toEqual({ count: 5 });

      // useMMKVBuffer: verify referential stability across unrelated mutations and updates on own mutation
      latestHookOutput.buf[1](new Uint8Array([4, 5, 6]));
      const snapA = latestHookOutput.buf[0];
      expect(snapA).toBeInstanceOf(ArrayBuffer);
      expect(Array.from(new Uint8Array(snapA!))).toEqual([4, 5, 6]);

      // Unrelated key change preserves exact ArrayBuffer reference (Object.is stability!)
      latestHookOutput.str[1]('Grace');
      expect(latestHookOutput.buf[0]).toBe(snapA);

      // Mutating sig updates buffer snapshot to fresh bytes
      latestHookOutput.buf[1](new Uint8Array([7, 8]));
      expect(latestHookOutput.buf[0]).not.toBe(snapA);
      expect(Array.from(new Uint8Array(latestHookOutput.buf[0]!))).toEqual([7, 8]);

      expect(latestHookOutput.keys.sort()).toEqual([
        'cart',
        'name',
        'qty',
        'sig',
        'vip',
      ]);
      expect(listenedKeys).toContain('name');
      expect(listenedKeys).toContain('sig');

      // Setting undefined removes key
      latestHookOutput.str[1](undefined);
      expect(latestHookOutput.str[0]).toBeUndefined();
      expect(latestHookOutput.keys).not.toContain('name');

      harness.unmount();
      // After unmount, listener no longer fires
      const countBefore = listenedKeys.length;
      latestHookOutput.inst.set('postUnmount', 'x');
      expect(listenedKeys.length).toBe(countBefore);
    });

    it('falls back cleanly when ReactHooksAdapter omits useSyncExternalStore (React 17 compat)', () => {
      const harness = createTestReactHarness({
        includeUseSyncExternalStore: false,
      });
      const runtime = createMMKVRuntime({ reactAdapter: harness.adapter });

      let output!: [string | undefined, (v: string | undefined) => void];
      harness.render(() => {
        output = runtime.useMMKVString('fallbackKey');
        return output;
      });
      expect(output[0]).toBeUndefined();
      output[1]('works');
      expect(output[0]).toBe('works');
      harness.unmount();
    });
  });

  it('contains zero disk I/O, zero native bindings, and zero top-level React imports', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../src/memory-storage/mmkvShim.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from\s+['"](?:node:)?(?:fs|path|os|crypto|buffer)['"]/);
    expect(src).not.toMatch(/from\s+['"]react-native['"]/);
    expect(src).not.toMatch(/from\s+['"]react['"]/);
    expect(src).not.toMatch(/react-native-nitro-modules/);
    expect(src).not.toMatch(/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/);
  });

  describe('Iteration 2 listener isolation, lifecycle & split-brain regressions', () => {
    it('isolates throwing listeners across set(), delete(), remove(), clearAll(), and importAllFrom()', () => {
      const runtime = createMMKVRuntime();
      const mmkv = runtime.createMMKV({ id: 'isolated-listeners' });
      const l2Events: string[] = [];

      mmkv.addOnValueChangedListener((k) => {
        throw new Error(`L1-boom:${k}`);
      });
      mmkv.addOnValueChangedListener((k) => {
        l2Events.push(k);
      });

      expect(() => mmkv.set('k1', 'v1')).not.toThrow();
      expect(mmkv.getString('k1')).toBe('v1');
      expect(l2Events).toEqual(['k1']);

      mmkv.set('k2', 'v2');
      mmkv.set('k3', 'v3');
      l2Events.length = 0;

      // clearAll must deliver notifications for ALL keys to non-throwing listeners
      expect(() => mmkv.clearAll()).not.toThrow();
      expect(mmkv.length).toBe(0);
      expect(l2Events.sort()).toEqual(['k1', 'k2', 'k3']);

      // importAllFrom must deliver notifications for ALL imported keys to non-throwing listeners
      const src = runtime.createMMKV({ id: 'src-import' });
      src.set('a', '1');
      src.set('b', '2');
      l2Events.length = 0;

      expect(() => mmkv.importAllFrom(src)).not.toThrow();
      expect(mmkv.length).toBe(2);
      expect(l2Events.sort()).toEqual(['a', 'b']);

      // remove/delete also isolate throwing listeners
      l2Events.length = 0;
      expect(() => mmkv.remove('a')).not.toThrow();
      expect(() => mmkv.delete('b')).not.toThrow();
      expect(l2Events).toEqual(['a', 'b']);
    });

    it('removes listeners registered through an instance when instance.dispose() is called on a shared bucket', () => {
      const runtime = createMMKVRuntime();
      const m1 = runtime.createMMKV({ id: 'shared-disp' });
      const m2 = runtime.createMMKV({ id: 'shared-disp' });

      const m1Events: string[] = [];
      const m2Events: string[] = [];
      m1.addOnValueChangedListener((k) => m1Events.push(k));
      m2.addOnValueChangedListener((k) => m2Events.push(k));

      m2.set('beforeDispose', '1');
      expect(m1Events).toEqual(['beforeDispose']);
      expect(m2Events).toEqual(['beforeDispose']);

      m1.dispose();
      m1.dispose(); // idempotent

      m2.set('afterDispose', '2');
      expect(m1Events).toEqual(['beforeDispose']);
      expect(m2Events).toEqual(['beforeDispose', 'afterDispose']);
    });

    it('eliminates stale-bucket split-brain on deleteMMKV() and runtime.reset() while preserving existsMMKV() accuracy and useMMKVBuffer coherence', () => {
      const harness = createTestReactHarness({
        includeUseSyncExternalStore: true,
      });
      const runtime = createMMKVRuntime({ reactAdapter: harness.adapter });

      // 1. deleteMMKV() zero split-brain
      const m1 = runtime.createMMKV({ id: 'split' });
      m1.set('k', 'v1');
      expect(runtime.deleteMMKV('split')).toBe(true);
      expect(runtime.existsMMKV('split')).toBe(false);

      // Read-only operations on m1 return empty/undefined WITHOUT recreating the bucket
      expect(m1.getString('k')).toBeUndefined();
      expect(m1.contains('k')).toBe(false);
      expect(m1.getAllKeys()).toEqual([]);
      expect(m1.length).toBe(0);
      expect(m1.size).toBe(0);
      expect(m1.isEncrypted).toBe(false);
      expect(m1.remove('k')).toBe(false);
      m1.clearAll();
      expect(runtime.existsMMKV('split')).toBe(false);

      // Mutating m1 creates the canonical live bucket shared with newly created m2
      m1.set('k', 'canonical');
      expect(runtime.existsMMKV('split')).toBe(true);
      const m2 = runtime.createMMKV({ id: 'split' });
      expect(m1.getString('k')).toBe('canonical');
      expect(m2.getString('k')).toBe('canonical');

      // 2. runtime.reset() zero split-brain
      runtime.reset();
      expect(runtime.existsMMKV('split')).toBe(false);
      expect(m1.getString('k')).toBeUndefined();
      expect(m2.getString('k')).toBeUndefined();
      expect(runtime.existsMMKV('split')).toBe(false);

      m1.set('k', 'after-reset');
      const m3 = runtime.createMMKV({ id: 'split' });
      expect(m1.getString('k')).toBe('after-reset');
      expect(m2.getString('k')).toBe('after-reset');
      expect(m3.getString('k')).toBe('after-reset');

      // 3. useMMKVBuffer detects new bucket generation across deleteMMKV + re-write
      const bStore = runtime.createMMKV({ id: 'buf-gen' });
      bStore.set('bin', new Uint8Array([1, 2, 3]));
      let latestBuf: ArrayBuffer | undefined;
      const renderBuf = () => {
        const [buf] = runtime.useMMKVBuffer('bin', bStore);
        latestBuf = buf;
        return buf;
      };
      harness.render(renderBuf);
      expect(Array.from(new Uint8Array(latestBuf!))).toEqual([1, 2, 3]);

      runtime.deleteMMKV('buf-gen');
      bStore.set('bin', new Uint8Array([9, 8, 7]));
      harness.render(renderBuf);
      expect(Array.from(new Uint8Array(latestBuf!))).toEqual([9, 8, 7]);
      harness.unmount();
    });

    it('rejects empty and non-string keys in importAllFrom() without mutating destination', () => {
      const runtime = createMMKVRuntime();
      const dest = runtime.createMMKV({ id: 'dest-validate' });
      dest.set('existing', 'keep');

      const foreignWithEmptyKey = {
        id: 'foreign',
        size: 1,
        byteSize: 1,
        length: 2,
        isReadOnly: false,
        isEncrypted: false,
        set: () => {},
        getString: (k: string) => (k === 'ok' ? 'yes' : k === '' ? 'bad' : undefined),
        getNumber: () => undefined,
        getBoolean: () => undefined,
        getBuffer: () => undefined,
        contains: (k: string) => k === 'ok' || k === '',
        delete: () => {},
        remove: () => false,
        getAllKeys: () => ['ok', ''],
        clearAll: () => {},
        recrypt: () => {},
        encrypt: () => {},
        decrypt: () => {},
        trim: () => {},
        checkContentChanged: () => {},
        importAllFrom: () => 0,
        addOnValueChangedListener: () => ({ remove: () => {} }),
        toString: () => 'foreign',
        toJSON: () => ({ foreign: ['ok', ''] }),
        dispose: () => {},
        equals: () => false,
      };

      expect(() => dest.importAllFrom(foreignWithEmptyKey)).toThrow(
        /Key must not be empty/,
      );
      expect(dest.contains('')).toBe(false);
      expect(dest.contains('ok')).toBe(false);
      expect(dest.getString('existing')).toBe('keep');
    });

    it('syncs useMMKVKeys on mount when keys mutate between initial render and effect execution', () => {
      const pendingEffects: Array<() => void | (() => void)> = [];
      let stateVal: string[] = [];
      let stateInitialized = false;
      let setStateCalls = 0;

      const deferredEffectAdapter: ReactHooksAdapter = {
        useRef<T>(initialValue: T) {
          return { current: initialValue };
        },
        useState<S>(initial: S | (() => S)) {
          if (!stateInitialized) {
            stateInitialized = true;
            stateVal = (
              typeof initial === 'function' ? (initial as () => S)() : initial
            ) as unknown as string[];
          }
          const setState = (action: S | ((prev: S) => S)) => {
            const prev = stateVal as unknown as S;
            const next =
              typeof action === 'function'
                ? (action as (p: S) => S)(prev)
                : action;
            if (!Object.is(prev, next)) {
              setStateCalls += 1;
              stateVal = next as unknown as string[];
            }
          };
          return [stateVal as unknown as S, setState];
        },
        useEffect(effect) {
          pendingEffects.push(effect);
        },
        useCallback<T extends (...args: never[]) => unknown>(cb: T) {
          return cb;
        },
        useMemo<T>(factory: () => T) {
          return factory();
        },
      };

      const runtime = createMMKVRuntime({ reactAdapter: deferredEffectAdapter });
      const mmkv = runtime.createMMKV({ id: 'mount-sync' });
      mmkv.set('initial', '1');

      // Initial render captures ['initial'] before useEffect runs
      const initialKeys = runtime.useMMKVKeys(mmkv);
      expect(initialKeys).toEqual(['initial']);

      // Mutate store BEFORE effect runs
      mmkv.set('addedBeforeEffect', '2');

      // Now run mount effect -> must sync keys immediately
      const cleanup = pendingEffects.shift()?.();
      expect(stateVal.sort()).toEqual(['addedBeforeEffect', 'initial']);
      expect(setStateCalls).toBe(1);
      cleanup?.();
    });
  });

  describe('Iteration 3 decoupled listeners, deleteMMKV reactivity & encryption lifecycle regressions', () => {
    it('never resurrects deleted buckets on addOnValueChangedListener() (including readOnly handles and mounted hooks)', () => {
      const harness = createTestReactHarness({
        includeUseSyncExternalStore: true,
      });
      const runtime = createMMKVRuntime({ reactAdapter: harness.adapter });

      const ro = runtime.createMMKV({ id: 'ro-ghost', readOnly: true });
      expect(runtime.deleteMMKV('ro-ghost')).toBe(true);
      expect(runtime.existsMMKV('ro-ghost')).toBe(false);

      const roEvents: string[] = [];
      const sub = ro.addOnValueChangedListener((k) => roEvents.push(k));
      expect(runtime.existsMMKV('ro-ghost')).toBe(false);

      // Mounting hooks on a deleted handle must ALSO keep existsMMKV() === false
      let renderedKeys: string[] = [];
      harness.render(() => {
        renderedKeys = runtime.useMMKVKeys(ro);
        return renderedKeys;
      });
      expect(renderedKeys).toEqual([]);
      expect(runtime.existsMMKV('ro-ghost')).toBe(false);

      // Subsequent write from another handle recreates bucket and delivers events to pre-registered listener & hook
      const writer = runtime.createMMKV({ id: 'ro-ghost' });
      writer.set('sku', '12345');
      expect(runtime.existsMMKV('ro-ghost')).toBe(true);
      expect(roEvents).toEqual(['sku']);
      expect(renderedKeys).toEqual(['sku']);

      sub.remove();
      harness.unmount();
    });

    it('notifies mounted hooks and listeners on deleteMMKV() and keeps subscriptions live across subsequent bucket recreation', () => {
      const harness = createTestReactHarness({
        includeUseSyncExternalStore: true,
      });
      const runtime = createMMKVRuntime({ reactAdapter: harness.adapter });

      const m = runtime.createMMKV({ id: 'hook-del' });
      m.set('key', 'v1');
      m.set('bin', new Uint8Array([1, 2, 3]));

      const directEvents: string[] = [];
      const sub = m.addOnValueChangedListener((k) => directEvents.push(k));

      let latestStr: string | undefined;
      let latestBuf: ArrayBuffer | undefined;
      let latestKeys: string[] = [];
      const render = () => {
        const [s] = runtime.useMMKVString('key', m);
        const [b] = runtime.useMMKVBuffer('bin', m);
        const ks = runtime.useMMKVKeys(m);
        latestStr = s;
        latestBuf = b;
        latestKeys = ks;
        return { s, b, ks };
      };

      harness.render(render);
      expect(latestStr).toBe('v1');
      expect(Array.from(new Uint8Array(latestBuf!))).toEqual([1, 2, 3]);
      expect(latestKeys.sort()).toEqual(['bin', 'key']);

      // deleteMMKV() MUST immediately notify hooks/listeners so stale PII disappears
      expect(runtime.deleteMMKV('hook-del')).toBe(true);
      expect(runtime.existsMMKV('hook-del')).toBe(false);
      expect(latestStr).toBeUndefined();
      expect(latestBuf).toBeUndefined();
      expect(latestKeys).toEqual([]);
      expect(directEvents.sort()).toEqual(['bin', 'key']);

      // Subsequent writes on the same handle recreate the bucket and MUST continue driving mounted hooks & listeners
      directEvents.length = 0;
      m.set('key', 'v2');
      m.set('bin', new Uint8Array([9, 8]));
      expect(latestStr).toBe('v2');
      expect(Array.from(new Uint8Array(latestBuf!))).toEqual([9, 8]);
      expect(latestKeys.sort()).toEqual(['bin', 'key']);
      expect(directEvents).toEqual(['key', 'bin']);

      // runtime.reset() clears all listeners cleanly
      directEvents.length = 0;
      runtime.reset();
      m.set('key', 'post-reset');
      expect(directEvents).toEqual([]);

      sub.remove();
      harness.unmount();
    });

    it('keeps deleted buckets absent on decrypt()/recrypt(undefined) and preserves mutable handle encryption state across deleteMMKV()', () => {
      const runtime = createMMKVRuntime();

      // 1. decrypt() after deleteMMKV() does NOT resurrect bucket
      const m1 = runtime.createMMKV({ id: 'enc-del', encryptionKey: 'k1' });
      expect(m1.isEncrypted).toBe(true);
      runtime.deleteMMKV('enc-del');
      expect(runtime.existsMMKV('enc-del')).toBe(false);
      m1.decrypt();
      expect(runtime.existsMMKV('enc-del')).toBe(false);

      // 2. recrypt(undefined) and recrypt('') after deleteMMKV() do NOT resurrect bucket
      const mRec = runtime.createMMKV({ id: 'recrypt-del', encryptionKey: 'k1' });
      runtime.deleteMMKV('recrypt-del');
      mRec.recrypt(undefined);
      expect(runtime.existsMMKV('recrypt-del')).toBe(false);
      mRec.recrypt('');
      expect(runtime.existsMMKV('recrypt-del')).toBe(false);

      // 3. decrypt() -> deleteMMKV() -> set() does NOT resurrect revoked initialEncryptionKey
      const mDec = runtime.createMMKV({ id: 'dec-persist', encryptionKey: 'k1' });
      mDec.decrypt();
      expect(mDec.isEncrypted).toBe(false);
      runtime.deleteMMKV('dec-persist');
      mDec.set('x', '1');
      expect(mDec.isEncrypted).toBe(false);

      // 4. encrypt('k2') -> deleteMMKV() -> set() preserves post-construction encryption key
      const mEnc = runtime.createMMKV({ id: 'enc-after-create' });
      expect(mEnc.isEncrypted).toBe(false);
      mEnc.encrypt('k2', 'AES-256');
      expect(mEnc.isEncrypted).toBe(true);
      runtime.deleteMMKV('enc-after-create');
      expect(runtime.existsMMKV('enc-after-create')).toBe(false);
      mEnc.set('a', '1');
      expect(mEnc.isEncrypted).toBe(true);
    });
  });

  describe('Iteration 4 default-instance lifecycle & resetEpoch isolation regressions', () => {
    it('keeps mmkv.default deleted when deleteMMKV(DEFAULT_MMKV_ID) fires with mounted default-instance hooks', () => {
      const harness = createTestReactHarness({
        includeUseSyncExternalStore: true,
      });
      const runtime = createMMKVRuntime({ reactAdapter: harness.adapter });

      let latestUser: string | undefined;
      let setUser!: (v: string | undefined) => void;
      let latestKeys: string[] = [];

      harness.render(() => {
        const [u, su] = runtime.useMMKVString('user');
        const ks = runtime.useMMKVKeys();
        latestUser = u;
        setUser = su;
        latestKeys = ks;
        return { u, ks };
      });

      setUser('alice');
      expect(latestUser).toBe('alice');
      expect(latestKeys).toEqual(['user']);
      expect(runtime.existsMMKV(DEFAULT_MMKV_ID)).toBe(true);

      // deleteMMKV(DEFAULT_MMKV_ID) must clear rendered values AND keep existsMMKV('mmkv.default') === false
      expect(runtime.deleteMMKV(DEFAULT_MMKV_ID)).toBe(true);
      expect(latestUser).toBeUndefined();
      expect(latestKeys).toEqual([]);
      expect(runtime.existsMMKV(DEFAULT_MMKV_ID)).toBe(false);

      // Subsequent write via createMMKV() / default handle resumes driving mounted hooks
      const def = runtime.createMMKV({ id: DEFAULT_MMKV_ID });
      def.set('user', 'bob');
      expect(runtime.existsMMKV(DEFAULT_MMKV_ID)).toBe(true);
      expect(latestUser).toBe('bob');
      expect(latestKeys).toEqual(['user']);

      harness.unmount();
    });

    it('clears defaultInstance on dispose() of useMMKV() singleton so future default hooks stay live', () => {
      const harness1 = createTestReactHarness({
        includeUseSyncExternalStore: true,
      });
      const harness2 = createTestReactHarness({
        includeUseSyncExternalStore: true,
      });
      const runtime = createMMKVRuntime({ reactAdapter: harness1.adapter });

      let defaultInst!: ReturnType<typeof runtime.useMMKV>;
      harness1.render(() => {
        defaultInst = runtime.useMMKV();
        return defaultInst;
      });
      defaultInst.set('k', 'v1');
      defaultInst.dispose();
      harness1.unmount();

      // Fresh component using default-instance hook on the still-live runtime must NOT throw disposed error
      let val: string | undefined;
      let setVal!: (v: string | undefined) => void;
      const runtime2View = createMMKVRuntime({ reactAdapter: harness2.adapter });
      let d2!: ReturnType<typeof runtime2View.useMMKV>;
      harness2.render(() => {
        d2 = runtime2View.useMMKV();
        return d2;
      });
      d2.set('k', 'v1');
      d2.dispose();
      harness2.unmount();

      const harness3 = createTestReactHarness({
        includeUseSyncExternalStore: true,
      });
      // Re-mount on the exact same runtime2View after disposing its default singleton
      // (using harness2's adapter via harness2.render)
      harness2.render(() => {
        const [v, sv] = runtime2View.useMMKVString('k');
        val = v;
        setVal = sv;
        return v;
      });
      expect(val).toBe('v1');
      expect(() => setVal('v2')).not.toThrow();
      expect(val).toBe('v2');
      harness2.unmount();
      harness3.unmount();
    });

    it('prevents stale pre-reset keys from leaking to post-reset listeners across deleteMMKV(), clearAll(), and importAllFrom()', () => {
      const runtime = createMMKVRuntime();

      // 1. deleteMMKV()
      const mDel = runtime.createMMKV({ id: 'epoch-del' });
      mDel.set('k1', '1');
      mDel.set('k2', '2');
      const postResetDel: string[] = [];
      mDel.addOnValueChangedListener(() => {
        runtime.reset();
        const fresh = runtime.createMMKV({ id: 'epoch-del' });
        fresh.addOnValueChangedListener((k) => postResetDel.push(k));
      });
      runtime.deleteMMKV('epoch-del');
      expect(postResetDel).toEqual([]);

      // 2. clearAll()
      const mClr = runtime.createMMKV({ id: 'epoch-clr' });
      mClr.set('old1', '1');
      mClr.set('old2', '2');
      const postResetClr: string[] = [];
      mClr.addOnValueChangedListener(() => {
        runtime.reset();
        const fresh = runtime.createMMKV({ id: 'epoch-clr' });
        fresh.addOnValueChangedListener((k) => postResetClr.push(k));
      });
      mClr.clearAll();
      expect(postResetClr).toEqual([]);

      // 3. importAllFrom()
      const src = runtime.createMMKV({ id: 'epoch-src' });
      src.set('imp1', '1');
      src.set('imp2', '2');
      const dst = runtime.createMMKV({ id: 'epoch-dst' });
      const postResetImp: string[] = [];
      dst.addOnValueChangedListener(() => {
        runtime.reset();
        const fresh = runtime.createMMKV({ id: 'epoch-dst' });
        fresh.addOnValueChangedListener((k) => postResetImp.push(k));
      });
      dst.importAllFrom(src);
      expect(postResetImp).toEqual([]);
    });
  });
});
