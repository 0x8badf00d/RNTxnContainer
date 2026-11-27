import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const E2E_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(E2E_ROOT, '..');
export const FIXTURES_DIR = path.join(E2E_ROOT, 'fixtures');

const EXPORT_CONDITION_ORDER = Object.freeze([
  'node',
  'import',
  'default',
  'require',
  'react-native',
]);

const DECLARATION_SUFFIX_RE = /\.d\.[cm]?ts$/i;
const MAX_DIAGNOSTIC_CHARS = 4000;

let freshImportCounter = 0;

function truncateDiagnostic(text) {
  if (typeof text !== 'string' || text.length <= MAX_DIAGNOSTIC_CHARS) {
    return text ?? '';
  }
  return `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}\n... [truncated ${text.length - MAX_DIAGNOSTIC_CHARS} chars]`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const MAX_SYMLINK_HOPS = 40;
const EXPORT_BLOCKED = Symbol('EXPORT_BLOCKED');

function isOutsideRoot(rootPath, targetPath) {
  const rel = path.relative(rootPath, targetPath);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * Resolves a repository-relative POSIX path while strictly preventing both
 * lexical path traversal (`../`) and symlink escapes (including multi-hop and
 * dangling symlinks) outside `rootDir`.
 */
export function resolveRepoPath(relPath, opts = {}) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new TypeError('relPath must be a non-empty string');
  }
  if (relPath.includes('\0')) {
    throw new Error(`Invalid path containing NUL byte: ${JSON.stringify(relPath)}`);
  }
  if (relPath.includes('\\')) {
    throw new Error(`Windows backslash paths are not permitted: "${relPath}"`);
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`Absolute paths are not permitted (expected relative path): "${relPath}"`);
  }

  const root = path.resolve(opts.rootDir ?? REPO_ROOT);
  const resolved = path.resolve(root, relPath);
  const rel = path.relative(root, resolved);

  if (isOutsideRoot(root, resolved)) {
    throw new Error(`Path traversal rejected: "${relPath}" escapes "${root}"`);
  }

  const rawSegments = relPath.split('/').filter((seg) => seg.length > 0 && seg !== '.');
  const hasDotDot = rawSegments.includes('..');

  if (fs.existsSync(root)) {
    const realRoot = fs.realpathSync(root);
    let current = realRoot;
    let hops = 0;
    let missingDepth = 0;
    const pending = [...rawSegments];

    while (pending.length > 0) {
      const seg = pending.shift();
      if (seg === '' || seg === '.') {
        continue;
      }
      if (seg === '..') {
        if (missingDepth > 0) {
          missingDepth -= 1;
        }
        current = path.dirname(current);
        if (isOutsideRoot(realRoot, current)) {
          throw new Error(`Symlink escape rejected: "${relPath}" resolves outside "${realRoot}"`);
        }
        continue;
      }

      const next = path.join(current, seg);
      if (missingDepth > 0) {
        missingDepth += 1;
        current = next;
        continue;
      }

      let stat;
      try {
        stat = fs.lstatSync(next);
      } catch (err) {
        if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
          missingDepth = 1;
          current = next;
          continue;
        }
        throw err;
      }

      if (stat.isSymbolicLink()) {
        hops += 1;
        if (hops > MAX_SYMLINK_HOPS) {
          throw new Error(
            `Symlink escape rejected: symlink loop or excessive depth (> ${MAX_SYMLINK_HOPS}) for "${relPath}"`,
          );
        }
        const linkTarget = fs.readlinkSync(next);
        if (path.isAbsolute(linkTarget)) {
          let tail = null;
          if (linkTarget === realRoot) {
            tail = [];
          } else if (linkTarget.startsWith(`${realRoot}${path.sep}`)) {
            tail = linkTarget.slice(realRoot.length + 1).split(path.sep);
          } else if (root !== realRoot && linkTarget === root) {
            tail = [];
          } else if (root !== realRoot && linkTarget.startsWith(`${root}${path.sep}`)) {
            tail = linkTarget.slice(root.length + 1).split(path.sep);
          } else if (fs.existsSync(linkTarget)) {
            const realLinkTarget = fs.realpathSync(linkTarget);
            if (isOutsideRoot(realRoot, realLinkTarget)) {
              throw new Error(`Symlink escape rejected: "${relPath}" resolves outside "${realRoot}"`);
            }
            const relFromReal = path.relative(realRoot, realLinkTarget);
            tail = relFromReal ? relFromReal.split(path.sep) : [];
          } else {
            throw new Error(`Symlink escape rejected: "${relPath}" points outside "${realRoot}"`);
          }
          current = realRoot;
          if (tail.length > 0) {
            pending.unshift(...tail);
          }
        } else {
          const linkSegs = linkTarget.split('/');
          pending.unshift(...linkSegs);
        }
        continue;
      }

      current = next;
    }

    if (isOutsideRoot(realRoot, current)) {
      throw new Error(`Symlink escape rejected: "${relPath}" resolves outside "${realRoot}"`);
    }
    if (!opts.allowRoot && current === realRoot) {
      throw new Error(`Path must refer to an entry inside "${root}", got "${relPath}"`);
    }

    const finalTarget = hasDotDot
      ? path.join(root, path.relative(realRoot, current))
      : resolved;

    if (fs.existsSync(current)) {
      const realCurrent = fs.realpathSync(current);
      if (isOutsideRoot(realRoot, realCurrent)) {
        throw new Error(`Symlink escape rejected: "${relPath}" resolves outside "${realRoot}"`);
      }
    } else if (opts.mustExist) {
      throw new Error(`Required path not found: ${relPath} (resolved: ${finalTarget})`);
    }

    return finalTarget;
  }

  if (!opts.allowRoot && rel === '') {
    throw new Error(`Path must refer to an entry inside "${root}", got "${relPath}"`);
  }
  if (opts.mustExist) {
    throw new Error(`Required path not found: ${relPath} (resolved: ${resolved})`);
  }

  return resolved;
}

/**
 * Synchronous, shell-free subprocess execution helper.
 */
export function runCommand(cmd, args = [], opts = {}) {
  if (typeof cmd !== 'string' || cmd.trim().length === 0) {
    throw new TypeError('cmd must be a non-empty string');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('args must be an array of strings');
  }

  const cwd = opts.cwd ?? REPO_ROOT;
  const env = opts.env
    ? opts.replaceEnv === true
      ? { ...opts.env }
      : { ...process.env, ...opts.env }
    : process.env;

  const result = spawnSync(cmd, args, {
    cwd,
    env,
    input: opts.input,
    timeout: opts.timeout ?? 30_000,
    maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
    encoding: 'utf8',
    shell: false,
  });

  const normalized = {
    status: result.status,
    signal: result.signal,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error ?? null,
  };

  if (
    opts.throwOnNonZero === true &&
    (normalized.error !== null || normalized.signal !== null || normalized.status !== 0)
  ) {
    const parts = [
      `Command failed: ${cmd} ${args.join(' ')}`,
      `status=${normalized.status}`,
      normalized.signal ? `signal=${normalized.signal}` : null,
      normalized.error ? `error=${normalized.error.message}` : null,
      normalized.stderr ? `stderr:\n${truncateDiagnostic(normalized.stderr)}` : null,
      normalized.stdout ? `stdout:\n${truncateDiagnostic(normalized.stdout)}` : null,
    ].filter(Boolean);
    throw new Error(parts.join('\n'), { cause: normalized.error ?? undefined });
  }

  return normalized;
}

function resolveExportConditionTarget(entry) {
  if (entry === null) {
    return EXPORT_BLOCKED;
  }
  if (typeof entry === 'string') {
    if (DECLARATION_SUFFIX_RE.test(entry)) {
      return null;
    }
    return entry;
  }
  if (Array.isArray(entry)) {
    let sawBlocked = false;
    for (const candidate of entry) {
      const resolved = resolveExportConditionTarget(candidate);
      if (resolved === EXPORT_BLOCKED) {
        sawBlocked = true;
        continue;
      }
      if (resolved !== null) {
        return resolved;
      }
    }
    return sawBlocked ? EXPORT_BLOCKED : null;
  }
  if (isPlainObject(entry)) {
    for (const condition of EXPORT_CONDITION_ORDER) {
      if (Object.hasOwn(entry, condition)) {
        if (entry[condition] === null) {
          return EXPORT_BLOCKED;
        }
        const resolved = resolveExportConditionTarget(entry[condition]);
        if (resolved === EXPORT_BLOCKED) {
          return EXPORT_BLOCKED;
        }
        if (resolved !== null) {
          return resolved;
        }
      }
    }
    return null;
  }
  return null;
}

function matchSubpathPattern(exportsMap, subpath) {
  let bestMatch = null;
  for (const [patternKey, targetEntry] of Object.entries(exportsMap)) {
    if (!patternKey.startsWith('./') || !patternKey.includes('*')) {
      continue;
    }
    const firstStar = patternKey.indexOf('*');
    if (patternKey.indexOf('*', firstStar + 1) !== -1) {
      continue;
    }
    const prefix = patternKey.slice(0, firstStar);
    const suffix = patternKey.slice(firstStar + 1);
    if (
      subpath.length >= prefix.length + suffix.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix)
    ) {
      const wildcardMatch = subpath.slice(prefix.length, subpath.length - suffix.length);
      if (
        bestMatch === null ||
        prefix.length > bestMatch.prefix.length ||
        (prefix.length === bestMatch.prefix.length && suffix.length > bestMatch.suffix.length)
      ) {
        bestMatch = { prefix, suffix, wildcardMatch, targetEntry };
      }
    }
  }
  if (!bestMatch) {
    return { matched: false, target: null };
  }
  if (bestMatch.targetEntry === null) {
    return { matched: true, target: null, blocked: true };
  }
  const rawTarget = resolveExportConditionTarget(bestMatch.targetEntry);
  if (rawTarget === EXPORT_BLOCKED) {
    return { matched: true, target: null, blocked: true };
  }
  if (rawTarget === null) {
    return { matched: true, target: null, blocked: false };
  }
  const expanded = rawTarget.replaceAll('*', bestMatch.wildcardMatch);
  if (DECLARATION_SUFFIX_RE.test(expanded)) {
    return { matched: true, target: null, blocked: false };
  }
  return { matched: true, target: expanded, blocked: false };
}

/**
 * Resolves a public `@internal/kiosk-host` subpath export via `package.json#exports`
 * without guessing internal source paths when built outputs are absent.
 */
export function resolveKioskHostExportPath(subpath = '.', opts = {}) {
  if (typeof subpath !== 'string' || (subpath !== '.' && !subpath.startsWith('./'))) {
    throw new TypeError(
      `Invalid @internal/kiosk-host export subpath ${JSON.stringify(subpath)}: must be "." or start with "./"`,
    );
  }
  if (subpath.includes('\0') || subpath.includes('\\')) {
    throw new TypeError(`Invalid characters in export subpath ${JSON.stringify(subpath)}`);
  }

  const rootDir = path.resolve(opts.rootDir ?? REPO_ROOT);
  const pkgPath = path.join(rootDir, 'package.json');

  if (!fs.existsSync(pkgPath) || !fs.statSync(pkgPath).isFile()) {
    throw new Error(
      `Cannot resolve @internal/kiosk-host export "${subpath}": missing ${pkgPath}`,
    );
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    throw new Error(`Malformed package.json at ${pkgPath}: ${err.message}`, { cause: err });
  }

  if (pkg?.name !== '@internal/kiosk-host') {
    throw new Error(
      `Expected package.json name "@internal/kiosk-host", got ${JSON.stringify(pkg?.name)}`,
    );
  }

  let rawTarget = null;
  const exportsField = pkg.exports;

  if (exportsField == null) {
    if (subpath === '.' && (typeof pkg.module === 'string' || typeof pkg.main === 'string')) {
      rawTarget = pkg.module || pkg.main;
    } else {
      throw new Error(
        `Export subpath "${subpath}" cannot be resolved: package.json has no "exports" map`,
      );
    }
  } else if (typeof exportsField === 'string') {
    if (subpath !== '.') {
      throw new Error(`Export subpath "${subpath}" is not defined in package.json exports`);
    }
    rawTarget = exportsField;
  } else if (isPlainObject(exportsField)) {
    const keys = Object.keys(exportsField);
    const hasDotKeys = keys.some((k) => k.startsWith('.'));
    const hasConditionKeys = keys.some((k) => !k.startsWith('.'));

    if (hasDotKeys && hasConditionKeys) {
      throw new Error(
        `Invalid package.json "exports": cannot mix subpath keys and condition keys`,
      );
    }

    if (!hasDotKeys) {
      if (subpath !== '.') {
        throw new Error(`Export subpath "${subpath}" is not defined in package.json exports`);
      }
      rawTarget = resolveExportConditionTarget(exportsField);
      if (rawTarget === EXPORT_BLOCKED) {
        throw new Error(`Export subpath "${subpath}" is explicitly restricted (null) in package.json`);
      }
      if (rawTarget === null) {
        throw new Error(
          `Export "${subpath}" in package.json has no runnable target condition (checked: ${EXPORT_CONDITION_ORDER.join(', ')})`,
        );
      }
    } else if (Object.hasOwn(exportsField, subpath)) {
      const entry = exportsField[subpath];
      if (entry === null) {
        throw new Error(`Export subpath "${subpath}" is explicitly restricted (null) in package.json`);
      }
      rawTarget = resolveExportConditionTarget(entry);
      if (rawTarget === EXPORT_BLOCKED) {
        throw new Error(`Export subpath "${subpath}" is explicitly restricted (null) in package.json`);
      }
      if (rawTarget === null) {
        throw new Error(
          `Export "${subpath}" in package.json has no runnable target condition (checked: ${EXPORT_CONDITION_ORDER.join(', ')})`,
        );
      }
    } else {
      const patternResult = matchSubpathPattern(exportsField, subpath);
      if (!patternResult.matched) {
        throw new Error(`Export subpath "${subpath}" is not defined in package.json exports`);
      }
      if (patternResult.blocked) {
        throw new Error(`Export subpath "${subpath}" is explicitly restricted (null) in package.json`);
      }
      if (patternResult.target === null) {
        throw new Error(
          `Export "${subpath}" in package.json has no runnable target condition (checked: ${EXPORT_CONDITION_ORDER.join(', ')})`,
        );
      }
      rawTarget = patternResult.target;
    }
  } else {
    throw new Error(`Unsupported package.json "exports" type: ${typeof exportsField}`);
  }

  if (typeof rawTarget !== 'string' || rawTarget.length === 0) {
    throw new Error(`Export "${subpath}" resolved to an empty target in package.json`);
  }
  if (DECLARATION_SUFFIX_RE.test(rawTarget)) {
    throw new Error(
      `Export "${subpath}" resolved to a non-executable TypeScript declaration file: "${rawTarget}"`,
    );
  }

  const normalizedRel = rawTarget.startsWith('./') ? rawTarget.slice(2) : rawTarget;
  const absTarget = resolveRepoPath(normalizedRel, { rootDir, allowRoot: false });

  if (!fs.existsSync(absTarget) || !fs.statSync(absTarget).isFile()) {
    throw new Error(
      `Package export "${subpath}" resolved to "${absTarget}", which does not exist (has @internal/kiosk-host been built?)`,
    );
  }

  return absTarget;
}

/**
 * Dynamically imports a public `@internal/kiosk-host` subpath export.
 * Returns the verbatim ESM module namespace object.
 *
 * Note on `opts.fresh === true`: query-string cache busting re-evaluates ESM
 * modules (`.mjs`/ESM `.js`/`.ts`), whereas CommonJS `.cjs` modules share Node's
 * CJS require cache; use `createMemoryStorageRuntime()` or a child process when
 * testing CJS module isolation.
 */
export async function loadKioskHostExport(subpath = '.', opts = {}) {
  const absTarget = resolveKioskHostExportPath(subpath, opts);
  let url = pathToFileURL(absTarget).href;
  if (opts.fresh === true) {
    freshImportCounter += 1;
    url = `${url}?kiosk_e2e_fresh=${freshImportCounter}`;
  }

  try {
    return await import(url);
  } catch (err) {
    const hint =
      err?.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'
        ? ' (Node v22 strip mode cannot run TypeScript enum/parameter-property syntax without compiled JS output or --experimental-transform-types)'
        : '';
    throw new Error(
      `Failed to import @internal/kiosk-host export "${subpath}" from "${absTarget}": ${err?.message ?? err}${hint}`,
      { cause: err },
    );
  }
}

/**
 * Creates a private (`0o700`) temporary directory, invokes `fn(dir)`, and
 * unconditionally removes the directory in `finally` without masking errors
 * thrown by `fn`.
 */
export async function withTempDir(fn, prefix = 'kiosk-e2e-') {
  if (typeof fn !== 'function') {
    throw new TypeError('withTempDir requires a callback function');
  }
  if (
    typeof prefix !== 'string' ||
    prefix.length === 0 ||
    /[\\/]/.test(prefix) ||
    prefix.includes('..') ||
    prefix.includes('\0')
  ) {
    throw new TypeError(`Invalid temp directory prefix: ${JSON.stringify(prefix)}`);
  }

  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  await fsPromises.chmod(dir, 0o700);

  let completed = false;
  try {
    const value = await fn(dir);
    completed = true;
    return value;
  } finally {
    try {
      await fsPromises.rm(dir, { recursive: true, force: true });
    } catch (cleanupErr) {
      if (completed) {
        throw cleanupErr;
      }
    }
  }
}

export function assertExitZero(result, context = '') {
  const label = context ? `${context}: ` : '';
  const detail = [
    `status=${result?.status}`,
    `signal=${result?.signal}`,
    result?.error ? `error=${result.error.message}` : null,
    result?.stderr ? `stderr=${truncateDiagnostic(result.stderr)}` : null,
    result?.stdout ? `stdout=${truncateDiagnostic(result.stdout)}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  assert.equal(result?.error ?? null, null, `${label}subprocess spawn error (${detail})`);
  assert.equal(result?.signal ?? null, null, `${label}subprocess terminated by signal (${detail})`);
  assert.equal(result?.status, 0, `${label}expected exit code 0 (${detail})`);
}

export function assertExitNonZero(result, context = '') {
  const label = context ? `${context}: ` : '';
  assert.ok(
    result !== null && typeof result === 'object',
    `${label}expected command result object, got ${result === null ? 'null' : typeof result}`,
  );
  const detail = [
    `status=${result.status}`,
    `signal=${result.signal}`,
    result.error ? `error=${result.error.message ?? result.error}` : null,
    result.stderr ? `stderr=${truncateDiagnostic(result.stderr)}` : null,
    result.stdout ? `stdout=${truncateDiagnostic(result.stdout)}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  // Prevent ENOENT / spawn errors from masquerading as expected non-zero CLI rejection.
  assert.equal(result.error ?? null, null, `${label}subprocess failed to spawn (${detail})`);
  const hasNonZeroStatus = Number.isInteger(result.status) && result.status !== 0;
  const hasSignal = typeof result.signal === 'string' && result.signal.length > 0;
  assert.ok(
    hasNonZeroStatus || hasSignal,
    `${label}expected non-zero exit status or terminating signal (${detail})`,
  );
}

export function loadFixtureText(relFixturePath) {
  const absPath = resolveRepoPath(relFixturePath, {
    rootDir: FIXTURES_DIR,
    allowRoot: false,
    mustExist: true,
  });
  return fs.readFileSync(absPath, 'utf8');
}

export function loadFixtureJson(relFixturePath) {
  const raw = loadFixtureText(relFixturePath);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in fixture "${relFixturePath}": ${err.message}`, { cause: err });
  }
}
