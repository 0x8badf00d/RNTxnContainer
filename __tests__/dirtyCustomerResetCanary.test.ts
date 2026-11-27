import {
  KioskSession,
  __resetKioskNativeModulesForTesting,
  __setKioskNativeModulesForTesting,
} from '../src/index.js';
import type { SessionEndReason } from '../src/index.js';
import {
  AsyncStorage as DefaultAsyncStorage,
  MMKV as DefaultMMKV,
  createMemoryStorageRuntime,
} from '../src/memory-storage/index.js';
import type { MemoryStorageRuntime } from '../src/memory-storage/index.js';

/**
 * Simulates the Native Shell + Ephemeral ReactHost lifecycle for the PRD §7.1
 * Dirty Customer Reset Canary:
 * - Each customer session gets a brand-new isolated MemoryStorageRuntime + JS app store.
 * - Persistent public CDN asset cache survives across customer resets.
 * - Clipboard, in-flight internal API requests, and ephemeral runtime state are wiped on reset.
 * - Native 60s hard idle kill switch triggers unconditional teardown even without endSession().
 */
class KioskCanaryHarness {
  private sessionCounter = 0;
  private activeSessionId = '';
  private activeStorage!: MemoryStorageRuntime;
  private activeCartStore = new Map<string, unknown>();
  private activeControllers = new Set<AbortController>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private isSessionActive = false;

  readonly publicCdnDiskCache = new Map<string, { url: string; hits: number }>();
  clipboard = '';
  readonly teardownLog: Array<{ sessionId: string; reason: string }> = [];

  constructor(private readonly hardIdleTimeoutMs = 60_000) {
    this.prebootNextSession();
  }

  get sessionId(): string {
    return this.activeSessionId;
  }

  get storage(): MemoryStorageRuntime {
    return this.activeStorage;
  }

  get cartStore(): Map<string, unknown> {
    return this.activeCartStore;
  }

  private prebootNextSession(): void {
    this.sessionCounter += 1;
    this.activeSessionId = `session-${String(this.sessionCounter).padStart(3, '0')}`;
    this.activeStorage = createMemoryStorageRuntime();
    this.activeCartStore = new Map<string, unknown>();
    this.activeControllers = new Set<AbortController>();
    this.isSessionActive = false;
    this.clearIdleTimer();

    const boundSessionId = this.activeSessionId;
    __setKioskNativeModulesForTesting({
      KioskSession: {
        getConstants: () => ({ sessionId: boundSessionId }),
        getSessionId: () => boundSessionId,
        endSession: (reason: string) => {
          if (boundSessionId !== this.activeSessionId) return;
          this.performTeardownAndPreboot(reason as SessionEndReason);
        },
        setHoldTeardown: () => {},
        notifyActivity: () => {
          if (boundSessionId !== this.activeSessionId) return;
          this.isSessionActive = true;
          this.resetIdleTimer();
        },
        reportFatalError: () => {
          if (boundSessionId !== this.activeSessionId) return;
          this.performTeardownAndPreboot('ERROR');
        },
      },
    });
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.isSessionActive) {
        this.performTeardownAndPreboot('IDLE_KILL_SWITCH');
      }
    }, this.hardIdleTimeoutMs);
  }

  startSlowInternalApiCall(): AbortController {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    return controller;
  }

  loadPublicCdnImage(url: string): { cacheHit: boolean; hits: number } {
    const existing = this.publicCdnDiskCache.get(url);
    if (existing) {
      existing.hits += 1;
      return { cacheHit: true, hits: existing.hits };
    }
    this.publicCdnDiskCache.set(url, { url, hits: 1 });
    return { cacheHit: false, hits: 1 };
  }

  private performTeardownAndPreboot(reason: string): void {
    const retiringSessionId = this.activeSessionId;
    this.clearIdleTimer();

    // 1. Cancel all tagged in-flight customer internal HTTP calls
    for (const ctrl of this.activeControllers) {
      ctrl.abort(`Session ${retiringSessionId} ended (${reason})`);
    }
    this.activeControllers.clear();

    // 2. Wipe OS clipboard
    this.clipboard = '';

    // 3. Destroy ephemeral JS runtime (AsyncStorage + MMKV + listeners + app store)
    this.activeCartStore.clear();
    this.activeStorage.dispose();

    this.teardownLog.push({ sessionId: retiringSessionId, reason });

    // 4. Pre-boot next fresh customer session (preserving public CDN disk cache!)
    this.prebootNextSession();
  }

  destroy(): void {
    this.clearIdleTimer();
    this.activeStorage.dispose();
    __resetKioskNativeModulesForTesting();
  }
}

describe('PRD §7.1 Dirty Customer Reset Canary', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await DefaultAsyncStorage.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
    __resetKioskNativeModulesForTesting();
  });

  it('wipes all customer AsyncStorage, MMKV, listeners, app store, clipboard, and slow internal requests on endSession("CANCELED") AND 60s kill switch while preserving public CDN cache', async () => {
    const harness = new KioskCanaryHarness(60_000);

    try {
      // === Customer 1 (session-001): Dirty every mutable surface ===
      expect(KioskSession.sessionId).toBe('session-001');
      KioskSession.notifyActivity();

      const runtime1 = harness.storage;
      harness.cartStore.set('items', [{ sku: 'SKU-9001', qty: 2 }]);
      harness.clipboard = '4111-1111-1111-1111';

      await runtime1.AsyncStorage.setItem(
        'customer.pii',
        JSON.stringify({ name: 'Jane Shopper', email: 'jane@example.com' }),
      );
      await runtime1.AsyncStorage.mergeItem(
        'customer.pii',
        JSON.stringify({ loyaltyId: 'LOY-888' }),
      );

      const mmkv1Default = new runtime1.MMKV();
      const mmkv1Cart = runtime1.createMMKV({ id: 'cart' });
      const mmkv1Payment = runtime1.createMMKV({ id: 'payment-cache' });
      mmkv1Default.set('customer.email', 'jane@example.com');
      mmkv1Cart.set('cart.total', 89.99);
      mmkv1Cart.set('cart.zeroFlag', false);
      mmkv1Payment.set('emv.receipt', new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

      const runtime1ListenerEvents: string[] = [];
      mmkv1Default.addOnValueChangedListener((k) =>
        runtime1ListenerEvents.push(`default:${k}`),
      );
      mmkv1Cart.addOnValueChangedListener((k) =>
        runtime1ListenerEvents.push(`cart:${k}`),
      );

      const slowInternalCall1 = harness.startSlowInternalApiCall();
      expect(slowInternalCall1.signal.aborted).toBe(false);

      const cdnThumbUrl = 'https://cdn.public.example/catalog/sku-9001.webp';
      expect(harness.loadPublicCdnImage(cdnThumbUrl).cacheHit).toBe(false);

      // Trigger explicit checkout cancel
      KioskSession.endSession('CANCELED');

      // === Assertions on retired Customer 1 ===
      expect(slowInternalCall1.signal.aborted).toBe(true);
      expect(harness.clipboard).toBe('');
      expect(runtime1.isDisposed).toBe(true);
      expect(await runtime1.AsyncStorage.getAllKeys()).toEqual([]);
      expect(mmkv1Default.getAllKeys()).toEqual([]);
      expect(mmkv1Default.size).toBe(0);
      expect(mmkv1Default.length).toBe(0);
      expect(mmkv1Cart.getAllKeys()).toEqual([]);
      expect(mmkv1Payment.getBuffer('emv.receipt')).toBeUndefined();
      // Post-disposal writes fail fast
      await expect(
        runtime1.AsyncStorage.setItem('zombie', 'nope'),
      ).rejects.toThrow(/disposed/);
      expect(() => mmkv1Default.set('zombie', 'nope')).toThrow(/disposed/);
      // Idempotent second dispose
      expect(() => runtime1.dispose()).not.toThrow();

      // === Customer 2 (session-002): Zero residual state + warm public CDN cache ===
      expect(KioskSession.sessionId).toBe('session-002');
      expect(harness.cartStore.size).toBe(0);
      expect(harness.clipboard).toBe('');

      const runtime2 = harness.storage;
      expect(await runtime2.AsyncStorage.getAllKeys()).toEqual([]);
      expect(await runtime2.AsyncStorage.getItem('customer.pii')).toBeNull();

      const mmkv2Default = new runtime2.MMKV();
      const mmkv2Cart = runtime2.createMMKV({ id: 'cart' });
      const mmkv2Payment = runtime2.createMMKV({ id: 'payment-cache' });

      expect(mmkv2Default.getAllKeys()).toEqual([]);
      expect(mmkv2Default.size).toBe(0);
      expect(mmkv2Default.byteSize).toBe(0);
      expect(mmkv2Default.length).toBe(0);
      expect(mmkv2Default.getString('customer.email')).toBeUndefined();
      expect(mmkv2Cart.getNumber('cart.total')).toBeUndefined();
      expect(mmkv2Payment.getBuffer('emv.receipt')).toBeUndefined();

      // Mutating Customer 2 triggers ZERO listener events on retired Customer 1
      const listenerCountBefore = runtime1ListenerEvents.length;
      mmkv2Default.set('customer.email', 'bob@example.com');
      mmkv2Cart.set('cart.total', 12.5);
      expect(runtime1ListenerEvents.length).toBe(listenerCountBefore);

      // Module-level default singletons were NEVER polluted by either isolated runtime
      expect(await DefaultAsyncStorage.getAllKeys()).toEqual([]);
      expect(new DefaultMMKV().getAllKeys()).toEqual([]);

      // Public CDN image hits warm disk cache
      expect(harness.loadPublicCdnImage(cdnThumbUrl)).toEqual({
        cacheHit: true,
        hits: 2,
      });

      // === Scenario B: 60s Native Hard Idle Kill Switch ===
      KioskSession.notifyActivity();
      await runtime2.AsyncStorage.setItem('abandoned.cart', '{"sku":"Z9"}');
      harness.clipboard = 'customer-2-secret';
      const slowInternalCall2 = harness.startSlowInternalApiCall();

      // At 59,999ms: still alive!
      jest.advanceTimersByTime(59_999);
      expect(KioskSession.sessionId).toBe('session-002');
      expect(slowInternalCall2.signal.aborted).toBe(false);
      expect(runtime2.isDisposed).toBe(false);

      // At 60,000ms: native kill switch fires unconditionally!
      jest.advanceTimersByTime(1);
      expect(KioskSession.sessionId).toBe('session-003');
      expect(slowInternalCall2.signal.aborted).toBe(true);
      expect(runtime2.isDisposed).toBe(true);
      expect(harness.clipboard).toBe('');

      // Customer 3 sees zero residual state while CDN remains warm
      const runtime3 = harness.storage;
      expect(await runtime3.AsyncStorage.getAllKeys()).toEqual([]);
      expect(new runtime3.MMKV().getAllKeys()).toEqual([]);
      expect(harness.loadPublicCdnImage(cdnThumbUrl)).toEqual({
        cacheHit: true,
        hits: 3,
      });

      expect(harness.teardownLog).toEqual([
        { sessionId: 'session-001', reason: 'CANCELED' },
        { sessionId: 'session-002', reason: 'IDLE_KILL_SWITCH' },
      ]);
    } finally {
      harness.destroy();
    }
  });
});
