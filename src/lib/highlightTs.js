// Tiny TypeScript/JavaScript syntax highlighter.
//
// Returns an array of {text, kind} tokens which the caller renders as
// styled spans. Kept in-house so we don't ship a 200 KB Prism / Shiki bundle
// just to colour a few spec files — the only language we care about here is
// TS-ish Playwright code.
//
// The tokenizer is single-pass + regex-based, so it's fast and good enough
// for files up to a few thousand lines. It does not produce an AST and will
// not handle pathological inputs (e.g. unterminated template strings) well —
// for those it falls back to rendering the rest of the file as plain text.

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'extends', 'implements',
  'interface', 'type', 'enum', 'import', 'from', 'export', 'default',
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'new', 'this', 'super', 'await', 'async', 'yield', 'try',
  'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'as',
  'true', 'false', 'null', 'undefined', 'void', 'public', 'private',
  'protected', 'readonly', 'static', 'abstract', 'declare', 'namespace',
  'module', 'is',
]);

const BUILTINS = new Set([
  'string', 'number', 'boolean', 'any', 'unknown', 'never', 'object',
  'Array', 'Promise', 'Map', 'Set', 'Date', 'RegExp', 'Error', 'JSON',
  'Math', 'console', 'process', 'globalThis',
  // Playwright-flavoured
  'test', 'expect', 'page', 'browser', 'context', 'locator', 'beforeAll',
  'afterAll', 'beforeEach', 'afterEach', 'describe',
]);

// Order matters — try complex patterns first.
const PATTERNS = [
  { kind: 'comment',  re: /^\/\/[^\n]*/ },
  { kind: 'comment',  re: /^\/\*[\s\S]*?\*\// },
  { kind: 'string',   re: /^"(?:[^"\\]|\\.)*"/ },
  { kind: 'string',   re: /^'(?:[^'\\]|\\.)*'/ },
  { kind: 'string',   re: /^`(?:[^`\\]|\\.)*`/ },
  { kind: 'number',   re: /^-?\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?/i },
  { kind: 'punct',    re: /^[{}\[\]()<>,.;:?]/ },
  { kind: 'operator', re: /^(?:=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\+\+|--|\+=|-=|\*=|\/=|=|\+|-|\*|\/|%|!|&|\||\^|~)/ },
  { kind: 'ident',    re: /^[A-Za-z_$][A-Za-z0-9_$]*/ },
  { kind: 'whitespace', re: /^\s+/ },
];

/**
 * Tokenise source code into a flat list of { text, kind } tokens.
 * `kind` is one of: comment, string, number, keyword, builtin, ident,
 * punct, operator, whitespace, or 'plain' for anything unrecognised.
 */
export function tokenizeTs(source) {
  const tokens = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const slice = source.slice(i);
    let matched = null;
    for (const { kind, re } of PATTERNS) {
      const m = re.exec(slice);
      if (m) {
        matched = { kind, text: m[0] };
        break;
      }
    }
    if (!matched) {
      // Unrecognised char — emit as plain to avoid infinite loop.
      tokens.push({ kind: 'plain', text: source[i] });
      i += 1;
      continue;
    }
    // Promote idents to keyword/builtin
    if (matched.kind === 'ident') {
      if (KEYWORDS.has(matched.text)) matched.kind = 'keyword';
      else if (BUILTINS.has(matched.text)) matched.kind = 'builtin';
    }
    tokens.push(matched);
    i += matched.text.length;
  }
  return tokens;
}

/**
 * Tailwind classes for each token kind. Uses project palette tokens — no
 * raw colours. Tuned for the dark code background (`bg-ink-900`).
 */
export const TOKEN_CLASSES = {
  comment:    'text-ink-500 italic',
  string:     'text-success-300',
  number:     'text-warn-300',
  keyword:    'text-info-300 font-semibold',
  builtin:    'text-accent-300',
  ident:      'text-ink-100',
  punct:      'text-ink-400',
  operator:   'text-ink-300',
  whitespace: '',
  plain:      'text-ink-100',
};
