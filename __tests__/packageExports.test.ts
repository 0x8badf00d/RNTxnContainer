import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('@internal/kiosk-host Package Manifest, Codegen & Dual ESM/CJS Build Contracts', () => {
  it('defines valid package.json exports, codegenConfig, bin, and optional peerDependencies', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(pkg['name']).toBe('@internal/kiosk-host');
    expect(pkg['codegenConfig']).toEqual({
      name: 'KioskHostSpecs',
      type: 'modules',
      jsSrcsDir: 'src/specs',
    });
    expect(pkg['bin']).toEqual({
      'check-kiosk-lockfile': './scripts/check-kiosk-lockfile.mjs',
    });

    const exportsMap = pkg['exports'] as Record<string, unknown>;
    expect(Object.keys(exportsMap)).toEqual([
      '.',
      './memory-storage',
      './memory-storage/async-storage',
      './memory-storage/mmkv',
      './metro',
      './package.json',
    ]);

    const peerMeta = pkg['peerDependenciesMeta'] as Record<
      string,
      { optional?: boolean }
    >;
    expect(peerMeta['react']?.optional).toBe(true);
    expect(peerMeta['react-native']?.optional).toBe(true);

    const files = pkg['files'] as string[];
    expect(files).toContain('dist');
    expect(files).toContain('src/specs');
    expect(files).toContain('scripts/check-kiosk-lockfile.mjs');
    expect(files).not.toContain('__tests__');
  });

  it('emits dual ESM + CJS dist/ outputs with zero ambient react-native type leakage', () => {
    expect(existsSync(DIST_DIR)).toBe(true);
    expect(
      JSON.parse(
        readFileSync(path.join(DIST_DIR, 'esm', 'package.json'), 'utf8'),
      ),
    ).toEqual({ type: 'module' });
    expect(
      JSON.parse(
        readFileSync(path.join(DIST_DIR, 'cjs', 'package.json'), 'utf8'),
      ),
    ).toEqual({ type: 'commonjs' });

    const requiredSubpaths = [
      'index.js',
      'index.d.ts',
      'memory-storage/index.js',
      'memory-storage/index.d.ts',
      'memory-storage/asyncStorageShim.js',
      'memory-storage/asyncStorageShim.d.ts',
      'memory-storage/mmkvShim.js',
      'memory-storage/mmkvShim.d.ts',
      'metro/withKioskHost.js',
      'metro/withKioskHost.d.ts',
    ];

    for (const format of ['esm', 'cjs']) {
      for (const rel of requiredSubpaths) {
        expect(existsSync(path.join(DIST_DIR, format, rel))).toBe(true);
      }
    }

    // Verify ZERO ambient `declare module 'react-native'` leaked into dist/
    const distFiles = walkFiles(DIST_DIR);
    for (const file of distFiles) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(/declare\s+module\s+['"]react-native['"]/);
    }
  });

  it('passes live Node v22 native ESM self-reference smoke checks across all 5 subpaths without react-native installed', () => {
    const esmScript = `
      import {
        KioskAssociate,
        KioskConfig,
        KioskSession,
        installKioskErrorGuards,
        sanitizeErrorMessage,
      } from '@internal/kiosk-host';
      import AsyncStorageDefault, { useAsyncStorage } from '@internal/kiosk-host/memory-storage/async-storage';
      import { MMKV, createMMKV, Mode } from '@internal/kiosk-host/memory-storage/mmkv';
      import { createMemoryStorageRuntime } from '@internal/kiosk-host/memory-storage';
      import withKioskHost, { KIOSK_STORAGE_ALIASES } from '@internal/kiosk-host/metro';

      globalThis.__turboModuleProxy = (name) => ({
        KioskAssociate: {
          getAssociateProfile: () => ({
            associateId: 'esm-a1',
            displayName: 'Ada',
            roles: ['cashier'],
            permissions: ['pos.sell'],
            storeId: 's1',
            accessToken: 'LEAKED_SECRET',
          }),
          requestAssociateLogout: () => {},
        },
        KioskConfig: {
          getDeviceConfig: () => ({
            storeId: 's1',
            kioskId: 'k1',
            terminalId: 't1',
            environment: 'prod',
          }),
        },
        KioskSession: {
          getConstants: () => ({ sessionId: 'esm-sess-123' }),
          getSessionId: () => 'esm-sess-123',
          endSession: () => {},
          setHoldTeardown: () => {},
          notifyActivity: () => {},
          reportFatalError: () => {},
        },
      })[name];

      const p = KioskAssociate.getAssociateProfile();
      if ('accessToken' in p || !Object.isFrozen(p) || !Object.isFrozen(p.roles)) {
        throw new Error('Profile projection/freeze check failed');
      }
      if (KioskConfig.getDeviceConfig().environment !== 'prod') {
        throw new Error('Config check failed');
      }
      if (KioskSession.sessionId !== 'esm-sess-123') {
        throw new Error('Session check failed');
      }
      const g = installKioskErrorGuards();
      if (!sanitizeErrorMessage('Bearer abc123').includes('[REDACTED]')) {
        throw new Error('Sanitize check failed');
      }
      g.dispose();

      // Verify AsyncStorage default import in native Node ESM (no .default trap!)
      await AsyncStorageDefault.setItem('k', 'v');
      if (await AsyncStorageDefault.getItem('k') !== 'v') {
        throw new Error('AsyncStorage default import check failed');
      }
      if (await useAsyncStorage('k').getItem() !== 'v') {
        throw new Error('useAsyncStorage check failed');
      }

      // Verify MMKV v3+v4 and isolated runtime
      const m = new MMKV({ mode: Mode.SINGLE_PROCESS });
      m.set('n', 7);
      if (createMMKV().getNumber('n') !== 7) {
        throw new Error('MMKV check failed');
      }
      const rt = createMemoryStorageRuntime();
      if (new rt.MMKV().getNumber('n') !== undefined) {
        throw new Error('Isolated runtime leaked default MMKV state');
      }
      rt.dispose();

      // Verify Metro wrapper
      const cfg = withKioskHost();
      let blocked = false;
      try {
        cfg.resolver.resolveRequest({ resolveRequest: () => ({ type: 'empty' }) }, 'react-native-webview', 'ios');
      } catch {
        blocked = true;
      }
      if (!blocked || !KIOSK_STORAGE_ALIASES['react-native-mmkv']) {
        throw new Error('Metro guardrail check failed');
      }

      console.log('ESM_SMOKE_OK');
    `;

    const res = spawnSync(process.execPath, ['--input-type=module', '-e', esmScript], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('ESM_SMOKE_OK');
  });

  it('passes live Node v22 CommonJS require() smoke checks and proves zero Dual-Package Hazard across ESM/CJS', () => {
    const dualScript = `
      import { createRequire } from 'node:module';
      import AsyncStorageESM from '@internal/kiosk-host/memory-storage/async-storage';
      import { MMKV as MMKV_ESM } from '@internal/kiosk-host/memory-storage/mmkv';

      const require = createRequire(import.meta.url);
      const rootCjs = require('@internal/kiosk-host');
      const asyncCjs = require('@internal/kiosk-host/memory-storage/async-storage');
      const mmkvCjs = require('@internal/kiosk-host/memory-storage/mmkv');
      const memCjs = require('@internal/kiosk-host/memory-storage');
      const metroCjs = require('@internal/kiosk-host/metro');

      if (!rootCjs.KioskAssociate || !rootCjs.KioskConfig || !rootCjs.KioskSession || !rootCjs.installKioskErrorGuards) {
        throw new Error('Missing CJS root exports');
      }
      if (typeof metroCjs.withKioskHost !== 'function' || typeof metroCjs.default !== 'function') {
        throw new Error('Missing CJS metro exports');
      }
      if (typeof memCjs.createMemoryStorageRuntime !== 'function') {
        throw new Error('Missing CJS memory-storage exports');
      }

      // Dual-Package Hazard check: module-level default singletons share state across ESM and CJS!
      await AsyncStorageESM.setItem('dual-key', 'shared-value');
      if (await asyncCjs.AsyncStorage.getItem('dual-key') !== 'shared-value') {
        throw new Error('AsyncStorage Dual-Package Hazard detected');
      }

      const instEsm = new MMKV_ESM();
      instEsm.set('dual-mmkv', 99);
      const instCjs = mmkvCjs.createMMKV();
      if (instCjs.getNumber('dual-mmkv') !== 99 || !(instEsm instanceof mmkvCjs.MMKV)) {
        throw new Error('MMKV Dual-Package Hazard detected');
      }

      console.log('CJS_AND_DUAL_OK');
    `;

    const res = spawnSync(process.execPath, ['--input-type=module', '-e', dualScript], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('CJS_AND_DUAL_OK');
  });
});
