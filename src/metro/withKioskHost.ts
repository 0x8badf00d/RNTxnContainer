export type MetroSourceFileResolution = {
  readonly type: 'sourceFile';
  readonly filePath: string;
};

export type MetroAssetFilesResolution = {
  readonly type: 'assetFiles';
  readonly filePaths: readonly string[];
};

export type MetroEmptyResolution = {
  readonly type: 'empty';
};

export type MetroVirtualResolution = {
  readonly type: 'virtual';
  readonly virtualPath: string | null | undefined;
  readonly source: string | Uint8Array;
};

export type MetroResolution =
  | MetroSourceFileResolution
  | MetroAssetFilesResolution
  | MetroEmptyResolution
  | MetroVirtualResolution;

export interface MetroResolutionContext<
  TContext = MetroDefaultResolutionContext,
  TResolution = MetroResolution,
> {
  readonly originModulePath?: string;
  readonly resolveRequest: (
    context: TContext,
    moduleName: string,
    platform: string | null,
  ) => TResolution;
}

export interface MetroDefaultResolutionContext {
  readonly originModulePath?: string;
  readonly resolveRequest: (
    context: MetroDefaultResolutionContext,
    moduleName: string,
    platform: string | null,
  ) => MetroResolution;
}

export type MetroResolveRequest<
  TContext = MetroDefaultResolutionContext,
  TResolution = MetroResolution,
> = (
  context: TContext,
  moduleName: string,
  platform: string | null,
) => TResolution;

export interface MetroResolverConfig<
  TContext = MetroDefaultResolutionContext,
  TResolution = MetroResolution,
> {
  readonly resolveRequest?: MetroResolveRequest<TContext, TResolution> | null;
}

export interface MetroConfigLike<
  TContext = MetroDefaultResolutionContext,
  TResolution = MetroResolution,
> {
  readonly resolver?: MetroResolverConfig<TContext, TResolution> | null;
}

export type KioskModulePolicyDecision =
  | { readonly action: 'block'; readonly blockedPackage: string }
  | {
      readonly action: 'alias';
      readonly matchedPackage: string;
      readonly targetModuleName: string;
    }
  | { readonly action: 'passthrough' };

export const KIOSK_STORAGE_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    '@react-native-async-storage/async-storage':
      '@internal/kiosk-host/memory-storage/async-storage',
    'react-native-mmkv': '@internal/kiosk-host/memory-storage/mmkv',
  });

export const KIOSK_BLOCKED_MODULES: readonly string[] = Object.freeze([
  'react-native-webview',
]);

const KIOSK_RESOLVER_BRAND = Symbol.for('@internal/kiosk-host/metro-resolver');

function stripWindowsExtendedPrefix(raw: string): string {
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(raw)) {
    return `//${raw.slice(8)}`;
  }
  if (/^[\\/]{2}\?[\\/]/.test(raw)) {
    return raw.slice(4);
  }
  return raw;
}

function stripQueryAndHash(raw: string): string {
  let end = raw.length;
  const qIdx = raw.indexOf('?');
  if (qIdx !== -1 && qIdx < end) {
    end = qIdx;
  }
  const hIdx = raw.indexOf('#');
  if (hIdx !== -1 && hIdx < end) {
    end = hIdx;
  }
  return raw.slice(0, end);
}

function normalizeSlashes(raw: string, stripQueryHash: boolean): string {
  const withoutWinPrefix = stripWindowsExtendedPrefix(raw);
  const base = stripQueryHash
    ? stripQueryAndHash(withoutWinPrefix)
    : withoutWinPrefix;
  let normalized = base.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function resolveDotSegments(slashNormalized: string): string[] {
  const rawSegments = slashNormalized.split('/');
  const stack: string[] = [];

  for (const segment of rawSegments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      const top = stack[stack.length - 1];
      if (top !== undefined && top !== '..') {
        stack.pop();
      } else {
        stack.push('..');
      }
      continue;
    }
    stack.push(segment);
  }

  return stack;
}

function matchesSegmentsAt(
  segments: readonly string[],
  startIndex: number,
  pkgSegmentsLower: readonly string[],
): boolean {
  if (startIndex + pkgSegmentsLower.length > segments.length) {
    return false;
  }
  for (let k = 0; k < pkgSegmentsLower.length; k++) {
    const expected = pkgSegmentsLower[k];
    const actual = segments[startIndex + k];
    if (
      expected === undefined ||
      actual === undefined ||
      actual.toLowerCase() !== expected
    ) {
      return false;
    }
  }
  return true;
}

function matchesPackageSpecifier(
  rawModuleName: string,
  packageName: string,
  isResolvedFilePath = false,
): boolean {
  if (typeof rawModuleName !== 'string' || rawModuleName.length === 0) {
    return false;
  }

  const slashNorm = normalizeSlashes(rawModuleName, !isResolvedFilePath);
  if (slashNorm.length === 0) {
    return false;
  }

  const pkgSegmentsLower = packageName.toLowerCase().split('/');
  const segments = resolveDotSegments(slashNorm);

  // Rule A: Bare package specifier or subpath (never match relative ./ or ../ or absolute / paths here).
  // Relies strictly on dot-resolved segments so "pkg/../other" passes through while "safe/../pkg" matches.
  const isRelativeOrAbsolute =
    slashNorm.startsWith('./') ||
    slashNorm.startsWith('../') ||
    slashNorm.startsWith('/') ||
    slashNorm === '.' ||
    slashNorm === '..' ||
    /^[a-zA-Z]:(?:\/|$)/.test(slashNorm) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\//.test(slashNorm);

  if (!isRelativeOrAbsolute) {
    if (
      segments.length >= pkgSegmentsLower.length &&
      segments[0] !== '..' &&
      matchesSegmentsAt(segments, 0, pkgSegmentsLower)
    ) {
      return true;
    }
  }

  // Rule B: Case-insensitive node_modules segment boundary match (macOS APFS / Windows NTFS / POSIX / pnpm)
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]?.toLowerCase() === 'node_modules') {
      if (matchesSegmentsAt(segments, i + 1, pkgSegmentsLower)) {
        return true;
      }
    }
  }

  return false;
}

function resolveKioskModulePolicyInternal(
  moduleName: string,
  isResolvedFilePath: boolean,
): KioskModulePolicyDecision {
  for (const blockedPackage of KIOSK_BLOCKED_MODULES) {
    if (
      matchesPackageSpecifier(moduleName, blockedPackage, isResolvedFilePath)
    ) {
      return { action: 'block', blockedPackage };
    }
  }

  for (const [matchedPackage, targetModuleName] of Object.entries(
    KIOSK_STORAGE_ALIASES,
  )) {
    if (
      matchesPackageSpecifier(moduleName, matchedPackage, isResolvedFilePath)
    ) {
      return { action: 'alias', matchedPackage, targetModuleName };
    }
  }

  return { action: 'passthrough' };
}

export function resolveKioskModulePolicy(
  moduleName: string,
): KioskModulePolicyDecision {
  return resolveKioskModulePolicyInternal(moduleName, false);
}

function buildBlockedModuleError(
  blockedPackage: string,
  offendingSpecifier: string,
  originModulePath?: string,
): Error {
  const originDetail =
    typeof originModulePath === 'string' && originModulePath.length > 0
      ? ` (imported from "${originModulePath}")`
      : '';
  return new Error(
    `[kiosk-host] Blocked module "${blockedPackage}" via "${offendingSpecifier}"${originDetail}. Customer WebViews are forbidden in kiosk builds (PRD v1 isolation policy). Remove this import to continue.`,
  );
}

function buildStorageBypassError(
  matchedPackage: string,
  offendingPath: string,
  targetModuleName: string,
  originModulePath?: string,
): Error {
  const originDetail =
    typeof originModulePath === 'string' && originModulePath.length > 0
      ? ` (imported from "${originModulePath}")`
      : '';
  return new Error(
    `[kiosk-host] Refused to bundle disk-backed storage module "${matchedPackage}" via "${offendingPath}"${originDetail}. Redirecting to "${targetModuleName}" still resolved into disk-backed storage.`,
  );
}

function isBrandedKioskResolver(fn: unknown): boolean {
  return (
    typeof fn === 'function' &&
    Boolean((fn as unknown as Record<symbol, unknown>)[KIOSK_RESOLVER_BRAND])
  );
}

function extractResolutionPaths(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const rec = value as Record<string, unknown>;
  const type = rec['type'];
  if (type === 'sourceFile' && typeof rec['filePath'] === 'string') {
    return [rec['filePath']];
  }
  if (type === 'assetFiles' && Array.isArray(rec['filePaths'])) {
    const paths: string[] = [];
    for (const item of rec['filePaths']) {
      if (typeof item === 'string') {
        paths.push(item);
      }
    }
    return paths;
  }
  if (type === 'virtual' && typeof rec['virtualPath'] === 'string') {
    return [rec['virtualPath']];
  }
  return [];
}

type PostResolutionDecision =
  | {
      readonly action: 'block';
      readonly blockedPackage: string;
      readonly offendingPath: string;
    }
  | {
      readonly action: 'alias';
      readonly matchedPackage: string;
      readonly targetModuleName: string;
      readonly offendingPath: string;
    }
  | { readonly action: 'passthrough' };

function inspectResolutionPolicy(resolution: unknown): PostResolutionDecision {
  const paths = extractResolutionPaths(resolution);
  let firstAlias:
    | {
        readonly action: 'alias';
        readonly matchedPackage: string;
        readonly targetModuleName: string;
        readonly offendingPath: string;
      }
    | null = null;

  for (const resolvedPath of paths) {
    const fileDecision = resolveKioskModulePolicyInternal(resolvedPath, true);
    if (fileDecision.action === 'block') {
      return {
        action: 'block',
        blockedPackage: fileDecision.blockedPackage,
        offendingPath: resolvedPath,
      };
    }
    if (fileDecision.action === 'alias' && firstAlias === null) {
      firstAlias = {
        action: 'alias',
        matchedPackage: fileDecision.matchedPackage,
        targetModuleName: fileDecision.targetModuleName,
        offendingPath: resolvedPath,
      };
    }
  }

  return firstAlias ?? { action: 'passthrough' };
}

export function createKioskResolveRequest<
  TContext extends MetroResolutionContext<TContext, unknown> =
    MetroDefaultResolutionContext,
>(
  previousResolveRequest?: MetroResolveRequest<
    TContext,
    ReturnType<TContext['resolveRequest']>
  > | null,
): MetroResolveRequest<TContext, ReturnType<TContext['resolveRequest']>> {
  type TResolution = ReturnType<TContext['resolveRequest']>;

  // Guard 1: Idempotent double-wrap protection via non-enumerable brand symbol
  if (previousResolveRequest && isBrandedKioskResolver(previousResolveRequest)) {
    return previousResolveRequest;
  }

  const activeResolutions = new Set<string>();
  const activeFallbackResolutions = new Set<string>();

  const invokeFallbackWithGuard = (
    contextResolver: MetroResolveRequest<TContext, TResolution>,
    context: TContext,
    modName: string,
    platform: string | null,
    key: string,
    extraGuardKey?: string,
  ): TResolution => {
    if (
      contextResolver === kioskResolveRequest ||
      activeFallbackResolutions.has(key) ||
      (extraGuardKey !== undefined &&
        activeFallbackResolutions.has(extraGuardKey))
    ) {
      throw new Error(
        `[kiosk-host] Metro resolveRequest recursion detected while resolving "${modName}".`,
      );
    }
    activeFallbackResolutions.add(key);
    const addedExtra =
      extraGuardKey !== undefined &&
      extraGuardKey !== key &&
      !activeFallbackResolutions.has(extraGuardKey);
    if (addedExtra && extraGuardKey !== undefined) {
      activeFallbackResolutions.add(extraGuardKey);
    }
    try {
      return contextResolver(context, modName, platform);
    } finally {
      activeFallbackResolutions.delete(key);
      if (addedExtra && extraGuardKey !== undefined) {
        activeFallbackResolutions.delete(extraGuardKey);
      }
    }
  };

  const kioskResolveRequest: MetroResolveRequest<TContext, TResolution> = (
    context: TContext,
    moduleName: string,
    platform: string | null,
  ): TResolution => {
    const decision = resolveKioskModulePolicy(moduleName);

    if (decision.action === 'block') {
      throw buildBlockedModuleError(
        decision.blockedPackage,
        moduleName,
        context.originModulePath,
      );
    }

    const targetModuleName =
      decision.action === 'alias' ? decision.targetModuleName : moduleName;
    const resolutionKey = `${context.originModulePath ?? ''}\0${platform ?? ''}\0${targetModuleName}`;

    // Guard 2 & 3: Self-reference, indirect cyclic wrapper, and multi-re-entry detection
    const alreadyActive = activeResolutions.has(resolutionKey);
    const addedResolutionKey = !alreadyActive;
    if (addedResolutionKey) {
      activeResolutions.add(resolutionKey);
    }

    try {
      const contextResolver = context.resolveRequest as MetroResolveRequest<
        TContext,
        TResolution
      >;
      const useContextFallback =
        alreadyActive || previousResolveRequest == null;
      const delegate: MetroResolveRequest<TContext, TResolution> =
        useContextFallback ? contextResolver : previousResolveRequest;

      const resolution = useContextFallback
        ? invokeFallbackWithGuard(
            contextResolver,
            context,
            targetModuleName,
            platform,
            resolutionKey,
          )
        : delegate(context, targetModuleName, platform);

      // Post-resolution defense-in-depth across sourceFile, assetFiles, and virtual resolutions
      const postDecision = inspectResolutionPolicy(resolution);
      if (postDecision.action === 'block') {
        throw buildBlockedModuleError(
          postDecision.blockedPackage,
          postDecision.offendingPath,
          context.originModulePath,
        );
      }

      if (postDecision.action === 'alias') {
        const aliasTarget = postDecision.targetModuleName;
        const aliasKey = `${context.originModulePath ?? ''}\0${platform ?? ''}\0${aliasTarget}`;

        // Step 1: If a custom delegate resolved an indirect specifier/relative path into
        // disk-backed storage, give that delegate a chance to resolve the memory-storage alias.
        if (
          !useContextFallback &&
          delegate !== contextResolver &&
          targetModuleName !== aliasTarget &&
          !activeResolutions.has(aliasKey)
        ) {
          activeResolutions.add(aliasKey);
          let redirected: TResolution;
          try {
            redirected = delegate(context, aliasTarget, platform);
          } finally {
            activeResolutions.delete(aliasKey);
          }
          const redirectedDecision = inspectResolutionPolicy(redirected);
          if (redirectedDecision.action === 'block') {
            throw buildBlockedModuleError(
              redirectedDecision.blockedPackage,
              redirectedDecision.offendingPath,
              context.originModulePath,
            );
          }
          if (redirectedDecision.action === 'passthrough') {
            return redirected;
          }
        }

        // Step 2: Fall back to Metro's default context.resolveRequest for the memory-storage alias
        // (unless we already resolved aliasTarget via contextResolver).
        const alreadyTriedContextForAlias =
          delegate === contextResolver && targetModuleName === aliasTarget;
        if (!alreadyTriedContextForAlias) {
          const addedAliasKey = !activeResolutions.has(aliasKey);
          if (addedAliasKey) {
            activeResolutions.add(aliasKey);
          }
          let fallback: TResolution;
          try {
            fallback = invokeFallbackWithGuard(
              contextResolver,
              context,
              aliasTarget,
              platform,
              aliasKey,
              resolutionKey,
            );
          } finally {
            if (addedAliasKey) {
              activeResolutions.delete(aliasKey);
            }
          }
          const fallbackDecision = inspectResolutionPolicy(fallback);
          if (fallbackDecision.action === 'block') {
            throw buildBlockedModuleError(
              fallbackDecision.blockedPackage,
              fallbackDecision.offendingPath,
              context.originModulePath,
            );
          }
          if (fallbackDecision.action === 'passthrough') {
            return fallback;
          }
          throw buildStorageBypassError(
            fallbackDecision.matchedPackage,
            fallbackDecision.offendingPath,
            aliasTarget,
            context.originModulePath,
          );
        }

        throw buildStorageBypassError(
          postDecision.matchedPackage,
          postDecision.offendingPath,
          aliasTarget,
          context.originModulePath,
        );
      }

      return resolution;
    } finally {
      if (addedResolutionKey) {
        activeResolutions.delete(resolutionKey);
      }
    }
  };

  Object.defineProperty(kioskResolveRequest, KIOSK_RESOLVER_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
  });

  return kioskResolveRequest;
}

/**
 * Wraps a Metro configuration to enforce `@internal/kiosk-host` build guardrails:
 * 1. Redirects `@react-native-async-storage/async-storage` and `react-native-mmkv`
 *    to pure in-memory JS `Map` shims (`@internal/kiosk-host/memory-storage/*`).
 * 2. Throws a hard build error if `react-native-webview` is imported directly or indirectly.
 *
 * Does not mutate `baseConfig` or `baseConfig.resolver`.
 *
 * Note: React Native 0.79+ enables `package.json` `"exports"` resolution in Metro by default.
 * Consuming apps on React Native 0.76–0.78 should enable
 * `resolver.unstable_enablePackageExports = true` so subpath imports such as
 * `@internal/kiosk-host/memory-storage/async-storage` resolve cleanly.
 */
export function withKioskHost<
  TContext extends MetroResolutionContext<TContext, unknown> =
    MetroDefaultResolutionContext,
  TConfig extends MetroConfigLike<
    TContext,
    ReturnType<TContext['resolveRequest']>
  > = MetroConfigLike<TContext, ReturnType<TContext['resolveRequest']>>,
>(
  baseConfig?: TConfig,
): Omit<TConfig, 'resolver'> & {
  readonly resolver: Omit<NonNullable<TConfig['resolver']>, 'resolveRequest'> & {
    readonly resolveRequest: MetroResolveRequest<
      TContext,
      ReturnType<TContext['resolveRequest']>
    >;
  };
} {
  const existingResolver = baseConfig?.resolver ?? undefined;
  const previousResolveRequest = existingResolver?.resolveRequest ?? null;
  const resolveRequest = createKioskResolveRequest<TContext>(
    previousResolveRequest,
  );

  const nextResolver = {
    ...(existingResolver as Record<string, unknown> | undefined),
    resolveRequest,
  };

  const nextConfig = {
    ...(baseConfig as Record<string, unknown> | undefined),
    resolver: nextResolver,
  };

  return nextConfig as Omit<TConfig, 'resolver'> & {
    readonly resolver: Omit<
      NonNullable<TConfig['resolver']>,
      'resolveRequest'
    > & {
      readonly resolveRequest: MetroResolveRequest<
        TContext,
        ReturnType<TContext['resolveRequest']>
      >;
    };
  };
}

export default withKioskHost;
