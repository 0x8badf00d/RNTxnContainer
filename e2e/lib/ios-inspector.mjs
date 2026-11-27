import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, resolveRepoPath, runCommand } from './assertions.mjs';

const CODE_UNIT_COMPARE = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'default',
  'in',
  'of',
  'instanceof',
  'typeof',
  'void',
  'delete',
  'yield',
  'await',
  'new',
  'else',
  'do',
]);

const REGEX_PRECEDING_PUNCT = new Set([
  '=', '(', '[', ',', ':', ';', '!', '&', '|', '?', '{', '}',
  '~', '^', '+', '-', '*', '/', '%', '<', '>',
]);

const CONTROL_FLOW_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

function isIdentChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 36
  );
}

function isIdentStart(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36
  );
}

function isHexDigit(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

function isDigit(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isCppDigitSeparator(source, quoteIndex) {
  if (quoteIndex <= 0 || quoteIndex + 1 >= source.length) {
    return false;
  }
  if (!isHexDigit(source[quoteIndex - 1]) || !isHexDigit(source[quoteIndex + 1])) {
    return false;
  }
  let k = quoteIndex - 1;
  while (k > 0) {
    const prev = source[k - 1];
    if (
      isHexDigit(prev) ||
      prev === "'" ||
      prev === 'x' ||
      prev === 'X' ||
      prev === 'b' ||
      prev === 'B'
    ) {
      k -= 1;
    } else {
      break;
    }
  }
  if (!isDigit(source[k])) {
    return false;
  }
  if (k > 0 && isIdentChar(source[k - 1])) {
    return false;
  }
  return true;
}

/**
 * Matches a C++11 raw string prefix (`R"`, `u8R"`, `uR"`, `UR"`, `LR"`) at `i`
 * when not preceded by an identifier character. Returns the index immediately
 * after `"`, or `-1` if no raw string starts at `i`.
 */
function matchCppRawStringStart(source, i) {
  if (i > 0 && isIdentChar(source[i - 1])) {
    return -1;
  }
  const ch = source[i];
  if (ch === 'R' && source[i + 1] === '"') {
    return i + 2;
  }
  if ((ch === 'u' || ch === 'U' || ch === 'L') && source[i + 1] === 'R' && source[i + 2] === '"') {
    return i + 3;
  }
  if (ch === 'u' && source[i + 1] === '8' && source[i + 2] === 'R' && source[i + 3] === '"') {
    return i + 4;
  }
  return -1;
}

/**
 * Attempts to scan a JavaScript regular expression literal `/pattern/flags`
 * starting at `startIndex` (where `source[startIndex] === '/'`).
 * Returns the index immediately after the regex literal (including flags), or
 * `-1` if no valid single-line regex literal terminates before newline/EOF.
 */
function scanJsRegexLiteral(source, startIndex) {
  const len = source.length;
  const next = source[startIndex + 1];
  if (!next || next === '/' || next === '*' || next === '\n' || next === '\r') {
    return -1;
  }

  let i = startIndex + 1;
  let inCharClass = false;
  while (i < len) {
    const ch = source[i];
    if (ch === '\n' || ch === '\r') {
      return -1;
    }
    if (ch === '\\') {
      if (i + 1 >= len || source[i + 1] === '\n' || source[i + 1] === '\r') {
        return -1;
      }
      i += 2;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      i += 1;
      continue;
    }
    if (ch === ']' && inCharClass) {
      inCharClass = false;
      i += 1;
      continue;
    }
    if (ch === '/' && !inCharClass) {
      i += 1;
      while (i < len && /[A-Za-z]/.test(source[i])) {
        i += 1;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Reads a repository-relative file strictly inside `REPO_ROOT`.
 * Throws loudly if missing, non-file, or escaping `REPO_ROOT`.
 */
export function readRepoFile(relPath, opts = {}) {
  const rootDir = path.resolve(opts.rootDir ?? REPO_ROOT);
  const absPath = resolveRepoPath(relPath, { rootDir, allowRoot: false });

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(`Required repository file not found: ${relPath} (resolved: ${absPath})`);
    }
    throw err;
  }

  if (!stat.isFile()) {
    throw new Error(`Expected regular file at "${relPath}", found non-file`);
  }

  return fs.readFileSync(absPath, 'utf8');
}

/**
 * Recursively lists regular files under `relDir` (normalized to POSIX `/`
 * relative paths from `rootDir`, sorted deterministically by code unit).
 * Throws loudly if `relDir` is missing or not a directory.
 */
export function listFilesRecursive(relDir, extensions = [], opts = {}) {
  if (!Array.isArray(extensions) || extensions.some((e) => typeof e !== 'string')) {
    throw new TypeError('extensions must be an array of strings');
  }

  const rootDir = path.resolve(opts.rootDir ?? REPO_ROOT);
  const absDir = resolveRepoPath(relDir, { rootDir, allowRoot: true });

  if (!fs.existsSync(absDir)) {
    throw new Error(`Required repository directory not found: ${relDir} (resolved: ${absDir})`);
  }
  if (!fs.statSync(absDir).isDirectory()) {
    throw new Error(`Expected directory at "${relDir}", found non-directory`);
  }

  const extSet = new Set(
    extensions
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => ext.length > 0)
      .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`)),
  );
  const ignoreDirs = new Set(opts.ignoreDirs ?? []);

  const realRoot = fs.realpathSync(rootDir);
  const visitedDirs = new Set([fs.realpathSync(absDir)]);
  const results = [];

  function walk(currDir) {
    const entries = fs.readdirSync(currDir, { withFileTypes: true });
    entries.sort((a, b) => CODE_UNIT_COMPARE(a.name, b.name));

    for (const entry of entries) {
      const entryAbs = path.join(currDir, entry.name);

      if (entry.isSymbolicLink()) {
        const realTarget = fs.realpathSync(entryAbs);
        const targetRel = path.relative(realRoot, realTarget);
        if (targetRel === '..' || targetRel.startsWith(`..${path.sep}`) || path.isAbsolute(targetRel)) {
          throw new Error(
            `Symlink escape rejected during traversal: "${entryAbs}" resolves outside "${realRoot}"`,
          );
        }
        const targetStat = fs.statSync(realTarget);
        if (targetStat.isDirectory()) {
          if (ignoreDirs.has(entry.name)) continue;
          if (!visitedDirs.has(realTarget)) {
            visitedDirs.add(realTarget);
            walk(entryAbs);
          }
        } else if (targetStat.isFile()) {
          if (extSet.size === 0 || extSet.has(path.extname(entry.name).toLowerCase())) {
            results.push(path.relative(rootDir, entryAbs).split(path.sep).join('/'));
          }
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        const realSubDir = fs.realpathSync(entryAbs);
        if (!visitedDirs.has(realSubDir)) {
          visitedDirs.add(realSubDir);
          walk(entryAbs);
        }
      } else if (entry.isFile()) {
        if (extSet.size === 0 || extSet.has(path.extname(entry.name).toLowerCase())) {
          results.push(path.relative(rootDir, entryAbs).split(path.sep).join('/'));
        }
      }
    }
  }

  walk(absDir);
  results.sort(CODE_UNIT_COMPARE);
  return results;
}

/**
 * Character-by-character C/Swift/ObjC++/JS comment stripper.
 *
 * Preserves every `\n` (and `\r`) so 1-based line numbers remain exact.
 * Strips `//`, `/* ... *\/`, and Swift nested `/* /* ... *\/ *\/` comments
 * (emitting a single `' '` space when a block comment contains no newline so
 * adjacent tokens never paste together).
 *
 * Respects `"..."`, `'...'` (with C++17 numeric digit-separator guard),
 * `"""..."""`, Swift raw strings `#"..."#` / `#"""..."""#`, C++11 raw strings
 * `R"delim(...)delim"`, JS template literals `` `...${...}...` ``, and (when
 * `language` is `'js'` or `'auto'`) JS regex literals `/.../`.
 */
export function stripCStyleComments(source, opts = {}) {
  if (typeof source !== 'string') {
    throw new TypeError('stripCStyleComments expects a string');
  }

  const language = opts.language ?? 'auto';
  if (!['auto', 'js', 'swift', 'objc'].includes(language)) {
    throw new TypeError(`Invalid language option: ${JSON.stringify(language)}`);
  }

  const allowJsRegex = language === 'js' || language === 'auto';
  const allowJsTemplate = language === 'js' || language === 'auto';
  const allowSwiftRawAndTriple = language === 'swift' || language === 'auto';
  const allowSwiftInterp = language === 'swift' || language === 'auto';
  const allowNestedBlockComments = language === 'swift' || language === 'auto';
  const allowCppRaw = language === 'objc' || language === 'auto';
  const allowCppDigitSep = language === 'objc' || language === 'auto';

  const len = source.length;
  const out = [];
  const templateBraceStack = [];
  const swiftInterpStack = [];
  const parenStack = [];

  let i = 0;
  let lastTokenAllowsRegex = true;
  let lastWasControlKeyword = false;
  let prevNonWs = '';

  function scanTemplateLiteral() {
    while (i < len) {
      const ch = source[i];
      if (ch === '\\') {
        out.push(ch);
        i += 1;
        if (i < len) {
          if (source[i] === '\r' && source[i + 1] === '\n') {
            out.push('\r', '\n');
            i += 2;
          } else {
            out.push(source[i]);
            i += 1;
          }
        }
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        out.push('${');
        i += 2;
        templateBraceStack.push(0);
        lastTokenAllowsRegex = true;
        lastWasControlKeyword = false;
        prevNonWs = '${';
        return;
      }
      if (ch === '`') {
        out.push('`');
        i += 1;
        lastTokenAllowsRegex = false;
        lastWasControlKeyword = false;
        prevNonWs = '`';
        return;
      }
      out.push(ch);
      i += 1;
    }
    lastTokenAllowsRegex = false;
    lastWasControlKeyword = false;
  }

  function scanSwiftString(isTriple, hashCount) {
    const closeHashes = hashCount > 0 ? '#'.repeat(hashCount) : '';
    const closeToken = (isTriple ? '"""' : '"') + closeHashes;
    const interpPrefix = `\\${closeHashes}(`;
    const escapePrefix = `\\${closeHashes}`;

    while (i < len) {
      if (allowSwiftInterp && source.startsWith(interpPrefix, i)) {
        out.push(interpPrefix);
        i += interpPrefix.length;
        swiftInterpStack.push({ isTriple, hashCount, parenDepth: 0 });
        lastTokenAllowsRegex = true;
        lastWasControlKeyword = false;
        prevNonWs = '(';
        return;
      }
      if (source.startsWith(escapePrefix, i)) {
        out.push(escapePrefix);
        i += escapePrefix.length;
        if (i < len) {
          if (source[i] === '\r' && source[i + 1] === '\n') {
            out.push('\r', '\n');
            i += 2;
          } else {
            out.push(source[i]);
            i += 1;
          }
        }
        continue;
      }
      if (source.startsWith(closeToken, i)) {
        out.push(closeToken);
        i += closeToken.length;
        lastTokenAllowsRegex = false;
        lastWasControlKeyword = false;
        prevNonWs = '"';
        return;
      }
      out.push(source[i]);
      i += 1;
    }
    lastTokenAllowsRegex = false;
    lastWasControlKeyword = false;
    prevNonWs = '"';
  }

  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    // 1. Swift raw string literal: #"..."#, ##"..."##, #"""..."""#
    if (allowSwiftRawAndTriple && ch === '#') {
      let k = 0;
      while (i + k < len && source[i + k] === '#') {
        k += 1;
      }
      if (source[i + k] === '"') {
        const isTriple = source.startsWith('"""', i + k);
        const quoteLen = isTriple ? 3 : 1;
        const openEnd = i + k + quoteLen;
        out.push(source.slice(i, openEnd));
        i = openEnd;
        scanSwiftString(isTriple, k);
        continue;
      }
    }

    // 2. Swift triple-quoted multiline string literal: """..."""
    if (allowSwiftRawAndTriple && ch === '"' && source.startsWith('"""', i)) {
      out.push('"""');
      i += 3;
      scanSwiftString(true, 0);
      continue;
    }

    // 3. C++11 raw string literal: R"delim(...)delim" (with optional u8/u/U/L prefix)
    if (allowCppRaw) {
      const delimStart = matchCppRawStringStart(source, i);
      if (delimStart !== -1) {
        let d = delimStart;
        let validDelim = true;
        while (d < len && source[d] !== '(') {
          const dc = source[d];
          if (
            d - delimStart >= 16 ||
            dc === ')' ||
            dc === '\\' ||
            dc === ' ' ||
            dc === '\t' ||
            dc === '\r' ||
            dc === '\n' ||
            dc === '\v' ||
            dc === '\f'
          ) {
            validDelim = false;
            break;
          }
          d += 1;
        }
        if (validDelim && d < len && source[d] === '(') {
          const delim = source.slice(delimStart, d);
          const closeSeq = `)${delim}"`;
          const closeIdx = source.indexOf(closeSeq, d + 1);
          if (closeIdx !== -1) {
            const endIdx = closeIdx + closeSeq.length;
            out.push(source.slice(i, endIdx));
            i = endIdx;
          } else {
            out.push(source.slice(i));
            i = len;
          }
          lastTokenAllowsRegex = false;
          lastWasControlKeyword = false;
          prevNonWs = '"';
          continue;
        }
      }
    }

    // 4. Standard double-quoted string literal: "..." (also covers ObjC @"..." and Swift \(...))
    if (ch === '"') {
      out.push('"');
      i += 1;
      scanSwiftString(false, 0);
      continue;
    }

    // 5. Single-quoted string/char literal with C++17 digit-separator guard
    if (ch === "'") {
      if (allowCppDigitSep && isCppDigitSeparator(source, i)) {
        out.push("'");
        i += 1;
        continue;
      }
      out.push("'");
      i += 1;
      while (i < len) {
        const sc = source[i];
        if (sc === '\\') {
          out.push('\\');
          i += 1;
          if (i < len) {
            if (source[i] === '\r' && source[i + 1] === '\n') {
              out.push('\r', '\n');
              i += 2;
            } else {
              out.push(source[i]);
              i += 1;
            }
          }
          continue;
        }
        out.push(sc);
        i += 1;
        if (sc === "'") {
          break;
        }
      }
      lastTokenAllowsRegex = false;
      lastWasControlKeyword = false;
      prevNonWs = "'";
      continue;
    }

    // 6. JS/TS template literal: `...${...}...`
    if (allowJsTemplate && ch === '`') {
      out.push('`');
      i += 1;
      scanTemplateLiteral();
      continue;
    }

    // 7. Single-line comment: // ... (preserve \r and \n)
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && source[i] !== '\n' && source[i] !== '\r') {
        i += 1;
      }
      continue;
    }

    // 8. Block comment (nested /* /* ... */ */ ONLY in swift/auto, never in js/objc)
    if (ch === '/' && next === '*') {
      let depth = 1;
      let sawNewline = false;
      i += 2;
      while (i < len && depth > 0) {
        if (allowNestedBlockComments && source[i] === '/' && source[i + 1] === '*') {
          depth += 1;
          i += 2;
          continue;
        }
        if (source[i] === '*' && source[i + 1] === '/') {
          depth -= 1;
          i += 2;
          continue;
        }
        if (source[i] === '\r') {
          if (source[i + 1] === '\n') {
            out.push('\r', '\n');
            i += 2;
          } else {
            out.push('\r');
            i += 1;
          }
          sawNewline = true;
          continue;
        }
        if (source[i] === '\n') {
          out.push('\n');
          sawNewline = true;
          i += 1;
          continue;
        }
        i += 1;
      }
      if (!sawNewline) {
        out.push(' ');
      }
      continue;
    }

    // 9. JS regex literal (e.g., /http:\/\//, /foo\/*/)
    if (allowJsRegex && ch === '/' && lastTokenAllowsRegex) {
      const regexEnd = scanJsRegexLiteral(source, i);
      if (regexEnd !== -1) {
        out.push(source.slice(i, regexEnd));
        i = regexEnd;
        lastTokenAllowsRegex = false;
        lastWasControlKeyword = false;
        prevNonWs = 'regex';
        continue;
      }
    }

    // 10a. Parenthesis tracking for Swift string interpolation `\( ... )`
    if (swiftInterpStack.length > 0) {
      if (ch === '(') {
        swiftInterpStack[swiftInterpStack.length - 1].parenDepth += 1;
        out.push('(');
        i += 1;
        lastTokenAllowsRegex = true;
        lastWasControlKeyword = false;
        prevNonWs = '(';
        continue;
      }
      if (ch === ')') {
        const top = swiftInterpStack[swiftInterpStack.length - 1];
        if (top.parenDepth === 0) {
          swiftInterpStack.pop();
          out.push(')');
          i += 1;
          scanSwiftString(top.isTriple, top.hashCount);
          continue;
        }
        top.parenDepth -= 1;
        out.push(')');
        i += 1;
        lastTokenAllowsRegex = false;
        lastWasControlKeyword = false;
        prevNonWs = ')';
        continue;
      }
    }

    // 10b. Brace tracking for JS template interpolation `${ ... }`
    if (templateBraceStack.length > 0) {
      if (ch === '{') {
        templateBraceStack[templateBraceStack.length - 1] += 1;
        out.push('{');
        i += 1;
        lastTokenAllowsRegex = true;
        lastWasControlKeyword = false;
        prevNonWs = '{';
        continue;
      }
      if (ch === '}') {
        const top = templateBraceStack[templateBraceStack.length - 1];
        if (top === 0) {
          templateBraceStack.pop();
          out.push('}');
          i += 1;
          scanTemplateLiteral();
          continue;
        }
        templateBraceStack[templateBraceStack.length - 1] = top - 1;
        out.push('}');
        i += 1;
        lastTokenAllowsRegex = true;
        lastWasControlKeyword = false;
        prevNonWs = '}';
        continue;
      }
    }

    // 11. Track lexical tokens for regex-vs-division disambiguation
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < len && isIdentChar(source[end])) {
        end += 1;
      }
      const word = source.slice(i, end);
      out.push(word);
      i = end;
      lastWasControlKeyword = prevNonWs !== '.' && CONTROL_FLOW_PAREN_KEYWORDS.has(word);
      lastTokenAllowsRegex = prevNonWs !== '.' && REGEX_PRECEDING_KEYWORDS.has(word);
      prevNonWs = 'ident';
      continue;
    }

    if (isDigit(ch)) {
      let end = i + 1;
      while (
        end < len &&
        (isHexDigit(source[end]) ||
          source[end] === '.' ||
          source[end] === '_' ||
          source[end] === 'x' ||
          source[end] === 'X' ||
          source[end] === 'b' ||
          source[end] === 'B' ||
          source[end] === 'o' ||
          source[end] === 'O' ||
          source[end] === 'e' ||
          source[end] === 'E' ||
          source[end] === 'n' ||
          (allowCppDigitSep && source[end] === "'" && isCppDigitSeparator(source, end)))
      ) {
        end += 1;
      }
      out.push(source.slice(i, end));
      i = end;
      lastTokenAllowsRegex = false;
      lastWasControlKeyword = false;
      prevNonWs = 'num';
      continue;
    }

    // Multi-char `++` / `--`: preserve `lastTokenAllowsRegex` so postfix `a++ / b` is division
    if ((ch === '+' && next === '+') || (ch === '-' && next === '-')) {
      const op = ch + next;
      out.push(op);
      i += 2;
      lastWasControlKeyword = false;
      prevNonWs = op;
      continue;
    }

    // Track parens for JS control-flow statements (`if (cond) /regex/`)
    if (ch === '(') {
      parenStack.push(lastWasControlKeyword);
      out.push('(');
      i += 1;
      lastTokenAllowsRegex = true;
      lastWasControlKeyword = false;
      prevNonWs = '(';
      continue;
    }
    if (ch === ')') {
      const wasControlParen = parenStack.length > 0 ? parenStack.pop() : false;
      out.push(')');
      i += 1;
      lastTokenAllowsRegex = wasControlParen;
      lastWasControlKeyword = false;
      prevNonWs = ')';
      continue;
    }

    out.push(ch);
    i += 1;

    if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n' && ch !== '\f' && ch !== '\v') {
      lastWasControlKeyword = false;
      prevNonWs = ch;
      if (REGEX_PRECEDING_PUNCT.has(ch)) {
        lastTokenAllowsRegex = true;
      } else if (ch === ']' || ch === '.') {
        lastTokenAllowsRegex = false;
      }
    }
  }

  return out.join('');
}

function decodeXmlEntities(text) {
  return text.replace(
    /&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g,
    (full, entity, dec, hex) => {
      if (entity === 'amp') return '&';
      if (entity === 'lt') return '<';
      if (entity === 'gt') return '>';
      if (entity === 'quot') return '"';
      if (entity === 'apos') return "'";
      if (dec !== undefined) return String.fromCodePoint(Number.parseInt(dec, 10));
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      return full;
    },
  );
}

function tokenizePlistXml(xmlText) {
  if (typeof xmlText !== 'string') {
    throw new TypeError('parsePlistXml expects an XML string');
  }

  const text = xmlText.startsWith('\uFEFF') ? xmlText.slice(1) : xmlText;

  const tokens = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    if (text[i] === '<') {
      // XML comment: <!-- ... --> (handled in-pass so CDATA containing `<!--` stays literal)
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end === -1) {
          throw new Error('Unterminated XML comment in plist');
        }
        i = end + 3;
        continue;
      }

      // Processing instruction: <? ... ?>
      if (text.startsWith('<?', i)) {
        const end = text.indexOf('?>', i + 2);
        if (end === -1) {
          throw new Error('Unterminated XML processing instruction in plist');
        }
        i = end + 2;
        continue;
      }

      // CDATA section: <![CDATA[ ... ]]>
      if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i + 9);
        if (end === -1) {
          throw new Error('Unterminated CDATA section in plist');
        }
        tokens.push({ type: 'text', value: text.slice(i + 9, end) });
        i = end + 3;
        continue;
      }

      // DOCTYPE declaration: <!DOCTYPE ...>
      if (text.startsWith('<!DOCTYPE', i)) {
        let j = i + 9;
        let inQuote = null;
        let bracketDepth = 0;
        while (j < len) {
          const c = text[j];
          if (inQuote) {
            if (c === inQuote) inQuote = null;
          } else if (c === '"' || c === "'") {
            inQuote = c;
          } else if (c === '[') {
            bracketDepth += 1;
          } else if (c === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
          } else if (c === '>' && bracketDepth === 0) {
            break;
          }
          j += 1;
        }
        if (j >= len) {
          throw new Error('Unterminated DOCTYPE declaration in plist');
        }
        i = j + 1;
        continue;
      }

      // Regular open / close / self-closing tag
      let j = i + 1;
      let inQuote = null;
      while (j < len) {
        const c = text[j];
        if (inQuote) {
          if (c === inQuote) inQuote = null;
        } else if (c === '"' || c === "'") {
          inQuote = c;
        } else if (c === '>') {
          break;
        }
        j += 1;
      }
      if (j >= len) {
        throw new Error(`Unterminated XML tag starting at offset ${i}`);
      }

      const rawTag = text.slice(i + 1, j).trim();
      i = j + 1;

      if (rawTag.length === 0) {
        throw new Error('Empty XML tag <> in plist');
      }

      if (rawTag.startsWith('/')) {
        const name = rawTag.slice(1).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) {
          throw new Error(`Malformed closing tag </${rawTag.slice(1)}> in plist`);
        }
        tokens.push({ type: 'close', name });
      } else if (rawTag.endsWith('/')) {
        const inner = rawTag.slice(0, -1).trim();
        const nameMatch = inner.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s[\s\S]*)?$/);
        if (!nameMatch) {
          throw new Error(`Malformed self-closing tag <${rawTag}> in plist`);
        }
        tokens.push({ type: 'selfClose', name: nameMatch[1] });
      } else {
        const nameMatch = rawTag.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s[\s\S]*)?$/);
        if (!nameMatch) {
          throw new Error(`Malformed opening tag <${rawTag}> in plist`);
        }
        tokens.push({ type: 'open', name: nameMatch[1] });
      }
      continue;
    }

    const nextLt = text.indexOf('<', i);
    const end = nextLt === -1 ? len : nextLt;
    const rawText = text.slice(i, end);
    tokens.push({ type: 'text', value: decodeXmlEntities(rawText) });
    i = end;
  }

  return tokens;
}

/**
 * Zero-dependency recursive-descent parser for Apple XML Property Lists.
 */
export function parsePlistXml(xmlText) {
  const tokens = tokenizePlistXml(xmlText);
  let pos = 0;

  function skipWhitespace() {
    while (pos < tokens.length && tokens[pos].type === 'text' && tokens[pos].value.trim() === '') {
      pos += 1;
    }
  }

  function peek() {
    skipWhitespace();
    return tokens[pos] ?? null;
  }

  function readElementText(tagName) {
    let acc = '';
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok.type === 'text') {
        acc += tok.value;
        pos += 1;
        continue;
      }
      if (tok.type === 'close' && tok.name === tagName) {
        pos += 1;
        return acc;
      }
      throw new Error(`Unexpected token <${tok.name ?? tok.type}> inside <${tagName}>`);
    }
    throw new Error(`Unclosed <${tagName}> element in plist`);
  }

  function parseValue() {
    const tok = peek();
    if (!tok) {
      throw new Error('Unexpected end of plist while expecting a value');
    }

    if (tok.type === 'selfClose') {
      pos += 1;
      switch (tok.name) {
        case 'dict':
          return {};
        case 'array':
          return [];
        case 'string':
          return '';
        case 'true':
          return true;
        case 'false':
          return false;
        case 'data':
        case 'date':
          return '';
        default:
          throw new Error(`Unsupported self-closing plist tag <${tok.name}/>`);
      }
    }

    if (tok.type !== 'open') {
      throw new Error(`Expected plist value element, got ${tok.type}${tok.name ? ` </${tok.name}>` : ''}`);
    }

    pos += 1;
    switch (tok.name) {
      case 'dict': {
        const obj = {};
        while (true) {
          const nextTok = peek();
          if (!nextTok) {
            throw new Error('Unclosed <dict> element in plist');
          }
          if (nextTok.type === 'close') {
            if (nextTok.name !== 'dict') {
              throw new Error(`Mismatched closing tag </${nextTok.name}> inside <dict>`);
            }
            pos += 1;
            return obj;
          }
          if (nextTok.type === 'selfClose' && nextTok.name === 'key') {
            pos += 1;
            obj[''] = parseValue();
            continue;
          }
          if (nextTok.type !== 'open' || nextTok.name !== 'key') {
            throw new Error(`Expected <key> inside <dict>, got ${nextTok.type} <${nextTok.name ?? ''}>`);
          }
          pos += 1;
          const key = readElementText('key');
          const valueTok = peek();
          if (!valueTok || valueTok.type === 'close') {
            throw new Error(`Missing value for <key>${key}</key> inside <dict>`);
          }
          obj[key] = parseValue();
        }
      }
      case 'array': {
        const arr = [];
        while (true) {
          const nextTok = peek();
          if (!nextTok) {
            throw new Error('Unclosed <array> element in plist');
          }
          if (nextTok.type === 'close') {
            if (nextTok.name !== 'array') {
              throw new Error(`Mismatched closing tag </${nextTok.name}> inside <array>`);
            }
            pos += 1;
            return arr;
          }
          arr.push(parseValue());
        }
      }
      case 'string':
        return readElementText('string');
      case 'true': {
        const body = readElementText('true');
        if (body.trim() !== '') {
          throw new Error(`Unexpected text inside <true>: ${JSON.stringify(body)}`);
        }
        return true;
      }
      case 'false': {
        const body = readElementText('false');
        if (body.trim() !== '') {
          throw new Error(`Unexpected text inside <false>: ${JSON.stringify(body)}`);
        }
        return false;
      }
      case 'integer': {
        const raw = readElementText('integer').trim();
        if (!/^[+-]?\d+$/.test(raw)) {
          throw new Error(`Invalid <integer> value in plist: ${JSON.stringify(raw)}`);
        }
        const n = Number(raw);
        if (!Number.isInteger(n)) {
          throw new Error(`Non-integer <integer> value in plist: ${JSON.stringify(raw)}`);
        }
        return n;
      }
      case 'real': {
        const raw = readElementText('real').trim();
        const n = Number(raw);
        if (raw.length === 0 || Number.isNaN(n)) {
          throw new Error(`Invalid <real> value in plist: ${JSON.stringify(raw)}`);
        }
        return n;
      }
      case 'date':
        return readElementText('date').trim();
      case 'data':
        return readElementText('data').trim();
      default:
        throw new Error(`Unsupported plist element <${tok.name}>`);
    }
  }

  const rootTok = peek();
  if (!rootTok) {
    throw new Error('Empty plist XML document');
  }
  if (rootTok.type === 'selfClose' && rootTok.name === 'plist') {
    pos += 1;
    if (peek() !== null) {
      throw new Error('Unexpected trailing content after <plist/>');
    }
    return null;
  }
  if (rootTok.type !== 'open' || rootTok.name !== 'plist') {
    throw new Error(`Expected root <plist> element, got ${rootTok.type} <${rootTok.name ?? ''}>`);
  }
  pos += 1;

  let rootValue = null;
  const firstChild = peek();
  if (firstChild && !(firstChild.type === 'close' && firstChild.name === 'plist')) {
    rootValue = parseValue();
  }

  const closeTok = peek();
  if (!closeTok || closeTok.type !== 'close' || closeTok.name !== 'plist') {
    throw new Error('Expected closing </plist> tag');
  }
  pos += 1;

  if (peek() !== null) {
    throw new Error('Unexpected trailing content after </plist>');
  }

  return rootValue;
}

/**
 * Parses `NSPrivacyAccessedAPITypes` from Apple's `PrivacyInfo.xcprivacy` XML.
 * Returns `Array<{ type: string, reasons: string[] }>`.
 */
export function parsePlistRequiredReasonAPIs(xmlText) {
  const root = parsePlistXml(xmlText);
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('PrivacyInfo.xcprivacy root element must be a <dict>');
  }

  const rawTypes = root.NSPrivacyAccessedAPITypes;
  if (rawTypes === undefined) {
    return [];
  }
  if (!Array.isArray(rawTypes)) {
    throw new Error('NSPrivacyAccessedAPITypes must be an <array>');
  }

  return rawTypes.map((entry, idx) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`NSPrivacyAccessedAPITypes[${idx}] must be a <dict>`);
    }
    const type =
      typeof entry.NSPrivacyAccessedAPIType === 'string'
        ? entry.NSPrivacyAccessedAPIType.trim()
        : '';
    const reasons = Array.isArray(entry.NSPrivacyAccessedAPITypeReasons)
      ? entry.NSPrivacyAccessedAPITypeReasons
          .filter((r) => typeof r === 'string')
          .map((r) => r.trim())
      : [];
    return { type, reasons };
  });
}

/**
 * Validates a CocoaPods `.podspec` using Ruby + `cocoapods-core`.
 * Never skips or mocks when `cocoapods-core` is missing; returns `{ ok: false, ... }`.
 */
export function validatePodspecViaRuby(podspecRelPath, opts = {}) {
  const baseDir = path.resolve(opts.baseDir ?? REPO_ROOT);
  const absPodspecPath = resolveRepoPath(podspecRelPath, { rootDir: baseDir, allowRoot: false });

  if (!fs.existsSync(absPodspecPath) || !fs.statSync(absPodspecPath).isFile()) {
    return {
      ok: false,
      specName: null,
      version: null,
      status: -1,
      stdout: '',
      stderr: `Podspec file not found: ${podspecRelPath}`,
      spec: null,
    };
  }

  const SENTINEL = 'KIOSK_PODSPEC_JSON:';
  const rubyScript = [
    'require "json"',
    'require "cocoapods-core"',
    'spec = Pod::Specification.from_file(ARGV[0])',
    'hash = spec.to_hash',
    'raise "Podspec name is empty" if spec.name.nil? || spec.name.to_s.strip.empty?',
    'raise "Podspec version is empty" if spec.version.nil? || spec.version.to_s.strip.empty?',
    'payload = { specName: spec.name.to_s, version: spec.version.to_s, spec: hash }',
    `puts "${SENTINEL}" + JSON.generate(payload)`,
  ].join('\n');

  const res = runCommand('ruby', ['-e', rubyScript, absPodspecPath], { cwd: baseDir });

  if (res.error !== null || res.signal !== null || res.status !== 0) {
    return {
      ok: false,
      specName: null,
      version: null,
      status: res.status,
      stdout: res.stdout,
      stderr: res.stderr || res.error?.message || `ruby exited with signal ${res.signal}`,
      spec: null,
    };
  }

  const lines = res.stdout.split(/\r?\n/);
  let jsonLine = null;
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    if (lines[idx].startsWith(SENTINEL)) {
      jsonLine = lines[idx].slice(SENTINEL.length);
      break;
    }
  }

  if (jsonLine === null) {
    return {
      ok: false,
      specName: null,
      version: null,
      status: res.status,
      stdout: res.stdout,
      stderr: 'Failed to parse podspec JSON output: sentinel marker missing from ruby stdout',
      spec: null,
    };
  }

  try {
    const parsed = JSON.parse(jsonLine);
    return {
      ok: true,
      specName: parsed.specName,
      version: parsed.version,
      status: 0,
      stdout: res.stdout,
      stderr: res.stderr,
      spec: parsed.spec,
    };
  } catch (err) {
    return {
      ok: false,
      specName: null,
      version: null,
      status: res.status,
      stdout: res.stdout,
      stderr: `Failed to parse podspec JSON output: ${err.message}`,
      spec: null,
    };
  }
}

/**
 * Verifies Objective-C++ `.mm` syntax and ARC rules targeting `arm64-apple-ios16.0`
 * via `clang++`. Fails loudly if `mmRelPaths` is empty or `stubIncludeRelDir` is absent.
 */
export function checkObjCSyntaxViaClang(mmRelPaths, stubIncludeRelDir, opts = {}) {
  if (!Array.isArray(mmRelPaths) || mmRelPaths.length === 0) {
    throw new Error('mmRelPaths must be a non-empty array');
  }

  const baseDir = path.resolve(opts.baseDir ?? REPO_ROOT);
  const absStubDir = resolveRepoPath(stubIncludeRelDir, { rootDir: baseDir, allowRoot: false });

  if (!fs.existsSync(absStubDir) || !fs.statSync(absStubDir).isDirectory()) {
    return {
      ok: false,
      stubIncludeDir: absStubDir,
      error: `Stub include directory not found: ${stubIncludeRelDir}`,
      results: [],
    };
  }

  const resolvedFiles = mmRelPaths.map((relPath) => ({
    relPath,
    absPath: resolveRepoPath(relPath, { rootDir: baseDir, allowRoot: false }),
  }));

  const extraIncludeArgs = [];
  for (const extraRel of opts.extraIncludeRelDirs ?? []) {
    const absExtra = resolveRepoPath(extraRel, { rootDir: baseDir, allowRoot: true });
    if (!fs.existsSync(absExtra) || !fs.statSync(absExtra).isDirectory()) {
      return {
        ok: false,
        stubIncludeDir: absStubDir,
        error: `Extra include directory not found: ${extraRel}`,
        results: [],
      };
    }
    extraIncludeArgs.push('-I', absExtra);
  }

  const extraFlags = opts.extraFlags ?? [];
  const results = [];
  let spawnError = null;

  for (const { relPath, absPath } of resolvedFiles) {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      results.push({
        file: relPath,
        ok: false,
        status: -1,
        signal: null,
        stdout: '',
        stderr: `Objective-C++ source file not found: ${relPath}`,
        error: null,
      });
      continue;
    }

    const args = [
      '--target=arm64-apple-ios16.0',
      '-x',
      'objective-c++',
      '-fobjc-arc',
      '-fsyntax-only',
      '-I',
      absStubDir,
      ...extraIncludeArgs,
      ...extraFlags,
      absPath,
    ];

    const res = runCommand('clang++', args, { cwd: baseDir });
    if (res.error !== null && spawnError === null) {
      spawnError = res.error.message;
    }
    const fileOk = res.error === null && res.signal === null && res.status === 0;
    results.push({
      file: relPath,
      ok: fileOk,
      status: res.status,
      signal: res.signal,
      stdout: res.stdout,
      stderr: res.stderr,
      error: res.error,
    });
  }

  return {
    ok: results.length > 0 && results.every((r) => r.ok),
    stubIncludeDir: absStubDir,
    error: spawnError,
    results,
  };
}
