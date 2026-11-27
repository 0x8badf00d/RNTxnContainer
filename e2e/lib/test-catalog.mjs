import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCStyleComments } from './ios-inspector.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '../..');

const CODE_UNIT_COMPARE = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const FEATURES = Object.freeze([
  'FEAT-01', 'FEAT-02', 'FEAT-03', 'FEAT-04',
  'FEAT-05', 'FEAT-06', 'FEAT-07', 'FEAT-08',
  'FEAT-09', 'FEAT-10', 'FEAT-11', 'FEAT-12',
  'FEAT-13', 'FEAT-14', 'FEAT-15', 'FEAT-16',
]);

export const TIERS = Object.freeze([1, 2, 3, 4]);
export const SUITES = Object.freeze(['swift', 'js', 'structural']);

export const COVERAGE_THRESHOLDS = Object.freeze({
  tier1Total: 80,
  tier1PerFeature: 5,
  tier2Total: 80,
  tier2PerFeature: 5,
  tier3Total: 16,
  tier4Total: 8,
  grandTotal: 184,
});

const VALID_FEATURE_SET = new Set(FEATURES);

const DISCOVERY_ROOTS = Object.freeze([
  { suite: 'swift', tier: 1, relDir: 'swift/Tests/E2ETier1Tests', suffix: '.swift' },
  { suite: 'swift', tier: 2, relDir: 'swift/Tests/E2ETier2Tests', suffix: '.swift' },
  { suite: 'swift', tier: 3, relDir: 'swift/Tests/E2ETier3Tests', suffix: '.swift' },
  { suite: 'swift', tier: 4, relDir: 'swift/Tests/E2ETier4Tests', suffix: '.swift' },
  { suite: 'js', tier: 1, relDir: 'js/tier1', suffix: '.test.mjs' },
  { suite: 'js', tier: 2, relDir: 'js/tier2', suffix: '.test.mjs' },
  { suite: 'js', tier: 3, relDir: 'js/tier3', suffix: '.test.mjs' },
  { suite: 'js', tier: 4, relDir: 'js/tier4', suffix: '.test.mjs' },
  { suite: 'structural', tier: 1, relDir: 'ios-structural/tier1', suffix: '.test.mjs' },
  { suite: 'structural', tier: 2, relDir: 'ios-structural/tier2', suffix: '.test.mjs' },
  { suite: 'structural', tier: 3, relDir: 'ios-structural/tier3', suffix: '.test.mjs' },
  { suite: 'structural', tier: 4, relDir: 'ios-structural/tier4', suffix: '.test.mjs' },
]);

const JS_REGEX_KEYWORDS = new Set([
  'return', 'throw', 'case', 'default', 'in', 'of', 'instanceof', 'typeof',
  'void', 'delete', 'yield', 'await', 'new', 'else', 'do',
]);

const JS_REGEX_PUNCT = new Set([
  '=', '(', '[', ',', ':', ';', '!', '&', '|', '?', '{', '}',
  '~', '^', '+', '-', '*', '/', '%', '<', '>',
]);

const JS_CONTROL_FLOW_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
const FORBIDDEN_OPTION_KEYS = new Set(['skip', 'todo', 'only']);

function lineNumberAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function isIdentChar(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57) ||
    c === 95 ||
    c === 36
  );
}

function isIdentStart(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 95 ||
    c === 36
  );
}

/**
 * Replaces Swift string literal contents with spaces while preserving `\n` and
 * tracking `\( ... )` / `\#( ... )` interpolations so string fixtures containing
 * `"func test_T1_..."` can never trigger false matches or invert quote state.
 */
function maskSwiftStringLiterals(stripped) {
  const len = stripped.length;
  const out = [];
  const interpStack = [];
  let i = 0;

  function emitMasked(slice) {
    for (let k = 0; k < slice.length; k += 1) {
      const ch = slice[k];
      out.push(ch === '\n' || ch === '\r' ? ch : ' ');
    }
  }

  function maskSwiftString(isTriple, hashCount) {
    const hashes = hashCount > 0 ? '#'.repeat(hashCount) : '';
    const closeToken = (isTriple ? '"""' : '"') + hashes;
    const interpPrefix = `\\${hashes}(`;
    const escPrefix = `\\${hashes}`;
    const start = i;

    while (i < len) {
      if (stripped.startsWith(interpPrefix, i)) {
        emitMasked(stripped.slice(start, i));
        out.push(interpPrefix);
        i += interpPrefix.length;
        interpStack.push({ isTriple, hashCount, parenDepth: 0 });
        return;
      }
      if (stripped.startsWith(escPrefix, i)) {
        i = Math.min(len, i + escPrefix.length + 1);
        continue;
      }
      if (stripped.startsWith(closeToken, i)) {
        i += closeToken.length;
        emitMasked(stripped.slice(start, i));
        return;
      }
      i += 1;
    }
    emitMasked(stripped.slice(start, i));
  }

  while (i < len) {
    const ch = stripped[i];

    // Swift raw string: #"..."#, ##"..."##, #"""..."""#
    if (ch === '#') {
      let k = 0;
      while (i + k < len && stripped[i + k] === '#') {
        k += 1;
      }
      if (stripped[i + k] === '"') {
        const isTriple = stripped.startsWith('"""', i + k);
        const quoteLen = isTriple ? 3 : 1;
        emitMasked(stripped.slice(i, i + k + quoteLen));
        i += k + quoteLen;
        maskSwiftString(isTriple, k);
        continue;
      }
    }

    // Swift triple-quoted string: """..."""
    if (ch === '"' && stripped.startsWith('"""', i)) {
      emitMasked('"""');
      i += 3;
      maskSwiftString(true, 0);
      continue;
    }

    // Standard double-quoted string: "..."
    if (ch === '"') {
      out.push(' ');
      i += 1;
      maskSwiftString(false, 0);
      continue;
    }

    // Track parens inside Swift string interpolation `\( ... )`
    if (interpStack.length > 0) {
      if (ch === '(') {
        interpStack[interpStack.length - 1].parenDepth += 1;
        out.push('(');
        i += 1;
        continue;
      }
      if (ch === ')') {
        const top = interpStack[interpStack.length - 1];
        if (top.parenDepth === 0) {
          interpStack.pop();
          out.push(')');
          i += 1;
          maskSwiftString(top.isTriple, top.hashCount);
          continue;
        }
        top.parenDepth -= 1;
        out.push(')');
        i += 1;
        continue;
      }
    }

    out.push(ch);
    i += 1;
  }

  return out.join('');
}

function unescapeJsString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      switch (next) {
        case 'n': out += '\n'; i += 1; break;
        case 'r': out += '\r'; i += 1; break;
        case 't': out += '\t'; i += 1; break;
        case '\\': out += '\\'; i += 1; break;
        case "'": out += "'"; i += 1; break;
        case '"': out += '"'; i += 1; break;
        case '`': out += '`'; i += 1; break;
        case '$': out += '$'; i += 1; break;
        case '\n': i += 1; break;
        case '\r':
          i += raw[i + 2] === '\n' ? 2 : 1;
          break;
        default:
          out += next;
          i += 1;
          break;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function readJsStringLiteralAt(source, startIndex) {
  const quote = source[startIndex];
  if (quote !== "'" && quote !== '"' && quote !== '`') {
    return null;
  }

  const len = source.length;
  let i = startIndex + 1;
  let hasInterpolation = false;

  while (i < len) {
    const ch = source[i];
    if (ch === '\\') {
      if (source[i + 1] === '\r' && source[i + 2] === '\n') {
        i += 3;
      } else {
        i += 2;
      }
      continue;
    }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      hasInterpolation = true;
      // Advance past `${ ... }` while skipping nested strings, templates, and regex literals
      i += 2;
      let depth = 1;
      let interpAllowsRegex = true;
      let interpPrevPunct = '${';
      let interpLastWasControl = false;
      const interpParenStack = [];

      while (i < len && depth > 0) {
        const ic = source[i];
        if (/\s/.test(ic)) {
          i += 1;
          continue;
        }
        if (ic === "'" || ic === '"' || ic === '`') {
          const nested = readJsStringLiteralAt(source, i);
          if (!nested) {
            return null;
          }
          i = nested.endIndex;
          interpAllowsRegex = false;
          interpLastWasControl = false;
          interpPrevPunct = ic;
          continue;
        }
        if (ic === '/' && interpAllowsRegex) {
          const regexEnd = skipJsRegexAt(source, i);
          if (regexEnd !== -1) {
            i = regexEnd;
            interpAllowsRegex = false;
            interpLastWasControl = false;
            interpPrevPunct = 'regex';
            continue;
          }
        }
        if (isIdentStart(ic)) {
          let end = i + 1;
          while (end < len && isIdentChar(source[end])) end += 1;
          const word = source.slice(i, end);
          const wasMember = interpPrevPunct === '.';
          interpLastWasControl = !wasMember && JS_CONTROL_FLOW_KEYWORDS.has(word);
          interpAllowsRegex = !wasMember && JS_REGEX_KEYWORDS.has(word);
          interpPrevPunct = '';
          i = end;
          continue;
        }
        if (ic >= '0' && ic <= '9') {
          let end = i + 1;
          while (end < len && /[0-9a-fA-FxXbBoOeE_.n]/.test(source[end])) end += 1;
          interpAllowsRegex = false;
          interpLastWasControl = false;
          interpPrevPunct = '';
          i = end;
          continue;
        }
        if ((ic === '+' && source[i + 1] === '+') || (ic === '-' && source[i + 1] === '-')) {
          interpPrevPunct = ic + ic;
          interpLastWasControl = false;
          i += 2;
          continue;
        }
        if (ic === '(') {
          interpParenStack.push(interpLastWasControl);
          interpAllowsRegex = true;
          interpLastWasControl = false;
          interpPrevPunct = '(';
          i += 1;
          continue;
        }
        if (ic === ')') {
          const wasControl = interpParenStack.length > 0 ? interpParenStack.pop() : false;
          interpAllowsRegex = wasControl;
          interpLastWasControl = false;
          interpPrevPunct = ')';
          i += 1;
          continue;
        }
        if (ic === '{') {
          depth += 1;
          interpAllowsRegex = true;
          interpLastWasControl = false;
          interpPrevPunct = '{';
          i += 1;
          continue;
        }
        if (ic === '}') {
          depth -= 1;
          interpAllowsRegex = true;
          interpLastWasControl = false;
          interpPrevPunct = '}';
          i += 1;
          continue;
        }
        interpPrevPunct = ic;
        interpLastWasControl = false;
        if (JS_REGEX_PUNCT.has(ic)) {
          interpAllowsRegex = true;
        } else if (ic === ']' || ic === '.') {
          interpAllowsRegex = false;
        }
        i += 1;
      }
      continue;
    }
    if (ch === quote) {
      const rawContent = source.slice(startIndex + 1, i);
      return {
        value: unescapeJsString(rawContent),
        hasInterpolation,
        endIndex: i + 1,
      };
    }
    if ((quote === "'" || quote === '"') && (ch === '\n' || ch === '\r')) {
      return null;
    }
    i += 1;
  }
  return null;
}

function skipJsRegexAt(source, startIndex) {
  const len = source.length;
  const next = source[startIndex + 1];
  if (!next || next === '/' || next === '*' || next === '\n' || next === '\r') {
    return -1;
  }
  let i = startIndex + 1;
  let inClass = false;
  while (i < len) {
    const ch = source[i];
    if (ch === '\n' || ch === '\r') return -1;
    if (ch === '\\') {
      if (i + 1 >= len || source[i + 1] === '\n' || source[i + 1] === '\r') return -1;
      i += 2;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === ']' && inClass) {
      inClass = false;
      i += 1;
      continue;
    }
    if (ch === '/' && !inClass) {
      i += 1;
      while (i < len && /[A-Za-z]/.test(source[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return -1;
}

function skipWhitespace(source, startIndex) {
  let i = startIndex;
  while (i < source.length && /\s/.test(source[i])) {
    i += 1;
  }
  return i;
}

function readTopLevelPropertyValue(source, startIndex) {
  const len = source.length;
  const valStart = skipWhitespace(source, startIndex);
  let valEnd = valStart;
  let vDepth = 0;
  let vAllowRegex = true;
  let vPrevPunct = ':';
  let vLastWasControl = false;
  const vParenStack = [];

  while (valEnd < len) {
    const vc = source[valEnd];
    if (/\s/.test(vc)) {
      valEnd += 1;
      continue;
    }
    if (vc === "'" || vc === '"' || vc === '`') {
      const lit = readJsStringLiteralAt(source, valEnd);
      valEnd = lit ? lit.endIndex : valEnd + 1;
      vAllowRegex = false;
      vLastWasControl = false;
      vPrevPunct = vc;
      continue;
    }
    if (vc === '/' && vAllowRegex) {
      const regexEnd = skipJsRegexAt(source, valEnd);
      if (regexEnd !== -1) {
        valEnd = regexEnd;
        vAllowRegex = false;
        vLastWasControl = false;
        vPrevPunct = 'regex';
        continue;
      }
    }
    if (isIdentStart(vc)) {
      let end = valEnd + 1;
      while (end < len && isIdentChar(source[end])) end += 1;
      const word = source.slice(valEnd, end);
      const wasMember = vPrevPunct === '.';
      vLastWasControl = !wasMember && JS_CONTROL_FLOW_KEYWORDS.has(word);
      vAllowRegex = !wasMember && JS_REGEX_KEYWORDS.has(word);
      vPrevPunct = '';
      valEnd = end;
      continue;
    }
    if (vc >= '0' && vc <= '9') {
      let end = valEnd + 1;
      while (end < len && /[0-9a-fA-FxXbBoOeE_.n]/.test(source[end])) end += 1;
      vAllowRegex = false;
      vLastWasControl = false;
      vPrevPunct = '';
      valEnd = end;
      continue;
    }
    if ((vc === '+' && source[valEnd + 1] === '+') || (vc === '-' && source[valEnd + 1] === '-')) {
      vPrevPunct = vc + vc;
      vLastWasControl = false;
      valEnd += 2;
      continue;
    }
    if (vc === '(') {
      vParenStack.push(vLastWasControl);
      vDepth += 1;
      vAllowRegex = true;
      vLastWasControl = false;
      vPrevPunct = '(';
      valEnd += 1;
      continue;
    }
    if (vc === ')') {
      if (vDepth === 0) break;
      const wasControl = vParenStack.length > 0 ? vParenStack.pop() : false;
      vDepth -= 1;
      vAllowRegex = wasControl;
      vLastWasControl = false;
      vPrevPunct = ')';
      valEnd += 1;
      continue;
    }
    if (vc === '{' || vc === '[') {
      vDepth += 1;
      vAllowRegex = true;
      vLastWasControl = false;
      vPrevPunct = vc;
      valEnd += 1;
      continue;
    }
    if (vc === '}' || vc === ']') {
      if (vDepth === 0) break;
      vDepth -= 1;
      vAllowRegex = vc === '}';
      vLastWasControl = false;
      vPrevPunct = vc;
      valEnd += 1;
      continue;
    }
    if (vc === ',' && vDepth === 0) {
      break;
    }
    vPrevPunct = vc;
    vLastWasControl = false;
    if (JS_REGEX_PUNCT.has(vc)) {
      vAllowRegex = true;
    } else if (vc === '.') {
      vAllowRegex = false;
    }
    valEnd += 1;
  }

  return {
    valText: source.slice(valStart, valEnd).trim(),
    valEnd,
  };
}

function readObjectPropertyKeyAt(source, startIndex) {
  const len = source.length;
  const ch = source[startIndex];
  if (!ch) return null;

  if (ch === '[') {
    const innerStart = skipWhitespace(source, startIndex + 1);
    const innerCh = source[innerStart];
    const lit =
      innerCh === "'" || innerCh === '"' || innerCh === '`'
        ? readJsStringLiteralAt(source, innerStart)
        : null;
    if (lit && !lit.hasInterpolation) {
      const closeBracket = skipWhitespace(source, lit.endIndex);
      if (source[closeBracket] === ']') {
        return { keyName: lit.value, afterKey: closeBracket + 1, kind: 'computed' };
      }
    }
    return null;
  }

  if (ch === "'" || ch === '"') {
    const lit = readJsStringLiteralAt(source, startIndex);
    if (!lit) return null;
    return { keyName: lit.value, afterKey: lit.endIndex, kind: 'string' };
  }

  if (isIdentStart(ch)) {
    let end = startIndex + 1;
    while (end < len && isIdentChar(source[end])) end += 1;
    return { keyName: source.slice(startIndex, end), afterKey: end, kind: 'ident' };
  }

  return null;
}

/**
 * Inspects a balanced JS object literal `{ ... }` starting at `braceStart` for
 * top-level `skip`, `todo`, or `only` properties (unquoted, quoted, computed
 * static literal, shorthand, method shorthand, or getter/async/generator)
 * whose value is not literally `false`/`undefined`/`null`.
 */
function inspectTestOptionsObject(source, braceStart) {
  const len = source.length;
  let i = braceStart + 1;
  let depth = 1;
  let expectingKey = true;
  let lastTokenAllowsRegex = true;
  let lastWasControlKeyword = false;
  let prevPunct = '{';
  const parenStack = [];
  const forbidden = [];

  while (i < len && depth > 0) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (depth === 1 && expectingKey) {
      if (ch === '}') {
        depth -= 1;
        i += 1;
        continue;
      }

      // Spread property `{ ...opts }`: enter value position so `{ ...skip }` is not misread
      if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
        expectingKey = false;
        lastTokenAllowsRegex = true;
        lastWasControlKeyword = false;
        prevPunct = '...';
        i += 3;
        continue;
      }

      // Generator method shorthand: `{ *skip() {} }`, `{ *'skip'() {} }`, `{ *['skip']() {} }`
      if (ch === '*') {
        const keyStart = skipWhitespace(source, i + 1);
        const propKey = readObjectPropertyKeyAt(source, keyStart);
        if (propKey) {
          const afterKeyWs = skipWhitespace(source, propKey.afterKey);
          if (source[afterKeyWs] === '(') {
            if (FORBIDDEN_OPTION_KEYS.has(propKey.keyName)) {
              forbidden.push(`*${propKey.keyName}()`);
            }
            i = afterKeyWs;
            expectingKey = false;
            lastTokenAllowsRegex = true;
            lastWasControlKeyword = false;
            prevPunct = '';
            continue;
          }
        }
        i = keyStart;
        expectingKey = false;
        lastTokenAllowsRegex = true;
        lastWasControlKeyword = false;
        prevPunct = '*';
        continue;
      }

      // Computed static string literal key: `{ ['skip']: true }`, `{ ['skip']() {} }`
      if (ch === '[') {
        const propKey = readObjectPropertyKeyAt(source, i);
        if (propKey) {
          const wsPos = skipWhitespace(source, propKey.afterKey);
          if (source[wsPos] === ':') {
            if (FORBIDDEN_OPTION_KEYS.has(propKey.keyName)) {
              const { valText, valEnd } = readTopLevelPropertyValue(source, wsPos + 1);
              if (valText !== 'false' && valText !== 'undefined' && valText !== 'null') {
                forbidden.push(`${propKey.keyName}: ${valText || '<empty>'}`);
              }
              i = valEnd;
              expectingKey = false;
              lastTokenAllowsRegex = false;
              lastWasControlKeyword = false;
              prevPunct = '';
              continue;
            }
            i = wsPos + 1;
            expectingKey = false;
            lastTokenAllowsRegex = true;
            lastWasControlKeyword = false;
            prevPunct = ':';
            continue;
          }
          if (source[wsPos] === '(') {
            if (FORBIDDEN_OPTION_KEYS.has(propKey.keyName)) {
              forbidden.push(`${propKey.keyName}()`);
            }
            i = wsPos;
            expectingKey = false;
            lastTokenAllowsRegex = true;
            lastWasControlKeyword = false;
            prevPunct = '';
            continue;
          }
        }
        depth += 1;
        lastTokenAllowsRegex = true;
        lastWasControlKeyword = false;
        prevPunct = '[';
        i += 1;
        continue;
      }

      // Quoted (`'skip'`, `"todo"`) or unquoted identifier key (including `get`/`set`/`async` methods)
      if (ch === "'" || ch === '"' || isIdentStart(ch)) {
        const first = readObjectPropertyKeyAt(source, i);
        if (!first) {
          i += 1;
          continue;
        }

        const wsPos = skipWhitespace(source, first.afterKey);
        const nextChar = source[wsPos];

        // Accessor or async method modifier prefix: `get skip() {}`, `async skip() {}`, `async *skip() {}`
        if (
          first.kind === 'ident' &&
          (first.keyName === 'get' || first.keyName === 'set' || first.keyName === 'async') &&
          nextChar !== ':' &&
          nextChar !== ',' &&
          nextChar !== '}' &&
          nextChar !== '('
        ) {
          let modifier = first.keyName;
          let targetPos = wsPos;
          if (modifier === 'async' && source[targetPos] === '*') {
            modifier = 'async *';
            targetPos = skipWhitespace(source, targetPos + 1);
          }
          const realKey = readObjectPropertyKeyAt(source, targetPos);
          if (realKey) {
            const afterRealWs = skipWhitespace(source, realKey.afterKey);
            if (source[afterRealWs] === '(') {
              if (modifier !== 'set' && FORBIDDEN_OPTION_KEYS.has(realKey.keyName)) {
                forbidden.push(`${modifier} ${realKey.keyName}()`);
              }
              i = afterRealWs;
              expectingKey = false;
              lastTokenAllowsRegex = true;
              lastWasControlKeyword = false;
              prevPunct = '';
              continue;
            }
          }
          i = targetPos;
          expectingKey = false;
          lastTokenAllowsRegex = true;
          lastWasControlKeyword = false;
          prevPunct = '';
          continue;
        }

        if (nextChar === ':') {
          if (FORBIDDEN_OPTION_KEYS.has(first.keyName)) {
            const { valText, valEnd } = readTopLevelPropertyValue(source, wsPos + 1);
            if (valText !== 'false' && valText !== 'undefined' && valText !== 'null') {
              forbidden.push(`${first.keyName}: ${valText || '<empty>'}`);
            }
            i = valEnd;
            expectingKey = false;
            lastTokenAllowsRegex = false;
            lastWasControlKeyword = false;
            prevPunct = '';
            continue;
          }
          i = wsPos + 1;
          expectingKey = false;
          lastTokenAllowsRegex = true;
          lastWasControlKeyword = false;
          prevPunct = ':';
          continue;
        }

        if (nextChar === '(') {
          // Method shorthand `{ skip() {} }`, `{ 'skip'() {} }`, `{ todo() {} }`, `{ only() {} }`
          if (FORBIDDEN_OPTION_KEYS.has(first.keyName)) {
            forbidden.push(`${first.keyName}()`);
          }
          i = wsPos;
          expectingKey = false;
          lastTokenAllowsRegex = true;
          lastWasControlKeyword = false;
          prevPunct = '';
          continue;
        }

        if (first.kind === 'ident' && (nextChar === ',' || nextChar === '}')) {
          // Unquoted shorthand `{ skip }` / `{ todo }` / `{ only }`
          if (FORBIDDEN_OPTION_KEYS.has(first.keyName)) {
            forbidden.push(first.keyName);
          }
          i = wsPos;
          expectingKey = false;
          lastTokenAllowsRegex = false;
          lastWasControlKeyword = false;
          prevPunct = '';
          continue;
        }

        i = first.afterKey;
        expectingKey = false;
        lastTokenAllowsRegex = false;
        lastWasControlKeyword = false;
        prevPunct = '';
        continue;
      }
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const lit = readJsStringLiteralAt(source, i);
      i = lit ? lit.endIndex : i + 1;
      lastTokenAllowsRegex = false;
      lastWasControlKeyword = false;
      prevPunct = ch;
      continue;
    }
    if (ch === '/' && lastTokenAllowsRegex) {
      const regexEnd = skipJsRegexAt(source, i);
      if (regexEnd !== -1) {
        i = regexEnd;
        lastTokenAllowsRegex = false;
        lastWasControlKeyword = false;
        prevPunct = 'regex';
        continue;
      }
    }
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < len && isIdentChar(source[end])) end += 1;
      const word = source.slice(i, end);
      const wasMemberAccess = prevPunct === '.';
      lastWasControlKeyword = !wasMemberAccess && JS_CONTROL_FLOW_KEYWORDS.has(word);
      lastTokenAllowsRegex = !wasMemberAccess && JS_REGEX_KEYWORDS.has(word);
      prevPunct = '';
      i = end;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let end = i + 1;
      while (end < len && /[0-9a-fA-FxXbBoOeE_.n]/.test(source[end])) end += 1;
      lastTokenAllowsRegex = false;
      lastWasControlKeyword = false;
      prevPunct = '';
      i = end;
      continue;
    }
    if ((ch === '+' && source[i + 1] === '+') || (ch === '-' && source[i + 1] === '-')) {
      prevPunct = ch + ch;
      lastWasControlKeyword = false;
      i += 2;
      continue;
    }
    if (ch === '(') {
      parenStack.push(lastWasControlKeyword);
      depth += 1;
      lastTokenAllowsRegex = true;
      lastWasControlKeyword = false;
      prevPunct = '(';
      i += 1;
      continue;
    }
    if (ch === ')') {
      const wasControl = parenStack.length > 0 ? parenStack.pop() : false;
      depth -= 1;
      lastTokenAllowsRegex = wasControl;
      lastWasControlKeyword = false;
      prevPunct = ')';
      i += 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      lastTokenAllowsRegex = true;
      lastWasControlKeyword = false;
      prevPunct = ch;
      i += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth -= 1;
      lastTokenAllowsRegex = ch === '}';
      lastWasControlKeyword = false;
      prevPunct = ch;
      i += 1;
      continue;
    }
    if (depth === 1 && ch === ':') {
      expectingKey = false;
      lastTokenAllowsRegex = true;
      lastWasControlKeyword = false;
      prevPunct = ':';
      i += 1;
      continue;
    }
    if (depth === 1 && ch === ',') {
      expectingKey = true;
      lastTokenAllowsRegex = true;
      lastWasControlKeyword = false;
      prevPunct = ',';
      i += 1;
      continue;
    }

    prevPunct = ch;
    lastWasControlKeyword = false;
    if (JS_REGEX_PUNCT.has(ch)) {
      lastTokenAllowsRegex = true;
    } else if (ch === '.') {
      lastTokenAllowsRegex = false;
    }
    i += 1;
  }

  return { forbidden, endIndex: i };
}

function validateAndCollectTier3Features(identifierPart) {
  const segments = identifierPart.split('_');
  const features = [];
  const seen = new Set();

  for (const seg of segments) {
    if (/^FEAT(?:\d|-|$)/i.test(seg)) {
      const m = seg.match(/^FEAT(0[1-9]|1[0-6])$/);
      if (!m) {
        return {
          ok: false,
          reason: `Invalid feature token "${seg}" in Tier 3 ID (expected FEAT01..FEAT16)`,
        };
      }
      const featId = `FEAT-${m[1]}`;
      if (!seen.has(featId)) {
        seen.add(featId);
        features.push(featId);
      }
    }
  }

  return { ok: true, features };
}

/**
 * Strictly parses and validates a single E2E test title/identifier.
 */
export function parseTestId(rawTitle, { suite = 'swift' } = {}) {
  if (typeof rawTitle !== 'string' || rawTitle.trim().length === 0) {
    return {
      valid: false,
      declaredTier: null,
      reason: 'Empty test identifier',
      rawTitle: String(rawTitle ?? ''),
    };
  }

  const tierMatch = rawTitle.match(/^T([1-4])_/);
  const declaredTier = tierMatch ? Number(tierMatch[1]) : null;

  if (suite === 'swift') {
    const t12 = rawTitle.match(
      /^T([12])_FEAT(0[1-9]|1[0-6])_(?!0+_)(\d{2,})_([A-Za-z0-9][A-Za-z0-9_]*)$/,
    );
    if (t12) {
      const tier = Number(t12[1]);
      const featNum = t12[2];
      const sequence = t12[3];
      const slug = t12[4];
      const feature = `FEAT-${featNum}`;
      return {
        valid: true,
        tier,
        id: rawTitle,
        slotKey: `T${tier}_FEAT${featNum}_${sequence}`,
        feature,
        features: [feature],
        sequence,
        slug,
        rawTitle,
      };
    }

    const t3 = rawTitle.match(/^T3_PAIR(?!0+_)(\d{2,})_([A-Za-z0-9][A-Za-z0-9_]*)$/);
    if (t3) {
      const featCheck = validateAndCollectTier3Features(rawTitle);
      if (!featCheck.ok) {
        return { valid: false, declaredTier: 3, reason: featCheck.reason, rawTitle };
      }
      const sequence = t3[1];
      const slug = t3[2];
      return {
        valid: true,
        tier: 3,
        id: rawTitle,
        slotKey: `T3_PAIR${sequence}`,
        feature: null,
        features: featCheck.features,
        sequence,
        slug,
        rawTitle,
      };
    }

    const t4 = rawTitle.match(/^T4_SCEN(?!0+_)(\d{2,})_([A-Za-z0-9][A-Za-z0-9_]*)$/);
    if (t4) {
      const sequence = t4[1];
      const slug = t4[2];
      return {
        valid: true,
        tier: 4,
        id: rawTitle,
        slotKey: `T4_SCEN${sequence}`,
        feature: null,
        features: [],
        sequence,
        slug,
        rawTitle,
      };
    }

    return {
      valid: false,
      declaredTier,
      reason: `Swift test name "test_${rawTitle}" does not match required T1_FEAT<01..16>_<NN>_<Slug>, T2_FEAT<01..16>_<NN>_<Slug>, T3_PAIR<NN>_<Slug>, or T4_SCEN<NN>_<Slug> grammar`,
      rawTitle,
    };
  }

  // JS and Structural suites: accept underscore-slug (with optional ": desc") OR colon-desc form.
  // Colon descriptions may begin with `@`, `<`, backtick, quotes, etc. so long as they are
  // non-empty and contain at least one alphanumeric character.
  const t12Underscore = rawTitle.match(
    /^T([12])_FEAT(0[1-9]|1[0-6])_(?!0+_)(\d{2,})_([A-Za-z0-9][A-Za-z0-9_]*)(?::\s*((?=.*[A-Za-z0-9])\S.*))?$/,
  );
  if (t12Underscore) {
    const tier = Number(t12Underscore[1]);
    const featNum = t12Underscore[2];
    const sequence = t12Underscore[3];
    const slug = t12Underscore[4];
    const feature = `FEAT-${featNum}`;
    const id = `T${tier}_FEAT${featNum}_${sequence}_${slug}`;
    return {
      valid: true,
      tier,
      id,
      slotKey: `T${tier}_FEAT${featNum}_${sequence}`,
      feature,
      features: [feature],
      sequence,
      slug,
      rawTitle,
    };
  }

  const t12Colon = rawTitle.match(
    /^T([12])_FEAT(0[1-9]|1[0-6])_(?!0+:)(\d{2,}):\s*((?=.*[A-Za-z0-9])\S.*)$/,
  );
  if (t12Colon) {
    const tier = Number(t12Colon[1]);
    const featNum = t12Colon[2];
    const sequence = t12Colon[3];
    const slug = t12Colon[4].trim();
    const feature = `FEAT-${featNum}`;
    const id = `T${tier}_FEAT${featNum}_${sequence}`;
    return {
      valid: true,
      tier,
      id,
      slotKey: id,
      feature,
      features: [feature],
      sequence,
      slug,
      rawTitle,
    };
  }

  const t3Underscore = rawTitle.match(
    /^T3_PAIR(?!0+_)(\d{2,})_([A-Za-z0-9][A-Za-z0-9_]*)(?::\s*((?=.*[A-Za-z0-9])\S.*))?$/,
  );
  if (t3Underscore) {
    const sequence = t3Underscore[1];
    const slug = t3Underscore[2];
    const id = `T3_PAIR${sequence}_${slug}`;
    const featCheck = validateAndCollectTier3Features(id);
    if (!featCheck.ok) {
      return { valid: false, declaredTier: 3, reason: featCheck.reason, rawTitle };
    }
    return {
      valid: true,
      tier: 3,
      id,
      slotKey: `T3_PAIR${sequence}`,
      feature: null,
      features: featCheck.features,
      sequence,
      slug,
      rawTitle,
    };
  }

  const t3Colon = rawTitle.match(
    /^T3_PAIR(?!0+(?:_|:))(\d{2,})(?:_(FEAT\d+(?:_FEAT\d+)*))?:\s*((?=.*[A-Za-z0-9])\S.*)$/,
  );
  if (t3Colon) {
    const sequence = t3Colon[1];
    const featGroup = t3Colon[2];
    const slug = t3Colon[3].trim();
    const id = featGroup ? `T3_PAIR${sequence}_${featGroup}` : `T3_PAIR${sequence}`;
    const featCheck = validateAndCollectTier3Features(id);
    if (!featCheck.ok) {
      return { valid: false, declaredTier: 3, reason: featCheck.reason, rawTitle };
    }
    return {
      valid: true,
      tier: 3,
      id,
      slotKey: `T3_PAIR${sequence}`,
      feature: null,
      features: featCheck.features,
      sequence,
      slug,
      rawTitle,
    };
  }

  const t4Underscore = rawTitle.match(
    /^T4_SCEN(?!0+_)(\d{2,})_([A-Za-z0-9][A-Za-z0-9_]*)(?::\s*((?=.*[A-Za-z0-9])\S.*))?$/,
  );
  if (t4Underscore) {
    const sequence = t4Underscore[1];
    const slug = t4Underscore[2];
    const id = `T4_SCEN${sequence}_${slug}`;
    return {
      valid: true,
      tier: 4,
      id,
      slotKey: `T4_SCEN${sequence}`,
      feature: null,
      features: [],
      sequence,
      slug,
      rawTitle,
    };
  }

  const t4Colon = rawTitle.match(/^T4_SCEN(?!0+:)(\d{2,}):\s*((?=.*[A-Za-z0-9])\S.*)$/);
  if (t4Colon) {
    const sequence = t4Colon[1];
    const slug = t4Colon[2].trim();
    const id = `T4_SCEN${sequence}`;
    return {
      valid: true,
      tier: 4,
      id,
      slotKey: id,
      feature: null,
      features: [],
      sequence,
      slug,
      rawTitle,
    };
  }

  return {
    valid: false,
    declaredTier,
    reason: `Test title ${JSON.stringify(rawTitle)} does not match required T1..T4 E2E test ID grammar`,
    rawTitle,
  };
}

function collectFilesRecursive(dirAbs, suffix, rootDir) {
  if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
    return [];
  }
  const files = [];

  function walk(curr) {
    const entries = fs.readdirSync(curr, { withFileTypes: true });
    entries.sort((a, b) => CODE_UNIT_COMPARE(a.name, b.name));
    for (const entry of entries) {
      const full = path.join(curr, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.push({
          absPath: full,
          relPath: path.relative(rootDir, full).split(path.sep).join('/'),
        });
      }
    }
  }

  walk(dirAbs);
  files.sort((a, b) => CODE_UNIT_COMPARE(a.relPath, b.relPath));
  return files;
}

function extractSwiftFile(source, relPath, directoryTier) {
  const stripped = stripCStyleComments(source, { language: 'swift' });
  const masked = maskSwiftStringLiterals(stripped);
  const candidates = [];
  const violations = [];

  const re = /\bfunc\s+test_([A-Za-z0-9_]+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(masked)) !== null) {
    const rawName = match[1];
    const params = match[2].trim();
    const line = lineNumberAt(masked, match.index);

    if (params.length > 0) {
      violations.push({
        type: 'invalid_swift_signature',
        suite: 'swift',
        tier: directoryTier,
        file: relPath,
        line,
        rawTitle: `test_${rawName}`,
        message: `XCTest method "func test_${rawName}(${params})" must take zero parameters`,
      });
      continue;
    }

    candidates.push({ rawTitle: rawName, line, file: relPath, suite: 'swift', directoryTier });
  }

  return { candidates, violations };
}

function extractJsFile(source, relPath, directoryTier, suite) {
  const stripped = stripCStyleComments(source, { language: 'js' });
  const len = stripped.length;
  const candidates = [];
  const violations = [];

  const templateBraceStack = [];
  const parenStack = [];
  let i = 0;
  let prevPunct = '';
  let prevWord = '';
  let lastTokenAllowsRegex = true;
  let lastWasControlKeyword = false;

  function consumeTemplateTail() {
    while (i < len) {
      const ch = stripped[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '$' && stripped[i + 1] === '{') {
        i += 2;
        templateBraceStack.push(0);
        prevPunct = '${';
        prevWord = '';
        lastTokenAllowsRegex = true;
        return;
      }
      if (ch === '`') {
        i += 1;
        prevPunct = '`';
        prevWord = '';
        lastTokenAllowsRegex = false;
        return;
      }
      i += 1;
    }
  }

  while (i < len) {
    const ch = stripped[i];

    // Skip whitespace
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // String literals in normal code (ignored for test() matching)
    if (ch === "'" || ch === '"') {
      const lit = readJsStringLiteralAt(stripped, i);
      i = lit ? lit.endIndex : i + 1;
      prevPunct = ch;
      prevWord = '';
      lastTokenAllowsRegex = false;
      continue;
    }

    // Template literals in normal code
    if (ch === '`') {
      i += 1;
      consumeTemplateTail();
      continue;
    }

    // Regex literals in normal code
    if (ch === '/' && lastTokenAllowsRegex) {
      const regexEnd = skipJsRegexAt(stripped, i);
      if (regexEnd !== -1) {
        i = regexEnd;
        prevPunct = '/';
        prevWord = '';
        lastTokenAllowsRegex = false;
        continue;
      }
    }

    // Template interpolation brace tracking
    if (templateBraceStack.length > 0) {
      if (ch === '{') {
        templateBraceStack[templateBraceStack.length - 1] += 1;
        i += 1;
        prevPunct = '{';
        prevWord = '';
        lastTokenAllowsRegex = true;
        continue;
      }
      if (ch === '}') {
        const top = templateBraceStack[templateBraceStack.length - 1];
        if (top === 0) {
          templateBraceStack.pop();
          i += 1;
          consumeTemplateTail();
          continue;
        }
        templateBraceStack[templateBraceStack.length - 1] = top - 1;
        i += 1;
        prevPunct = '}';
        prevWord = '';
        lastTokenAllowsRegex = true;
        continue;
      }
    }

    // Identifiers
    if (isIdentStart(ch)) {
      const wordStart = i;
      let wordEnd = i + 1;
      while (wordEnd < len && isIdentChar(stripped[wordEnd])) {
        wordEnd += 1;
      }
      const word = stripped.slice(wordStart, wordEnd);

      if (
        (word === 'test' || word === 'it') &&
        prevPunct !== '.' &&
        prevWord !== 'function'
      ) {
        const afterWord = skipWhitespace(stripped, wordEnd);

        // Check forbidden modifiers: test.skip(...), test.todo(...), test.only(...)
        if (stripped[afterWord] === '.') {
          const modStart = skipWhitespace(stripped, afterWord + 1);
          let modEnd = modStart;
          while (modEnd < len && isIdentChar(stripped[modEnd])) modEnd += 1;
          const modName = stripped.slice(modStart, modEnd);
          const afterMod = skipWhitespace(stripped, modEnd);
          if (
            (modName === 'skip' || modName === 'todo' || modName === 'only') &&
            stripped[afterMod] === '('
          ) {
            const argPos = skipWhitespace(stripped, afterMod + 1);
            const titleLit = readJsStringLiteralAt(stripped, argPos);
            const line = lineNumberAt(stripped, wordStart);
            violations.push({
              type: 'forbidden_test_modifier',
              suite,
              tier: directoryTier,
              file: relPath,
              line,
              rawTitle: titleLit ? titleLit.value : `${word}.${modName}(...)`,
              message: `Forbidden test modifier "${word}.${modName}(...)" detected${titleLit ? ` on ${JSON.stringify(titleLit.value)}` : ''}`,
            });
            i = titleLit ? titleLit.endIndex : afterMod + 1;
            prevPunct = '(';
            prevWord = '';
            lastTokenAllowsRegex = true;
            continue;
          }
        }

        // Active test call: test('...', ...) or it('...', ...)
        if (stripped[afterWord] === '(') {
          const argPos = skipWhitespace(stripped, afterWord + 1);
          const firstChar = stripped[argPos];
          if (firstChar === "'" || firstChar === '"' || firstChar === '`') {
            const titleLit = readJsStringLiteralAt(stripped, argPos);
            const line = lineNumberAt(stripped, wordStart);
            if (!titleLit) {
              violations.push({
                type: 'malformed_id',
                suite,
                tier: directoryTier,
                file: relPath,
                line,
                rawTitle: '<unterminated-string>',
                message: `Unterminated test title string literal in ${word}(...)`,
              });
              i = afterWord + 1;
              prevPunct = '(';
              prevWord = '';
              lastTokenAllowsRegex = true;
              continue;
            }

            if (titleLit.hasInterpolation) {
              violations.push({
                type: 'malformed_id',
                suite,
                tier: directoryTier,
                file: relPath,
                line,
                rawTitle: titleLit.value,
                message: `Dynamic template interpolation is forbidden in test title (${word}(\`...\${...}\`))`,
              });
              i = titleLit.endIndex;
              prevPunct = '`';
              prevWord = '';
              lastTokenAllowsRegex = false;
              continue;
            }

            // Verify the static string literal is the complete 1st argument (reject `'...' + suffix` etc.)
            let resumeAt = titleLit.endIndex;
            const afterTitle = skipWhitespace(stripped, titleLit.endIndex);
            const nextAfterTitle = stripped[afterTitle];
            if (nextAfterTitle !== ',' && nextAfterTitle !== ')') {
              violations.push({
                type: 'malformed_id',
                suite,
                tier: directoryTier,
                file: relPath,
                line,
                rawTitle: titleLit.value,
                message: `Dynamic or non-literal test title expression after ${JSON.stringify(titleLit.value)} in ${word}(...) (expected ',' or ')', found ${JSON.stringify(nextAfterTitle ?? '<eof>')})`,
              });
              i = titleLit.endIndex;
              prevPunct = '';
              prevWord = '';
              lastTokenAllowsRegex = false;
              lastWasControlKeyword = false;
              continue;
            }

            // Inspect optional 2nd argument `{ skip: ..., todo: ..., only: ... }`
            let forbiddenOpts = [];
            if (nextAfterTitle === ',') {
              const secondArgStart = skipWhitespace(stripped, afterTitle + 1);
              if (stripped[secondArgStart] === '{') {
                const optCheck = inspectTestOptionsObject(stripped, secondArgStart);
                forbiddenOpts = optCheck.forbidden;
                resumeAt = optCheck.endIndex;
              }
            }

            if (forbiddenOpts.length > 0) {
              violations.push({
                type: 'forbidden_test_modifier',
                suite,
                tier: directoryTier,
                file: relPath,
                line,
                rawTitle: titleLit.value,
                message: `Forbidden test options { ${forbiddenOpts.join(', ')} } detected on ${JSON.stringify(titleLit.value)}`,
              });
            } else {
              candidates.push({
                rawTitle: titleLit.value,
                line,
                file: relPath,
                suite,
                directoryTier,
              });
            }

            i = resumeAt;
            prevPunct = '';
            prevWord = '';
            lastTokenAllowsRegex = false;
            lastWasControlKeyword = false;
            continue;
          }
        }
      }

      i = wordEnd;
      const wasMemberAccess = prevPunct === '.';
      lastWasControlKeyword = !wasMemberAccess && JS_CONTROL_FLOW_KEYWORDS.has(word);
      prevPunct = '';
      prevWord = word;
      lastTokenAllowsRegex = !wasMemberAccess && JS_REGEX_KEYWORDS.has(word);
      continue;
    }

    // Numbers
    if (ch >= '0' && ch <= '9') {
      let end = i + 1;
      while (end < len && /[0-9a-fA-FxXbBoOeE_.n]/.test(stripped[end])) {
        end += 1;
      }
      i = end;
      prevPunct = '';
      prevWord = '';
      lastTokenAllowsRegex = false;
      lastWasControlKeyword = false;
      continue;
    }

    // Multi-char `++` / `--`: preserve `lastTokenAllowsRegex` so postfix `a++ / b` is division
    if ((ch === '+' && stripped[i + 1] === '+') || (ch === '-' && stripped[i + 1] === '-')) {
      prevPunct = ch + ch;
      prevWord = '';
      lastWasControlKeyword = false;
      i += 2;
      continue;
    }

    // Control-flow paren tracking: `if (cond) /regex/`
    if (ch === '(') {
      parenStack.push(lastWasControlKeyword);
      i += 1;
      prevPunct = '(';
      prevWord = '';
      lastTokenAllowsRegex = true;
      lastWasControlKeyword = false;
      continue;
    }
    if (ch === ')') {
      const wasControl = parenStack.length > 0 ? parenStack.pop() : false;
      i += 1;
      prevPunct = ')';
      prevWord = '';
      lastTokenAllowsRegex = wasControl;
      lastWasControlKeyword = false;
      continue;
    }

    // Punctuation
    i += 1;
    prevPunct = ch;
    prevWord = '';
    lastWasControlKeyword = false;
    if (JS_REGEX_PUNCT.has(ch)) {
      lastTokenAllowsRegex = true;
    } else if (ch === ']' || ch === '.') {
      lastTokenAllowsRegex = false;
    }
  }

  return { candidates, violations };
}

function createEmptyCounts() {
  const byFeature = {};
  for (const feat of FEATURES) {
    byFeature[feat] = { tier1: 0, tier2: 0, tier3Refs: 0, totalT1T2: 0 };
  }
  return {
    total: 0,
    byTier: { 1: 0, 2: 0, 3: 0, 4: 0 },
    bySuite: { swift: 0, js: 0, structural: 0 },
    byTierAndSuite: {
      1: { swift: 0, js: 0, structural: 0 },
      2: { swift: 0, js: 0, structural: 0 },
      3: { swift: 0, js: 0, structural: 0 },
      4: { swift: 0, js: 0, structural: 0 },
    },
    byFeature,
  };
}

/**
 * Discovers, validates, and catalogs all E2E tests across all 4 tiers and 3 suites.
 */
export function discoverTests(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT_DIR);
  const e2eDir = path.resolve(options.e2eDir ?? path.join(rootDir, 'e2e'));

  const tests = [];
  const violations = [];
  const duplicates = [];
  const counts = createEmptyCounts();

  const seenById = new Map();
  const seenBySlotKey = new Map();

  for (const rootSpec of DISCOVERY_ROOTS) {
    const targetAbs = path.join(e2eDir, rootSpec.relDir);
    const files = collectFilesRecursive(targetAbs, rootSpec.suffix, rootDir);

    for (const fileInfo of files) {
      const source = fs.readFileSync(fileInfo.absPath, 'utf8');
      const extracted =
        rootSpec.suite === 'swift'
          ? extractSwiftFile(source, fileInfo.relPath, rootSpec.tier)
          : extractJsFile(source, fileInfo.relPath, rootSpec.tier, rootSpec.suite);

      for (const v of extracted.violations) {
        violations.push(v);
      }

      for (const cand of extracted.candidates) {
        const parsed = parseTestId(cand.rawTitle, { suite: cand.suite });
        if (!parsed.valid) {
          violations.push({
            type: 'malformed_id',
            suite: cand.suite,
            tier: cand.directoryTier,
            file: cand.file,
            line: cand.line,
            rawTitle: cand.rawTitle,
            message: parsed.reason,
          });
          continue;
        }

        if (parsed.tier !== cand.directoryTier) {
          violations.push({
            type: 'tier_mismatch',
            suite: cand.suite,
            tier: cand.directoryTier,
            declaredTier: parsed.tier,
            directoryTier: cand.directoryTier,
            file: cand.file,
            line: cand.line,
            id: parsed.id,
            rawTitle: cand.rawTitle,
            message: `Test "${parsed.id}" declares Tier ${parsed.tier} but is located in Tier ${cand.directoryTier} directory (${cand.file}:${cand.line})`,
          });
          continue;
        }

        const entry = {
          id: parsed.id,
          slotKey: parsed.slotKey,
          tier: parsed.tier,
          suite: cand.suite,
          feature: parsed.feature,
          features: parsed.features,
          sequence: parsed.sequence,
          slug: parsed.slug,
          rawTitle: cand.rawTitle,
          file: cand.file,
          line: cand.line,
        };

        if (seenById.has(entry.id)) {
          const first = seenById.get(entry.id);
          const dupViolation = {
            type: 'duplicate_id',
            suite: entry.suite,
            tier: entry.tier,
            file: entry.file,
            line: entry.line,
            id: entry.id,
            slotKey: entry.slotKey,
            firstSuite: first.suite,
            firstTier: first.tier,
            firstFile: first.file,
            firstLine: first.line,
            message: `Duplicate test ID "${entry.id}" at ${entry.file}:${entry.line} (first seen at ${first.file}:${first.line})`,
          };
          violations.push(dupViolation);
          duplicates.push(dupViolation);
          continue;
        }

        if (seenBySlotKey.has(entry.slotKey)) {
          const first = seenBySlotKey.get(entry.slotKey);
          const dupViolation = {
            type: 'duplicate_slot_key',
            suite: entry.suite,
            tier: entry.tier,
            file: entry.file,
            line: entry.line,
            id: entry.id,
            slotKey: entry.slotKey,
            firstSuite: first.suite,
            firstTier: first.tier,
            firstFile: first.file,
            firstLine: first.line,
            message: `Duplicate slot key "${entry.slotKey}" ("${entry.id}" at ${entry.file}:${entry.line} collides with "${first.id}" at ${first.file}:${first.line})`,
          };
          violations.push(dupViolation);
          duplicates.push(dupViolation);
          continue;
        }

        seenById.set(entry.id, entry);
        seenBySlotKey.set(entry.slotKey, entry);
        tests.push(entry);

        counts.total += 1;
        counts.byTier[entry.tier] += 1;
        counts.bySuite[entry.suite] += 1;
        counts.byTierAndSuite[entry.tier][entry.suite] += 1;

        if (entry.tier === 1 && entry.feature && VALID_FEATURE_SET.has(entry.feature)) {
          counts.byFeature[entry.feature].tier1 += 1;
          counts.byFeature[entry.feature].totalT1T2 += 1;
        } else if (entry.tier === 2 && entry.feature && VALID_FEATURE_SET.has(entry.feature)) {
          counts.byFeature[entry.feature].tier2 += 1;
          counts.byFeature[entry.feature].totalT1T2 += 1;
        } else if (entry.tier === 3) {
          for (const f of entry.features) {
            if (VALID_FEATURE_SET.has(f)) {
              counts.byFeature[f].tier3Refs += 1;
            }
          }
        }
      }
    }
  }

  tests.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const sCmp = CODE_UNIT_COMPARE(a.suite, b.suite);
    if (sCmp !== 0) return sCmp;
    const idCmp = CODE_UNIT_COMPARE(a.id, b.id);
    if (idCmp !== 0) return idCmp;
    return a.line - b.line;
  });

  return {
    rootDir,
    e2eDir,
    tests,
    violations,
    duplicates,
    counts,
    integrityOk: violations.length === 0,
  };
}

export function filterTests(catalog, { tier = 'all', suite = 'all' } = {}) {
  const tierNum = tier === 'all' ? null : Number(tier);
  return catalog.tests.filter((t) => {
    if (tierNum !== null && t.tier !== tierNum) return false;
    if (suite !== 'all' && t.suite !== suite) return false;
    return true;
  });
}

export function filterScopeViolations(catalog, { tier = 'all', suite = 'all' } = {}) {
  const tierNum = tier === 'all' ? null : Number(tier);
  return catalog.violations.filter((v) => {
    const primaryMatch =
      (tierNum === null || v.tier === tierNum) &&
      (suite === 'all' || v.suite === suite);
    if (primaryMatch) return true;

    if (v.type === 'duplicate_id' || v.type === 'duplicate_slot_key') {
      const firstMatch =
        (tierNum === null || v.firstTier === tierNum) &&
        (suite === 'all' || v.firstSuite === suite);
      if (firstMatch) return true;
    }

    return false;
  });
}

/**
 * Evaluates all 38 mandatory E2E coverage & integrity checks.
 */
export function evaluateCoverage(catalog, thresholds = COVERAGE_THRESHOLDS) {
  const checks = [];

  checks.push({
    key: 'catalog.integrity',
    label: 'Catalog integrity (0 duplicates, malformed IDs, tier mismatches, invalid signatures, forbidden modifiers)',
    actual: catalog.violations.length,
    required: 0,
    comparator: '==',
    passed: catalog.violations.length === 0,
  });

  checks.push({
    key: 'tier1.total',
    label: 'Tier 1 total tests',
    actual: catalog.counts.byTier[1],
    required: thresholds.tier1Total,
    comparator: '>=',
    passed: catalog.counts.byTier[1] >= thresholds.tier1Total,
  });

  for (const feat of FEATURES) {
    const actual = catalog.counts.byFeature[feat]?.tier1 ?? 0;
    checks.push({
      key: `tier1.${feat}`,
      label: `Tier 1 ${feat}`,
      actual,
      required: thresholds.tier1PerFeature,
      comparator: '>=',
      passed: actual >= thresholds.tier1PerFeature,
    });
  }

  checks.push({
    key: 'tier2.total',
    label: 'Tier 2 total tests',
    actual: catalog.counts.byTier[2],
    required: thresholds.tier2Total,
    comparator: '>=',
    passed: catalog.counts.byTier[2] >= thresholds.tier2Total,
  });

  for (const feat of FEATURES) {
    const actual = catalog.counts.byFeature[feat]?.tier2 ?? 0;
    checks.push({
      key: `tier2.${feat}`,
      label: `Tier 2 ${feat}`,
      actual,
      required: thresholds.tier2PerFeature,
      comparator: '>=',
      passed: actual >= thresholds.tier2PerFeature,
    });
  }

  checks.push({
    key: 'tier3.total',
    label: 'Tier 3 total tests',
    actual: catalog.counts.byTier[3],
    required: thresholds.tier3Total,
    comparator: '>=',
    passed: catalog.counts.byTier[3] >= thresholds.tier3Total,
  });

  checks.push({
    key: 'tier4.total',
    label: 'Tier 4 total tests',
    actual: catalog.counts.byTier[4],
    required: thresholds.tier4Total,
    comparator: '>=',
    passed: catalog.counts.byTier[4] >= thresholds.tier4Total,
  });

  checks.push({
    key: 'grand.total',
    label: 'Grand total tests (Tiers 1-4)',
    actual: catalog.counts.total,
    required: thresholds.grandTotal,
    comparator: '>=',
    passed: catalog.counts.total >= thresholds.grandTotal,
  });

  const failures = checks.filter((c) => !c.passed);
  return {
    passed: failures.length === 0,
    integrityOk: catalog.integrityOk,
    checks,
    failures,
  };
}

function padRight(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padLeft(str, width) {
  const s = String(str);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

export function formatCatalogReport(catalog, options = {}) {
  const tier = options.tier ?? 'all';
  const suite = options.suite ?? 'all';
  const listTests = options.listTests ?? true;
  const checkCoverage = options.checkCoverage ?? false;
  const coverage = options.coverage ?? evaluateCoverage(catalog);
  const filtered = filterTests(catalog, { tier, suite });

  const lines = [];
  const hr = '='.repeat(82);
  const subHr = '-'.repeat(82);

  lines.push(hr);
  lines.push('E2E Test Catalog Report');
  lines.push(
    `Scope: tier=${tier} suite=${suite} | Discovered: ${catalog.counts.total} total (${filtered.length} in scope) | Duplicates: ${catalog.duplicates.length} | Integrity: ${catalog.integrityOk ? 'OK' : `FAILED (${catalog.violations.length} violations)`}`,
  );
  lines.push(hr);

  // Per-Tier / Per-Suite Table
  lines.push('Per-Tier / Per-Suite Summary:');
  lines.push(
    `${padRight('Tier', 10)} ${padLeft('Swift', 7)} ${padLeft('JS', 7)} ${padLeft('Structural', 12)} ${padLeft('Total', 7)} ${padLeft('Min Req', 9)}  Status`,
  );
  lines.push(subHr);

  const tierMins = {
    1: COVERAGE_THRESHOLDS.tier1Total,
    2: COVERAGE_THRESHOLDS.tier2Total,
    3: COVERAGE_THRESHOLDS.tier3Total,
    4: COVERAGE_THRESHOLDS.tier4Total,
  };

  for (const t of TIERS) {
    const row = catalog.counts.byTierAndSuite[t];
    const total = catalog.counts.byTier[t];
    const minReq = tierMins[t];
    const status = total >= minReq ? 'MET' : 'UNMET';
    lines.push(
      `${padRight(`Tier ${t}`, 10)} ${padLeft(row.swift, 7)} ${padLeft(row.js, 7)} ${padLeft(row.structural, 12)} ${padLeft(total, 7)} ${padLeft(minReq, 9)}  ${status}`,
    );
  }
  lines.push(subHr);
  lines.push(
    `${padRight('Total', 10)} ${padLeft(catalog.counts.bySuite.swift, 7)} ${padLeft(catalog.counts.bySuite.js, 7)} ${padLeft(catalog.counts.bySuite.structural, 12)} ${padLeft(catalog.counts.total, 7)} ${padLeft(COVERAGE_THRESHOLDS.grandTotal, 9)}  ${catalog.counts.total >= COVERAGE_THRESHOLDS.grandTotal ? 'MET' : 'UNMET'}`,
  );
  lines.push('');

  // Per-Feature Table (FEAT-01..FEAT-16)
  lines.push('Per-Feature Coverage Matrix (FEAT-01..FEAT-16):');
  lines.push(
    `${padRight('Feature', 10)} ${padLeft('Tier 1 (min 5)', 16)} ${padLeft('Tier 2 (min 5)', 16)} ${padLeft('T3 Refs', 10)}  Status`,
  );
  lines.push(subHr);
  for (const feat of FEATURES) {
    const fc = catalog.counts.byFeature[feat];
    const met =
      fc.tier1 >= COVERAGE_THRESHOLDS.tier1PerFeature &&
      fc.tier2 >= COVERAGE_THRESHOLDS.tier2PerFeature;
    lines.push(
      `${padRight(feat, 10)} ${padLeft(`${fc.tier1}/${COVERAGE_THRESHOLDS.tier1PerFeature}`, 16)} ${padLeft(`${fc.tier2}/${COVERAGE_THRESHOLDS.tier2PerFeature}`, 16)} ${padLeft(fc.tier3Refs, 10)}  ${met ? 'MET' : 'UNMET'}`,
    );
  }
  lines.push('');

  // Discovered Tests List
  if (listTests) {
    lines.push(`Discovered Tests (${filtered.length}):`);
    if (filtered.length === 0) {
      lines.push('  (none)');
    } else {
      for (const entry of filtered) {
        lines.push(`  [T${entry.tier}][${entry.suite}] ${entry.id} (${entry.file}:${entry.line})`);
      }
    }
    lines.push('');
  }

  // Catalog Integrity Violations
  if (catalog.violations.length > 0) {
    lines.push(`Catalog Integrity Violations (${catalog.violations.length}):`);
    for (const v of catalog.violations) {
      lines.push(`  - [${v.type}] ${v.file}:${v.line} — ${v.message}`);
    }
    lines.push('');
  }

  // Coverage Gate Summary
  if (checkCoverage) {
    if (coverage.passed) {
      lines.push(`Coverage Check: PASS (all ${coverage.checks.length} requirements satisfied)`);
    } else {
      lines.push(`Coverage Check: FAIL (${coverage.failures.length} unmet requirements)`);
      for (const f of coverage.failures) {
        lines.push(
          `  - ${f.label}: actual ${f.actual}, required ${f.comparator} ${f.required}`,
        );
      }
    }
    lines.push(hr);
  }

  return lines.join('\n');
}

/**
 * Parses Linux `swift-corelibs-xctest`, macOS Apple `XCTest`, and Swift Testing
 * output logs with ANSI stripping and zero double-counting.
 */
export function parseSwiftTestOutput(logText) {
  if (typeof logText !== 'string') {
    throw new TypeError('parseSwiftTestOutput expects a string');
  }

  const clean = logText.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');

  let xctestPassed = 0;
  let caseFailed = 0;
  let caseSkipped = 0;

  const xctestCaseRe = /Test Case\s+'[^']+'\s+(passed|failed|skipped)\b/gi;
  let m;
  while ((m = xctestCaseRe.exec(clean)) !== null) {
    const status = m[1].toLowerCase();
    if (status === 'passed') xctestPassed += 1;
    else if (status === 'failed') caseFailed += 1;
    else if (status === 'skipped') caseSkipped += 1;
  }

  // Swift Testing per-case markers (line-by-line, strictly O(N) linear, using an
  // even-quote-parity sticky-regex scanner for `recorded [a known|an] issue` and
  // `skipped:` prefixes so raw unescaped `"` in display names, spaces in Swift
  // filenames, and spoofed pass/fail/skip payloads can never misclassify events).
  const swiftTestingRunFailRe = /^\s*✘\s+Test\s+run(?:\s+|$)/;
  const swiftTestingRunPassRe =
    /^\s*[✔━]\s+Test\s+run\s+with\s+(\d+)\s+tests?(?:\s+in\s+\d+\s+suites?)?\s+passed(?:\s+after\s+\d+(?:\.\d+)?\s+seconds?(?:\s+with\s+\d+\s+(?:known\s+issues?|issues?)(?:\s*\(including\s+\d+\s+known\s+issues?\))?)?\.?)?\s*$/;
  const swiftTestingEventHeaderRe = /^\s*([✔✘━◇⊘])\s+(?:Test|Suite)\s+(?!run(?:\s+|$))/;
  const stickyRecordedIssueRe =
    /(?:with\s+\d+\s+(?:arguments?|test\s+cases?)\s+)?recorded\s+an\s+issue(?:([ \t]+at[ \t]+)|([ \t]+with[ \t]+)|(:)|([ \t]*$))/y;
  const stickyRecordedKnownRe =
    /(?:with\s+\d+\s+(?:arguments?|test\s+cases?)\s+)?recorded\s+a\s+known\s+issue(?:([ \t]+at[ \t]+)|([ \t]+with[ \t]+)|(:)|([ \t]*$))/y;
  const stickySkippedRe =
    /(?:with\s+\d+\s+(?:arguments?|test\s+cases?)\s+)?skipped(?::|\.?[ \t]*$)/iy;
  const swiftTestingStartedRe =
    /^\s*◇\s+(?:Test|Suite)\s+(?!run(?:\s+|$))(?:"[^\r\n]*"|[^\s"]\S*)(?:\s+passing\s+\d+\s+arguments?)?\s+started\.?\s*$/;
  const swiftTestingPassRe =
    /^\s*[✔━]\s+Test\s+(?!run(?:\s+|$))(?:"[^\r\n]*"|[^\s"]\S*)(?:\s+with\s+\d+\s+(?:arguments?|test\s+cases?))?\s+passed(?:\s+after\s+\d+(?:\.\d+)?\s+seconds?(?:\s+with\s+\d+\s+(?:known\s+issues?|issues?)(?:\s*\(including\s+\d+\s+known\s+issues?\))?)?\.?)?\s*$/;
  const swiftTestingFailRe =
    /^\s*✘\s+Test\s+(?!run(?:\s+|$))(?:"[^\r\n]*"|[^\s"]\S*)(?:\s+with\s+\d+\s+(?:arguments?|test\s+cases?))?\s+failed(?:\s+after\s+\d+(?:\.\d+)?\s+seconds?(?:\s+with\s+\d+\s+(?:known\s+issues?|issues?)(?:\s*\(including\s+\d+\s+known\s+issues?\))?)?\.?)?\s*$/;
  const swiftTestingSkipRe =
    /^\s*(?:[➜◇⊘]|->)\s+(?:Test|Suite)\s+(?!run(?:\s+|$))(?:"[^\r\n]*"|[^\s"]\S*)(?:\s+with\s+\d+\s+(?:arguments?|test\s+cases?))?\s+skipped(?::.*|\.?)\s*$/i;
  const swiftTestingIssueFailRe =
    /^\s*✘\s+(?:Test|Suite)\s+(?!run(?:\s+|$))(?:"[^\r\n]*"|[^\s"]\S*)(?:\s+with\s+\d+\s+(?:arguments?|test\s+cases?))?\s+recorded\s+an\s+issue(?:\s+(?:with|at)\b|:|\s*$)/;

  const findLastLocInfo = (str) => {
    let trimmedEnd = str.length;
    while (trimmedEnd > 0 && (str[trimmedEnd - 1] === ' ' || str[trimmedEnd - 1] === '\t')) {
      trimmedEnd -= 1;
    }
    const locRe = /:\d+:\d+/g;
    let lastLocColonIdx = -1;
    let locMatch;
    while ((locMatch = locRe.exec(str)) !== null) {
      const end = locMatch.index + locMatch[0].length;
      if (end === trimmedEnd || str[end] === ':') {
        lastLocColonIdx = locMatch.index;
      }
    }
    if (lastLocColonIdx === -1) {
      return { lastLocColonIdx: -1, lastAtBeforeLocIdx: -1 };
    }
    const atRe = /[ \t]at[ \t]/g;
    let lastAtBeforeLocIdx = -1;
    let atMatch;
    while ((atMatch = atRe.exec(str)) !== null) {
      let fileStart = atMatch.index + 4;
      if (fileStart >= lastLocColonIdx) {
        break;
      }
      while (fileStart < lastLocColonIdx && (str[fileStart] === ' ' || str[fileStart] === '\t')) {
        fileStart += 1;
      }
      if (fileStart < lastLocColonIdx) {
        lastAtBeforeLocIdx = atMatch.index;
      }
    }
    return { lastLocColonIdx, lastAtBeforeLocIdx };
  };

  let swiftTestingPassed = 0;
  let swiftTestingFailed = 0;
  let swiftTestingSkipped = 0;
  let runFailBanners = 0;
  let hasSwiftTestingRunPassBanner = false;
  let swiftTestingRunPassedTotal = 0;
  let hasSwiftTestingIssueFail = false;

  const lines = clean.split(/\r?\n/);
  for (const line of lines) {
    if (swiftTestingRunFailRe.test(line)) {
      runFailBanners += 1;
      continue;
    }
    const runPassMatch = swiftTestingRunPassRe.exec(line);
    if (runPassMatch) {
      hasSwiftTestingRunPassBanner = true;
      swiftTestingRunPassedTotal = Number.parseInt(runPassMatch[1], 10);
      continue;
    }

    const headerMatch = swiftTestingEventHeaderRe.exec(line);
    if (headerMatch) {
      const glyph = headerMatch[1];
      if (glyph === '✘' || glyph === '━' || glyph === '◇' || glyph === '⊘') {
        const rest = line.slice(headerMatch[0].length);
        const verbRe =
          glyph === '✘'
            ? stickyRecordedIssueRe
            : glyph === '━'
              ? stickyRecordedKnownRe
              : stickySkippedRe;
        let locInfo = null;
        let prefixMatched = false;

        const testAtPos = (pos) => {
          verbRe.lastIndex = pos;
          const vm = verbRe.exec(rest);
          if (!vm) return false;
          if (glyph === '◇' || glyph === '⊘') {
            return true;
          }
          if (vm[3] !== undefined || vm[4] !== undefined) {
            return true;
          }
          if (locInfo === null) {
            locInfo = findLastLocInfo(rest);
          }
          const afterVerb = verbRe.lastIndex;
          if (vm[1] !== undefined) {
            return locInfo.lastLocColonIdx > afterVerb;
          }
          if (vm[2] !== undefined) {
            return locInfo.lastAtBeforeLocIdx > afterVerb;
          }
          return false;
        };

        if (rest.length > 0 && rest[0] !== '"') {
          let idx = 0;
          while (idx < rest.length && rest[idx] !== ' ' && rest[idx] !== '\t') {
            idx += 1;
          }
          if (idx < rest.length) {
            while (idx < rest.length && (rest[idx] === ' ' || rest[idx] === '\t')) {
              idx += 1;
            }
            if (idx < rest.length && testAtPos(idx)) {
              prefixMatched = true;
            }
          }
        } else if (rest.length > 0 && rest[0] === '"') {
          let quoteCount = 1;
          for (let i = 1; i < rest.length; i += 1) {
            if (rest.charCodeAt(i) === 34) {
              quoteCount += 1;
              if (
                quoteCount % 2 === 0 &&
                (i + 1 === rest.length || rest[i + 1] === ' ' || rest[i + 1] === '\t')
              ) {
                let pos = i + 1;
                while (pos < rest.length && (rest[pos] === ' ' || rest[pos] === '\t')) {
                  pos += 1;
                }
                if (pos > i + 1 && pos < rest.length && testAtPos(pos)) {
                  prefixMatched = true;
                  break;
                }
              }
            }
          }
        }

        if (prefixMatched) {
          if (glyph === '✘') {
            hasSwiftTestingIssueFail = true;
          } else if (glyph === '◇' || glyph === '⊘') {
            swiftTestingSkipped += 1;
            caseSkipped += 1;
          }
          continue;
        }
      }
    }

    if (swiftTestingStartedRe.test(line)) {
      continue;
    }
    if (swiftTestingPassRe.test(line)) {
      swiftTestingPassed += 1;
    } else if (swiftTestingFailRe.test(line)) {
      swiftTestingFailed += 1;
      caseFailed += 1;
    } else if (swiftTestingSkipRe.test(line)) {
      swiftTestingSkipped += 1;
      caseSkipped += 1;
    } else if (swiftTestingIssueFailRe.test(line)) {
      hasSwiftTestingIssueFail = true;
    }
  }

  // Cap Swift Testing pass count to authoritative `Test run with N test(s) ... passed`
  // banner total on clean passing runs so multiline `withKnownIssue` Error.description
  // payloads cannot inflate `--min-tests`.
  if (
    hasSwiftTestingRunPassBanner &&
    swiftTestingFailed === 0 &&
    swiftTestingSkipped === 0 &&
    runFailBanners === 0 &&
    !hasSwiftTestingIssueFail
  ) {
    swiftTestingPassed = Math.min(swiftTestingPassed, swiftTestingRunPassedTotal);
  }
  const casePassed = xctestPassed + swiftTestingPassed;

  // Track Swift Testing failure banners & truncated issue-only logs without inflating normal multi-issue failures
  const bannerFailed =
    caseFailed === 0
      ? Math.max(runFailBanners, hasSwiftTestingIssueFail ? 1 : 0)
      : runFailBanners;

  // Aggregate XCTest `Executed ...` summaries by hierarchy level (`root` / `bundle` / `leaf`)
  // while NEVER allowing a later suite's 0 failures/skips to mask an earlier non-zero suite.
  const suiteHeaderRe = /Test Suite\s+'([^']+)'\s+(passed|failed)\b/i;
  const summaryRe =
    /Executed\s+(\d+)\s+tests?,\s+with\s+(?:(\d+)\s+tests?\s+skipped\s+and\s+)?(\d+)\s+failures?/i;

  let hasExecutedSummary = false;
  let pendingSuiteKind = null;

  let maxSummaryExecuted = 0;
  let maxSummaryFailed = 0;
  let maxSummarySkipped = 0;

  let rootCount = 0;
  let rootExecuted = 0;
  let rootFailed = 0;
  let rootSkipped = 0;

  let bundleCount = 0;
  let bundleExecuted = 0;
  let bundleFailed = 0;
  let bundleSkipped = 0;

  let leafCount = 0;
  let leafExecuted = 0;
  let leafFailed = 0;
  let leafSkipped = 0;

  for (const line of lines) {
    const suiteMatch = line.match(suiteHeaderRe);
    if (suiteMatch) {
      const suiteName = suiteMatch[1].trim().toLowerCase();
      if (suiteName === 'all tests' || suiteName === 'selected tests') {
        pendingSuiteKind = 'root';
      } else if (suiteName.endsWith('.xctest')) {
        pendingSuiteKind = 'bundle';
      } else {
        pendingSuiteKind = 'leaf';
      }
    }

    const sumMatch = line.match(summaryRe);
    if (sumMatch) {
      hasExecutedSummary = true;
      const exec = Number.parseInt(sumMatch[1], 10);
      const skip = sumMatch[2] !== undefined ? Number.parseInt(sumMatch[2], 10) : 0;
      const fail = Number.parseInt(sumMatch[3], 10);

      maxSummaryExecuted = Math.max(maxSummaryExecuted, exec);
      maxSummaryFailed = Math.max(maxSummaryFailed, fail);
      maxSummarySkipped = Math.max(maxSummarySkipped, skip);

      const kind = pendingSuiteKind ?? 'leaf';
      if (kind === 'root') {
        rootCount += 1;
        rootExecuted += exec;
        rootFailed += fail;
        rootSkipped += skip;
      } else if (kind === 'bundle') {
        bundleCount += 1;
        bundleExecuted += exec;
        bundleFailed += fail;
        bundleSkipped += skip;
      } else {
        leafCount += 1;
        leafExecuted += exec;
        leafFailed += fail;
        leafSkipped += skip;
      }
      pendingSuiteKind = null;
    }
  }

  let summaryExecuted = maxSummaryExecuted;
  if (rootCount > 0) {
    summaryExecuted = Math.max(rootExecuted, maxSummaryExecuted);
  } else if (bundleCount > 0) {
    summaryExecuted = Math.max(bundleExecuted, maxSummaryExecuted);
  } else if (leafCount > 0) {
    summaryExecuted = Math.max(leafExecuted, maxSummaryExecuted);
  }

  const summaryFailed = Math.max(
    maxSummaryFailed,
    rootFailed,
    bundleFailed,
    leafFailed,
    bannerFailed,
  );
  const summarySkipped = Math.max(maxSummarySkipped, rootSkipped, bundleSkipped, leafSkipped);

  const totalCases = casePassed + caseFailed + caseSkipped;
  if (totalCases > 0) {
    const failed = Math.max(caseFailed, summaryFailed);
    const skipped = Math.max(caseSkipped, summarySkipped);
    const executed = Math.max(totalCases, summaryExecuted, casePassed + failed + skipped);
    return {
      executed,
      passed: casePassed,
      failed,
      skipped,
      hasExecutedSummary,
    };
  }

  if (hasExecutedSummary) {
    const passed = Math.max(0, summaryExecuted - summaryFailed - summarySkipped);
    return {
      executed: summaryExecuted,
      passed,
      failed: summaryFailed,
      skipped: summarySkipped,
      hasExecutedSummary: true,
    };
  }

  return {
    executed: bannerFailed,
    passed: 0,
    failed: bannerFailed,
    skipped: 0,
    hasExecutedSummary: false,
  };
}

/**
 * Parses Node v22 TAP reporter root-level summary counters and detects
 * synthetic empty-file TAP passes (`ok <N> - <path>.test.mjs`) that Node v22
 * emits when a `.test.mjs` file executes 0 runtime tests.
 */
export function parseNodeTapOutput(tapText) {
  if (typeof tapText !== 'string') {
    throw new TypeError('parseNodeTapOutput expects a string');
  }

  const fields = {
    tests: null,
    suites: null,
    pass: null,
    fail: null,
    cancelled: null,
    skipped: null,
    todo: null,
  };

  const lines = tapText.split(/\r?\n/);
  let vacuousFiles = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];

    const summaryMatch = rawLine.match(
      /^#\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/,
    );
    if (summaryMatch) {
      fields[summaryMatch[1]] = Number.parseInt(summaryMatch[2], 10);
      continue;
    }

    // Detect unindented top-level passing TAP entries synthesized by Node v22 when a
    // `.test.mjs` file registers 0 runtime tests. Excludes genuine `T[1-4]_...` test
    // titles (unless formatted as a relative path containing `/` or `\` before any `:`),
    // indented child subtests, diagnostic comments (`# ...`), and `type: 'suite'` entries.
    const okMatch = rawLine.match(/^ok\s+\d+\s+-\s+(.+?)\s*$/);
    if (okMatch) {
      const desc = okMatch[1];
      if (!desc.endsWith('.test.mjs')) {
        continue;
      }

      if (/^T[1-4]_/.test(desc)) {
        const colonIdx = desc.indexOf(':');
        const prefixBeforeColon = colonIdx === -1 ? desc : desc.slice(0, colonIdx);
        const looksLikeRelativePath =
          prefixBeforeColon.includes('/') || prefixBeforeColon.includes('\\');
        if (!looksLikeRelativePath) {
          continue;
        }
      }

      // Skip entries immediately preceded by an indented child subtest plan (`    1..K`).
      let prevIdx = i - 1;
      while (prevIdx >= 0 && lines[prevIdx].trim() === '') {
        prevIdx -= 1;
      }
      if (prevIdx >= 0 && /^\s+1\.\.\d+\s*$/.test(lines[prevIdx])) {
        continue;
      }

      // Inspect optional YAML block (`  ---` ... `  ...`); `type: 'suite'` entries represent
      // `describe(...)` suites and never inflate `# tests` or `# pass`.
      let isSuiteEntry = false;
      if (i + 1 < lines.length && /^\s+---\s*$/.test(lines[i + 1])) {
        let j = i + 2;
        while (j < lines.length && !/^\s+\.\.\.\s*$/.test(lines[j])) {
          if (lines[j].length > 0 && !/^\s/.test(lines[j])) {
            break;
          }
          if (/^\s+type:\s*['"]?suite['"]?\s*$/.test(lines[j])) {
            isSuiteEntry = true;
          }
          j += 1;
        }
      }

      if (!isSuiteEntry) {
        vacuousFiles += 1;
      }
    }
  }

  const valid = Object.values(fields).every((v) => v !== null);
  const tests = Math.max(0, (fields.tests ?? 0) - vacuousFiles);
  const pass = Math.max(0, (fields.pass ?? 0) - vacuousFiles);

  return {
    valid,
    tests,
    suites: fields.suites ?? 0,
    pass,
    fail: fields.fail ?? 0,
    cancelled: fields.cancelled ?? 0,
    skipped: fields.skipped ?? 0,
    todo: fields.todo ?? 0,
    vacuousFiles,
  };
}

function validateTierValue(val) {
  return val === '1' || val === '2' || val === '3' || val === '4' || val === 'all';
}

function validateSuiteValue(val) {
  return val === 'swift' || val === 'js' || val === 'structural' || val === 'all';
}

function usageText() {
  return [
    'Usage: node e2e/lib/test-catalog.mjs [options]',
    '',
    'Options:',
    '  --list                     List discovered E2E tests and per-tier/feature tables',
    '  --check-coverage           Enforce all 38 global coverage & integrity thresholds',
    '  --tier <1|2|3|4|all>       Filter scope by tier (default: all)',
    '  --suite <swift|js|structural|all>  Filter scope by suite (default: all)',
    '  --root <dir>               Override repository root directory',
    '  --json                     Emit machine-readable catalog JSON',
    '  --verify-swift-log <file>  Post-flight verify XCTest output log (requires --min-tests)',
    '  --verify-tap <file>        Post-flight verify Node TAP output file (requires --min-tests)',
    '  --min-tests <N>            Minimum expected passing tests for post-flight verification',
    '  -h, --help                 Show this help message',
  ].join('\n');
}

export function runCli(argv = process.argv.slice(2)) {
  let list = false;
  let checkCoverage = false;
  let jsonMode = false;
  let showHelp = false;
  let tier = 'all';
  let suite = 'all';
  let rootDir = DEFAULT_ROOT_DIR;
  let verifySwiftLog = null;
  let verifyTap = null;
  let minTests = null;

  function failArg(msg) {
    process.stderr.write(`Error: ${msg}\n\n${usageText()}\n`);
    return 2;
  }

  function consumeValue(flag, eqVal, indexRef) {
    if (eqVal !== null) {
      if (eqVal.length === 0) {
        return { error: `Flag ${flag} requires a non-empty value` };
      }
      return { value: eqVal };
    }
    if (indexRef.i + 1 >= argv.length) {
      return { error: `Flag ${flag} requires a value` };
    }
    const nextVal = argv[indexRef.i + 1];
    if (nextVal.length === 0) {
      return { error: `Flag ${flag} requires a non-empty value` };
    }
    indexRef.i += 1;
    return { value: nextVal };
  }

  const indexRef = { i: 0 };
  for (; indexRef.i < argv.length; indexRef.i += 1) {
    const raw = argv[indexRef.i];
    let flag = raw;
    let eqVal = null;
    const eqPos = raw.indexOf('=');
    if (eqPos !== -1) {
      flag = raw.slice(0, eqPos);
      eqVal = raw.slice(eqPos + 1);
    }

    switch (flag) {
      case '--list':
        if (eqVal !== null) return failArg(`Boolean flag ${flag} does not accept a value`);
        list = true;
        break;
      case '--check-coverage':
        if (eqVal !== null) return failArg(`Boolean flag ${flag} does not accept a value`);
        checkCoverage = true;
        break;
      case '--json':
        if (eqVal !== null) return failArg(`Boolean flag ${flag} does not accept a value`);
        jsonMode = true;
        break;
      case '-h':
      case '--help':
        if (eqVal !== null) return failArg(`Boolean flag ${flag} does not accept a value`);
        showHelp = true;
        break;
      case '--tier': {
        const res = consumeValue(flag, eqVal, indexRef);
        if (res.error) return failArg(res.error);
        if (!validateTierValue(res.value)) {
          return failArg(`Invalid --tier value ${JSON.stringify(res.value)} (expected 1|2|3|4|all)`);
        }
        tier = res.value;
        break;
      }
      case '--suite': {
        const res = consumeValue(flag, eqVal, indexRef);
        if (res.error) return failArg(res.error);
        if (!validateSuiteValue(res.value)) {
          return failArg(
            `Invalid --suite value ${JSON.stringify(res.value)} (expected swift|js|structural|all)`,
          );
        }
        suite = res.value;
        break;
      }
      case '--root': {
        const res = consumeValue(flag, eqVal, indexRef);
        if (res.error) return failArg(res.error);
        rootDir = path.resolve(res.value);
        break;
      }
      case '--verify-swift-log': {
        const res = consumeValue(flag, eqVal, indexRef);
        if (res.error) return failArg(res.error);
        verifySwiftLog = res.value;
        break;
      }
      case '--verify-tap': {
        const res = consumeValue(flag, eqVal, indexRef);
        if (res.error) return failArg(res.error);
        verifyTap = res.value;
        break;
      }
      case '--min-tests': {
        const res = consumeValue(flag, eqVal, indexRef);
        if (res.error) return failArg(res.error);
        if (!/^\d+$/.test(res.value)) {
          return failArg(`Invalid --min-tests value ${JSON.stringify(res.value)} (expected non-negative integer)`);
        }
        minTests = Number.parseInt(res.value, 10);
        break;
      }
      default:
        return failArg(`Unknown argument: ${JSON.stringify(raw)}`);
    }
  }

  if (showHelp) {
    process.stdout.write(`${usageText()}\n`);
    return 0;
  }

  if (verifySwiftLog !== null && verifyTap !== null) {
    return failArg('Cannot combine --verify-swift-log and --verify-tap');
  }

  // Post-flight Swift log verification
  if (verifySwiftLog !== null) {
    const requiredMin = Math.max(1, minTests ?? 1);
    if (!fs.existsSync(verifySwiftLog)) {
      process.stderr.write(`Swift log file not found: ${verifySwiftLog}\n`);
      return 1;
    }
    const parsed = parseSwiftTestOutput(fs.readFileSync(verifySwiftLog, 'utf8'));
    const reasons = [];
    if (!parsed.hasExecutedSummary && parsed.executed === 0) {
      reasons.push('no XCTest execution summary or test case results found in log');
    }
    if (parsed.failed > 0) {
      reasons.push(`${parsed.failed} Swift test failure(s)`);
    }
    if (parsed.skipped > 0) {
      reasons.push(`${parsed.skipped} Swift test(s) skipped (skipped-as-pass forbidden)`);
    }
    if (parsed.passed < 1 || parsed.passed < requiredMin) {
      reasons.push(`only ${parsed.passed} Swift test(s) passed, expected at least ${requiredMin}`);
    }

    const summary = `executed=${parsed.executed} passed=${parsed.passed} failed=${parsed.failed} skipped=${parsed.skipped}`;
    if (reasons.length > 0) {
      process.stderr.write(`Swift post-flight check failed (${summary}): ${reasons.join('; ')}\n`);
      return 1;
    }
    process.stdout.write(`${summary}\n`);
    return 0;
  }

  // Post-flight Node TAP verification
  if (verifyTap !== null) {
    const requiredMin = Math.max(1, minTests ?? 1);
    if (!fs.existsSync(verifyTap)) {
      process.stderr.write(`TAP output file not found: ${verifyTap}\n`);
      return 1;
    }
    const parsed = parseNodeTapOutput(fs.readFileSync(verifyTap, 'utf8'));
    const reasons = [];
    if (!parsed.valid) {
      reasons.push('incomplete or missing Node TAP summary footer');
    }
    if (parsed.vacuousFiles > 0) {
      reasons.push(
        `${parsed.vacuousFiles} .test.mjs file(s) executed 0 runtime tests (vacuous file-as-test pass forbidden)`,
      );
    }
    if (parsed.fail > 0) {
      reasons.push(`${parsed.fail} failed test(s)`);
    }
    if (parsed.cancelled > 0) {
      reasons.push(`${parsed.cancelled} cancelled test(s)`);
    }
    if (parsed.skipped > 0) {
      reasons.push(`${parsed.skipped} skipped test(s) (skipped-as-pass forbidden)`);
    }
    if (parsed.todo > 0) {
      reasons.push(`${parsed.todo} todo test(s) (todo-as-pass forbidden)`);
    }
    if (parsed.tests < 1 || parsed.tests < requiredMin) {
      reasons.push(`only ${parsed.tests} test(s) executed, expected at least ${requiredMin}`);
    }
    if (parsed.pass < 1 || parsed.pass < requiredMin) {
      reasons.push(`only ${parsed.pass} test(s) passed, expected at least ${requiredMin}`);
    }

    const summary = `executed=${parsed.tests} passed=${parsed.pass} failed=${parsed.fail} skipped=${parsed.skipped} todo=${parsed.todo} cancelled=${parsed.cancelled} vacuousFiles=${parsed.vacuousFiles}`;
    if (reasons.length > 0) {
      process.stderr.write(`TAP post-flight check failed (${summary}): ${reasons.join('; ')}\n`);
      return 1;
    }
    process.stdout.write(`${summary}\n`);
    return 0;
  }

  const catalog = discoverTests({ rootDir });
  const coverage = evaluateCoverage(catalog);

  if (jsonMode) {
    const filtered = filterTests(catalog, { tier, suite });
    const scopeViolations = filterScopeViolations(catalog, { tier, suite });
    const payload = {
      tier,
      suite,
      integrityOk: catalog.integrityOk,
      filteredCount: filtered.length,
      scopeIntegrityOk: scopeViolations.length === 0,
      scopeViolationSummary: scopeViolations
        .slice(0, 3)
        .map((v) => `[${v.type}] ${v.file}:${v.line}: ${v.message}`)
        .join(' | '),
      scopeViolations,
      counts: catalog.counts,
      violations: catalog.violations,
      duplicates: catalog.duplicates,
      tests: filtered,
      ...(checkCoverage ? { coverage } : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (checkCoverage) {
      return coverage.passed ? 0 : 1;
    }
    return catalog.integrityOk ? 0 : 1;
  }

  // Default behavior if neither --list nor --check-coverage was specified: list
  const effectiveList = list || !checkCoverage;
  const report = formatCatalogReport(catalog, {
    tier,
    suite,
    listTests: effectiveList,
    checkCoverage,
    coverage,
  });
  process.stdout.write(`${report}\n`);

  if (checkCoverage) {
    return coverage.passed ? 0 : 1;
  }
  return catalog.integrityOk ? 0 : 1;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

if (isMainModule()) {
  const exitCode = runCli(process.argv.slice(2));
  process.exit(exitCode);
}
