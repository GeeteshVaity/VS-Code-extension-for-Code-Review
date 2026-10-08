/**
 * Unit tests for the Phase 4 webview pieces: the pure syntax highlighter and
 * the HTML builder. Also emits browser-previewable HTML files into dist-test/
 * so the panel can be inspected visually outside VS Code.
 *
 * Run: npm test
 */
import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml, highlightCode } from '../src/services/codeHighlight';
import { buildWebviewHtml, type WebviewPayload } from '../src/panels/webviewHtml';

const SAMPLE_RESULT = {
  executionTrace:
    '1. tick 0: loadAll() invoked\n2. await fetchA() suspends…\n3. continuation runs after fetchB() (out of order!).',
  vulnerabilityAnalysis:
    'Race condition: results object mutated by whichever promise settles last (severity: high).',
  impactAssessment:
    'UI can render stale data; unbounded listener accumulation grows memory ~1 KB/frame.',
  refactoredCode:
    'async function loadAll() {\n  const [a, b] = await Promise.all([fetchA(), fetchB()]);\n  return { a, b }; // safe ordering\n}',
};

const HTML_SHELL = (payload: WebviewPayload): string =>
  buildWebviewHtml(payload, 'test-nonce-123');

/** Pull the embedded JSON payload back out of the generated document. */
function readEmbeddedPayload(html: string): unknown {
  const match = html.match(
    /<script type="application\/json" id="cot-payload">([\s\S]*?)<\/script>/
  );
  assert.ok(match, 'cot-payload script block must exist');
  return JSON.parse(match[1]) as unknown;
}

interface Case {
  name: string;
  run: () => void;
}

const cases: Case[] = [
  {
    name: 'escapeHtml escapes &, <, >',
    run: () => {
      assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href="x"&gt;&amp;&lt;/a&gt;');
      assert.equal(escapeHtml('a < b && b > c'), 'a &lt; b &amp;&amp; b &gt; c');
    },
  },
  {
    name: 'highlightCode wraps keywords, strings, comments, numbers in spans',
    run: () => {
      const out = highlightCode('const x = 42; // note');
      assert.ok(out.includes('<span class="tok-k">const</span>'), 'keyword span');
      assert.ok(out.includes('<span class="tok-n">42</span>'), 'number span');
      assert.ok(out.includes('<span class="tok-c">// note</span>'), 'comment span');
      assert.ok(
        highlightCode('let s = "hello";').includes('<span class="tok-s">"hello"</span>'),
        'string span (quotes are not escaped, so literal quotes wrap)'
      );
    },
  },
  {
    name: 'highlightCode neutralizes HTML injection attempts',
    run: () => {
      const out = highlightCode('<script>alert(1)</script>');
      assert.ok(!out.includes('<script>'), 'no raw script tag may survive');
      assert.ok(out.includes('&lt;script&gt;'), 'must be escaped');
      const img = highlightCode('<img src=x onerror="alert(1)">');
      assert.ok(!img.includes('<img'), 'no raw img tag may survive');
    },
  },
  {
    name: 'loading HTML: spinner, four accordion titles, CSP nonce, theme tokens',
    run: () => {
      const html = HTML_SHELL({ status: 'loading' });
      assert.ok(html.includes('script-src \'nonce-test-nonce-123\''), 'CSP nonce');
      assert.ok(html.includes('class="spinner"'), 'spinner present');
      assert.ok(html.includes('class="skel"'), 'skeleton bars present while loading');
      assert.ok(html.includes('Chaining thought'), 'loading message present');
      assert.ok(html.includes('var(--vscode-editor-background'), 'editor background token');
      assert.ok(!html.includes('id="replace-btn"'), 'no replace button while loading');
      const payload = readEmbeddedPayload(html) as { status: string };
      assert.equal(payload.status, 'loading');
    },
  },
  {
    name: 'result HTML: highlighted code, Replace in Editor button, bridge message shape',
    run: () => {
      const html = HTML_SHELL({
        status: 'result',
        languageId: 'typescript',
        result: SAMPLE_RESULT,
      });
      assert.ok(html.includes('id="replace-btn"'), 'button present');
      assert.ok(html.includes('Replace in Editor'), 'button label exact');
      assert.ok(
        html.includes("{ command: 'replaceCode', code: code }"),
        'webview→host message shape from the spec'
      );
      assert.ok(html.includes('<span class="tok-k">async</span>'), 'refactored code highlighted');
      assert.ok(html.includes('id="refactored-code"'), 'code block id');
      // All four spec-mandated accordions with their emoji titles.
      for (const title of [
        '🔍</span>Execution Trace',
        '🚨</span>Vulnerability Analysis',
        '⚡</span>Impact Assessment',
        '✨</span>Refactored Code',
      ]) {
        assert.ok(html.includes(title), `accordion "${title}" present`);
      }
      // All four prose fields escaped into their accordions.
      assert.ok(html.includes(escapeHtml(SAMPLE_RESULT.executionTrace)), 'trace rendered');
      assert.ok(html.includes(escapeHtml(SAMPLE_RESULT.vulnerabilityAnalysis)), 'vulns rendered');
      assert.ok(html.includes(escapeHtml(SAMPLE_RESULT.impactAssessment)), 'impact rendered');
      // Payload round-trips byte-for-byte.
      const payload = readEmbeddedPayload(html) as {
        status: string;
        result: typeof SAMPLE_RESULT;
      };
      assert.equal(payload.status, 'result');
      assert.deepEqual(payload.result, SAMPLE_RESULT);
    },
  },
  {
    name: 'result HTML survives a refactoredCode containing </script> and markup',
    run: () => {
      const hostile = {
        ...SAMPLE_RESULT,
        refactoredCode: 'const x = "</script><script>alert(1)</script>";',
      };
      const html = HTML_SHELL({
        status: 'result',
        languageId: 'javascript',
        result: hostile,
      });
      // Embedded JSON must not contain a literal "</script" that breaks out.
      const payload = readEmbeddedPayload(html) as { result: typeof hostile };
      assert.deepEqual(payload.result.refactoredCode, hostile.refactoredCode);
      // The escaped hostile code must appear only as text, never as live markup.
      assert.ok(!html.includes('<script>alert(1)</script>'), 'hostile script must not survive as markup');
      assert.ok(html.includes('&lt;/script&gt;'), 'closing script escaped in code view');
    },
  },
  {
    name: 'error HTML: message rendered escaped with retry hint',
    run: () => {
      const html = HTML_SHELL({
        status: 'error',
        message: '[rate-limit] Groq rate limit hit — retry after 12s. <img onerror=x>',
      });
      assert.ok(html.includes('role="alert"'), 'alert role');
      assert.ok(html.includes('retry after 12s'), 'message text present');
      assert.ok(!html.includes('<img onerror'), 'message must be escaped');
      assert.ok(html.includes('&lt;img onerror=x&gt;'), 'escaped payload visible');
      assert.ok(html.includes('Run <em>CoT: Run Deep Code Review</em> again'), 'retry hint');
    },
  },
  {
    name: 'open-state accordions: trace and refactored open, others collapsed',
    run: () => {
      const html = HTML_SHELL({ status: 'result', languageId: 'typescript', result: SAMPLE_RESULT });
      const traceIdx = html.indexOf('Execution Trace');
      const vulnIdx = html.indexOf('Vulnerability Analysis');
      const impactIdx = html.indexOf('Impact Assessment');
      const refIdx = html.indexOf('Refactored Code');
      const openTag = '<details class="acc" open>';
      const closedTag = '<details class="acc">';
      const sectionAt = (i: number): string => (html.lastIndexOf(openTag, i) > html.lastIndexOf(closedTag, i) ? 'open' : 'closed');
      assert.equal(sectionAt(traceIdx), 'open', 'trace open by default');
      assert.equal(sectionAt(vulnIdx), 'closed', 'vulnerability collapsed by default');
      assert.equal(sectionAt(impactIdx), 'closed', 'impact collapsed by default');
      assert.equal(sectionAt(refIdx), 'open', 'refactored open by default');
    },
  },
];

function writePreviews(): void {
  const samples: Array<[string, WebviewPayload]> = [
    ['webview-preview-result.html', { status: 'result', languageId: 'typescript', result: SAMPLE_RESULT }],
    ['webview-preview-loading.html', { status: 'loading' }],
    ['webview-preview-error.html', { status: 'error', message: '[rate-limit] Groq rate limit hit — retry after 12s.' }],
  ];
  for (const [name, payload] of samples) {
    // acquireVsCodeApi is VS Code-only; stub it so previews run in a browser.
    const html = buildWebviewHtml(payload, 'preview-nonce').replace(
      'acquireVsCodeApi()',
      '({ postMessage: function () {}, setState: function () {}, getState: function () { return undefined; } })'
    );
    writeFileSync(join(__dirname, name), html, 'utf8');
  }
  console.log('PREVIEWS  wrote webview-preview-{result,loading,error}.html');
}

async function main(): Promise<void> {
  let failed = 0;
  for (const testCase of cases) {
    try {
      testCase.run();
      console.log(`PASS  ${testCase.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${testCase.name}`);
      console.error(err instanceof Error ? err.stack : err);
    }
  }
  writePreviews();
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
