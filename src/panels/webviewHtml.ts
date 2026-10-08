/**
 * Pure HTML/CSS/JS builder for the review webview.
 *
 * No `vscode` import: unit-testable under plain Node and renderable in a
 * regular browser for visual checks. All dynamic content is escaped or
 * JSON-encoded before it touches the markup; styling uses VS Code theme
 * tokens (`var(--vscode-…)`) with sensible fallbacks.
 */
import { escapeHtml, highlightCode } from '../services/codeHighlight';

export interface WebviewResult {
  executionTrace: string;
  vulnerabilityAnalysis: string;
  impactAssessment: string;
  refactoredCode: string;
}

export type WebviewPayload =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'result'; languageId: string; result: WebviewResult };

/** Serialize for a raw-text <script type="application/json"> block. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const MODEL_CHIP = 'llama-3.3-70b-versatile';

function statusChip(payload: WebviewPayload): string {
  switch (payload.status) {
    case 'loading':
      return 'analyzing…';
    case 'error':
      return 'failed';
    case 'result':
      return payload.languageId;
  }
}

function loadingSection(): string {
  const skeleton = '<div class="skel" style="width: 60%"></div>' +
    '<div class="skel" style="width: 92%"></div>' +
    '<div class="skel" style="width: 78%"></div>';
  return `
    <section class="loading" role="status" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <p class="loading-title">Chaining thought — analyzing async execution…</p>
      <div class="skel-group" aria-hidden="true">${skeleton}${skeleton}</div>
    </section>`;
}

function errorSection(message: string): string {
  return `
    <section class="error" role="alert">
      <strong>Review failed</strong>
      <p>${escapeHtml(message)}</p>
      <p class="hint">Run <em>CoT: Run Deep Code Review</em> again to retry.</p>
    </section>`;
}

function accordion(
  icon: string,
  title: string,
  bodyHtml: string,
  open: boolean
): string {
  return `<details class="acc"${open ? ' open' : ''}>
      <summary><span class="acc-icon" aria-hidden="true">${icon}</span>${escapeHtml(title)}</summary>
      <div class="body">${bodyHtml}</div>
    </details>`;
}

function resultSection(result: WebviewResult): string {
  const textBody = (value: string): string =>
    `<pre class="text"><code>${escapeHtml(value)}</code></pre>`;

  const codeBody = `
      <pre class="code"><code id="refactored-code">${highlightCode(result.refactoredCode)}</code></pre>
      <div class="actions">
        <button id="replace-btn" class="btn primary" type="button">Replace in Editor</button>
        <span class="hint">Swaps the reviewed selection in the source editor for this code.</span>
      </div>`;

  return [
    accordion('🔍', 'Execution Trace', textBody(result.executionTrace), true),
    accordion('🚨', 'Vulnerability Analysis', textBody(result.vulnerabilityAnalysis), false),
    accordion('⚡', 'Impact Assessment', textBody(result.impactAssessment), false),
    accordion('✨', 'Refactored Code', codeBody, true),
  ].join('\n');
}

/** Build the full webview document for the given state. */
export function buildWebviewHtml(payload: WebviewPayload, nonce: string): string {
  const main =
    payload.status === 'loading'
      ? loadingSection()
      : payload.status === 'error'
        ? errorSection(payload.message)
        : resultSection(payload.result);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CoT Deep Review</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 14px 18px 30px;
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-foreground, #cccccc);
    font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    line-height: 1.55;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding-bottom: 12px;
    margin-bottom: 6px;
    border-bottom: 1px solid var(--vscode-panel-border, #454545);
  }
  header h1 { font-size: 1.1em; margin: 0; font-weight: 600; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    border: 1px solid var(--vscode-panel-border, #454545);
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground, #9d9d9d);
    background: var(--vscode-editorWidget-background, #252526);
  }

  details.acc {
    border: 1px solid var(--vscode-panel-border, #454545);
    border-radius: 4px;
    margin: 10px 0;
    background: var(--vscode-editorWidget-background, #252526);
    overflow: hidden;
  }
  details.acc > summary {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    cursor: pointer;
    font-weight: 600;
    user-select: none;
    list-style: none;
  }
  details.acc > summary::-webkit-details-marker { display: none; }
  details.acc > summary::before {
    content: '▸';
    display: inline-block;
    transition: transform 0.15s ease;
    color: var(--vscode-descriptionForeground, #9d9d9d);
  }
  details.acc[open] > summary::before { transform: rotate(90deg); }
  details.acc[open] > summary { border-bottom: 1px solid var(--vscode-panel-border, #454545); }
  details.acc > summary:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  details.acc > summary:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: -2px;
  }
  .acc-icon { filter: saturate(0.9); }
  .body { padding: 12px 14px; }

  pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
  pre.text code {
    font-family: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
    font-size: var(--vscode-editor-font-size, 13px);
  }
  pre.code {
    background: var(--vscode-textCodeBlock-background, #161616);
    border: 1px solid var(--vscode-panel-border, #3c3c3c);
    border-radius: 4px;
    padding: 12px;
    overflow-x: auto;
    white-space: pre;
    font-family: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
    font-size: var(--vscode-editor-font-size, 13px);
  }
  .tok-c { color: var(--vscode-editorTokenCommentForeground, #6a9955); font-style: italic; }
  .tok-s { color: var(--vscode-editorTokenStringForeground, #ce9178); }
  .tok-n { color: var(--vscode-editorTokenNumberForeground, #b5cea8); }
  .tok-k { color: var(--vscode-editorKeywordForeground, #569cd6); }
  pre.code::-webkit-scrollbar { height: 10px; }
  pre.code::-webkit-scrollbar-track { background: transparent; }
  pre.code::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background, #424242);
    border-radius: 5px;
  }
  pre.code::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground, #4f4f4f);
  }

  .actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  .btn {
    font-family: inherit;
    font-size: inherit;
    border: none;
    border-radius: 2px;
    padding: 8px 18px;
    cursor: pointer;
  }
  .btn.primary {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
  }
  .btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #1177bb); }
  .btn.primary:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 2px;
  }
  .btn:disabled {
    cursor: default;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #cccccc);
  }
  .hint { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 0.9em; }

  .loading { text-align: center; padding: 34px 10px; }
  .spinner {
    width: 24px; height: 24px;
    margin: 0 auto 14px;
    border: 3px solid var(--vscode-panel-border, #454545);
    border-top-color: var(--vscode-progressBar-background, #0e70c0);
    border-radius: 50%;
    animation: cot-spin 0.8s linear infinite;
  }
  @keyframes cot-spin { to { transform: rotate(360deg); } }
  .loading-title { margin: 0 0 18px; color: var(--vscode-descriptionForeground, #9d9d9d); }
  .skel-group { max-width: 520px; margin: 0 auto; text-align: left; }
  .skel {
    height: 12px;
    border-radius: 6px;
    margin: 10px 0;
    background: linear-gradient(90deg,
      var(--vscode-editorWidget-border, #3c3c3c),
      var(--vscode-list-hoverBackground, #2a2d2e),
      var(--vscode-editorWidget-border, #3c3c3c));
    background-size: 200% 100%;
    animation: cot-shimmer 1.4s ease infinite;
  }
  @keyframes cot-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  .error {
    border-left: 3px solid var(--vscode-inputValidation-errorBorder, #be1100);
    background: var(--vscode-inputValidation-errorBackground, rgba(190, 17, 0, 0.15));
    color: var(--vscode-errorForeground, #f48771);
    padding: 12px 14px;
    border-radius: 4px;
    margin-top: 12px;
  }
  .error p { margin: 8px 0 0; }

  .toast {
    position: fixed;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    background: var(--vscode-notifications-background, #252526);
    color: var(--vscode-notifications-foreground, #cccccc);
    border: 1px solid var(--vscode-notifications-border, #454545);
    border-radius: 4px;
    padding: 8px 16px;
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;
    max-width: 80%;
  }
  .toast.show { opacity: 1; }
  .toast.error { border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
</style>
</head>
<body>
<header>
  <h1>🧠 CoT Deep Review</h1>
  <div class="chips">
    <span class="chip">${escapeHtml(MODEL_CHIP)}</span>
    <span class="chip" id="status-chip">${escapeHtml(statusChip(payload))}</span>
  </div>
</header>
<main>
${main}
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script type="application/json" id="cot-payload">${embedJson(payload)}</script>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var payload = {};
  try {
    var payloadEl = document.getElementById('cot-payload');
    if (payloadEl) { payload = JSON.parse(payloadEl.textContent || '{}'); }
  } catch (e) { payload = {}; }

  var btn = document.getElementById('replace-btn');
  var toastEl = document.getElementById('toast');
  var toastTimer;
  function toast(text, isError) {
    if (!toastEl) { return; }
    toastEl.textContent = text;
    toastEl.classList.toggle('error', !!isError);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 3500);
  }

  if (btn) {
    btn.addEventListener('click', function () {
      var code = payload && payload.result && payload.result.refactoredCode;
      if (typeof code !== 'string' || !code) { toast('Nothing to replace.', true); return; }
      btn.disabled = true;
      btn.textContent = 'Replacing…';
      vscode.postMessage({ command: 'replaceCode', code: code });
      // Safety net: restore the button if the host never answers.
      setTimeout(function () {
        if (btn.disabled) { btn.disabled = false; btn.textContent = 'Replace in Editor'; }
      }, 10000);
    });
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg.command !== 'string') { return; }
    if (msg.command === 'replaceDone') {
      if (btn) { btn.disabled = false; }
      if (msg.success) {
        if (btn) {
          btn.textContent = '\\u2713 Replaced in Editor';
          setTimeout(function () { btn.textContent = 'Replace in Editor'; }, 2500);
        }
        toast('Refactored code applied to the editor.', false);
      } else {
        if (btn) { btn.textContent = 'Replace in Editor'; }
        toast(msg.message || 'Replace failed.', true);
      }
    }
  });

  if (payload.status === 'result') { vscode.setState(payload); }
})();
</script>
</body>
</html>`;
}
