#!/usr/bin/env node

import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function freezeRules(rules) {
  return Object.freeze(rules.map((r) => Object.freeze({ ...r })));
}

export const MANDATORY_PODFILE_RULES = freezeRules([
  { rule: 'RNCAsyncStorage', category: 'storage' },
  { rule: '@react-native-async-storage/async-storage', category: 'storage' },
  { rule: 'react-native-async-storage', category: 'storage' },
  { rule: 'react-native-mmkv', category: 'storage' },
  { rule: 'MMKV', category: 'storage' },
  { rule: 'MMKVCore', category: 'storage' },
  { rule: 'MMKVAppExtension', category: 'storage' },
  { rule: 'op-sqlite', category: 'sqlite' },
  { rule: '@op-engineering/op-sqlite', category: 'sqlite' },
  { rule: 'OPSQLite', category: 'sqlite' },
  { rule: 'react-native-quick-sqlite', category: 'sqlite' },
  { rule: 'react-native-cookies', category: 'cookies' },
  { rule: '@react-native-cookies/cookies', category: 'cookies' },
  { rule: 'RNCCookies', category: 'cookies' },
  { rule: 'react-native-webview', category: 'webview' },
  { rule: 'RNCWebView', category: 'webview' },
]);

export const STRICT_PODFILE_RULES = freezeRules([
  { rule: 'react-native-sqlite-storage', category: 'sqlite' },
  { rule: 'SQLiteStorage', category: 'sqlite' },
  { rule: 'RealmJS', category: 'storage' },
  { rule: 'realm', category: 'storage' },
  { rule: 'WatermelonDB', category: 'storage' },
  { rule: 'watermelondb', category: 'storage' },
  { rule: 'RNFS', category: 'filesystem' },
  { rule: 'react-native-fs', category: 'filesystem' },
  { rule: 'react-native-blob-util', category: 'filesystem' },
  { rule: 'rn-fetch-blob', category: 'filesystem' },
]);

export const MANDATORY_GRADLE_RULES = freezeRules([
  // Exact group:artifact coordinate rules (matched first)
  { rule: 'com.tencent:mmkv', category: 'storage', kind: 'coordinate' },
  { rule: 'com.tencent:mmkv-static', category: 'storage', kind: 'coordinate' },
  { rule: 'com.tencent:mmkv-shared', category: 'storage', kind: 'coordinate' },
  { rule: 'com.reactnativecommunity:webview', category: 'webview', kind: 'coordinate' },
  { rule: 'com.reactnativecommunity:async-storage', category: 'storage', kind: 'coordinate' },
  { rule: 'io.github.react-native-async-storage:async-storage', category: 'storage', kind: 'coordinate' },
  { rule: 'com.reactnativecommunity:cookies', category: 'cookies', kind: 'coordinate' },
  { rule: 'com.opengineering:op-sqlite', category: 'sqlite', kind: 'coordinate' },
  // Exact artifact name rules (zero substring matching so androidx.sqlite:sqlite never false-positives)
  { rule: 'RNCAsyncStorage', category: 'storage', kind: 'artifact' },
  { rule: 'react-native-async-storage', category: 'storage', kind: 'artifact' },
  { rule: 'react-native-async-storage_async-storage', category: 'storage', kind: 'artifact' },
  { rule: 'react-native-mmkv', category: 'storage', kind: 'artifact' },
  { rule: 'mmkv', category: 'storage', kind: 'artifact' },
  { rule: 'mmkv-static', category: 'storage', kind: 'artifact' },
  { rule: 'mmkv-shared', category: 'storage', kind: 'artifact' },
  { rule: 'MMKVCore', category: 'storage', kind: 'artifact' },
  { rule: 'MMKVAppExtension', category: 'storage', kind: 'artifact' },
  { rule: 'op-sqlite', category: 'sqlite', kind: 'artifact' },
  { rule: 'op-engineering_op-sqlite', category: 'sqlite', kind: 'artifact' },
  { rule: 'OPSQLite', category: 'sqlite', kind: 'artifact' },
  { rule: 'react-native-quick-sqlite', category: 'sqlite', kind: 'artifact' },
  { rule: 'react-native-cookies', category: 'cookies', kind: 'artifact' },
  { rule: 'react-native-cookies_cookies', category: 'cookies', kind: 'artifact' },
  { rule: 'RNCCookies', category: 'cookies', kind: 'artifact' },
  { rule: 'react-native-webview', category: 'webview', kind: 'artifact' },
  { rule: 'RNCWebView', category: 'webview', kind: 'artifact' },
]);

export const STRICT_GRADLE_RULES = freezeRules([
  // Exact group:artifact coordinate rules
  { rule: 'io.realm:realm-android-library', category: 'storage', kind: 'coordinate' },
  { rule: 'io.realm.kotlin:library-base', category: 'storage', kind: 'coordinate' },
  { rule: 'io.realm.kotlin:library-sync', category: 'storage', kind: 'coordinate' },
  { rule: 'com.nozbe:watermelondb', category: 'storage', kind: 'coordinate' },
  // Exact artifact name rules
  { rule: 'react-native-sqlite-storage', category: 'sqlite', kind: 'artifact' },
  { rule: 'SQLiteStorage', category: 'sqlite', kind: 'artifact' },
  { rule: 'RealmJS', category: 'storage', kind: 'artifact' },
  { rule: 'realm', category: 'storage', kind: 'artifact' },
  { rule: 'realm-android-library', category: 'storage', kind: 'artifact' },
  { rule: 'WatermelonDB', category: 'storage', kind: 'artifact' },
  { rule: 'watermelondb', category: 'storage', kind: 'artifact' },
  { rule: 'nozbe_watermelondb', category: 'storage', kind: 'artifact' },
  { rule: 'RNFS', category: 'filesystem', kind: 'artifact' },
  { rule: 'react-native-fs', category: 'filesystem', kind: 'artifact' },
  { rule: 'react-native-blob-util', category: 'filesystem', kind: 'artifact' },
  { rule: 'rn-fetch-blob', category: 'filesystem', kind: 'artifact' },
]);

export class LockfileParseError extends Error {
  constructor(message, file = '') {
    super(message);
    this.name = 'LockfileParseError';
    this.file = file;
  }
}

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
  }
}

const VALID_PODFILE_HEADERS = new Set([
  'PODS',
  'DEPENDENCIES',
  'COCOAPODS',
  'SPEC CHECKSUMS',
  'PODFILE CHECKSUM',
]);

function stripBom(content) {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function stripInlineComment(text) {
  let inSingle = false;
  let inDouble = false;
  let atScalarStart = true;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i++;
          continue;
        }
        inSingle = false;
        atScalarStart = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < text.length) {
        i++;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        atScalarStart = false;
      }
      continue;
    }
    if (atScalarStart && ch === "'") {
      inSingle = true;
      atScalarStart = false;
      continue;
    }
    if (atScalarStart && ch === '"') {
      inDouble = true;
      atScalarStart = false;
      continue;
    }
    if (ch === '#') {
      if (i === 0 || /\s/.test(text[i - 1])) {
        return text.slice(0, i).trimEnd();
      }
      atScalarStart = false;
      continue;
    }
    if (ch === '[' || ch === ',' || ch === ':') {
      atScalarStart = true;
    } else if (ch !== ' ' && ch !== '\t') {
      atScalarStart = false;
    }
  }
  return text.trimEnd();
}

function findInlineMappingColon(text) {
  if (text.length === 0) {
    return -1;
  }
  const first = text[0];
  if (first === "'" || first === '"') {
    let i = 1;
    let closed = false;
    if (first === "'") {
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        i++;
      }
    } else {
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          closed = true;
          i++;
          break;
        }
        i++;
      }
    }
    if (!closed) {
      return -1;
    }
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
      i++;
    }
    if (i < text.length && text[i] === ':' && i + 1 < text.length) {
      return i;
    }
    return -1;
  }

  // Plain scalar key: never toggle quote state mid-scalar.
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ':') {
      const next = text[i + 1];
      if (next !== undefined && /\s/.test(next)) {
        return i;
      }
    }
  }
  return -1;
}

function decodeYamlDoubleQuoted(inner, lineNumber, file) {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    if (i + 1 >= inner.length) {
      throw new LockfileParseError(
        `Invalid trailing escape in double-quoted YAML scalar at line ${lineNumber} (${file})`,
        file,
      );
    }
    const esc = inner[++i];
    switch (esc) {
      case '\\':
        out += '\\';
        break;
      case '"':
        out += '"';
        break;
      case '/':
        out += '/';
        break;
      case 't':
        out += '\t';
        break;
      case ' ':
        out += ' ';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case '0':
        out += '\0';
        break;
      case 'a':
        out += '\x07';
        break;
      case 'b':
        out += '\b';
        break;
      case 'v':
        out += '\v';
        break;
      case 'f':
        out += '\f';
        break;
      case 'e':
        out += '\x1b';
        break;
      case 'x': {
        const hex = inner.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
          throw new LockfileParseError(
            `Invalid \\x escape in double-quoted YAML scalar at line ${lineNumber} (${file})`,
            file,
          );
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        break;
      }
      case 'u': {
        const hex = inner.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new LockfileParseError(
            `Invalid \\u escape in double-quoted YAML scalar at line ${lineNumber} (${file})`,
            file,
          );
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      case 'U': {
        const hex = inner.slice(i + 1, i + 9);
        if (!/^[0-9a-fA-F]{8}$/.test(hex)) {
          throw new LockfileParseError(
            `Invalid \\U escape in double-quoted YAML scalar at line ${lineNumber} (${file})`,
            file,
          );
        }
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) {
          throw new LockfileParseError(
            `Out-of-range \\U code point in double-quoted YAML scalar at line ${lineNumber} (${file})`,
            file,
          );
        }
        out += String.fromCodePoint(cp);
        i += 8;
        break;
      }
      default:
        throw new LockfileParseError(
          `Unsupported escape "\\${esc}" in double-quoted YAML scalar at line ${lineNumber} (${file})`,
          file,
        );
    }
  }
  return out;
}

function stripMatchingOuterQuotes(text, lineNumber = 0, file = '') {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  const first = trimmed[0];
  if (first === '"') {
    let closeIdx = -1;
    for (let i = 1; i < trimmed.length; i++) {
      if (trimmed[i] === '\\') {
        if (i + 1 >= trimmed.length) {
          throw new LockfileParseError(
            `Unterminated double-quoted YAML scalar at line ${lineNumber} (${file})`,
            file,
          );
        }
        i++;
        continue;
      }
      if (trimmed[i] === '"') {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx === -1) {
      throw new LockfileParseError(
        `Unterminated double-quoted YAML scalar at line ${lineNumber} (${file})`,
        file,
      );
    }
    const afterClose = trimmed.slice(closeIdx + 1);
    if (afterClose.length > 0 && !/^[ \t]+\([^()]*\)$/.test(afterClose)) {
      throw new LockfileParseError(
        `Unexpected trailing content after double-quoted YAML scalar at line ${lineNumber} (${file})`,
        file,
      );
    }
    return (
      decodeYamlDoubleQuoted(trimmed.slice(1, closeIdx), lineNumber, file) +
      afterClose
    );
  }
  if (first === "'") {
    let closeIdx = -1;
    for (let i = 1; i < trimmed.length; i++) {
      if (trimmed[i] === "'") {
        if (trimmed[i + 1] === "'") {
          i++;
          continue;
        }
        closeIdx = i;
        break;
      }
    }
    if (closeIdx === -1) {
      throw new LockfileParseError(
        `Unterminated single-quoted YAML scalar at line ${lineNumber} (${file})`,
        file,
      );
    }
    const afterClose = trimmed.slice(closeIdx + 1);
    if (afterClose.length > 0 && !/^[ \t]+\([^()]*\)$/.test(afterClose)) {
      throw new LockfileParseError(
        `Unexpected trailing content after single-quoted YAML scalar at line ${lineNumber} (${file})`,
        file,
      );
    }
    return trimmed.slice(1, closeIdx).replace(/''/g, "'") + afterClose;
  }
  return trimmed;
}

function extractPodfileCandidates(token) {
  const candidates = [token];
  if (token.startsWith('@')) {
    const parts = token.split('/');
    if (parts.length > 2) {
      candidates.push(parts.slice(0, 2).join('/'));
    }
  } else if (token.includes('/')) {
    candidates.push(token.split('/')[0]);
  }
  return candidates;
}

export function detectLockfileFormat(filePath, content = '') {
  const base = path.basename(String(filePath || '')).toLowerCase();

  if (/^podfile(?:[._-].*)?\.lock$/i.test(base)) {
    return 'podfile.lock';
  }
  if (/(?:^gradle.*\.lockfile$|\.lockfile$)/i.test(base)) {
    return 'gradle.lockfile';
  }

  const normalized = stripBom(String(content || ''));
  if (
    /^(?:["']?(?:PODS|DEPENDENCIES|SPEC CHECKSUMS|PODFILE CHECKSUM|COCOAPODS)["']?)[ \t]*:/m.test(
      normalized,
    )
  ) {
    return 'podfile.lock';
  }
  if (
    /^[ \t]*#[ \t]*This is a Gradle generated file for dependency locking/im.test(
      normalized,
    ) ||
    /^[ \t]*empty=/m.test(normalized) ||
    /^[ \t]*[^:\s=#]+:[^:\s=]+:[^:\s=]+=/m.test(normalized)
  ) {
    return 'gradle.lockfile';
  }

  throw new LockfileParseError(
    `Unable to detect lockfile format for: ${filePath || '<memory>'}`,
    filePath || '',
  );
}

export function checkPodfileLockContent(content, options = {}) {
  const file = options.file ?? 'Podfile.lock';
  const strict = Boolean(options.strict);

  const activeRules = strict
    ? [...MANDATORY_PODFILE_RULES, ...STRICT_PODFILE_RULES]
    : [...MANDATORY_PODFILE_RULES];
  const exactRuleMap = new Map();
  const lowerRuleMap = new Map();
  for (const r of activeRules) {
    if (!exactRuleMap.has(r.rule)) {
      exactRuleMap.set(r.rule, r);
    }
    const lower = r.rule.toLowerCase();
    if (!lowerRuleMap.has(lower)) {
      lowerRuleMap.set(lower, r);
    }
  }

  const normalized = stripBom(String(content ?? ''));
  const lines = normalized.split(/\r\n|\n|\r/);

  let currentSection = null;
  let sectionClosedByFlow = false;
  let sawValidHeader = false;
  const podReportedKeys = new Set();
  const podReportedRules = new Set();
  const podReportedTokens = new Set();
  const podViolations = [];
  const depViolations = [];

  const parseYamlFlowSequence = (flowText, lineNumber) => {
    const inner = flowText.slice(1, -1).trim();
    if (inner.length === 0) {
      return [];
    }

    const items = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let closedQuote = false;

    for (let idx = 0; idx < inner.length; idx++) {
      const ch = inner[idx];
      if (inSingle) {
        if (ch === "'") {
          if (inner[idx + 1] === "'") {
            current += "''";
            idx++;
            continue;
          }
          inSingle = false;
          closedQuote = true;
        }
        current += ch;
        continue;
      }
      if (inDouble) {
        if (ch === '\\' && idx + 1 < inner.length) {
          current += ch + inner[idx + 1];
          idx++;
          continue;
        }
        if (ch === '"') {
          inDouble = false;
          closedQuote = true;
        }
        current += ch;
        continue;
      }

      if (ch === '[' || ch === ']' || ch === '{' || ch === '}') {
        throw new LockfileParseError(
          `Unsupported nested YAML flow syntax in ${currentSection} at line ${lineNumber} (${file})`,
          file,
        );
      }
      if (ch === ',') {
        const trimmedItem = current.trim();
        if (trimmedItem.length === 0) {
          throw new LockfileParseError(
            `Malformed YAML flow sequence in ${currentSection} at line ${lineNumber} (${file})`,
            file,
          );
        }
        items.push(trimmedItem);
        current = '';
        closedQuote = false;
        continue;
      }
      if (closedQuote) {
        if (ch === ' ' || ch === '\t') {
          current += ch;
          continue;
        }
        if (ch === ':') {
          closedQuote = false;
          current += ch;
          continue;
        }
        throw new LockfileParseError(
          `Malformed YAML flow sequence in ${currentSection} at line ${lineNumber} (${file})`,
          file,
        );
      }
      if (current.trim().length === 0 && ch === "'") {
        inSingle = true;
        current += ch;
        continue;
      }
      if (current.trim().length === 0 && ch === '"') {
        inDouble = true;
        current += ch;
        continue;
      }
      current += ch;
    }

    if (inSingle || inDouble) {
      throw new LockfileParseError(
        `Unterminated quote in ${currentSection} flow sequence at line ${lineNumber} (${file})`,
        file,
      );
    }

    const lastItem = current.trim();
    if (lastItem.length === 0) {
      throw new LockfileParseError(
        `Malformed YAML flow sequence in ${currentSection} at line ${lineNumber} (${file})`,
        file,
      );
    }
    items.push(lastItem);
    return items;
  };

  const assertSupportedYamlEntry = (cleaned, lineNumber, section) => {
    if (cleaned.length === 0) {
      throw new LockfileParseError(
        `Empty ${section} entry at line ${lineNumber} (${file})`,
        file,
      );
    }
    const first = cleaned[0];
    if (
      cleaned === '-' ||
      /^-\s/.test(cleaned) ||
      cleaned === '?' ||
      /^\?\s/.test(cleaned) ||
      cleaned === ':' ||
      /^:\s/.test(cleaned) ||
      first === '&' ||
      first === '*' ||
      first === '!' ||
      first === '{' ||
      first === '[' ||
      first === '|' ||
      first === '>'
    ) {
      throw new LockfileParseError(
        `Unsupported YAML construct in ${section} at line ${lineNumber} (${file})`,
        file,
      );
    }
  };

  const evaluateSinglePodfileEntry = (rawEntry, lineNumber, section) => {
    let cleaned = stripInlineComment(rawEntry).trim();
    assertSupportedYamlEntry(cleaned, lineNumber, section);

    if (cleaned.endsWith(':')) {
      cleaned = cleaned.slice(0, -1).trim();
    }

    const entry = stripMatchingOuterQuotes(cleaned, lineNumber, file).trim();

    let token = entry;
    const parenIdx = token.indexOf('(');
    if (parenIdx !== -1) {
      token = token.slice(0, parenIdx).trim();
    }

    if (token.length === 0) {
      return;
    }

    const candidates = extractPodfileCandidates(token);
    let matchedRule = null;
    for (const candidate of candidates) {
      const found =
        exactRuleMap.get(candidate) ?? lowerRuleMap.get(candidate.toLowerCase());
      if (found) {
        matchedRule = found;
        break;
      }
    }

    if (!matchedRule) {
      return;
    }

    const tokenLower = token.toLowerCase();
    const ruleLower = matchedRule.rule.toLowerCase();
    const dedupeKey = `${tokenLower}\0${ruleLower}`;

    const violation = {
      file,
      format: 'podfile.lock',
      line: lineNumber,
      entry,
      matchedRule: matchedRule.rule,
      category: matchedRule.category,
    };

    if (section === 'PODS') {
      if (!podReportedKeys.has(dedupeKey)) {
        podReportedKeys.add(dedupeKey);
        podReportedRules.add(ruleLower);
        podReportedTokens.add(tokenLower);
        podViolations.push(violation);
      }
    } else {
      depViolations.push({
        violation,
        ruleKey: ruleLower,
        tokenKey: tokenLower,
        dedupeKey,
      });
    }
  };

  const evaluatePodfileListItem = (rawItemBody, lineNumber, section) => {
    const cleaned = stripInlineComment(rawItemBody).trim();
    assertSupportedYamlEntry(cleaned, lineNumber, section);

    const colonIdx = findInlineMappingColon(cleaned);
    if (colonIdx !== -1) {
      const keyPart = cleaned.slice(0, colonIdx).trim();
      const valPart = cleaned.slice(colonIdx + 1).trim();
      if (keyPart.length === 0) {
        throw new LockfileParseError(
          `Malformed ${section} mapping entry at line ${lineNumber} (${file})`,
          file,
        );
      }
      evaluateSinglePodfileEntry(keyPart, lineNumber, section);

      if (valPart.length > 0) {
        if (valPart.startsWith('[') && valPart.endsWith(']')) {
          const nestedItems = parseYamlFlowSequence(valPart, lineNumber);
          for (const nestedItem of nestedItems) {
            if (findInlineMappingColon(nestedItem) !== -1) {
              throw new LockfileParseError(
                `Unsupported nested YAML mapping in ${section} flow sequence at line ${lineNumber} (${file})`,
                file,
              );
            }
            evaluateSinglePodfileEntry(nestedItem, lineNumber, section);
          }
        } else {
          throw new LockfileParseError(
            `Unsupported inline YAML mapping value in ${section} at line ${lineNumber} (${file})`,
            file,
          );
        }
      }
      return;
    }

    evaluateSinglePodfileEntry(cleaned, lineNumber, section);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      continue;
    }

    if (/^\s*(?:<{7}|={7}|>{7}|\|{7})(?:\s|$)/.test(line)) {
      throw new LockfileParseError(
        `Git merge conflict marker in Podfile.lock at line ${lineNumber} (${file})`,
        file,
      );
    }

    if (!/^\s/.test(line)) {
      const headerMatch =
        /^(?:([A-Z][A-Z0-9_-]*(?: +[A-Z0-9_-]+)*)|"([A-Z][A-Z0-9 _-]*)"|'([A-Z][A-Z0-9 _-]*)')[ \t]*:(?:[ \t]*(.*))?$/.exec(
          line,
        );
      if (headerMatch) {
        currentSection = (
          headerMatch[1] ??
          headerMatch[2] ??
          headerMatch[3]
        ).trim();
        sectionClosedByFlow = false;
        if (VALID_PODFILE_HEADERS.has(currentSection)) {
          sawValidHeader = true;
        }
        if (currentSection === 'PODS' || currentSection === 'DEPENDENCIES') {
          const trailing = stripInlineComment(headerMatch[4] ?? '').trim();
          if (trailing.length > 0) {
            if (trailing.startsWith('[') && trailing.endsWith(']')) {
              sectionClosedByFlow = true;
              const items = parseYamlFlowSequence(trailing, lineNumber);
              for (const rawItem of items) {
                if (findInlineMappingColon(rawItem) !== -1) {
                  throw new LockfileParseError(
                    `Unsupported inline YAML mapping in ${currentSection} flow sequence at line ${lineNumber} (${file})`,
                    file,
                  );
                }
                evaluateSinglePodfileEntry(rawItem, lineNumber, currentSection);
              }
            } else {
              throw new LockfileParseError(
                `Malformed ${currentSection} header value at line ${lineNumber} (${file})`,
                file,
              );
            }
          }
        }
        continue;
      }

      if (
        !(
          (currentSection === 'PODS' || currentSection === 'DEPENDENCIES') &&
          /^-\s+/.test(line)
        )
      ) {
        throw new LockfileParseError(
          `Invalid Podfile.lock: unrecognized top-level line at line ${lineNumber} (${file})`,
          file,
        );
      }
    }

    if (currentSection === null) {
      throw new LockfileParseError(
        `Invalid Podfile.lock: unexpected content before section header at line ${lineNumber} (${file})`,
        file,
      );
    }

    if (currentSection !== 'PODS' && currentSection !== 'DEPENDENCIES') {
      continue;
    }

    if (sectionClosedByFlow) {
      throw new LockfileParseError(
        `Invalid mixed flow and block entries in ${currentSection} at line ${lineNumber} (${file})`,
        file,
      );
    }

    const listMatch = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (!listMatch) {
      throw new LockfileParseError(
        `Malformed ${currentSection} entry at line ${lineNumber} (${file})`,
        file,
      );
    }

    evaluatePodfileListItem(listMatch[1], lineNumber, currentSection);
  }

  if (!sawValidHeader) {
    throw new LockfileParseError(
      `Invalid Podfile.lock: missing PODS/COCOAPODS header (${file})`,
      file,
    );
  }

  const violations = [...podViolations];
  const depSeen = new Set();
  for (const item of depViolations) {
    if (
      podReportedRules.has(item.ruleKey) ||
      podReportedTokens.has(item.tokenKey) ||
      depSeen.has(item.dedupeKey)
    ) {
      continue;
    }
    depSeen.add(item.dedupeKey);
    violations.push(item.violation);
  }

  return {
    ok: violations.length === 0,
    strict,
    file,
    format: 'podfile.lock',
    violations,
  };
}

export function checkGradleLockfileContent(content, options = {}) {
  const file = options.file ?? 'gradle.lockfile';
  const strict = Boolean(options.strict);

  const activeRules = strict
    ? [...MANDATORY_GRADLE_RULES, ...STRICT_GRADLE_RULES]
    : [...MANDATORY_GRADLE_RULES];

  const exactCoordMap = new Map();
  const coordMap = new Map();
  const exactArtifactMap = new Map();
  const artifactMap = new Map();
  for (const r of activeRules) {
    const lower = r.rule.toLowerCase();
    if (r.kind === 'coordinate') {
      if (!exactCoordMap.has(r.rule)) exactCoordMap.set(r.rule, r);
      if (!coordMap.has(lower)) coordMap.set(lower, r);
    } else {
      if (!exactArtifactMap.has(r.rule)) exactArtifactMap.set(r.rule, r);
      if (!artifactMap.has(lower)) artifactMap.set(lower, r);
    }
  }

  const normalized = stripBom(String(content ?? ''));
  const lines = normalized.split(/\r\n|\n|\r/);

  let sawValidLine = false;
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const lineNumber = i + 1;

    if (trimmed === '') {
      continue;
    }
    if (/^(?:<{7}|={7}|>{7}|\|{7})(?:\s|$)/.test(trimmed)) {
      throw new LockfileParseError(
        `Git merge conflict marker in gradle.lockfile at line ${lineNumber} (${file})`,
        file,
      );
    }
    if (trimmed.startsWith('#')) {
      if (/^#\s*This is a Gradle generated file for dependency locking/i.test(trimmed)) {
        sawValidLine = true;
      }
      continue;
    }
    if (/^empty=/.test(trimmed)) {
      sawValidLine = true;
      continue;
    }

    const match = /^([^:\s=]+):([^:\s=]+):([^:\s=]+)=(.*)$/.exec(trimmed);
    if (!match) {
      throw new LockfileParseError(
        `Malformed gradle.lockfile entry at line ${lineNumber} (${file})`,
        file,
      );
    }

    sawValidLine = true;
    const group = match[1];
    const artifact = match[2];
    const coord = `${group}:${artifact}`;
    const coordLower = coord.toLowerCase();
    const artifactLower = artifact.toLowerCase();

    // Coordinate rules take priority over generic artifact rules; exact case preferred over fallback
    const matchedRule =
      exactCoordMap.get(coord) ??
      coordMap.get(coordLower) ??
      exactArtifactMap.get(artifact) ??
      artifactMap.get(artifactLower) ??
      null;

    if (matchedRule) {
      violations.push({
        file,
        format: 'gradle.lockfile',
        line: lineNumber,
        entry: trimmed,
        matchedRule: matchedRule.rule,
        category: matchedRule.category,
      });
    }
  }

  if (!sawValidLine) {
    throw new LockfileParseError(
      `Empty or invalid gradle.lockfile (${file})`,
      file,
    );
  }

  return {
    ok: violations.length === 0,
    strict,
    file,
    format: 'gradle.lockfile',
    violations,
  };
}

export function checkLockfiles(targets, options = {}) {
  const strict = Boolean(options.strict);
  const filesChecked = [];
  const violations = [];

  if (!Array.isArray(targets) || targets.length === 0) {
    throw new CliUsageError('At least one lockfile target must be provided.');
  }

  for (const rawTarget of targets) {
    let target;
    if (typeof rawTarget === 'string') {
      if (rawTarget.trim().length === 0) {
        throw new CliUsageError(
          'Lockfile target path must be a non-empty string.',
        );
      }
      target = { path: rawTarget, format: 'auto' };
    } else if (
      rawTarget !== null &&
      typeof rawTarget === 'object' &&
      typeof rawTarget.path === 'string' &&
      rawTarget.path.trim().length > 0
    ) {
      target = { path: rawTarget.path, format: rawTarget.format ?? 'auto' };
    } else {
      throw new CliUsageError(
        'Each lockfile target must be a non-empty path string or an object with a non-empty string "path" property.',
      );
    }

    const filePath = target.path;
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      throw new LockfileParseError(`Lockfile not found: ${filePath}`, filePath);
    }

    if (stat.isDirectory()) {
      throw new LockfileParseError(
        `Lockfile path is a directory, not a file: ${filePath}`,
        filePath,
      );
    }

    let content;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new LockfileParseError(
        `Unable to read lockfile "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
        filePath,
      );
    }

    const format =
      target.format === 'auto'
        ? detectLockfileFormat(filePath, content)
        : target.format;

    let result;
    if (format === 'podfile.lock') {
      result = checkPodfileLockContent(content, { file: filePath, strict });
    } else if (format === 'gradle.lockfile') {
      result = checkGradleLockfileContent(content, { file: filePath, strict });
    } else {
      throw new LockfileParseError(
        `Unsupported lockfile format "${format}" for ${filePath}`,
        filePath,
      );
    }

    filesChecked.push(filePath);
    violations.push(...result.violations);
  }

  return {
    ok: violations.length === 0,
    strict,
    filesChecked,
    violations,
  };
}

const HELP_TEXT = `Usage:
  check-kiosk-lockfile.mjs [options]

Options:
  --podfile-lock <path>      Check a CocoaPods Podfile.lock (repeatable)
  --gradle-lockfile <path>   Check a Gradle gradle.lockfile (repeatable)
  --lockfile <path>          Check a lockfile with auto-detected format (repeatable)
  --strict                   Enable extended kiosk denylist (SQLite/Realm/WatermelonDB/FS)
  --json                     Output machine-readable JSON
  -h, --help                 Show this help message and exit 0

Exit Codes:
  0  All checked lockfiles are clean (or --help displayed)
  1  One or more forbidden pods/dependencies detected
  2  CLI usage error, missing/unreadable file, or unparseable lockfile format
`;

function consumeOptionValue(argv, index, flagName, inlineValue) {
  if (inlineValue !== undefined) {
    if (inlineValue.length === 0) {
      throw new CliUsageError(`Option ${flagName} requires a non-empty file path.`);
    }
    return { value: inlineValue, nextIndex: index };
  }
  const next = argv[index + 1];
  if (next === undefined || next.length === 0 || next.startsWith('-')) {
    throw new CliUsageError(`Option ${flagName} requires a file path argument.`);
  }
  return { value: next, nextIndex: index + 1 };
}

export function parseCliArgs(argv) {
  const targets = [];
  let strict = false;
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }

    const eqIdx = arg.indexOf('=');
    const flag = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
    const inlineValue = eqIdx !== -1 ? arg.slice(eqIdx + 1) : undefined;

    if (flag === '--podfile-lock') {
      const { value, nextIndex } = consumeOptionValue(argv, i, flag, inlineValue);
      targets.push({ path: value, format: 'podfile.lock' });
      i = nextIndex;
      continue;
    }
    if (flag === '--gradle-lockfile') {
      const { value, nextIndex } = consumeOptionValue(argv, i, flag, inlineValue);
      targets.push({ path: value, format: 'gradle.lockfile' });
      i = nextIndex;
      continue;
    }
    if (flag === '--lockfile') {
      const { value, nextIndex } = consumeOptionValue(argv, i, flag, inlineValue);
      targets.push({ path: value, format: 'auto' });
      i = nextIndex;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }

    throw new CliUsageError(
      `Unexpected positional argument: ${arg}. Use --podfile-lock, --gradle-lockfile, or --lockfile.`,
    );
  }

  if (!help && targets.length === 0) {
    throw new CliUsageError(
      'No lockfile specified. Pass --podfile-lock <path>, --gradle-lockfile <path>, or --lockfile <path>.',
    );
  }

  return { targets, strict, json, help };
}

export function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((msg) => process.stdout.write(msg));
  const stderr = io.stderr ?? ((msg) => process.stderr.write(msg));

  const wantsJson = Array.isArray(argv) && argv.includes('--json');
  const wantsStrict = Array.isArray(argv) && argv.includes('--strict');

  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (wantsJson) {
      stdout(
        `${JSON.stringify(
          {
            ok: false,
            strict: wantsStrict,
            filesChecked: [],
            violations: [],
            error: message,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      stderr(`[kiosk-lockfile] Error: ${message}\n`);
    }
    return 2;
  }

  if (parsed.help) {
    stdout(HELP_TEXT);
    return 0;
  }

  let report;
  try {
    report = checkLockfiles(parsed.targets, { strict: parsed.strict });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (parsed.json) {
      stdout(
        `${JSON.stringify(
          {
            ok: false,
            strict: parsed.strict,
            filesChecked: [],
            violations: [],
            error: message,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      stderr(`[kiosk-lockfile] Error: ${message}\n`);
    }
    return 2;
  }

  if (parsed.json) {
    stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.ok) {
    stdout(
      `[kiosk-lockfile] OK: Checked ${report.filesChecked.length} lockfile(s); 0 forbidden dependencies found.\n`,
    );
  } else {
    const lines = [
      `[kiosk-lockfile] FAILED: Found ${report.violations.length} forbidden dependenc${report.violations.length === 1 ? 'y' : 'ies'} across ${report.filesChecked.length} lockfile(s):`,
    ];
    for (const v of report.violations) {
      lines.push(
        `  - ${v.file}:${v.line} [${v.format}] (${v.category}) matched "${v.matchedRule}" -> ${v.entry}`,
      );
    }
    stdout(`${lines.join('\n')}\n`);
  }

  return report.ok ? 0 : 1;
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(path.resolve(process.argv[1]))
    );
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  process.exitCode = runCli(process.argv.slice(2));
}
