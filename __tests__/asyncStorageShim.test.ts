import { readFileSync } from 'node:fs';
import path from 'node:path';
import AsyncStorageDefault, {
  AsyncStorage,
  createAsyncStorageShim,
  createUseAsyncStorage,
  useAsyncStorage,
} from '../src/memory-storage/asyncStorageShim.js';
import type { AsyncStorageKeyError } from '../src/memory-storage/asyncStorageShim.js';

describe('AsyncStorage Pure In-Memory JS Map Shim', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('exports identical default and named singleton instances', () => {
    expect(AsyncStorageDefault).toBe(AsyncStorage);
  });

  it('supports basic getItem, setItem, removeItem, clear, getAllKeys, flushGetRequests with FIFO ordering', async () => {
    const store = createAsyncStorageShim();

    // Pipelined unawaited calls preserve strict FIFO order
    const pSet = store.setItem('cart', 'item-1');
    const pGet = store.getItem('cart');
    await pSet;
    expect(await pGet).toBe('item-1');

    // Empty string "" is preserved accurately (NEVER coerced to null)
    await store.setItem('empty', '');
    expect(await store.getItem('empty')).toBe('');
    expect(await store.getItem('missing')).toBeNull();

    // Object.prototype key names work without collision
    await store.setItem('__proto__', 'proto-val');
    await store.setItem('constructor', 'ctor-val');
    await store.setItem('toString', 'str-val');
    expect(await store.getItem('__proto__')).toBe('proto-val');
    expect(await store.getItem('constructor')).toBe('ctor-val');
    expect(await store.getItem('toString')).toBe('str-val');

    // Defensive copy of getAllKeys()
    const keys = await store.getAllKeys();
    expect(keys).toEqual([
      'cart',
      'empty',
      '__proto__',
      'constructor',
      'toString',
    ]);
    (keys as string[]).push('tampered-key');
    expect(await store.getAllKeys()).not.toContain('tampered-key');

    // removeItem existing & missing (silent no-op)
    await store.removeItem('empty');
    await store.removeItem('never-existed');
    expect(await store.getItem('empty')).toBeNull();

    // flushGetRequests is a safe synchronous no-op
    expect(() => store.flushGetRequests()).not.toThrow();

    await store.clear();
    expect(await store.getAllKeys()).toEqual([]);
  });

  it('invokes optional error-first callbacks on every method and never double-invokes if callback throws', async () => {
    const store = createAsyncStorageShim();

    const setCb = jest.fn();
    await store.setItem('k1', '{"a":1}', setCb);
    expect(setCb).toHaveBeenCalledTimes(1);
    expect(setCb).toHaveBeenCalledWith(null);

    const getCb = jest.fn();
    expect(await store.getItem('k1', getCb)).toBe('{"a":1}');
    expect(getCb).toHaveBeenCalledWith(null, '{"a":1}');

    const mergeCb = jest.fn();
    await store.mergeItem('k1', '{"b":2}', mergeCb);
    expect(mergeCb).toHaveBeenCalledWith(null);

    const keysCb = jest.fn();
    const keys = await store.getAllKeys(keysCb);
    expect(keys).toEqual(['k1']);
    expect(keysCb).toHaveBeenCalledWith(null, ['k1']);

    const multiSetCb = jest.fn();
    await store.multiSet(
      [
        ['k2', 'v2'],
        ['k3', ''],
      ],
      multiSetCb,
    );
    expect(multiSetCb).toHaveBeenCalledWith(null);

    const multiGetCb = jest.fn();
    const pairs = await store.multiGet(['k2', 'missing', 'k3', 'k2'], multiGetCb);
    expect(pairs).toEqual([
      ['k2', 'v2'],
      ['missing', null],
      ['k3', ''],
      ['k2', 'v2'],
    ]);
    expect(multiGetCb).toHaveBeenCalledWith(null, pairs);

    const multiRemoveCb = jest.fn();
    await store.multiRemove(['k2', 'missing'], multiRemoveCb);
    expect(multiRemoveCb).toHaveBeenCalledWith(null);

    const removeCb = jest.fn();
    await store.removeItem('k1', removeCb);
    expect(removeCb).toHaveBeenCalledWith(null);

    const clearCb = jest.fn();
    await store.clear(clearCb);
    expect(clearCb).toHaveBeenCalledWith(null);

    // Invoke-at-most-once guarantee when user callback throws
    const throwingCb = jest.fn(() => {
      throw new Error('user callback boom');
    });
    await expect(store.getItem('k1', throwingCb)).rejects.toThrow(
      'user callback boom',
    );
    expect(throwingCb).toHaveBeenCalledTimes(1);
    // Queue remains healthy after throwing callback
    await store.setItem('after', 'ok');
    expect(await store.getItem('after')).toBe('ok');
  });

  it('performs native iOS object-only recursive deep JSON merge (replaces arrays) and defends against prototype pollution', async () => {
    const store = createAsyncStorageShim();

    await store.setItem(
      'cart',
      JSON.stringify({
        customer: { name: 'Alice', tier: 'gold', prefs: { sms: true } },
        items: [{ sku: 'A1' }, { sku: 'A2' }],
        discount: 5,
      }),
    );

    await store.mergeItem(
      'cart',
      JSON.stringify({
        customer: { tier: 'platinum', prefs: { email: false } },
        items: [{ sku: 'B9' }],
        tax: 1.25,
      }),
    );

    const merged = JSON.parse((await store.getItem('cart'))!);
    expect(merged).toEqual({
      customer: {
        name: 'Alice',
        tier: 'platinum',
        prefs: { sms: true, email: false },
      },
      // Native iOS parity: arrays are replaced, NOT concatenated
      items: [{ sku: 'B9' }],
      discount: 5,
      tax: 1.25,
    });

    // Prototype pollution defense on existing key AND first-write missing key
    const maliciousPayload =
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"p2":true}},"safe":1}';
    await store.mergeItem('proto-new', maliciousPayload);
    await store.mergeItem('cart', maliciousPayload);

    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['p2']).toBeUndefined();
    expect(await store.getItem('proto-new')).toBe('{"safe":1}');
    expect(JSON.parse((await store.getItem('cart'))!).safe).toBe(1);
  });

  it('rejects invalid JSON on mergeItem without corrupting existing value or creating missing key', async () => {
    const store = createAsyncStorageShim();

    await store.setItem('plain', 'not-json-text');
    const cb = jest.fn();
    await expect(store.mergeItem('plain', '{"a":1}', cb)).rejects.toThrow(
      /Invalid existing JSON/,
    );
    expect(cb).toHaveBeenCalledTimes(1);
    expect((cb.mock.calls[0]?.[0] as AsyncStorageKeyError).key).toBe('plain');
    expect(await store.getItem('plain')).toBe('not-json-text');

    await expect(store.mergeItem('brand-new', '{bad-json')).rejects.toThrow(
      /Invalid incoming JSON/,
    );
    expect(await store.getItem('brand-new')).toBeNull();
  });

  it('handles multiMerge cumulative duplicate keys and partial failure collection', async () => {
    const store = createAsyncStorageShim();
    await store.setItem('ok1', '{"a":1}');
    await store.setItem('bad', '{"untouched":true}');

    const cb = jest.fn();
    let caught: unknown;
    try {
      await store.multiMerge(
        [
          ['ok1', '{"b":2}'],
          ['ok1', '{"c":3}'],
          ['bad', '{corrupt'],
          ['ok2', '{"d":4}'],
        ],
        cb,
      );
    } catch (err) {
      caught = err;
    }

    expect(Array.isArray(caught)).toBe(true);
    const errors = caught as AsyncStorageKeyError[];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.key).toBe('bad');
    expect(cb).toHaveBeenCalledWith(errors);

    // Valid pairs applied sequentially; failing key untouched
    expect(JSON.parse((await store.getItem('ok1'))!)).toEqual({
      a: 1,
      b: 2,
      c: 3,
    });
    expect(JSON.parse((await store.getItem('ok2'))!)).toEqual({ d: 4 });
    expect(await store.getItem('bad')).toBe('{"untouched":true}');
  });

  it('validates keys, values, callbacks, and empty/invalid multi* arguments cleanly', async () => {
    const store = createAsyncStorageShim();

    await expect(store.setItem('k', null as unknown as string)).rejects.toThrow(
      /null\/undefined/,
    );
    await expect(
      store.setItem('k', undefined as unknown as string),
    ).rejects.toThrow(/null\/undefined/);
    await expect(store.setItem('k', 123 as unknown as string)).rejects.toThrow(
      /expected a string/,
    );
    await expect(store.getItem(123 as unknown as string)).rejects.toThrow(
      /expected a string/,
    );
    await expect(
      store.getItem('k', 'not-a-fn' as unknown as () => void),
    ).rejects.toThrow(TypeError);

    // Empty arrays to multi* succeed cleanly
    expect(await store.multiGet([])).toEqual([]);
    await expect(store.multiSet([])).resolves.toBeUndefined();
    await expect(store.multiRemove([])).resolves.toBeUndefined();
    await expect(store.multiMerge([])).resolves.toBeUndefined();

    // Non-array to multi* rejects cleanly and invokes callback([err])
    const cb = jest.fn();
    await expect(
      store.multiSet(null as unknown as ReadonlyArray<readonly [string, string]>, cb),
    ).rejects.toThrow(TypeError);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(Array.isArray(cb.mock.calls[0]?.[0])).toBe(true);
  });

  it('supports pure-JS useAsyncStorage(key) without React and enforces disposal boundaries', async () => {
    let disposed = false;
    const backing = new Map<string, string>();
    const store = createAsyncStorageShim(backing, {
      isDisposed: () => disposed,
    });
    const useScoped = createUseAsyncStorage(store);
    const hook = useScoped('loyalty');

    await hook.setItem('{"id":"L-1"}');
    await hook.mergeItem('{"points":250}');
    expect(JSON.parse((await hook.getItem())!)).toEqual({
      id: 'L-1',
      points: 250,
    });
    await hook.removeItem();
    expect(await hook.getItem()).toBeNull();

    // Also verify default useAsyncStorage works cleanly
    const defaultHook = useAsyncStorage('default-key');
    await defaultHook.setItem('hello');
    expect(await defaultHook.getItem()).toBe('hello');
    expect(await store.getItem('default-key')).toBeNull(); // strictly isolated

    // Dispose behavior: reads return empty, writes reject
    await store.setItem('before-dispose', 'secret');
    disposed = true;
    backing.clear();
    expect(await store.getItem('before-dispose')).toBeNull();
    expect(await store.getAllKeys()).toEqual([]);
    expect(await store.multiGet(['before-dispose'])).toEqual([
      ['before-dispose', null],
    ]);
    await expect(store.setItem('x', 'y')).rejects.toThrow(/disposed/);
    await expect(store.removeItem('x')).rejects.toThrow(/disposed/);
    await expect(store.clear()).rejects.toThrow(/disposed/);
  });

  it('contains zero disk I/O, zero native bindings, and zero top-level React imports', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../src/memory-storage/asyncStorageShim.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from\s+['"](?:node:)?(?:fs|path|os|crypto|buffer)['"]/);
    expect(src).not.toMatch(/from\s+['"]react-native['"]/);
    expect(src).not.toMatch(/from\s+['"]react['"]/);
    expect(src).not.toMatch(/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/);
  });
});
