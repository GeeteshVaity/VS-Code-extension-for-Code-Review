/**
 * Minimal, dependency-free syntax highlighter for the webview code block.
 *
 * Pure module (no `vscode` import) so it is unit-testable under plain Node.
 * Strategy: escape HTML first, then classify tokens with one alternating
 * regex (comments → strings → numbers → keywords), so user/model-provided
 * code can never inject markup into the webview.
 */

/**
 * Keywords highlighted as tokens. JS/TS reserved words + type-system
 * keywords + a small Python core. Deliberately omits ambiguous member
 * names (get/set/from/of) to avoid mis-coloring ordinary method calls.
 */
const KEYWORDS: readonly string[] = [
  // JavaScript / TypeScript
  'abstract', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
  'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'implements', 'import', 'in', 'instanceof', 'interface', 'let',
  'namespace', 'new', 'null', 'private', 'protected', 'public', 'readonly',
  'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'type', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield',
  // Python
  'and', 'as', 'assert', 'def', 'del', 'elif', 'except', 'from',
  'global', 'is', 'lambda', 'nonlocal', 'not', 'None', 'or', 'pass',
  'raise', 'True', 'False',
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KEYWORD_SET = new Set(KEYWORDS); // dedupes overlap (with, finally, …)

const KEYWORD_PATTERN = [...KEYWORD_SET]
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join('|');

const TOKEN_RE = new RegExp(
  [
    '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)', // 1: line/block comment
    '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)', // 2: string literal
    '(\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)', // 3: number
    `(\\b(?:${KEYWORD_PATTERN})\\b)`, // 4: keyword
  ].join('|'),
  'g'
);

/** Escape the three characters that matter inside HTML text nodes. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape `code` and wrap recognized tokens in spans:
 * `.tok-c` comment, `.tok-s` string, `.tok-n` number, `.tok-k` keyword.
 * Always safe to embed inside `<code>…</code>`.
 */
export function highlightCode(code: string): string {
  const escaped = escapeHtml(code);
  return escaped.replace(
    TOKEN_RE,
    (match, comment?: string, str?: string, num?: string, kw?: string) => {
      if (comment !== undefined) return `<span class="tok-c">${comment}</span>`;
      if (str !== undefined) return `<span class="tok-s">${str}</span>`;
      if (num !== undefined) return `<span class="tok-n">${num}</span>`;
      if (kw !== undefined) return `<span class="tok-k">${kw}</span>`;
      return match;
    }
  );
}
