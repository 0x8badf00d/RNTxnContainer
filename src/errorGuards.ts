import { getNativeKioskSession } from './internal/nativeBridge.js';
import type { KioskErrorGuardHandle, KioskErrorGuardOptions } from './types.js';

export const DEFAULT_MAX_ERROR_MESSAGE_LENGTH = 512;

const GUARD_STATE_SYMBOL = Symbol.for('@internal/kiosk-host/error-guards-state');

type ErrorUtilsGlobalHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler?: () => ErrorUtilsGlobalHandler | undefined;
  setGlobalHandler?: (handler: ErrorUtilsGlobalHandler | undefined) => void;
}

interface HermesPromiseRejectionTrackerOptions {
  allRejections: boolean;
  onUnhandled: (id: number, error: unknown) => void;
  onHandled?: (id: number) => void;
}

interface HermesInternalLike {
  enablePromiseRejectionTracker?: (
    options: HermesPromiseRejectionTrackerOptions,
  ) => void;
}

interface PromiseRejectionEventLike {
  reason?: unknown;
  preventDefault?: () => void;
}

interface NodeProcessLike {
  on?: (event: string, listener: (reason: unknown) => void) => unknown;
  off?: (event: string, listener: (reason: unknown) => void) => unknown;
  removeListener?: (
    event: string,
    listener: (reason: unknown) => void,
  ) => unknown;
}

interface ActiveGuardState {
  installed: boolean;
  handle: KioskErrorGuardHandle;
}

interface GlobalWithErrorHooks {
  [GUARD_STATE_SYMBOL]?: ActiveGuardState;
  ErrorUtils?: ErrorUtilsLike;
  HermesInternal?: HermesInternalLike;
  addEventListener?: (
    type: string,
    listener: (event: unknown) => void,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: (event: unknown) => void,
  ) => void;
  onunhandledrejection?: ((event: unknown) => void) | null;
  process?: NodeProcessLike;
}

function getGlobalHost(): GlobalWithErrorHooks {
  return globalThis as unknown as GlobalWithErrorHooks;
}

function safeExtractRawErrorText(error: unknown): string {
  try {
    if (error === null || error === undefined) {
      return 'UnknownError';
    }
    if (typeof error === 'string') {
      return error;
    }

    if (error instanceof Error) {
      let name = 'Error';
      let message = '';
      try {
        if (typeof error.name === 'string' && error.name.length > 0) {
          name = error.name;
        }
      } catch {
        name = 'Error';
      }
      try {
        if (typeof error.message === 'string') {
          message = error.message;
        }
      } catch {
        message = '';
      }
      return message.length > 0 ? `${name}: ${message}` : name;
    }

    if (typeof error === 'object') {
      try {
        const record = error as Record<string, unknown>;
        const rawMessage = record['message'];
        if (typeof rawMessage === 'string') {
          let name = 'Error';
          try {
            const rawName = record['name'];
            if (typeof rawName === 'string' && rawName.length > 0) {
              name = rawName;
            }
          } catch {
            name = 'Error';
          }
          return rawMessage.length > 0 ? `${name}: ${rawMessage}` : name;
        }
      } catch {
        // Fall through to String(error)
      }
    }

    return String(error);
  } catch {
    return 'UnknownError';
  }
}

function isUriPrefixAt(str: string, start: number, end: number): boolean {
  if (end - start < 2) {
    return false;
  }
  // Relative path starting with '/' (e.g. /api/v1/checkout)
  if (str.charCodeAt(start) === 47 /* '/' */) {
    return true;
  }
  // RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":" <non-empty>
  // Handles both hierarchical (https://, myapp-kiosk://) and opaque (com.retail.kiosk:callback) URIs.
  const first = str.charCodeAt(start);
  const isAlpha =
    (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
  if (!isAlpha) {
    return false;
  }
  for (let i = start + 1; i < end; i++) {
    const ch = str.charCodeAt(i);
    if (ch === 58 /* ':' */) {
      return i + 1 < end;
    }
    const isSchemeChar =
      (ch >= 65 && ch <= 90) ||
      (ch >= 97 && ch <= 122) ||
      (ch >= 48 && ch <= 57) ||
      ch === 43 /* '+' */ ||
      ch === 45 /* '-' */ ||
      ch === 46 /* '.' */;
    if (!isSchemeChar) {
      return false;
    }
  }
  return false;
}

function isUriPrefixDelimiter(ch: number): boolean {
  return (
    ch === 61 /* '=' */ ||
    ch === 44 /* ',' */ ||
    ch === 59 /* ';' */ ||
    ch === 40 /* '(' */ ||
    ch === 41 /* ')' */ ||
    ch === 91 /* '[' */ ||
    ch === 93 /* ']' */ ||
    ch === 123 /* '{' */ ||
    ch === 125 /* '}' */ ||
    ch === 58 /* ':' */ ||
    ch === 38 /* '&' */
  );
}

const URI_TOKEN_RE = /[^\s"'`<>]+/g;
const AUTH_HEADER_RE =
  /\b(Authorization(?:\\\\\\"|\\"|["'`])?[ \t]*[:=][ \t]*(\\\\\\"|\\"|["'`])?)(?:Bearer|Basic|Token|ApiKey|Api-Key)[ \t]+/gi;
const BEARER_BASIC_RE = /\b(Bearer|Basic)[ \t]+/gi;
const EYJ_JWT_RE =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}=*\.(?:[A-Za-z0-9_-]{4,}=*\.(?:[A-Za-z0-9_-]+=*(?:\.(?:[A-Za-z0-9_-]+=*(?:\.[A-Za-z0-9_-]+=*)?|\.[A-Za-z0-9_-]+=*))?)?|[A-Za-z0-9_-]{0,3}=*\.[A-Za-z0-9_-]+=*\.[A-Za-z0-9_-]*=*\.[A-Za-z0-9_-]+=*)(?![A-Za-z0-9_=-])/g;
const LONG_JWT_RE =
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{10,}=*\.[A-Za-z0-9_-]{10,}=*\.[A-Za-z0-9_-]{10,}=*(?![A-Za-z0-9_=-])/g;
const KV_STANDALONE_RE =
  /(?<![A-Za-z0-9])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|passwd|secret|token)(?:\\\\\\"|\\"|["'`])?[ \t]*[:=][ \t]*/gi;
const KV_CAMEL_RE =
  /[A-Za-z0-9](?:AccessToken|RefreshToken|IdToken|IDToken|ClientSecret|ApiKey|APIKey|Password|Passwd|Secret|Token)(?:\\\\\\"|\\"|["'`])?[ \t]*[:=][ \t]*/g;
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PAN_RE = /(?<![A-Za-z0-9])(?:\d[ -]?){12,18}\d(?![A-Za-z0-9])/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const PHONE_RE =
  /(?<!\d)(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g;

/**
 * Linear-time O(N) scanner redacting query strings and fragments on hierarchical
 * URIs (http/https/custom://), opaque RFC 3986 custom OAuth URIs (scheme:path?...),
 * and relative paths (/path?...). Supports backticks, markdown parens, commas,
 * semicolons, and chained multi-'=' parameters while keeping query-internal
 * punctuation intact inside the redacted span.
 */
function redactUriQueriesAndFragments(text: string): string {
  if (text.indexOf('?') === -1 && text.indexOf('#') === -1) {
    return text;
  }

  return text.replace(URI_TOKEN_RE, (token, offset: number) => {
    let coreEnd = token.length;
    // Preserve trailing backslash of an escaped JSON closing quote \"
    if (
      coreEnd > 0 &&
      token.charCodeAt(coreEnd - 1) === 92 /* '\\' */ &&
      text.charCodeAt(offset + coreEnd) === 34 /* '"' */
    ) {
      coreEnd--;
    }
    while (coreEnd > 0) {
      const c = token.charCodeAt(coreEnd - 1);
      if (
        c === 93 /* ']' */ &&
        (token.endsWith('[REDACTED]', coreEnd) ||
          token.endsWith('[REDACTED_JWT]', coreEnd))
      ) {
        break;
      }
      if (
        c === 41 /* ')' */ ||
        c === 93 /* ']' */ ||
        c === 125 /* '}' */ ||
        c === 44 /* ',' */ ||
        c === 59 /* ';' */
      ) {
        coreEnd--;
      } else {
        break;
      }
    }

    const core = coreEnd === token.length ? token : token.slice(0, coreEnd);
    const trailing = coreEnd === token.length ? '' : token.slice(coreEnd);

    let nextQ = core.indexOf('?');
    let nextH = core.indexOf('#');
    if (nextQ === -1 && nextH === -1) {
      return token;
    }

    // Single left-to-right pass over disjoint segment starts with monotonic next-? / next-# cursors.
    // Because every delimiter in isUriPrefixDelimiter is either ':' (immediate return in isUriPrefixAt)
    // or a non-scheme char (immediate false in isUriPrefixAt), total work is strictly O(core.length).
    let matchedSplitIdx = -1;
    let matchedQ = -1;
    let matchedH = -1;
    let segStart = 0;

    while (segStart < core.length) {
      if (nextQ !== -1 && nextQ < segStart) {
        nextQ = core.indexOf('?', segStart);
      }
      if (nextH !== -1 && nextH < segStart) {
        nextH = core.indexOf('#', segStart);
      }
      if (nextQ === -1 && nextH === -1) {
        break;
      }

      const segSplitIdx =
        nextQ !== -1 && (nextH === -1 || nextQ < nextH) ? nextQ : nextH;

      if (
        segSplitIdx - segStart >= 2 &&
        isUriPrefixAt(core, segStart, segSplitIdx)
      ) {
        matchedSplitIdx = segSplitIdx;
        matchedQ = nextQ;
        matchedH = nextH;
        break;
      }

      let delimIdx = -1;
      for (let i = segStart; i < core.length; i++) {
        if (isUriPrefixDelimiter(core.charCodeAt(i))) {
          delimIdx = i;
          break;
        }
      }
      if (delimIdx === -1) {
        break;
      }
      segStart = delimIdx + 1;
    }

    if (matchedSplitIdx === -1) {
      return token;
    }

    const prefix = core.slice(0, matchedSplitIdx);
    if (matchedQ !== -1 && matchedH !== -1 && matchedQ < matchedH) {
      return `${prefix}?[REDACTED]#[REDACTED]${trailing}`;
    }
    if (matchedQ !== -1 && (matchedH === -1 || matchedQ < matchedH)) {
      return `${prefix}?[REDACTED]${trailing}`;
    }
    return `${prefix}#[REDACTED]${trailing}`;
  });
}

interface QuotedScanResult {
  readonly end: number;
  readonly closed: boolean;
}

function scanQuotedTail(
  text: string,
  start: number,
  quoteChar: string,
): QuotedScanResult {
  const quoteCode = quoteChar.charCodeAt(0);
  let i = start;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 10 /* '\n' */ || ch === 13 /* '\r' */) {
      return { end: i, closed: false };
    }
    if (ch === 92 /* '\\' */ && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next === 10 || next === 13) {
        return { end: i, closed: false };
      }
      i += 2;
      continue;
    }
    if (ch === quoteCode) {
      return { end: i + 1, closed: true };
    }
    i += 1;
  }
  return { end: i, closed: false };
}

function scanEscapedDoubleQuotedTail(
  text: string,
  start: number,
): QuotedScanResult {
  let i = start;
  let innerEscaped = false;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 10 /* '\n' */ || ch === 13 /* '\r' */) {
      return { end: i, closed: false };
    }
    if (ch === 34 /* '"' */) {
      // Unescaped outer quote terminates an enclosing JSON-stringified payload.
      return { end: i, closed: false };
    }
    if (ch === 92 /* '\\' */ && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next === 10 || next === 13) {
        return { end: i, closed: false };
      }
      if (next === 34 /* '"' */) {
        if (innerEscaped) {
          innerEscaped = false;
          i += 2;
          continue;
        }
        return { end: i + 2, closed: true };
      }
      if (next === 92 /* '\\' */) {
        innerEscaped = !innerEscaped;
        i += 2;
        continue;
      }
      innerEscaped = false;
      i += 2;
      continue;
    }
    innerEscaped = false;
    i += 1;
  }
  return { end: i, closed: false };
}

function scanTripleEscapedDoubleQuotedTail(
  text: string,
  start: number,
): QuotedScanResult {
  let i = start;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 10 /* '\n' */ || ch === 13 /* '\r' */) {
      return { end: i, closed: false };
    }
    if (ch === 34 /* '"' */) {
      return { end: i, closed: false };
    }
    if (ch === 92 /* '\\' */) {
      const runStart = i;
      while (i < text.length && text.charCodeAt(i) === 92 /* '\\' */) {
        i += 1;
      }
      const bsCount = i - runStart;
      if (i < text.length && text.charCodeAt(i) === 34 /* '"' */) {
        const quoteIdx = i;
        if (bsCount % 8 === 3) {
          // Level-3 closing quote (3, 11, ... backslashes before '"')
          return { end: quoteIdx + 1, closed: true };
        }
        if (bsCount % 8 === 7) {
          // Level-3 escaped inner quote (7, 15, ... backslashes before '"')
          i = quoteIdx + 1;
          continue;
        }
        if (bsCount % 4 === 1) {
          // Enclosing Level-2 '\"' quote (1, 5, ... backslashes before '"')
          return { end: runStart, closed: false };
        }
        // Even number of backslashes before '"': enclosing unescaped '"'
        return { end: quoteIdx, closed: false };
      }
      continue;
    }
    i += 1;
  }
  return { end: i, closed: false };
}

function isBaseKvTerminator(text: string, idx: number): boolean {
  if (idx >= text.length) {
    return true;
  }
  const ch = text.charCodeAt(idx);
  if (
    ch <= 32 ||
    ch === 38 /* '&' */ ||
    ch === 59 /* ';' */ ||
    ch === 44 /* ',' */ ||
    ch === 39 /* "'" */ ||
    ch === 34 /* '"' */ ||
    ch === 96 /* '`' */ ||
    ch === 125 /* '}' */
  ) {
    return true;
  }
  if (ch === 92 /* '\\' */ && text.charCodeAt(idx + 1) === 34 /* '"' */) {
    return true;
  }
  return false;
}

function isUnquotedKvTerminator(text: string, idx: number): boolean {
  if (isBaseKvTerminator(text, idx)) {
    return true;
  }
  if (text.charCodeAt(idx) === 93 /* ']' */) {
    return isBaseKvTerminator(text, idx + 1);
  }
  return false;
}

function scanUnquotedAuthToken(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (
      ch <= 32 ||
      ch === 44 /* ',' */ ||
      ch === 59 /* ';' */ ||
      ch === 39 /* "'" */ ||
      ch === 34 /* '"' */ ||
      ch === 96 /* '`' */ ||
      ch === 125 /* '}' */ ||
      ch === 93 /* ']' */
    ) {
      break;
    }
    if (ch === 92 /* '\\' */ && text.charCodeAt(i + 1) === 34 /* '"' */) {
      break;
    }
    i += 1;
  }
  return i;
}

function scanUnquotedSchemeToken(
  text: string,
  start: number,
  allowBearerChars: boolean,
): number {
  let i = start;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    const isBase =
      (ch >= 65 && ch <= 90) ||
      (ch >= 97 && ch <= 122) ||
      (ch >= 48 && ch <= 57) ||
      ch === 43 /* '+' */ ||
      ch === 47 /* '/' */ ||
      (allowBearerChars &&
        (ch === 45 /* '-' */ ||
          ch === 46 /* '.' */ ||
          ch === 95 /* '_' */ ||
          ch === 126 /* '~' */));
    if (!isBase) {
      break;
    }
    i += 1;
  }
  if (i === start) {
    return start;
  }
  while (i < text.length && text.charCodeAt(i) === 61 /* '=' */) {
    i += 1;
  }
  return i;
}

function redactAuthorizationHeaders(text: string): string {
  AUTH_HEADER_RE.lastIndex = 0;
  const parts: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = AUTH_HEADER_RE.exec(text)) !== null) {
    const matchStart = match.index;
    const prefix = match[1]!;
    const openQuote = match[2];
    const valStart = matchStart + match[0].length;

    let valEnd = valStart;
    let replacement: string | null = null;

    if (openQuote !== undefined) {
      if (openQuote === '\\\\\\"') {
        const scanned = scanTripleEscapedDoubleQuotedTail(text, valStart);
        valEnd = scanned.end;
        replacement = `${prefix}[REDACTED]${scanned.closed ? '\\\\\\"' : ''}`;
      } else if (openQuote === '\\"') {
        const scanned = scanEscapedDoubleQuotedTail(text, valStart);
        valEnd = scanned.end;
        replacement = `${prefix}[REDACTED]${scanned.closed ? '\\"' : ''}`;
      } else {
        const scanned = scanQuotedTail(text, valStart, openQuote);
        valEnd = scanned.end;
        replacement = `${prefix}[REDACTED]${scanned.closed ? openQuote : ''}`;
      }
    } else if (valStart < text.length) {
      if (text.startsWith('\\\\\\"', valStart)) {
        const scanned = scanTripleEscapedDoubleQuotedTail(text, valStart + 4);
        valEnd = scanned.end;
        replacement = `${prefix}[REDACTED]`;
      } else if (
        text.charCodeAt(valStart) === 92 /* '\\' */ &&
        text.charCodeAt(valStart + 1) === 34 /* '"' */
      ) {
        const scanned = scanEscapedDoubleQuotedTail(text, valStart + 2);
        valEnd = scanned.end;
        replacement = `${prefix}[REDACTED]`;
      } else {
        const firstChar = text[valStart];
        if (firstChar === '"' || firstChar === "'" || firstChar === '`') {
          const scanned = scanQuotedTail(text, valStart + 1, firstChar);
          valEnd = scanned.end;
          replacement = `${prefix}[REDACTED]`;
        } else {
          const end = scanUnquotedAuthToken(text, valStart);
          if (end > valStart) {
            valEnd = end;
            replacement = `${prefix}[REDACTED]`;
          }
        }
      }
    }

    if (replacement !== null) {
      parts.push(text.slice(cursor, matchStart), replacement);
      cursor = valEnd;
      AUTH_HEADER_RE.lastIndex = valEnd;
    }
  }

  if (cursor === 0) {
    return text;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

function redactBearerAndBasicTokens(text: string): string {
  BEARER_BASIC_RE.lastIndex = 0;
  const parts: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = BEARER_BASIC_RE.exec(text)) !== null) {
    const matchStart = match.index;
    const scheme = match[1]!;
    const valStart = matchStart + match[0].length;
    if (valStart >= text.length) {
      break;
    }

    let valEnd = valStart;
    let matched = false;

    if (text.startsWith('\\\\\\"', valStart)) {
      const scanned = scanTripleEscapedDoubleQuotedTail(text, valStart + 4);
      valEnd = scanned.end;
      matched = true;
    } else if (
      text.charCodeAt(valStart) === 92 /* '\\' */ &&
      text.charCodeAt(valStart + 1) === 34 /* '"' */
    ) {
      const scanned = scanEscapedDoubleQuotedTail(text, valStart + 2);
      valEnd = scanned.end;
      matched = true;
    } else {
      const firstChar = text[valStart];
      if (firstChar === '"' || firstChar === "'" || firstChar === '`') {
        const scanned = scanQuotedTail(text, valStart + 1, firstChar);
        valEnd = scanned.end;
        matched = true;
      } else {
        const end = scanUnquotedSchemeToken(
          text,
          valStart,
          scheme.toLowerCase() === 'bearer',
        );
        if (end > valStart) {
          valEnd = end;
          matched = true;
        }
      }
    }

    if (matched) {
      const normalizedScheme =
        scheme.toLowerCase() === 'bearer' ? 'Bearer' : 'Basic';
      parts.push(text.slice(cursor, matchStart), `${normalizedScheme} [REDACTED]`);
      cursor = valEnd;
      BEARER_BASIC_RE.lastIndex = valEnd;
    }
  }

  if (cursor === 0) {
    return text;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

function redactKeyValuesWithPattern(text: string, keySepRe: RegExp): string {
  const parts: string[] = [];
  let cursor = 0;
  keySepRe.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = keySepRe.exec(text)) !== null) {
    const valStart = match.index + match[0].length;
    if (valStart >= text.length) {
      break;
    }
    if (
      text.startsWith('[REDACTED_JWT]', valStart) &&
      isUnquotedKvTerminator(text, valStart + 14)
    ) {
      keySepRe.lastIndex = valStart + 14;
      continue;
    }
    if (
      text.startsWith('[REDACTED]', valStart) &&
      isUnquotedKvTerminator(text, valStart + 10)
    ) {
      keySepRe.lastIndex = valStart + 10;
      continue;
    }

    let valEnd = valStart;
    let replacement: string | null = null;

    if (text.startsWith('\\\\\\"', valStart)) {
      const scanned = scanTripleEscapedDoubleQuotedTail(text, valStart + 4);
      valEnd = scanned.end;
      replacement = `\\\\\\"[REDACTED]${scanned.closed ? '\\\\\\"' : ''}`;
    } else if (
      text.charCodeAt(valStart) === 92 /* '\\' */ &&
      text.charCodeAt(valStart + 1) === 34 /* '"' */
    ) {
      const scanned = scanEscapedDoubleQuotedTail(text, valStart + 2);
      valEnd = scanned.end;
      replacement = `\\"[REDACTED]${scanned.closed ? '\\"' : ''}`;
    } else {
      const firstChar = text[valStart];
      if (firstChar === '"' || firstChar === "'" || firstChar === '`') {
        const scanned = scanQuotedTail(text, valStart + 1, firstChar);
        valEnd = scanned.end;
        replacement = `${firstChar}[REDACTED]${scanned.closed ? firstChar : ''}`;
      } else {
        let i = valStart;
        while (i < text.length && !isUnquotedKvTerminator(text, i)) {
          i += 1;
        }
        if (i > valStart) {
          valEnd = i;
          replacement = '[REDACTED]';
        }
      }
    }

    if (replacement !== null) {
      parts.push(text.slice(cursor, valStart), replacement);
      cursor = valEnd;
      keySepRe.lastIndex = valEnd;
    }
  }

  if (cursor === 0) {
    return text;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/**
 * Redacts OAuth credentials, JWTs/JWEs, secrets, URL query strings/fragments,
 * emails, PANs, SSNs, and phone numbers in linear time and clamps length.
 * Guaranteed never to throw.
 */
export function sanitizeErrorMessage(
  error: unknown,
  maxLength: number = DEFAULT_MAX_ERROR_MESSAGE_LENGTH,
): string {
  let text = safeExtractRawErrorText(error);

  // 1. Authorization headers and Bearer/Basic schemes (unquoted, quoted, and JSON-escaped)
  if (text.indexOf(':') !== -1 || text.indexOf('=') !== -1) {
    text = redactAuthorizationHeaders(text);
  }
  text = redactBearerAndBasicTokens(text);

  // 2. JWTs & 5-segment JWEs (standard/padded/short/unsigned/hyphen-ended/JWE eyJ... and long 3-segment base64url tokens)
  if (text.indexOf('.') !== -1) {
    if (text.indexOf('eyJ') !== -1) {
      text = text.replace(EYJ_JWT_RE, '[REDACTED_JWT]');
    }
    text = text.replace(LONG_JWT_RE, '[REDACTED_JWT]');
  }

  // 3. Sensitive key-value secrets (standalone, snake_case/kebab-case prefixed, camelCase compound; quoted, escaped-JSON, or unquoted)
  if (text.indexOf(':') !== -1 || text.indexOf('=') !== -1) {
    text = redactKeyValuesWithPattern(text, KV_STANDALONE_RE);
    text = redactKeyValuesWithPattern(text, KV_CAMEL_RE);
  }

  // 4. URL query strings & fragments (http/https, custom/opaque OAuth schemes, relative paths)
  text = redactUriQueriesAndFragments(text);

  // 5. Email addresses (linear-time negative lookbehind over entire local-part charset)
  if (text.indexOf('@') !== -1) {
    text = text.replace(EMAIL_RE, '[REDACTED_EMAIL]');
  }

  // 6. PAN-like 13-19 digit sequences (preserving RFC 4122 UUIDs in O(N)), SSNs, and US phone numbers
  const uuidSpans: Array<[number, number]> = [];
  if (text.indexOf('-') !== -1) {
    UUID_RE.lastIndex = 0;
    let uuidMatch: RegExpExecArray | null;
    while ((uuidMatch = UUID_RE.exec(text)) !== null) {
      uuidSpans.push([uuidMatch.index, uuidMatch.index + uuidMatch[0].length]);
    }
  }

  let uuidCursor = 0;
  text = text.replace(PAN_RE, (match, offset: number) => {
    const end = offset + match.length;
    while (
      uuidCursor < uuidSpans.length &&
      uuidSpans[uuidCursor]![1] <= offset
    ) {
      uuidCursor++;
    }
    const span = uuidSpans[uuidCursor];
    if (span !== undefined && offset < span[1] && end > span[0]) {
      return match;
    }
    return '[REDACTED_PAN]';
  });
  text = text.replace(SSN_RE, '[REDACTED_ID]');
  text = text.replace(PHONE_RE, '[REDACTED_PHONE]');

  // 7. Strip control characters and normalize whitespace
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0) {
    text = 'UnknownError';
  }

  // 8. Clamp length strictly <= limit
  const limit =
    typeof maxLength === 'number' && Number.isFinite(maxLength) && maxLength >= 1
      ? Math.floor(maxLength)
      : DEFAULT_MAX_ERROR_MESSAGE_LENGTH;

  if (text.length > limit) {
    return limit <= 3 ? text.slice(0, limit) : `${text.slice(0, limit - 3)}...`;
  }

  return text;
}

function extractRejectionReason(event: unknown): unknown {
  try {
    if (event !== null && typeof event === 'object' && 'reason' in event) {
      return (event as PromiseRejectionEventLike).reason;
    }
    return event;
  } catch {
    return 'UnknownError';
  }
}

/**
 * Installs idempotent global JS crash and unhandled promise rejection guards
 * that report sanitized messages to NativeKioskSession.
 */
export function installKioskErrorGuards(
  options?: KioskErrorGuardOptions,
): KioskErrorGuardHandle {
  const host = getGlobalHost();
  const existing = host[GUARD_STATE_SYMBOL];
  if (existing && existing.installed) {
    return existing.handle;
  }

  const maxMessageLength =
    options?.maxMessageLength ?? DEFAULT_MAX_ERROR_MESSAGE_LENGTH;
  const chainPreviousHandler = options?.chainPreviousHandler ?? false;

  const restorers: Array<() => void> = [];

  const reportToNative = (error: unknown, isFatal: boolean): void => {
    try {
      const sanitized = sanitizeErrorMessage(error, maxMessageLength);
      const session = getNativeKioskSession();
      if (typeof session.reportFatalError === 'function') {
        session.reportFatalError(sanitized, isFatal);
      } else if (isFatal && typeof session.endSession === 'function') {
        session.endSession('ERROR');
      }
    } catch {
      // Never throw out of a global error/rejection handler
    }
  };

  const state: ActiveGuardState = {
    installed: true,
    handle: {
      dispose(): void {
        if (!state.installed) {
          return;
        }
        state.installed = false;
        if (host[GUARD_STATE_SYMBOL] === state) {
          delete host[GUARD_STATE_SYMBOL];
        }
        for (const restore of restorers) {
          try {
            restore();
          } catch {
            // Never throw during teardown restoration
          }
        }
        restorers.length = 0;
      },
      uninstall(): void {
        state.handle.dispose();
      },
      isInstalled(): boolean {
        return state.installed;
      },
    },
  };

  // 1. React Native ErrorUtils global handler
  const errorUtils = host.ErrorUtils;
  if (errorUtils && typeof errorUtils.setGlobalHandler === 'function') {
    let previousGlobalHandler: ErrorUtilsGlobalHandler | undefined;
    try {
      previousGlobalHandler =
        typeof errorUtils.getGlobalHandler === 'function'
          ? errorUtils.getGlobalHandler()
          : undefined;
    } catch {
      previousGlobalHandler = undefined;
    }

    const wrappedGlobalHandler: ErrorUtilsGlobalHandler = (error, isFatal) => {
      if (!state.installed) {
        return;
      }
      const fatal = typeof isFatal === 'boolean' ? isFatal : true;
      reportToNative(error, fatal);
      if (chainPreviousHandler && typeof previousGlobalHandler === 'function') {
        try {
          previousGlobalHandler(error, fatal);
        } catch {
          // Never throw out of global handler
        }
      }
    };

    let installedGlobalHandler = false;
    try {
      errorUtils.setGlobalHandler(wrappedGlobalHandler);
      installedGlobalHandler = true;
    } catch {
      // Defensive: frozen/throwing ErrorUtils must not abort remaining hooks
    }

    if (installedGlobalHandler) {
      restorers.push(() => {
        if (typeof errorUtils.setGlobalHandler === 'function') {
          try {
            errorUtils.setGlobalHandler(previousGlobalHandler);
          } catch {
            // Never throw during teardown restoration
          }
        }
      });
    }
  }

  // 2. Unhandled Promise Rejections (Hermes -> Web EventTarget -> onunhandledrejection)
  const hermesInternal = host.HermesInternal;
  if (
    hermesInternal &&
    typeof hermesInternal.enablePromiseRejectionTracker === 'function'
  ) {
    let installedHermesTracker = false;
    try {
      hermesInternal.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled: (_id, err) => {
          if (state.installed) {
            reportToNative(err, true);
          }
        },
        onHandled: () => {
          // No-op
        },
      });
      installedHermesTracker = true;
    } catch {
      // Defensive: do not abort installing remaining hooks
    }
    if (installedHermesTracker) {
      restorers.push(() => {
        if (
          typeof hermesInternal.enablePromiseRejectionTracker === 'function'
        ) {
          hermesInternal.enablePromiseRejectionTracker({
            allRejections: false,
            onUnhandled: () => {
              // No-op
            },
            onHandled: () => {
              // No-op
            },
          });
        }
      });
    }
  } else if (
    typeof host.addEventListener === 'function' &&
    typeof host.removeEventListener === 'function'
  ) {
    const webRejectionListener = (event: unknown): void => {
      if (!state.installed) {
        return;
      }
      try {
        if (
          event !== null &&
          typeof event === 'object' &&
          typeof (event as PromiseRejectionEventLike).preventDefault ===
            'function'
        ) {
          (event as PromiseRejectionEventLike).preventDefault!();
        }
      } catch {
        // Ignore preventDefault errors
      }
      reportToNative(extractRejectionReason(event), true);
    };

    let installedWebListener = false;
    try {
      host.addEventListener('unhandledrejection', webRejectionListener);
      installedWebListener = true;
    } catch {
      // Defensive: do not abort installing remaining hooks
    }
    if (installedWebListener) {
      restorers.push(() => {
        if (typeof host.removeEventListener === 'function') {
          host.removeEventListener('unhandledrejection', webRejectionListener);
        }
      });
    }
  } else {
    const hadOwnProp = Object.prototype.hasOwnProperty.call(
      host,
      'onunhandledrejection',
    );
    const previousOnUnhandledRejection = host.onunhandledrejection;

    let installedOnUnhandled = false;
    try {
      host.onunhandledrejection = (event: unknown): void => {
        if (!state.installed) {
          return;
        }
        reportToNative(extractRejectionReason(event), true);
        if (
          chainPreviousHandler &&
          typeof previousOnUnhandledRejection === 'function'
        ) {
          try {
            previousOnUnhandledRejection(event);
          } catch {
            // Never throw
          }
        }
      };
      installedOnUnhandled = true;
    } catch {
      // Defensive: do not abort installing remaining hooks
    }

    if (installedOnUnhandled) {
      restorers.push(() => {
        if (hadOwnProp) {
          host.onunhandledrejection = previousOnUnhandledRejection;
        } else {
          delete host.onunhandledrejection;
        }
      });
    }
  }

  // 3. Node.js process unhandledRejection listener
  const proc = host.process;
  if (proc && typeof proc.on === 'function') {
    const nodeRejectionListener = (reason: unknown): void => {
      if (state.installed) {
        reportToNative(reason, true);
      }
    };

    let installedNodeListener = false;
    try {
      proc.on('unhandledRejection', nodeRejectionListener);
      installedNodeListener = true;
    } catch {
      // Defensive: do not abort install
    }
    if (installedNodeListener) {
      restorers.push(() => {
        if (typeof proc.off === 'function') {
          proc.off('unhandledRejection', nodeRejectionListener);
        } else if (typeof proc.removeListener === 'function') {
          proc.removeListener('unhandledRejection', nodeRejectionListener);
        }
      });
    }
  }

  host[GUARD_STATE_SYMBOL] = state;
  return state.handle;
}
