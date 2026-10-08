/**
 * Phase 5 — full-pipeline tests over the async edge-case fixtures:
 *   fixture source → CoT prompt → (mocked) Groq response → schema parse →
 *   webview HTML render.
 *
 * Also simulates the spec's ~1.1s API latency while the loading state is
 * what the panel shows.
 *
 * Run: npm test
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GROQ_MODEL, SYSTEM_PROMPT, buildUserPrompt, runCoTReview } from '../src/services/groqService';
import { buildWebviewHtml, type WebviewResult } from '../src/panels/webviewHtml';

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

interface Fixture {
  file: string;
  languageId: string;
  /** CoT finding the fixture exists to provoke. */
  hazard: RegExp;
  /** Realistic refactored replacement the "model" returns. */
  refactoredCode: string;
}

const FIXTURES: Fixture[] = [
  {
    file: 'race-condition.ts',
    languageId: 'typescript',
    hazard: /race|lost update|ordering/i,
    refactoredCode: [
      'let lastSeen = -1;',
      'export async function loadSnapshot(id: number): Promise<Snapshot> {',
      '  const snap = await fetchSnapshot(id);',
      '  if (snap.id <= lastSeen) return latest ?? snap;',
      '  lastSeen = snap.id;',
      '  latest = snap;',
      '  return snap;',
      '}',
    ].join('\n'),
  },
  {
    file: 'unhandled-rejection.ts',
    languageId: 'typescript',
    hazard: /unhandled rejection|floating promise|cascade/i,
    refactoredCode: [
      'export function startWorker(): void {',
      '  syncAll().catch(report);',
      '  setInterval(() => { void syncAll().catch(report); }, 5_000);',
      '}',
    ].join('\n'),
  },
  {
    file: 'leaking-closure.ts',
    languageId: 'typescript',
    hazard: /memory leak|listener|closure/i,
    refactoredCode: [
      'export function attach(selector: string): () => void {',
      '  const cleanups: Array<() => void> = [];',
      '  document.querySelectorAll(selector).forEach((el, i) => {',
      '    const onClick = (): void => console.log(i, el);',
      '    el.addEventListener("click", onClick);',
      '    cleanups.push(() => el.removeEventListener("click", onClick));',
      '  });',
      '  return () => cleanups.forEach((off) => off());',
      '}',
    ].join('\n'),
  },
];

function readFixture(file: string): string {
  return readFileSync(join(FIXTURES_DIR, file), 'utf8');
}

/** Craft the mocked Groq envelope for a fixture's review. */
function mockReview(fixture: Fixture, source: string): unknown {
  const result: WebviewResult = {
    executionTrace: `Tick-by-tick walk of ${fixture.file}: await points suspend, continuations re-enter out of order.`,
    vulnerabilityAnalysis: `Detected hazard matching ${fixture.hazard.source}: triggered by the sequence in the selection.`,
    impactAssessment: `Failure scenario for ${fixture.file}: stale/leaked state under load; ${source.length} chars of input affected.`,
    refactoredCode: fixture.refactoredCode,
  };
  return { choices: [{ message: { content: JSON.stringify(result) } }] };
}

interface Case {
  name: string;
  run: () => Promise<void>;
}

const cases: Case[] = [
  ...FIXTURES.map<Case>((fixture) => ({
    name: `pipeline: ${fixture.file} flows prompt → API → parse → webview intact`,
    run: async () => {
      const source = readFixture(fixture.file);
      assert.ok(source.length > 100, 'fixture must have content');

      let capturedBody: Record<string, unknown> | undefined;
      const result = await runCoTReview(
        { selectedText: source, languageId: fixture.languageId, apiKey: 'gsk_test' },
        {
          fetchImpl: (_url, init) => {
            capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return Promise.resolve(
              new Response(JSON.stringify(mockReview(fixture, source)), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              })
            );
          },
        }
      );

      // The fixture source and language must actually reach the request.
      const messages = capturedBody?.messages as Array<{ role: string; content: string }>;
      assert.equal(capturedBody?.model, GROQ_MODEL);
      assert.equal(messages[1].content, buildUserPrompt({ selectedText: source, languageId: fixture.languageId }));
      assert.ok(messages[1].content.includes(source), 'fixture source embedded in user prompt');

      // Parsed result matches the schema contract.
      assert.equal(result.refactoredCode, fixture.refactoredCode);
      assert.ok(result.executionTrace && result.vulnerabilityAnalysis && result.impactAssessment);

      // The fixture's hazard category is covered by the system prompt.
      assert.ok(SYSTEM_PROMPT.match(fixture.hazard), `system prompt covers ${fixture.file} hazard`);

      // Webview renders the result with highlighting and intact payload.
      const html = buildWebviewHtml(
        { status: 'result', languageId: fixture.languageId, result },
        'pipe-nonce'
      );
      const payloadMatch = html.match(
        /<script type="application\/json" id="cot-payload">([\s\S]*?)<\/script>/
      );
      assert.ok(payloadMatch, 'payload present');
      assert.deepEqual(
        (JSON.parse(payloadMatch[1]) as { result: WebviewResult }).result,
        result,
        'payload round-trips'
      );
      assert.ok(html.includes('<span class="tok-k">'), 'refactored code highlighted');
      assert.ok(html.includes('id="replace-btn"'), 'replace button armed');
      assert.ok(!html.includes('<script>alert'), 'no injection via fixture content');
    },
  })),
  {
    name: 'system prompt mandates all three async hazard categories + JSON schema',
    run: async () => {
      assert.ok(/race conditions/i.test(SYSTEM_PROMPT), 'race conditions');
      assert.ok(/unhandled promise rejection/i.test(SYSTEM_PROMPT), 'rejection cascades');
      assert.ok(/memory leaks/i.test(SYSTEM_PROMPT), 'memory leaks');
      assert.ok(/event listeners/i.test(SYSTEM_PROMPT), 'event listeners');
      assert.ok(/closures/i.test(SYSTEM_PROMPT), 'closures');
      for (const field of [
        'executionTrace',
        'vulnerabilityAnalysis',
        'impactAssessment',
        'refactoredCode',
      ]) {
        assert.ok(SYSTEM_PROMPT.includes(`"${field}"`), `schema field ${field}`);
      }
    },
  },
  {
    name: 'async: ~1.1s API latency resolves while panel shows loading state',
    run: async () => {
      const fixture = FIXTURES[0];
      const source = readFixture(fixture.file);
      const loadingHtml = buildWebviewHtml({ status: 'loading' }, 'pipe-nonce');
      assert.ok(loadingHtml.includes('class="spinner"'), 'spinner shown during latency');
      assert.ok(loadingHtml.includes('class="skel"'), 'skeleton shown during latency');

      const started = Date.now();
      const result = await runCoTReview(
        { selectedText: source, languageId: fixture.languageId, apiKey: 'gsk_test' },
        {
          fetchImpl: () =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve(
                    new Response(JSON.stringify(mockReview(fixture, source)), {
                      status: 200,
                      headers: { 'content-type': 'application/json' },
                    })
                  ),
                1_100
              )
            ),
        }
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 1_100, `waits for the response (got ${elapsed}ms)`);
      assert.equal(result.refactoredCode, fixture.refactoredCode);
    },
  },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const testCase of cases) {
    try {
      await testCase.run();
      console.log(`PASS  ${testCase.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${testCase.name}`);
      console.error(err instanceof Error ? err.stack : err);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
